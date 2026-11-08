/**
 * Snapshot performance (TASK-10; REQ-NFR-06, architecture §14, §15.1): a project snapshot of a 200-task run
 * builds in under 1 s no matter how large the event log is, because it never reads the events table.
 * Also checks the inbox shapes the project list and the global inbox derive from the same data.
 * Run after `npm run build`: npm run test:unit
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../dist/db.js";
import { Orchestrator } from "../../dist/orchestrator.js";
import { DEFAULT_SERVER_CONFIG } from "../../dist/config.js";

const TASKS = 200;
const EVENTS = 100_000;

let tmp, store, orch, runId;

function task(runId, i, status) {
  return {
    run_id: runId, key: `T${String(i + 1).padStart(3, "0")}`, title: `Task ${i + 1}`, description: "x".repeat(200),
    acceptance: ["it works", "it is tested"], depends_on: i ? [`T${String(i).padStart(3, "0")}`] : [], parallel: 0,
    phase: `Phase ${1 + Math.floor(i / 20)}`, order_idx: i, status, attempt: 1, max_attempts: 2, merge_policy: "auto",
    validate_cmd: null, worktree: null, branch: null, pr_url: null, session_id: null, summary: "did it",
    files: ["src/a.ts"], last_feedback: status === "failed" ? "tests failed" : null,
  };
}

before(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "orch-perf-test-")));
  const home = path.join(tmp, "home");
  const repoA = path.join(tmp, "alpha"), repoB = path.join(tmp, "beta");
  for (const d of [home, repoA, repoB]) fs.mkdirSync(d, { recursive: true });
  store = new Store(path.join(home, "orch.db"));
  store.addProject({ id: "alpha", name: "Alpha", repo_path: repoA });
  store.addProject({ id: "beta", name: "Beta", repo_path: repoB });

  const run = store.createRun(path.join(repoA, "specs/001"), "Big run", "main", "running", "alpha");
  runId = run.id;
  const ids = [];
  store.db.transaction(() => {
    for (let i = 0; i < TASKS; i++) ids.push(store.insertTask(task(run.id, i, i === 0 ? "failed" : i < 150 ? "done" : "pending")).id);
    for (let i = 0; i < EVENTS; i++) store.addEvent(run.id, ids[i % TASKS], "agent", { message: `line ${i} ` + "y".repeat(80) });
    for (let i = 0; i < 300; i++) store.addDecision(run.id, ids[i % TASKS], "worker", `decision ${i}`, "because");
  })();
  store.addQuestion(run.id, ids[1], "Which way?", ["A", "B"]);

  // Beta: a plan awaiting approval, so the global inbox spans two projects.
  const runB = store.createRun(path.join(repoB, "specs/001"), "Small run", "main", "plan_pending", "beta");
  store.insertTask(task(runB.id, 0, "pending"));

  orch = new Orchestrator(DEFAULT_SERVER_CONFIG, store, { home });
});
after(() => {
  store.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test(`project snapshot of ${TASKS} tasks with ${EVENTS} events builds in under 1 s (REQ-NFR-06)`, () => {
  orch.snapshot("alpha"); // warm up statement caches and the project context
  const t0 = performance.now();
  const s = orch.snapshot("alpha");
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `snapshot took ${ms.toFixed(0)} ms`);
  assert.equal(s.project.id, "alpha");
  assert.equal(s.run.id, runId);
  assert.equal(s.tasks.length, TASKS);
  assert.equal(s.decisions.length, 300);
  assert.equal(s.inboxCount, 2); // the failed task and the open question
  assert.deepEqual(s.inbox.map((i) => i.type).sort(), ["failed", "question"]);
});

test("a run of another project is 404 in a project snapshot", () => {
  assert.throws(() => orch.snapshot("beta", runId), (e) => e.status === 404);
  assert.throws(() => orch.snapshot("nope"), (e) => e.status === 404);
});

test("project list and global inbox stay fast and label every item with its project (REQ-HITL-01)", () => {
  const t0 = performance.now();
  const list = orch.listProjectSummaries();
  const inbox = orch.globalInbox();
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `project list + inbox took ${ms.toFixed(0)} ms`);
  assert.deepEqual(list.map((p) => [p.id, p.run?.status, p.inboxCount, p.error]), [["alpha", "running", 2, null], ["beta", "plan_pending", 1, null]]);
  assert.deepEqual(inbox.map((i) => [i.project_id, i.project_name, i.type]).sort(), [
    ["alpha", "Alpha", "failed"], ["alpha", "Alpha", "question"], ["beta", "Beta", "approve_plan"],
  ]);
});

test("change events carry the project id", () => {
  const seen = [];
  const on = (c) => seen.push(c);
  orch.on("change", on);
  try { orch.approvePlan(store.listRuns("beta")[0].id); } finally { orch.off("change", on); }
  assert.ok(seen.length >= 2, "approve emits a decision and a run change");
  assert.ok(seen.every((c) => c.projectId === "beta"), JSON.stringify(seen.map((c) => [c.what, c.projectId])));
});
