/**
 * Event archive and retention (TASK-12; architecture §17, decision 0019, REQ-OPS-04).
 * Run after `npm run build`: npm run test:unit
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { Store } from "../../dist/db.js";
import { archiveEligibleRuns, archiveFilePath, archivedLogEvent } from "../../dist/archive.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const daysAgo = (d) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString();

let tmp;
let n = 0;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orch-archive-test-")); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A fresh store with one project and a run in `status` last updated `age` days ago, holding 3 events and 1 decision. */
function fixture({ status = "done", age = 40 } = {}) {
  const dir = path.join(tmp, `case-${n++}`);
  const store = new Store(path.join(dir, "orch.db"));
  store.addProject({ id: "proj", name: "proj", repo_path: path.join(dir, "repo") });
  const run = store.createRun("specs/x", "Run", "main", "planning", "proj");
  store.addEvent(run.id, null, "state", { message: "one" });
  store.addEvent(run.id, null, "tool", { name: "Bash" });
  store.addEvent(run.id, null, "text", { text: "three" });
  store.addDecision(run.id, null, "planner", "kept decision", "why");
  store.db.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?").run(status, daysAgo(age), run.id);
  return { dir, store, run, archiveRoot: path.join(dir, "archive") };
}

describe("archiveEligibleRuns", () => {
  test("a run finished 40 days ago with 30-day retention is archived, its events deleted, decisions kept", async () => {
    const { store, run, archiveRoot } = fixture();
    const r = await archiveEligibleRuns(store, { now: NOW, eventDays: 30, archiveRoot });
    assert.deepEqual(r, { archived: [run.id], errors: [] });

    const file = path.join(archiveRoot, "proj", `${run.id}-events.jsonl.gz`);
    assert.equal(archiveFilePath(archiveRoot, run), file);
    assert.ok(fs.existsSync(file));
    assert.ok(!fs.existsSync(file + ".tmp"));
    const lines = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8").trim().split("\n");
    assert.equal(lines.length, 3);
    const parsed = lines.map((l) => JSON.parse(l));
    assert.deepEqual(parsed.map((e) => e.kind), ["state", "tool", "text"]);
    assert.deepEqual(parsed[1].data, { name: "Bash" });

    assert.equal(store.listEvents({ runId: run.id }).length, 0);
    assert.equal(store.getRun(run.id).archived_at, NOW.toISOString());
    const decisions = store.listDecisions(run.id);
    assert.ok(decisions.some((d) => d.text === "kept decision"));
    assert.ok(decisions.some((d) => d.actor === "orchestrator" && d.text.includes(file)));

    // A second pass finds nothing left to do.
    assert.deepEqual(await archiveEligibleRuns(store, { now: NOW, eventDays: 30, archiveRoot }), { archived: [], errors: [] });
    store.db.close();
  });

  test("an unfinished run 90 days old is never archived", async () => {
    for (const status of ["planning", "plan_pending", "ready", "running", "paused"]) {
      const { store, run, archiveRoot } = fixture({ status, age: 90 });
      const r = await archiveEligibleRuns(store, { now: NOW, eventDays: 30, archiveRoot });
      assert.deepEqual(r, { archived: [], errors: [] }, status);
      assert.equal(store.listEvents({ runId: run.id }).length, 3, status);
      assert.equal(store.getRun(run.id).archived_at, null, status);
      assert.ok(!fs.existsSync(archiveRoot), status);
      store.db.close();
    }
  });

  test("a finished run inside the retention window is kept", async () => {
    const { store, run, archiveRoot } = fixture({ status: "failed", age: 10 });
    assert.deepEqual(await archiveEligibleRuns(store, { now: NOW, eventDays: 30, archiveRoot }), { archived: [], errors: [] });
    assert.equal(store.listEvents({ runId: run.id }).length, 3);
    store.db.close();
  });

  test("eventDays 0 turns archiving off", async () => {
    const { store, run, archiveRoot } = fixture({ age: 400 });
    assert.deepEqual(await archiveEligibleRuns(store, { now: NOW, eventDays: 0, archiveRoot }), { archived: [], errors: [] });
    assert.equal(store.listEvents({ runId: run.id }).length, 3);
    store.db.close();
  });

  test("an unwritable archive root deletes no events and returns an error", async () => {
    const { dir, store, run } = fixture();
    // A regular file where the archive directory should be: mkdir fails even when running as root.
    const archiveRoot = path.join(dir, "not-a-dir");
    fs.writeFileSync(archiveRoot, "x");
    const r = await archiveEligibleRuns(store, { now: NOW, eventDays: 30, archiveRoot });
    assert.deepEqual(r.archived, []);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], new RegExp(`event archive failed for run ${run.id}`));

    const events = store.listEvents({ runId: run.id });
    assert.deepEqual(events.slice(0, 3).map((e) => e.kind), ["state", "tool", "text"]);
    assert.equal(events.length, 4);
    assert.equal(events[3].kind, "error");
    assert.equal(store.getRun(run.id).archived_at, null);
    assert.ok(store.listDecisions(run.id).every((d) => d.actor !== "orchestrator"));
    store.db.close();
  });

  test("a large log is streamed in pages and archived completely", async () => {
    const { store, run, archiveRoot } = fixture();
    for (let i = 0; i < 1203; i++) store.addEvent(run.id, null, "text", { text: `line ${i}` });
    store.db.prepare("UPDATE runs SET updated_at = ? WHERE id = ?").run(daysAgo(40), run.id);
    // Another run's events are not touched.
    const other = store.createRun("specs/y", "Other", "main", "running", "proj");
    store.addEvent(other.id, null, "state", { message: "live" });
    await archiveEligibleRuns(store, { now: NOW, eventDays: 30, archiveRoot });
    const lines = zlib.gunzipSync(fs.readFileSync(archiveFilePath(archiveRoot, run))).toString("utf8").trim().split("\n");
    assert.equal(lines.length, 1206);
    const ids = lines.map((l) => JSON.parse(l).id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    assert.equal(store.listEvents({ runId: other.id }).length, 1);
    store.db.close();
  });
});

describe("Store archive methods", () => {
  test("listArchivableRuns returns finished, unarchived runs older than the cutoff", () => {
    const { store, run } = fixture({ status: "stopped", age: 40 });
    assert.deepEqual(store.listArchivableRuns(daysAgo(30)).map((r) => r.id), [run.id]);
    assert.deepEqual(store.listArchivableRuns(daysAgo(50)), []);
    store.deleteRunEventsAndMarkArchived(run.id, NOW.toISOString());
    assert.deepEqual(store.listArchivableRuns(daysAgo(30)), []);
    store.db.close();
  });

  test("iterateRunEvents yields one run's events in id order across pages", () => {
    const { store, run } = fixture();
    const ids = [...store.iterateRunEvents(run.id, 2)].map((e) => e.id);
    assert.equal(ids.length, 3);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    store.db.close();
  });
});

describe("archivedLogEvent", () => {
  test("is one info event naming the archive file, sorting after every real event", () => {
    const run = { id: "r1", project_id: "proj", archived_at: "2026-06-01T00:00:00.000Z", updated_at: "x" };
    const ev = archivedLogEvent("/home/orch/archive", run, "t1");
    assert.equal(ev.kind, "info");
    assert.equal(ev.task_id, "t1");
    assert.equal(ev.ts, run.archived_at);
    assert.equal(ev.data.message, `Log archived to ${path.join("/home/orch/archive", "proj", "r1-events.jsonl.gz")}`);
    assert.equal(ev.id, Number.MAX_SAFE_INTEGER);
  });

  test("a run without a project archives under _unassigned", () => {
    assert.equal(archiveFilePath("/a", { id: "r1", project_id: null }), path.join("/a", "_unassigned", "r1-events.jsonl.gz"));
    assert.throws(() => archiveFilePath("/a", { id: "../x", project_id: "p" }));
  });
});
