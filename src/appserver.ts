/**
 * The app under test for UI validation mode (architecture §10.4, decision 0016). orch starts the
 * project's start command in the task's worktree on a free port, waits until it answers, hands the URL
 * to the validator and always stops the whole process group afterwards. A pidfile per task
 * (`<pidDir>/app-<taskId>.pid`) lets the next daemon start kill apps a crashed daemon left behind.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

/** How much of the app's output is kept for the attempt's feedback. */
export const APP_OUTPUT_CHARS = 3000;
/** Grace period between SIGTERM and SIGKILL of the app's process group. */
export const STOP_GRACE_MS = 5000;
const POLL_MS = 1000;

export interface StartAppOptions {
  cwd: string;
  /** `validation.ui.startCommand`, run with `sh -c`. */
  startCommand: string;
  /** `validation.ui.url`; `{port}` is replaced by the chosen port. */
  urlTemplate: string;
  /** `validation.ui.env`, merged over the daemon's environment (PORT is set by orch). */
  env: Record<string, string>;
  readyTimeoutSeconds: number;
  pidDir: string;
  taskId: string;
  /** Called right after the spawn, before readiness, so a stop can end the app while orch waits for it. */
  onSpawn?: (app: AppProcess) => void;
}

export interface AppProcess {
  url: string;
  port: number;
  pid: number;
  /** SIGTERM the process group, SIGKILL after 5 s, delete the pidfile. Idempotent. */
  stop(): Promise<void>;
  /** The app's last 3000 chars of stdout + stderr. */
  output(): string;
}

/** The app did not answer in time or exited early. `output` is its last 3000 chars. The app is already stopped. */
export class AppStartError extends Error {
  constructor(message: string, readonly output: string) { super(message); }
}

/** A free TCP port on 127.0.0.1 (listen on 0, close). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

export function pidFile(pidDir: string, taskId: string): string {
  return path.join(pidDir, `app-${taskId}.pid`);
}

/** Is any process of the group led by `pid` alive? */
function groupAlive(pid: number): boolean {
  try { signalGroup(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}
/** Signal the process group (POSIX). Windows has no process groups; the leader alone is signalled there. */
function signalGroup(pid: number, sig: NodeJS.Signals | 0) {
  process.kill(process.platform === "win32" ? pid : -pid, sig);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** SIGTERM the group, wait up to `graceMs` for it to go away, then SIGKILL. */
async function killGroup(pid: number, graceMs = STOP_GRACE_MS): Promise<void> {
  try { signalGroup(pid, "SIGTERM"); } catch { return; } // already gone
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!groupAlive(pid)) return;
    await sleep(100);
  }
  try { signalGroup(pid, "SIGKILL"); } catch { /* gone meanwhile */ }
}

/**
 * Start the app and wait until it answers with a status below 500 (polled every second). Throws
 * `AppStartError` (with the app's output) when it exits first or `readyTimeoutSeconds` passes; the
 * app is stopped before the error is thrown.
 */
export async function startApp(opts: StartAppOptions): Promise<AppProcess> {
  const port = await freePort();
  const url = (opts.urlTemplate || "http://127.0.0.1:{port}/").replaceAll("{port}", String(port));
  const child = spawn("sh", ["-c", opts.startCommand], {
    cwd: opts.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...opts.env, PORT: String(port) },
  });
  let out = "";
  const append = (d: Buffer) => { out = (out + d.toString("utf8")).slice(-APP_OUTPUT_CHARS); };
  child.stdout!.on("data", append);
  child.stderr!.on("data", append);
  let exited: string | null = null;
  child.once("error", (e) => { exited ??= `could not start (${e.message})`; });
  const exit = new Promise<void>((resolve) => child.once("exit", (code, sig) => { exited ??= `exited (${sig ?? `code ${code}`})`; resolve(); }));

  const pid = child.pid;
  if (pid === undefined) {
    await sleep(0); // let the spawn error arrive
    throw new AppStartError(`App ${exited ?? "could not start"}: \`${opts.startCommand}\``, out);
  }
  fs.mkdirSync(opts.pidDir, { recursive: true });
  const file = pidFile(opts.pidDir, opts.taskId);
  fs.writeFileSync(file, `${pid}\n`);

  let stopping: Promise<void> | null = null;
  const app: AppProcess = {
    url, port, pid,
    output: () => out,
    stop: () => (stopping ??= (async () => {
      await killGroup(pid);
      // Reap the leader (a zombie still counts as alive), then give a SIGKILLed group a moment to go.
      await Promise.race([exit, sleep(2000)]);
      for (let i = 0; i < 20 && groupAlive(pid); i++) await sleep(50);
      child.stdout?.destroy(); child.stderr?.destroy();
      try { if (fs.readFileSync(file, "utf8").trim() === String(pid)) fs.unlinkSync(file); } catch { /* already removed */ }
    })()),
  };
  opts.onSpawn?.(app);

  const deadline = Date.now() + opts.readyTimeoutSeconds * 1000;
  for (;;) {
    if (exited) break;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(Math.max(500, Math.min(POLL_MS * 2, deadline - Date.now()))) });
      await r.body?.cancel();
      if (r.status < 500) return app;
    } catch { /* not listening yet */ }
    if (exited || Date.now() >= deadline) break;
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
  }
  // Decide the message before stopping: the stop itself makes the app exit.
  const why = exited ? `App ${exited} before answering at ${url}` : `App did not become ready at ${url} within ${opts.readyTimeoutSeconds} s`;
  await app.stop();
  throw new AppStartError(`${why}: \`${opts.startCommand}\``, out);
}

/**
 * Stop apps a previous daemon left running (`recover()`): every `app-<taskId>.pid` in `pidDir`. Their
 * groups get SIGTERM now (synchronously); the returned promise resolves after the SIGKILL escalation and
 * the pidfiles are removed. Returns what was found, with `alive` false for a pid that was already gone.
 */
export function killLeftovers(pidDir: string): { found: { taskId: string; pid: number; alive: boolean }[]; done: Promise<void> } {
  let names: string[] = [];
  try { names = fs.readdirSync(pidDir).filter((f) => /^app-.+\.pid$/.test(f)); } catch { /* no run dir yet */ }
  const found: { taskId: string; pid: number; alive: boolean }[] = [];
  const waits: Promise<void>[] = [];
  for (const name of names) {
    const file = path.join(pidDir, name);
    let text = "";
    try { text = fs.readFileSync(file, "utf8").trim(); } catch { continue; }
    const pid = Number(text);
    const taskId = name.slice(4, -4);
    const remove = () => { try { if (fs.readFileSync(file, "utf8").trim() === text) fs.unlinkSync(file); } catch { /* gone */ } };
    if (!Number.isInteger(pid) || pid <= 1) { remove(); continue; }
    const alive = groupAlive(pid);
    found.push({ taskId, pid, alive });
    waits.push((alive ? killGroup(pid) : Promise.resolve()).then(remove));
  }
  return { found, done: Promise.all(waits).then(() => undefined) };
}
