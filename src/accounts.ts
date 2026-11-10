/**
 * Agent accounts (T028, decision 0025; architecture §15.3, contract sign-in-flows.md): which CLIs are installed
 * and signed in, and a headless run of each CLI's own login flow whose output goes to open dashboards.
 *
 * Vendor-free: the adapters contribute their status and login commands through `AgentAdapter.account`; only the
 * GitHub CLI pair lives here (GitHub is not an agent vendor). Credentials stay in each CLI's own store.
 *
 * REQ-OPS-08: this module never touches the store, `decide()`, the event log or any file. A flow's lines are
 * emitted as `account` events (the HTTP server forwards them to SSE clients) and held in memory only while the
 * flow runs so a reloaded dashboard can catch up. Typed input is written to the child and forgotten.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import os from "node:os";
import { getAdapter } from "./adapters/index.js";
import type { AccountStatus, AdapterAccount, AdapterConfig, AgentAdapter, LaunchSpec } from "./adapters/types.js";

export type AccountState = "signed_in" | "signed_out" | "unknown";

export interface AccountRow {
  id: string;
  kind: "adapter" | "tool";
  type: string;
  command: string;
  version: string | null;
  status: AccountState;
  detail: string;
  loginActive: boolean;
  /** False when the adapter has no in-browser flow; `loginNotice` then says what to do instead. */
  canLogin: boolean;
  loginNotice?: string;
  /** The exact command to run by hand (the fallback, and what a 501 answer names). */
  manualCommand?: string;
}

/** An error the HTTP layer maps to a status code; `body` is merged into the JSON answer. */
export class AccountError extends Error {
  constructor(message: string, public status: number, public body: Record<string, unknown> = {}) { super(message); }
}

export interface AccountsOptions {
  /** Read at call time so a changed server.json (T029) applies without a restart. */
  config: () => { adapters: Record<string, AdapterConfig>; ghCommand: string };
  /** Working directory of every flow (ORCH_HOME). */
  cwd: string;
  /** Test seams. */
  platform?: NodeJS.Platform;
  resolveAdapter?: (type: string) => AgentAdapter;
  loginTimeoutMs?: number;
  probeTimeoutMs?: number;
}

interface Entry { id: string; kind: "adapter" | "tool"; type: string; cfg: AdapterConfig; account: AdapterAccount | undefined }

interface Flow {
  child: ReturnType<typeof spawn>;
  /** Unterminated output (a prompt such as "Paste code here > "). */
  partial: string;
  partialTimer: NodeJS.Timeout | null;
  lastInput: string | null;
  /** Lines printed so far; memory only, dropped when the flow ends. */
  lines: string[];
  timer: NodeJS.Timeout;
  cancelled: boolean;
  timedOut: boolean;
}

const MAX_LINES = 300;
const MAX_INPUT = 4096;
/** A prompt with no newline is shown after this much silence. */
const PARTIAL_FLUSH_MS = 400;

// CSI sequences, OSC sequences (BEL or ST terminated), charset selects and other two-byte escapes.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[@-Z\\-_=>]/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** One output line, escape sequences removed; a carriage return overwrites what came before it. */
export function cleanLine(raw: string): string {
  const parts = raw.replace(ANSI, "").split("\r");
  let last = "";
  for (const p of parts) if (p.replace(CONTROL, "").trim()) last = p;
  return last.replace(CONTROL, "").replace(/\s+$/, "");
}

const shQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const commandLine = (spec: LaunchSpec) => [spec.command, ...spec.args].map(shQuote).join(" ");

/** The GitHub CLI is the one non-agent account (contract: sign-in-flows.md). */
function ghAccount(ghCommand: string): AdapterAccount {
  return {
    status: () => ({ command: ghCommand, args: ["auth", "status"], stdin: null }),
    parseStatus(output, exitCode) {
      const line = output.split(/\r?\n/).map((l) => l.replace(/^[\s✓✗X!-]+/, "").trim()).find((l) => /logged in to/i.test(l));
      if (exitCode === 0) return { signedIn: true, detail: line ?? "signed in" };
      return { signedIn: false, detail: exitCode === null ? "status check timed out" : "not signed in" };
    },
    login: () => ({ command: ghCommand, args: ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"], stdin: null }),
    failureHint: "Check that github.com is reachable from the server, then try again, or run `gh auth login` by hand.",
  };
}

function runProbe(spec: LaunchSpec, env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<{ output: string; exitCode: number | null; spawnFailed: boolean }> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (exitCode: number | null, spawnFailed = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ output, exitCode, spawnFailed });
    };
    const child = spawn(spec.command, spec.args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(null); }, timeoutMs);
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", () => finish(null, true));
    child.on("close", (code) => finish(code));
  });
}

function versionOf(output: string): string | null {
  const m = output.match(/\d+\.\d+\.\d+[\w.+-]*/);
  if (m) return m[0];
  const first = cleanLine(output.split(/\r?\n/).find((l) => l.trim()) ?? "");
  return first ? first.slice(0, 60) : null;
}

export class Accounts extends EventEmitter {
  private flows = new Map<string, Flow>();
  private readonly platform: NodeJS.Platform;
  private readonly resolveAdapter: (type: string) => AgentAdapter;
  private readonly loginTimeoutMs: number;
  private readonly probeTimeoutMs: number;

  constructor(private opts: AccountsOptions) {
    super();
    this.platform = opts.platform ?? os.platform();
    this.resolveAdapter = opts.resolveAdapter ?? getAdapter;
    this.loginTimeoutMs = opts.loginTimeoutMs ?? 10 * 60_000;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 15_000;
  }

  private entries(): Entry[] {
    const { adapters, ghCommand } = this.opts.config();
    const out: Entry[] = [];
    for (const [id, cfg] of Object.entries(adapters)) {
      let account: AdapterAccount | undefined;
      try { account = this.resolveAdapter(cfg.type).account; } catch { /* unknown type: shown as unknown */ }
      out.push({ id, kind: "adapter", type: cfg.type, cfg, account });
    }
    out.push({ id: "gh", kind: "tool", type: "gh", cfg: { type: "gh", command: ghCommand, extraArgs: [], env: {} }, account: ghAccount(ghCommand) });
    return out;
  }

  private entry(id: string): Entry {
    const e = this.entries().find((x) => x.id === id);
    if (!e) throw new AccountError(`unknown account '${id}'`, 404);
    return e;
  }

  private envFor(e: Entry): NodeJS.ProcessEnv {
    return { ...process.env, ...e.cfg.env };
  }

  private async probe(e: Entry): Promise<AccountRow> {
    const login = e.account?.login(e.cfg) ?? null;
    const base = {
      id: e.id, kind: e.kind, type: e.type, command: e.cfg.command,
      loginActive: this.flows.has(e.id), canLogin: !!login, loginNotice: e.account?.loginNotice,
      manualCommand: login ? commandLine(login) : undefined,
    };
    const env = this.envFor(e);
    const v = await runProbe({ command: e.cfg.command, args: ["--version"], stdin: null }, env, this.opts.cwd, this.probeTimeoutMs);
    if (v.spawnFailed) return { ...base, version: null, status: "unknown", detail: `not installed (cannot run '${e.cfg.command}')` };
    const version = v.exitCode === null ? null : versionOf(v.output);
    if (!e.account) return { ...base, version, status: "unknown", detail: "this adapter has no sign-in support" };
    const s = await runProbe(e.account.status(e.cfg), env, this.opts.cwd, this.probeTimeoutMs);
    if (s.spawnFailed) return { ...base, version, status: "unknown", detail: `not installed (cannot run '${e.cfg.command}')` };
    let st: AccountStatus;
    try { st = e.account.parseStatus(s.output, s.exitCode); } catch { st = { signedIn: false, detail: "could not read the status output" }; }
    if (s.exitCode === null) return { ...base, version, status: "unknown", detail: `status check timed out after ${Math.round(this.probeTimeoutMs / 1000)} s` };
    let detail = st.detail;
    if (e.kind === "tool" && env.GH_TOKEN) detail += " (GH_TOKEN is set in the environment, so gh ignores the stored login)";
    return { ...base, version, status: st.signedIn ? "signed_in" : "signed_out", detail };
  }

  /** One row per adapter plus gh; probes run in parallel (15 s each), on demand, never on the tick. */
  list(): Promise<AccountRow[]> {
    return Promise.all(this.entries().map((e) => this.probe(e)));
  }

  /** Re-probe one account. */
  async row(id: string): Promise<AccountRow> {
    return this.probe(this.entry(id));
  }

  isActive(id: string): boolean { return this.flows.has(id); }

  /** Lines printed so far by the running flow (memory only); empty when none runs. */
  lines(id: string): string[] { return [...(this.flows.get(id)?.lines ?? [])]; }

  startLogin(id: string): void {
    const e = this.entry(id);
    const spec = e.account?.login(e.cfg) ?? null;
    if (!spec) throw new AccountError(e.account?.loginNotice ?? `'${id}' has no sign-in flow`, 400);
    if (this.platform !== "linux" && this.platform !== "darwin") {
      const cmd = commandLine(spec);
      throw new AccountError(`Signing in from the dashboard needs Linux or macOS on the server. Run this by hand: ${cmd}`, 501, { command: cmd });
    }
    if (this.flows.has(id)) throw new AccountError(`a sign-in for '${id}' is already running`, 409);

    // A pseudo-terminal via script(1), so CLIs that insist on a TTY work and output is flushed per line. The wide
    // window keeps a long authorization URL on one line.
    const argv = this.platform === "linux"
      ? ["-qfec", `stty cols 1000 rows 50 2>/dev/null; exec ${commandLine(spec)}`, "/dev/null"]
      : ["-q", "/dev/null", spec.command, ...spec.args];
    const env = { ...this.envFor(e), TERM: process.env.TERM || "xterm" };
    const child = spawn("script", argv, { cwd: this.opts.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const flow: Flow = {
      child, partial: "", partialTimer: null, lastInput: null, lines: [], cancelled: false, timedOut: false,
      timer: setTimeout(() => { flow.timedOut = true; this.kill(flow); }, this.loginTimeoutMs),
    };
    this.flows.set(id, flow);
    console.log(`[accounts] sign-in started for ${id}`); // no flow content is ever logged

    let ended = false;
    const end = (exitCode: number | null) => {
      if (ended) return;
      ended = true;
      clearTimeout(flow.timer);
      if (flow.partialTimer) clearTimeout(flow.partialTimer);
      this.flushPartial(id, flow);
      this.flows.delete(id);
      console.log(`[accounts] sign-in for ${id} ended (exit ${exitCode ?? "none"}${flow.cancelled ? ", cancelled" : ""}${flow.timedOut ? ", timed out" : ""})`);
      const hint = exitCode !== 0 && !flow.cancelled ? e.account?.failureHint : undefined;
      this.emit("account", { id, done: true, exitCode, ...(flow.cancelled ? { cancelled: true } : {}), ...(flow.timedOut ? { timedOut: true } : {}), ...(hint ? { hint } : {}) });
      this.probe(e).then((row) => this.emit("account", { id, account: row }), () => { /* the next GET probes again */ });
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const onData = (chunk: string) => {
      flow.partial += chunk;
      const parts = flow.partial.split("\n");
      flow.partial = parts.pop() ?? "";
      for (const p of parts) this.emitLine(id, flow, p);
      if (flow.partialTimer) clearTimeout(flow.partialTimer);
      flow.partialTimer = flow.partial ? setTimeout(() => this.flushPartial(id, flow), PARTIAL_FLUSH_MS) : null;
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.stdin.on("error", () => { /* the flow may end while we write */ });
    child.on("error", (err) => {
      this.emitLine(id, flow, `could not start the sign-in: ${err.message}`);
      end(null);
    });
    child.on("close", (code) => end(code));
  }

  sendInput(id: string, text: string): void {
    const flow = this.flows.get(id);
    if (!flow) throw new AccountError(`no sign-in is running for '${id}'`, 409);
    const clean = String(text ?? "").replace(/[\r\n]+/g, "").slice(0, MAX_INPUT);
    // Show a pending prompt before the echo of the answer arrives.
    if (flow.partialTimer) clearTimeout(flow.partialTimer);
    this.flushPartial(id, flow);
    flow.lastInput = clean ? clean : null;
    flow.child.stdin!.write(clean + "\n");
  }

  cancel(id: string): void {
    const flow = this.flows.get(id);
    if (!flow) throw new AccountError(`no sign-in is running for '${id}'`, 409);
    flow.cancelled = true;
    this.kill(flow);
  }

  /** Stop every running flow (server shutdown). */
  stopAll(): void {
    for (const f of this.flows.values()) { f.cancelled = true; this.kill(f); }
  }

  private kill(flow: Flow) {
    flow.child.kill("SIGTERM");
    setTimeout(() => flow.child.kill("SIGKILL"), 3000).unref();
  }

  private flushPartial(id: string, flow: Flow) {
    if (!flow.partial) return;
    const p = flow.partial;
    flow.partial = "";
    this.emitLine(id, flow, p);
  }

  private emitLine(id: string, flow: Flow, raw: string) {
    const line = cleanLine(raw);
    if (!line) return;
    // The pty echoes what the owner typed; do not send it back.
    if (flow.lastInput !== null && line === flow.lastInput) { flow.lastInput = null; return; }
    flow.lines.push(line);
    if (flow.lines.length > MAX_LINES) flow.lines.shift();
    this.emit("account", { id, line });
  }
}
