#!/usr/bin/env node
/**
 * End-to-end test: builds a throwaway git repo with a Spec Kit feature dir,
 * starts the daemon with the fake agent, plans, approves, runs, answers the
 * question, approves the manual merge, and checks that everything lands on main.
 *   node scripts/e2e.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PORT = 4811;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orch-e2e-"));
const repo = path.join(tmp, "repo");
fs.mkdirSync(repo);
const sh = (c, cwd = repo) => execSync(c, { cwd, stdio: "pipe", encoding: "utf8" });

sh("git init -q -b main");
fs.writeFileSync(path.join(repo, "README.md"), "# demo\n");
fs.writeFileSync(path.join(repo, "check.sh"), "#!/bin/sh\nfor f in impl/*.txt; do [ -f \"$f\" ] || continue; grep -q OK \"$f\" || { echo \"$f is not OK\"; exit 1; }; done\necho checks passed\n");
fs.mkdirSync(path.join(repo, "specs/001-demo"), { recursive: true });
fs.writeFileSync(path.join(repo, "specs/001-demo/spec.md"), "# Feature Specification: Demo greeting\n\nUsers get greeted.\n");
fs.writeFileSync(path.join(repo, "specs/001-demo/plan.md"), "# Implementation Plan: Demo greeting\n\nPlain text files in impl/.\n");
fs.writeFileSync(path.join(repo, "specs/001-demo/tasks.md"), `# Tasks

## Phase 1: Setup
- [ ] T001 Create base greeting file in impl/T001.txt

## Phase 2: Core
- [ ] T002 [P] Add localized greeting (depends on T001)
- [ ] T003 [P] Add farewell file
- [ ] T004 Expose greeting through the public API
`);
sh("git add -A && git -c user.name=t -c user.email=t@x commit -q -m init");
fs.writeFileSync(path.join(repo, "orch.config.json"), JSON.stringify({
  repo: ".", baseBranch: "main", worktreeDir: "../wt", dbPath: ".orch/orch.db", port: PORT, publicUrl: `http://localhost:${PORT}`,
  agents: {
    timeoutMinutes: 2,
    adapters: {
      claude: { type: "claude", command: path.join(ROOT, "scripts/fake-agent.mjs"), extraArgs: [], env: {} },
      gemini: { type: "gemini", command: path.join(ROOT, "scripts/fake-agent.mjs"), extraArgs: ["--yolo", "--skip-trust"], env: { FAKE_FLAVOR: "gemini" } },
    },
    // Workers on one adapter, validation on another: the mixed setup this test exists to exercise.
    roles: { planner: { adapter: "claude", model: "" }, worker: { adapter: "claude", model: "" }, validator: { adapter: "gemini", model: "pro" } },
  },
  scheduler: { maxParallel: 2, tickSeconds: 1, maxAttempts: 2, resumeOnRetry: true },
  validation: { command: "sh check.sh", agent: true },
  git: { pr: false, mergePolicy: "auto", squash: true, copyFiles: [], setupCommand: "" },
}, null, 2));

const daemon = spawn("node", [path.join(ROOT, "dist/cli.js"), "serve"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
daemon.stdout.on("data", (d) => process.stdout.write("[daemon] " + d));
daemon.stderr.on("data", (d) => process.stdout.write("[daemon!] " + d));
const api = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p}: ${j.error}`);
  return j;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = false;
try {
  for (let i = 0; i < 50; i++) { try { await api("GET", "/api/state"); break; } catch { await sleep(200); } }
  const html = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
  if (!html.includes("<title>orch</title>")) throw new Error("dashboard did not serve");

  const run = await api("POST", "/api/plan", { specDir: path.join(repo, "specs/001-demo"), llm: true });
  console.log("planned:", run.id, run.status);
  let s = await api("GET", "/api/state");
  const t004 = s.tasks.find((t) => t.key === "T004");
  if (t004.merge_policy !== "manual") throw new Error("planner enrichment not applied");
  if (!s.tasks.every((t) => t.acceptance.length === 1)) throw new Error("acceptance criteria missing");
  if (!s.inbox.some((i) => i.type === "approve_plan")) throw new Error("approve_plan not in inbox");

  await api("POST", `/api/runs/${run.id}/approve`);
  await api("POST", `/api/runs/${run.id}/start`);

  const seen = new Set();
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await sleep(700);
    s = await api("GET", "/api/state");
    for (const i of s.inbox) {
      const k = `${i.type}:${i.id ?? i.task_id}`;
      if (seen.has(k)) continue;
      if (i.type === "question") { seen.add(k); console.log("answering:", i.title); await api("POST", `/api/questions/${i.id}/answer`, { answer: "French" }); }
      if (i.type === "merge") { seen.add(k); console.log("merging:", i.task_key); await api("POST", `/api/tasks/${i.task_id}/merge`); }
      if (i.type === "failed") throw new Error(`task failed: ${i.title}\n${i.detail}`);
    }
    if (s.run.status === "done") break;
  }
  s = await api("GET", "/api/state");
  console.log("final:", s.run.status, s.tasks.map((t) => `${t.key}=${t.status}(${t.attempt})`).join(" "));
  if (s.run.status !== "done") throw new Error("run did not finish");
  const t003 = s.tasks.find((t) => t.key === "T003"), t004b = s.tasks.find((t) => t.key === "T004");
  if (t003.attempt !== 2) throw new Error("T003 should have needed 2 attempts (gate)");
  if (t004b.attempt !== 2) throw new Error("T004 should have needed 2 attempts (validator)");
  const files = sh("ls impl").trim().split("\n");
  if (files.length !== 4) throw new Error("expected 4 impl files on main, got " + files);
  if (!sh("cat impl/T002.txt").includes("greeting=French")) throw new Error("answer did not reach the worker");
  const tasksMd = fs.readFileSync(path.join(repo, "specs/001-demo/tasks.md"), "utf8");
  if ((tasksMd.match(/\[x\]/g) || []).length !== 4) throw new Error("tasks.md not ticked");
  const decisions = s.decisions.map((d) => `${d.actor}:${d.text}`);
  for (const must of ["planner:Marked T004", "worker:Used a plain text file for T001", "human:Answered", "human:Approved merge of T004", "validator:T004 passed validation", "orchestrator:Retrying T003"]) {
    if (!decisions.some((d) => d.startsWith(must))) throw new Error(`missing decision: ${must}\n${decisions.join("\n")}`);
  }
  const evs = await api("GET", `/api/runs/${run.id}/events?limit=1000`);
  const vStart = evs.filter((e) => e.kind === "state" && /validator started \(gemini:pro\)/.test(e.data.message));
  if (vStart.length < 4) throw new Error("validator did not run on the gemini adapter: " + vStart.length);
  const vInit = evs.filter((e) => e.kind === "info" && e.data.role === "validator" && e.data.model === "fake-gemini");
  if (!vInit.length) throw new Error("gemini stream not parsed (no init with fake-gemini model)");
  const log = sh("git log --oneline").trim().split("\n");
  console.log("main log:\n  " + log.join("\n  "));
  console.log("decisions:\n  " + decisions.join("\n  "));
  ok = true;
} catch (e) {
  console.error("E2E FAILED:", e.message);
} finally {
  daemon.kill("SIGTERM");
  await sleep(300);
  if (ok) { fs.rmSync(tmp, { recursive: true, force: true }); console.log("E2E PASSED"); }
  else console.log("repo kept at", repo);
  process.exit(ok ? 0 : 1);
}
