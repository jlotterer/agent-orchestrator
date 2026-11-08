#!/usr/bin/env node
/**
 * End-to-end test for TASK-08 (architecture §16, decision 0014): bearer-token auth, the open
 * health check, the dashboard login cookie on the SSE stream, the token reaching agents through
 * their env, the bind guard, and no secret in the DB, the events or any prompt.
 *   node scripts/e2e-auth.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { makeRepo, writeConfig, startDaemon, api as apiFor, waitFor, cleanup, sleep, ROOT, FAKE_AGENT } from "./lib/e2e.mjs";

const PORT = 4815;
const TOKEN = "tok-" + randomBytes(12).toString("hex");
const NTFY_TOKEN = "ntfy-" + randomBytes(12).toString("hex");
const CLI = path.join(ROOT, "dist/cli.js");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const BASE = `http://127.0.0.1:${PORT}`;

/** process.env without ORCH_TOKEN / ORCH_CONFIG (unless given in `extra`), plus `extra`. */
const envWithout = (extra = {}) => {
  const e = { ...process.env };
  delete e.ORCH_TOKEN; delete e.ORCH_CONFIG;
  return { ...e, ...extra };
};
const cli = (args, env, cwd) => spawnSync("node", [CLI, ...args], { cwd, env, encoding: "utf8", timeout: 20_000 });
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const { repo, tmp, home } = makeRepo({
  prefix: "orch-e2e-auth-",
  files: {
    "README.md": "# demo\n",
    "specs/001-demo/spec.md": "# Feature Specification: Demo\n\nTwo files.\n",
    "specs/001-demo/plan.md": "# Implementation Plan: Demo\n\nPlain text files in impl/.\n",
    "specs/001-demo/tasks.md": "# Tasks\n\n## Phase 1: Core\n- [ ] T001 [P] Create impl/T001.txt\n- [ ] T005 [P] Create impl/T005.txt\n",
  },
});
const promptLog = path.join(tmp, "prompts.log");
writeConfig(repo, {
  repo: ".", baseBranch: "main", worktreeDir: "../wt", dbPath: ".orch/orch.db",
  // A non-loopback bind is allowed because a token is set (ORCH_TOKEN below).
  host: "0.0.0.0", port: PORT, publicUrl: `http://localhost:${PORT}`,
  agents: {
    timeoutMinutes: 2,
    adapters: { claude: { type: "claude", command: FAKE_AGENT, extraArgs: [], env: { FAKE_PROMPT_LOG: promptLog } } },
    roles: { planner: { adapter: "claude", model: "" }, worker: { adapter: "claude", model: "" }, validator: { adapter: "claude", model: "" } },
  },
  scheduler: { maxParallel: 2, tickSeconds: 1, maxAttempts: 2, resumeOnRetry: true },
  validation: { command: "", agent: true },
  git: { pr: false, mergePolicy: "auto", squash: true, copyFiles: [], setupCommand: "" },
  // A closed local port: notifications fail fast, but the ntfy token is configured and must not leak.
  notify: { ntfyUrl: "http://127.0.0.1:9/orch-e2e", ntfyToken: NTFY_TOKEN },
});

let ok = false;
try {
  // ---- bind guard: 0.0.0.0 without a token refuses to start ----
  const guardDir = path.join(tmp, "guard");
  fs.mkdirSync(guardDir);
  writeConfig(guardDir, { repo, host: "0.0.0.0", port: PORT + 1, dbPath: path.join(guardDir, "orch.db") });
  const g = cli(["serve"], envWithout({ ORCH_CONFIG: path.join(guardDir, "orch.config.json"), ORCH_HOME: path.join(guardDir, "home") }), guardDir);
  assert(g.status === 1, `serve on 0.0.0.0 without a token should exit 1, got ${g.status}\n${g.stdout}\n${g.stderr}`);
  assert(g.stderr.includes("auth.token") && g.stderr.includes("auth.allowInsecure"), "bind guard message should name auth.token and auth.allowInsecure:\n" + g.stderr);
  console.log("bind guard: refused 0.0.0.0 without a token");

  const daemon = await startDaemon({ cwd: repo, port: PORT, env: { ORCH_TOKEN: TOKEN, ORCH_HOME: home } });
  const api = apiFor(PORT, { token: TOKEN });

  // ---- 401 without the token; health and the dashboard shell stay open ----
  const anon = await fetch(`${BASE}/api/state`);
  assert(anon.status === 401, "GET /api/state without a token should be 401, got " + anon.status);
  assert((await anon.json()).error === "unauthorized", "401 body should be {error:'unauthorized'}");
  const wrong = await fetch(`${BASE}/api/state`, { headers: { authorization: "Bearer nope" } });
  assert(wrong.status === 401, "a wrong token should be 401, got " + wrong.status);
  const ctl = await fetch(`${BASE}/api/start`, { method: "POST" });
  assert(ctl.status === 401, "run control without a token should be 401, got " + ctl.status);
  const health = await fetch(`${BASE}/api/health`);
  const hj = await health.json();
  assert(health.status === 200 && hj.ok === true && hj.version === VERSION && typeof hj.uptimeSec === "number", "health: " + JSON.stringify(hj));
  assert((await fetch(`${BASE}/`)).status === 200, "dashboard shell should load without a token");
  console.log("auth gate: 401 without token; health open with version", hj.version);

  // ---- CLI: ORCH_TOKEN set → works; unset → exit 1 "unauthorized" ----
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-e2e-auth-cli-"));
  const okRun = cli(["status"], envWithout({ ORCH_URL: BASE, ORCH_TOKEN: TOKEN }), cliDir);
  assert(okRun.status === 0, `orch status with ORCH_TOKEN should succeed:\n${okRun.stdout}\n${okRun.stderr}`);
  const noRun = cli(["status"], envWithout({ ORCH_URL: BASE }), cliDir);
  fs.rmSync(cliDir, { recursive: true, force: true });
  assert(noRun.status === 1 && /unauthorized/.test(noRun.stderr), `orch status without a token should exit 1 with "unauthorized":\n${noRun.status}\n${noRun.stderr}`);
  console.log("cli: ok with ORCH_TOKEN, 'unauthorized' without");

  // ---- dashboard login → cookie → SSE ----
  const bad = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "nope" }) });
  assert(bad.status === 401 && !bad.headers.get("set-cookie"), "login with a wrong token should be 401 with no cookie");
  const sseAnon = await fetch(`${BASE}/api/events/stream`);
  assert(sseAnon.status === 401, "SSE without credentials should be 401, got " + sseAnon.status);
  const login = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN }) });
  const setCookie = login.headers.get("set-cookie") ?? "";
  assert(login.status === 200 && /orch_token=/.test(setCookie) && /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie), "login cookie: " + login.status + " " + setCookie);
  const cookie = setCookie.split(";")[0];
  const ac = new AbortController();
  const sse = await fetch(`${BASE}/api/events/stream`, { headers: { cookie }, signal: ac.signal });
  assert(sse.status === 200 && /text\/event-stream/.test(sse.headers.get("content-type") ?? ""), "SSE with the login cookie should connect, got " + sse.status);
  const first = await sse.body.getReader().read();
  assert(new TextDecoder().decode(first.value).includes("connected"), "SSE did not send its greeting");
  ac.abort();
  const viaCookie = await fetch(`${BASE}/api/state`, { headers: { cookie } });
  assert(viaCookie.status === 200, "the login cookie should authorize API calls too");
  console.log("login: cookie set; SSE connected with it");

  // ---- a full run: the worker's `orch decide` must get through (ORCH_TOKEN in the agent env) ----
  const run = await api("POST", "/api/plan", { specDir: path.join(repo, "specs/001-demo"), llm: true });
  await api("POST", `/api/runs/${run.id}/approve`);
  await api("POST", `/api/runs/${run.id}/start`);
  let s;
  await waitFor(async () => {
    s = await api("GET", "/api/state");
    const failed = s.inbox.find((i) => i.type === "failed");
    if (failed) throw new Error(`task failed: ${failed.title}\n${failed.detail}`);
    return s.run.status === "done";
  }, { timeoutMs: 90_000, intervalMs: 500, label: "run to finish" });
  const decisions = s.decisions.map((d) => `${d.actor}:${d.text}`);
  for (const k of ["T001", "T005"]) {
    assert(decisions.some((d) => d.startsWith(`worker:Used a plain text file for ${k}`)), `worker decision for ${k} missing (token not in agent env?):\n${decisions.join("\n")}`);
  }
  assert(s.config.auth === true && s.config.ntfyToken === true, "publicConfig should expose auth/ntfyToken as booleans: " + JSON.stringify(s.config));
  const configJson = JSON.stringify(s.config);
  assert(!configJson.includes(TOKEN) && !configJson.includes(NTFY_TOKEN), "a secret leaked into publicConfig");
  console.log("run: done; worker decisions recorded through the CLI");

  // ---- secrets: not in events, not in prompts, not in the DB file ----
  const evs = await api("GET", `/api/runs/${run.id}/events?limit=5000`);
  assert(evs.length > 0, "no events recorded");
  for (const ev of evs) {
    const d = JSON.stringify(ev.data ?? null);
    assert(!d.includes(TOKEN) && !d.includes(NTFY_TOKEN), `a secret appeared in event ${ev.id} (${ev.kind})`);
  }
  const prompts = fs.readFileSync(promptLog, "utf8");
  assert(prompts.includes("You are the PLANNER") && prompts.includes("You are the VALIDATOR"), "prompt log incomplete");
  assert(!prompts.includes(TOKEN) && !prompts.includes(NTFY_TOKEN), "a secret appeared in an agent prompt");

  daemon.kill("SIGTERM");
  await new Promise((r) => (daemon.exitCode !== null ? r() : daemon.once("exit", r)));
  await sleep(200);
  const dbDir = home;
  const dbFiles = fs.readdirSync(dbDir).filter((f) => f.startsWith("orch.db"));
  assert(dbFiles.includes("orch.db"), "DB file not found in " + dbDir);
  for (const f of dbFiles) {
    const bytes = fs.readFileSync(path.join(dbDir, f));
    for (const secret of [TOKEN, NTFY_TOKEN]) assert(!bytes.includes(Buffer.from(secret)), `a secret appeared in ${f}`);
  }
  console.log(`secrets: absent from ${evs.length} events, all prompts and ${dbFiles.join(", ")}`);
  ok = true;
} catch (e) {
  console.error("E2E AUTH FAILED:", e.message);
} finally {
  await cleanup({ ok });
  if (ok) console.log("E2E AUTH PASSED");
  process.exit(ok ? 0 : 1);
}
