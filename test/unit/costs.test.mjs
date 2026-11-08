/**
 * Cost and agent-time rollup (TASK-17; architecture §18, REQ-UI-06).
 * Run after `npm run build`: npm run test:unit
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../dist/db.js";
import { addRunUsage, addTaskUsage, runTotals, projectTotals, taskTotals } from "../../dist/costs.js";
import { archiveEligibleRuns } from "../../dist/archive.js";

let tmp;
let n = 0;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orch-costs-test-")); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function newStore() {
  const dir = path.join(tmp, `case-${n++}`);
  const store = new Store(path.join(dir, "orch.db"));
  store.addProject({ id: "proj", name: "proj", repo_path: path.join(dir, "repo") });
  return store;
}
function addTask(store, runId, key) {
  return store.insertTask({
    run_id: runId, key, title: key, description: key, acceptance: [], depends_on: [], parallel: 0, phase: "Phase 1",
    order_idx: Number(key.slice(1)), status: "pending", attempt: 0, max_attempts: 2, merge_policy: "auto",
    validate_cmd: null, worktree: null, branch: null, pr_url: null, session_id: null, summary: null, files: [], last_feedback: null,
  });
}

describe("costs: rows", () => {
  test("NULL + x = x, and a call without a cost adds only time", () => {
    const store = newStore();
    const run = store.createRun("specs/x", "Run", "main", "running", "proj");
    const t = addTask(store, run.id, "T1");
    assert.deepEqual(taskTotals(store.getTask(t.id)), { costUsd: null, agentMs: 0 });
    addTaskUsage(store, t.id, { costUsd: null, durationMs: 1000 }); // e.g. Gemini
    assert.deepEqual(taskTotals(store.getTask(t.id)), { costUsd: null, agentMs: 1000 });
    addTaskUsage(store, t.id, { costUsd: 0.04, durationMs: 500 });
    addTaskUsage(store, t.id, { costUsd: 0.06, durationMs: 250 });
    assert.deepEqual(taskTotals(store.getTask(t.id)), { costUsd: 0.1, agentMs: 1750 });
  });
});

describe("costs: rollups", () => {
  test("run total = run row (planner) + Σ tasks: 0.10 + 0.05 + 0.02 = 0.17", () => {
    const store = newStore();
    const run = store.createRun("specs/x", "Run", "main", "running", "proj");
    const a = addTask(store, run.id, "T1"), b = addTask(store, run.id, "T2");
    addTaskUsage(store, a.id, { costUsd: 0.10, durationMs: 3000 });
    addTaskUsage(store, b.id, { costUsd: 0.05, durationMs: 2000 });
    addRunUsage(store, run.id, { costUsd: 0.02, durationMs: 1000 });
    assert.deepEqual(runTotals(store, run.id), { costUsd: 0.17, agentMs: 6000 });
  });

  test("all-null costs give costUsd null (shown as n/a), with agent time still counted", () => {
    const store = newStore();
    const run = store.createRun("specs/x", "Run", "main", "running", "proj");
    const a = addTask(store, run.id, "T1");
    addTask(store, run.id, "T2"); // never ran
    addTaskUsage(store, a.id, { costUsd: null, durationMs: 1200 });
    addRunUsage(store, run.id, { costUsd: null, durationMs: 800 });
    assert.deepEqual(runTotals(store, run.id), { costUsd: null, agentMs: 2000 });
    assert.deepEqual(projectTotals(store, "proj"), { costUsd: null, agentMs: 2000 });
  });

  test("a run with no tasks and no agents is null / 0; an unknown run too", () => {
    const store = newStore();
    const run = store.createRun("specs/x", "Run", "main", "planning", "proj");
    assert.deepEqual(runTotals(store, run.id), { costUsd: null, agentMs: 0 });
    assert.deepEqual(runTotals(store, "nope"), { costUsd: null, agentMs: 0 });
    assert.deepEqual(projectTotals(store, "other"), { costUsd: null, agentMs: 0 });
  });

  test("project total = Σ its runs; other projects are not counted", () => {
    const store = newStore();
    store.addProject({ id: "other", name: "other", repo_path: path.join(tmp, `other-${n}`) });
    const r1 = store.createRun("specs/a", "A", "main", "done", "proj");
    const r2 = store.createRun("specs/b", "B", "main", "running", "proj");
    const r3 = store.createRun("specs/c", "C", "main", "running", "other");
    addTaskUsage(store, addTask(store, r1.id, "T1").id, { costUsd: 0.10, durationMs: 100 });
    addRunUsage(store, r2.id, { costUsd: 0.02, durationMs: 50 });
    addTaskUsage(store, addTask(store, r2.id, "T1").id, { costUsd: null, durationMs: 25 });
    addTaskUsage(store, addTask(store, r3.id, "T1").id, { costUsd: 9, durationMs: 9 });
    assert.deepEqual(projectTotals(store, "proj"), { costUsd: 0.12, agentMs: 175 });
    assert.deepEqual(projectTotals(store, "other"), { costUsd: 9, agentMs: 9 });
  });

  test("archiving a run's events does not change its totals", async () => {
    const store = newStore();
    const run = store.createRun("specs/x", "Run", "main", "done", "proj");
    const t = addTask(store, run.id, "T1");
    addTaskUsage(store, t.id, { costUsd: 0.03, durationMs: 400 });
    store.addEvent(run.id, t.id, "info", { cost_usd: 0.03, duration_ms: 400 });
    store.db.prepare("UPDATE runs SET updated_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", run.id);
    const prior = runTotals(store, run.id);
    const r = await archiveEligibleRuns(store, { now: new Date(), eventDays: 30, archiveRoot: path.join(tmp, `arch-${n}`) });
    assert.deepEqual(r.archived, [run.id]);
    assert.equal(store.listEvents({ runId: run.id }).filter((e) => e.kind === "info").length, 0, "events were archived");
    assert.deepEqual(runTotals(store, run.id), prior);
    assert.deepEqual(projectTotals(store, "proj"), prior);
  });
});
