#!/usr/bin/env node
/**
 * End-to-end test: builds a throwaway git repo with a Spec Kit feature dir,
 * starts the daemon with the fake agent, plans, approves, runs, answers the
 * question, reviews T004's diff and sends it back with feedback (TASK-06), approves the
 * manual merge, and checks that everything lands on main.
 * TASK-13: `orch plan --dry-run` creates nothing; the planner's plan question (PLAN_QUESTION in spec.md)
 * has no task and holds every start until answered; approval refuses a dependency cycle.
 * TASK-14: the planner gives T002 and T003 overlapping files_owned; they never run at the same time and an
 * orchestrator decision names both. T001's out-of-scope edit (notes/T001.md) is a finding, and T001 still passes.
 *   node scripts/e2e.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeRepo, writeConfig, startDaemon, api as apiFor, waitFor, cleanup, sleep, FAKE_AGENT, ROOT } from "./lib/e2e.mjs";

const PORT = 4811;
const CHECK_SH = "#!/bin/sh\nfor f in impl/*.txt; do [ -f \"$f\" ] || continue; grep -q OK \"$f\" || { echo \"$f is not OK\"; exit 1; }; done\necho checks passed\n";
const { repo, home, sh, tmp } = makeRepo({
  prefix: "orch-e2e-",
  files: {
    "README.md": "# demo\n",
    "check.sh": CHECK_SH,
    "specs/001-demo/spec.md": "# Feature Specification: Demo greeting\n\nUsers get greeted.\n\nPLAN_QUESTION: capitalization is not settled yet.\n",
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
const ACTIVE_DIR = path.join(tmp, "active"); // fake agents record which tasks overlap in time (TASK-14)
writeConfig(repo, {
  repo: ".", baseBranch: "main", worktreeDir: "../wt", dbPath: ".orch/orch.db", port: PORT, publicUrl: `http://localhost:${PORT}`,
  agents: {
    timeoutMinutes: 2,
    adapters: {
      claude: { type: "claude", command: FAKE_AGENT, extraArgs: [], env: { FAKE_ACTIVE_DIR: ACTIVE_DIR } },
      gemini: { type: "gemini", command: FAKE_AGENT, extraArgs: ["--yolo", "--skip-trust"], env: { FAKE_FLAVOR: "gemini", FAKE_ACTIVE_DIR: ACTIVE_DIR } },
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

  // TASK-13 (REQ-INTAKE-10): a dry run prints the plan and creates nothing.
  const specDir = path.join(repo, "specs/001-demo");
  const dry = spawnSync("node", [path.join(ROOT, "dist/cli.js"), "plan", "--dry-run", specDir], {
    cwd: repo, encoding: "utf8", env: { ...process.env, ORCH_HOME: home, ORCH_URL: `http://127.0.0.1:${PORT}`, ORCH_TOKEN: "", ORCH_PROJECT: "" },
  });
  if (dry.status !== 0) throw new Error(`orch plan --dry-run exited ${dry.status}\n${dry.stdout}\n${dry.stderr}`);
  for (const k of ["T001", "T002", "T003", "T004", "[P]", "Phase 1: Setup", "Phase 2: Core"]) {
    if (!dry.stdout.includes(k)) throw new Error(`dry run output lacks ${k}:\n${dry.stdout}`);
  }
  if (!/T004 .*\n\s+depends on: T001, T003/.test(dry.stdout)) throw new Error("dry run output lacks T004's dependencies:\n" + dry.stdout);
  const afterDry = await api("GET", "/api/state");
  if (afterDry.run || afterDry.runs.length) throw new Error("dry run created a run: " + JSON.stringify(afterDry.runs));
  console.log("dry run ok:", dry.stdout.split("\n")[0]);

  const run = await api("POST", "/api/plan", { specDir, llm: true });
  console.log("planned:", run.id, run.status);
  let s = await api("GET", "/api/state");
  const t004 = s.tasks.find((t) => t.key === "T004");
  if (t004.merge_policy !== "manual") throw new Error("planner enrichment not applied");
  if (!s.tasks.every((t) => t.acceptance.length === 1)) throw new Error("acceptance criteria missing");
  if (!s.inbox.some((i) => i.type === "approve_plan")) throw new Error("approve_plan not in inbox");
  // TASK-13 (REQ-INTAKE-07): the planner's question is about the plan, not about a task.
  const planQ = s.inbox.find((i) => i.type === "question");
  if (!planQ || planQ.task_id || planQ.task_key || !planQ.plan) throw new Error("expected a plan question with no task: " + JSON.stringify(s.inbox));
  if (s.questions.some((q) => q.task_id)) throw new Error("plan question was attached to a task");

  // TASK-14 (REQ-INTAKE-04): the planner's files_owned is applied.
  const owned = Object.fromEntries(s.tasks.map((t) => [t.key, t.files_owned]));
  if (JSON.stringify(owned.T002) !== JSON.stringify(["impl/T002.txt", "shared/**"]) || !owned.T003.includes("shared/farewell.md")) {
    throw new Error("planner files_owned not applied: " + JSON.stringify(owned));
  }
  // TASK-14 (REQ-INTAKE-09): the edit API accepts files_owned (trimmed, deduplicated) and rejects a non-array.
  const t004id = s.tasks.find((t) => t.key === "T004").id;
  await api("POST", `/api/tasks/${t004id}/edit`, { files_owned: [" impl/T004.txt ", "impl/T004.txt", ""] });
  if (JSON.stringify((await api("GET", "/api/state")).tasks.find((t) => t.key === "T004").files_owned) !== JSON.stringify(["impl/T004.txt"])) {
    throw new Error("files_owned edit not applied");
  }
  const badOwned = await raw("POST", `/api/tasks/${t004id}/edit`, { files_owned: "impl/**" });
  if (badOwned.status !== 400) throw new Error("a non-array files_owned should be 400: " + JSON.stringify(badOwned));
  if (!(await api("GET", "/api/state")).decisions.some((d) => d.actor === "human" && d.text === "Edited task T004: files_owned")) throw new Error("files_owned edit not recorded as a human decision");

  // TASK-13 (§6.3): approval refuses a dependency cycle and names its keys. T004 already depends on T001.
  const t001 = s.tasks.find((t) => t.key === "T001");
  await api("POST", `/api/tasks/${t001.id}/edit`, { depends_on: ["T004"] });
  const cyc = await raw("POST", `/api/runs/${run.id}/approve`);
  if (cyc.status !== 400 || !/cycle/.test(cyc.body.error ?? "") || !cyc.body.error.includes("T001") || !cyc.body.error.includes("T004")) {
    throw new Error("approving a cycle should be 400 naming T001 and T004: " + JSON.stringify(cyc));
  }
  if ((await api("GET", "/api/state")).run.status !== "plan_pending") throw new Error("a refused approval changed the run");
  console.log("cycle refused:", cyc.body.error);
  await api("POST", `/api/tasks/${t001.id}/edit`, { depends_on: [] });

  await api("POST", `/api/runs/${run.id}/approve`);
  await api("POST", `/api/runs/${run.id}/start`);

  // While the plan question is open no task starts (several ticks at tickSeconds 1).
  await sleep(3500);
  s = await api("GET", "/api/state");
  if (s.run.status !== "running") throw new Error("run should be running, is " + s.run.status);
  if (!s.tasks.every((t) => t.status === "pending" && t.attempt === 0)) throw new Error("a task started while the plan question was open: " + s.tasks.map((t) => `${t.key}=${t.status}`).join(" "));
  const evsHeld = await api("GET", `/api/runs/${run.id}/events?limit=1000`);
  if (!evsHeld.some((e) => e.kind === "state" && /plan questions/.test(e.data.message ?? ""))) throw new Error("no 'waiting on you' event for the plan question");
  console.log("answering plan question:", planQ.title);
  await api("POST", `/api/questions/${planQ.id}/answer`, { answer: "Yes" });

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
  for (const must of ["planner:Marked T004", "human:Answered plan question", "worker:Used a plain text file for T001", "human:Answered", "human:Approved merge of T004", "validator:T004 passed validation", "orchestrator:Retrying T003", "orchestrator:Retrying T004", "human:Sending owner feedback on T004"]) {
    if (!decisions.some((d) => d.startsWith(must))) throw new Error(`missing decision: ${must}\n${decisions.join("\n")}`);
  }
  const evs = await api("GET", `/api/runs/${run.id}/events?limit=1000`);

  // TASK-14 (REQ-SCHED-02, REQ-HITL-06): T002 and T003 own overlapping files, so they never ran together.
  const concurrent = fs.existsSync(path.join(ACTIVE_DIR, "concurrent.log")) ? fs.readFileSync(path.join(ACTIVE_DIR, "concurrent.log"), "utf8") : "";
  if (/T002 with T003|T003 with T002/.test(concurrent)) throw new Error("T002 and T003 ran at the same time:\n" + concurrent);
  const hold = s.decisions.find((d) => d.actor === "orchestrator" && d.text.startsWith("Holding") && d.text.includes("T002") && d.text.includes("T003"));
  if (!hold) throw new Error(`no orchestrator decision naming T002 and T003:\n${decisions.join("\n")}`);
  console.log("overlap hold:", hold.text);
  // TASK-14 (REQ-VAL-05): T001's edit outside its owned files is a finding, and the verdict stays PASS.
  const t001v = evs.filter((e) => e.kind === "verdict" && e.task_id === t001.id).at(-1);
  if (!t001v || t001v.data.verdict !== "PASS" || JSON.stringify(t001v.data.out_of_scope) !== JSON.stringify(["notes/T001.md"]) || !t001v.data.findings.some((f) => f.includes("notes/T001.md"))) {
    throw new Error("T001 verdict should PASS with notes/T001.md out of scope: " + JSON.stringify(t001v?.data));
  }
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
