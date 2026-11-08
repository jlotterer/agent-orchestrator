#!/usr/bin/env node
/**
 * End-to-end test: builds a throwaway git repo with a Spec Kit feature dir,
 * starts the daemon with the fake agent, plans, approves, runs, answers the
 * question, reviews T004's diff and sends it back with feedback (TASK-06), approves the
 * manual merge, and checks that everything lands on main.
 *   node scripts/e2e.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { makeRepo, writeConfig, startDaemon, api as apiFor, waitFor, cleanup, FAKE_AGENT } from "./lib/e2e.mjs";

const PORT = 4811;
const CHECK_SH = "#!/bin/sh\nfor f in impl/*.txt; do [ -f \"$f\" ] || continue; grep -q OK \"$f\" || { echo \"$f is not OK\"; exit 1; }; done\necho checks passed\n";
const { repo, home, sh } = makeRepo({
  prefix: "orch-e2e-",
  files: {
    "README.md": "# demo\n",
    "check.sh": CHECK_SH,
    "specs/001-demo/spec.md": "# Feature Specification: Demo greeting\n\nUsers get greeted.\n",
    "specs/001-demo/plan.md": "# Implementation Plan: Demo greeting\n\nPlain text files in impl/.\n",
    "specs/001-demo/tasks.md": `# Tasks

## Phase 1: Setup
- [ ] T001 Create base greeting file in impl/T001.txt

## Phase 2: Core
- [ ] T002 [P] Add localized greeting (depends on T001)
- [ ] T003 [P] Add farewell file
- [ ] T004 Expose greeting through the public API
`,
  },
});
writeConfig(repo, {
  repo: ".", baseBranch: "main", worktreeDir: "../wt", dbPath: ".orch/orch.db", port: PORT, publicUrl: `http://localhost:${PORT}`,
  agents: {
    timeoutMinutes: 2,
    adapters: {
      claude: { type: "claude", command: FAKE_AGENT, extraArgs: [], env: {} },
      gemini: { type: "gemini", command: FAKE_AGENT, extraArgs: ["--yolo", "--skip-trust"], env: { FAKE_FLAVOR: "gemini" } },
    },
    // Workers on one adapter, validation on another: the mixed setup this test exists to exercise.
    roles: { planner: { adapter: "claude", model: "" }, worker: { adapter: "claude", model: "" }, validator: { adapter: "gemini", model: "pro" } },
  },
  scheduler: { maxParallel: 2, tickSeconds: 1, maxAttempts: 2, resumeOnRetry: true },
  validation: { command: "sh check.sh", agent: true },
  git: { pr: false, mergePolicy: "auto", squash: true, copyFiles: [], setupCommand: "" },
});

const api = apiFor(PORT);
/** Raw request: { status, body } without throwing, for error-path assertions. */
const raw = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let ok = false;
try {
  await startDaemon({ cwd: repo, port: PORT, env: { ORCH_HOME: home } });
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
  let sentBack = false;
  /** TASK-06: review T004's diff, then send it back with feedback instead of merging it. */
  const reviewAndSendBack = async (i) => {
    const d = await api("GET", `/api/tasks/${i.task_id}/diff`);
    const f = d.files.find((x) => x.path === "impl/T004.txt");
    if (!f || f.additions < 1 || f.binary || !/^\+OK/m.test(f.patch ?? "")) throw new Error("T004 diff missing impl/T004.txt with additions:\n" + JSON.stringify(d, null, 2));
    if (d.files.some((x) => x.path.startsWith("impl/") && x.path !== "impl/T004.txt")) throw new Error("T004 diff includes other tasks' files: " + d.files.map((x) => x.path));
    if (!d.base || !d.head || d.truncated !== false) throw new Error("diff shape: " + JSON.stringify({ base: d.base, head: d.head, truncated: d.truncated }));
    const empty = await raw("POST", `/api/tasks/${i.task_id}/request-changes`, { feedback: "  " });
    if (empty.status !== 400) throw new Error("empty feedback should be rejected: " + JSON.stringify(empty));
    console.log("sending back:", i.task_key);
    await api("POST", `/api/tasks/${i.task_id}/request-changes`, { feedback: "add a trailing note" });
    const after = await api("GET", "/api/state");
    if (after.inbox.some((x) => x.type === "merge" && x.task_id === i.task_id)) throw new Error("T004 still in the inbox after Send back");
    sentBack = true;
  };
  await waitFor(async () => {
    s = await api("GET", "/api/state");
    for (const i of s.inbox) {
      const k = `${i.type}:${i.id ?? i.task_id}`;
      if (seen.has(k)) continue;
      if (i.type === "question") { seen.add(k); console.log("answering:", i.title); await api("POST", `/api/questions/${i.id}/answer`, { answer: "French" }); }
      if (i.type === "merge" && i.task_key === "T004" && !sentBack) { await reviewAndSendBack(i); continue; }
      if (i.type === "merge") { seen.add(k); console.log("merging:", i.task_key); await api("POST", `/api/tasks/${i.task_id}/merge`); }
      if (i.type === "failed") throw new Error(`task failed: ${i.title}\n${i.detail}`);
    }
    return s.run.status === "done";
  }, { timeoutMs: 120_000, intervalMs: 700, label: "run to finish" }).catch((e) => { if (!/^timed out/.test(e.message)) throw e; });
  s = await api("GET", "/api/state");
  console.log("final:", s.run.status, s.tasks.map((t) => `${t.key}=${t.status}(${t.attempt})`).join(" "));
  if (s.run.status !== "done") throw new Error("run did not finish");
  const t003 = s.tasks.find((t) => t.key === "T003"), t004b = s.tasks.find((t) => t.key === "T004");
  if (t003.attempt !== 2) throw new Error("T003 should have needed 2 attempts (gate)");
  if (!sentBack) throw new Error("T004 was never sent back");
  if (t004b.fix_rounds !== 1) throw new Error("T004 should have had 1 owner feedback round, got " + t004b.fix_rounds);
  if (!sh("cat impl/T004.txt").includes("note")) throw new Error("owner feedback did not reach the worker (impl/T004.txt has no note)");
  const gone = await raw("GET", `/api/tasks/${t003.id}/diff`);
  if (gone.status !== 404 || !/worktree/.test(gone.body.error ?? "")) throw new Error("diff of a merged task should be 404 with a reason: " + JSON.stringify(gone));
  const late = await raw("POST", `/api/tasks/${t003.id}/request-changes`, { feedback: "too late" });
  if (late.status !== 400) throw new Error("request-changes on a done task should be rejected: " + JSON.stringify(late));
  const files = sh("ls impl").trim().split("\n");
  if (files.length !== 4) throw new Error("expected 4 impl files on main, got " + files);
  if (!sh("cat impl/T002.txt").includes("greeting=French")) throw new Error("answer did not reach the worker");
  const tasksMd = fs.readFileSync(path.join(repo, "specs/001-demo/tasks.md"), "utf8");
  if ((tasksMd.match(/\[x\]/g) || []).length !== 4) throw new Error("tasks.md not ticked");
  const decisions = s.decisions.map((d) => `${d.actor}:${d.text}`);
  for (const must of ["planner:Marked T004", "worker:Used a plain text file for T001", "human:Answered", "human:Approved merge of T004", "validator:T004 passed validation", "orchestrator:Retrying T003", "orchestrator:Retrying T004", "human:Sending owner feedback on T004"]) {
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
  await cleanup({ ok });
  if (ok) console.log("E2E PASSED");
  process.exit(ok ? 0 : 1);
}
