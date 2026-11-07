/**
 * Shared helpers for the end-to-end scenarios (scripts/e2e*.mjs).
 *
 *   const { repo, tmp, sh } = makeRepo({ files: { "README.md": "# demo\n" }, origin: true });
 *   writeConfig(repo, { ... });
 *   await startDaemon({ cwd: repo, port: 4811 });
 *   const call = api(4811);
 *   await waitFor(async () => (await call("GET", "/api/state")).run?.status === "done", { timeoutMs: 120_000 });
 *   await cleanup({ ok });   // kills daemons; removes temp dirs only when ok, else prints where they are
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";

/** Repository root of orch itself. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FAKE_AGENT = path.join(ROOT, "scripts/fake-agent.mjs");
export const FAKE_GH = path.join(ROOT, "scripts/fake-gh.mjs");

const tracked = { tmps: [], repos: [], daemons: [] };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run a shell command in `cwd`, returning stdout. Throws on a non-zero exit. */
export const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: "pipe", encoding: "utf8" });

/**
 * Create a throwaway git repo on `main` with `files` (relative path -> content) committed.
 * `origin: true` also creates a local bare repo at `<tmp>/origin.git`, adds it as `origin` and pushes main.
 * Returns { tmp, repo, origin, sh } where `sh(cmd, cwd = repo)` runs in the repo.
 */
export function makeRepo({ files = {}, origin = false, prefix = "orch-e2e-" } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  tracked.tmps.push(tmp);
  tracked.repos.push(repo);
  const run = (c, cwd = repo) => sh(c, cwd);
  const originPath = origin ? path.join(tmp, "origin.git") : null;
  if (originPath) run(`git init -q --bare -b main "${originPath}"`, tmp);
  run("git init -q -b main");
  // orch commits and rebases in this repo and its worktrees; fresh CI runners/containers have no identity.
  run("git config user.name t && git config user.email t@x");
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(repo, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
  run("git add -A && git -c user.name=t -c user.email=t@x commit -q -m init");
  if (originPath) run(`git remote add origin "${originPath}" && git push -q -u origin main`);
  return { tmp, repo, origin: originPath, sh: run };
}

/** Write `orch.config.json` into `repo` (left untracked). */
export function writeConfig(repo, config) {
  fs.writeFileSync(path.join(repo, "orch.config.json"), JSON.stringify(config, null, 2));
}

/** `api(port)` returns `(method, path, body?) => json`; non-2xx responses throw `<path>: <error>`. */
export function api(port) {
  return async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (!r.ok) throw new Error(`${p}: ${j.error}`);
    return j;
  };
}

/**
 * Poll `fn` until it returns a truthy value (returned) or `timeoutMs` passes (throws).
 * Errors thrown by `fn` propagate immediately unless `ignoreErrors` is set.
 */
export async function waitFor(fn, { timeoutMs = 10_000, intervalMs = 200, ignoreErrors = false, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      if (!ignoreErrors) throw e;
    }
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await sleep(intervalMs);
  }
}

/**
 * Start `dist/cli.js serve` in `cwd` with `env` merged over process.env. Output is echoed with a
 * `[<name>]` / `[<name>!]` prefix. Resolves once GET /api/state answers on `port`.
 */
export async function startDaemon({ cwd, env = {}, port, name = "daemon", readyTimeoutMs = 10_000 }) {
  const proc = spawn("node", [path.join(ROOT, "dist/cli.js"), "serve"], { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  proc.stdout.on("data", (d) => process.stdout.write(`[${name}] ` + d));
  proc.stderr.on("data", (d) => process.stdout.write(`[${name}!] ` + d));
  tracked.daemons.push(proc);
  const call = api(port);
  await waitFor(() => call("GET", "/api/state"), { timeoutMs: readyTimeoutMs, ignoreErrors: true, label: `${name} on :${port}` });
  return proc;
}

/** Stop every daemon started here; remove temp dirs when `ok`, otherwise print where the repos were kept. */
export async function cleanup({ ok }) {
  for (const d of tracked.daemons) d.kill("SIGTERM");
  if (tracked.daemons.length) await sleep(300);
  if (ok) for (const t of tracked.tmps) fs.rmSync(t, { recursive: true, force: true });
  else for (const r of tracked.repos) console.log("repo kept at", r);
  tracked.daemons = []; tracked.tmps = []; tracked.repos = [];
}
