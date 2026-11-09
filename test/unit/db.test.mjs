/**
 * Versioned DB migrations and the new Store methods (TASK-07; architecture §20).
 * Run after `npm run build`: npm run test:unit
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Store, SCHEMA_VERSION } from "../../dist/db.js";

let tmp;
let n = 0;
const dbFile = () => path.join(tmp, `orch-${n++}.db`);

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orch-db-test-")); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** The 0.1 schema as released, before the R1 columns and before user_version was used. */
const LEGACY_SCHEMA = `
CREATE TABLE runs (id TEXT PRIMARY KEY, spec_dir TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
  base_branch TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, notes TEXT);
CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), key TEXT NOT NULL, title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', acceptance TEXT NOT NULL DEFAULT '[]', depends_on TEXT NOT NULL DEFAULT '[]',
  parallel INTEGER NOT NULL DEFAULT 0, phase TEXT, order_idx INTEGER NOT NULL, status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 2, merge_policy TEXT NOT NULL DEFAULT 'auto',
  validate_cmd TEXT, worktree TEXT, branch TEXT, pr_url TEXT, session_id TEXT, summary TEXT, files TEXT NOT NULL DEFAULT '[]',
  last_feedback TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(run_id, key));
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, task_id TEXT, ts TEXT NOT NULL,
  kind TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, task_id TEXT, ts TEXT NOT NULL,
  actor TEXT NOT NULL, text TEXT NOT NULL, rationale TEXT);
CREATE TABLE questions (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, task_id TEXT NOT NULL, ts TEXT NOT NULL,
  text TEXT NOT NULL, options TEXT NOT NULL DEFAULT '[]', answer TEXT, answered_at TEXT);
`;
const TS = "2026-01-01T00:00:00.000Z";

function legacyDb({ r1 = false } = {}) {
  const file = dbFile();
  const db = new Database(file);
  db.exec(LEGACY_SCHEMA);
  if (r1) for (const c of ["fix_rounds INTEGER NOT NULL DEFAULT 0", "pr_head TEXT", "pr_pushed_at TEXT", "pr_feedback_at TEXT", "ci_head TEXT", "ci_status TEXT"]) {
    db.exec(`ALTER TABLE tasks ADD COLUMN ${c}`);
  }
  db.prepare("INSERT INTO runs VALUES ('r1', '/repo/specs/001', 'Old run', 'paused', 'main', ?, ?, 'note')").run(TS, TS);
  db.prepare(`INSERT INTO tasks (id, run_id, key, title, description, acceptance, depends_on, parallel, phase, order_idx, status,
    files, summary, created_at, updated_at) VALUES ('t1', 'r1', 'T001', 'Do it', 'desc', '["works"]', '[]', 1, 'Setup', 0, 'done',
    '["a.ts"]', 'did it', ?, ?)`).run(TS, TS);
  db.prepare("INSERT INTO decisions (run_id, task_id, ts, actor, text, rationale) VALUES ('r1', 't1', ?, 'worker', 'chose X', 'because')").run(TS);
  db.prepare("INSERT INTO questions (run_id, task_id, ts, text, options) VALUES ('r1', 't1', ?, 'Which?', '[\"a\",\"b\"]')").run(TS);
  db.prepare("INSERT INTO events (run_id, task_id, ts, kind, data) VALUES ('r1', 't1', ?, 'info', '{\"message\":\"hi\"}')").run(TS);
  db.close();
  return file;
}

const version = (store) => store.db.pragma("user_version", { simple: true });
const schemaSql = (store) => store.db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
const notNull = (store, table, col) => store.db.prepare(`PRAGMA table_info(${table})`).all().find((c) => c.name === col).notnull;

describe("migrations", () => {
  test("schema version is 3", () => assert.equal(SCHEMA_VERSION, 3));

  test("a fresh database is created at the current version", () => {
    const s = new Store(dbFile());
    assert.equal(version(s), 3);
    assert.equal(notNull(s, "questions", "task_id"), 0);
    s.db.close();
  });

  for (const r1 of [false, true]) {
    test(`a pre-migration DB (${r1 ? "with" : "without"} R1 columns) keeps every row and reaches version 3`, () => {
      const s = new Store(legacyDb({ r1 }));
      assert.equal(version(s), 3);

      const run = s.getRun("r1");
      assert.equal(run.title, "Old run");
      assert.equal(run.status, "paused");
      assert.equal(run.notes, "note");
      assert.equal(run.project_id, null);
      assert.equal(run.cost_usd, null);
      assert.equal(run.agent_ms, null);
      assert.equal(run.archived_at, null);
      assert.equal(run.docs_update_json, null);
      assert.equal(run.docs_update_ack_at, null);

      const t = s.getTask("t1");
      assert.equal(t.key, "T001");
      assert.deepEqual(t.acceptance, ["works"]);
      assert.deepEqual(t.files, ["a.ts"]);
      assert.equal(t.summary, "did it");
      assert.equal(t.fix_rounds, 0);
      assert.deepEqual(t.files_owned, []);
      assert.equal(t.validate_mode, "standard");
      assert.equal(t.synthetic, false);
      assert.equal(t.cost_usd, null);
      assert.equal(t.agent_ms, null);

      const [d] = s.listDecisions("r1");
      assert.equal(d.text, "chose X");
      assert.equal(d.rationale, "because");

      const [q] = s.listQuestions("r1");
      assert.equal(q.id, 1);
      assert.equal(q.task_id, "t1");
      assert.deepEqual(q.options, ["a", "b"]);
      assert.equal(s.openQuestionsForTask("t1").length, 1);
      assert.equal(notNull(s, "questions", "task_id"), 0);

      assert.equal(s.listEvents({ runId: "r1" })[0].data.message, "hi");

      // New questions continue after the copied ids; plan questions have no task.
      const plan = s.addQuestion("r1", null, "Whole spec?", []);
      assert.equal(plan.id, 2);
      assert.equal(s.getQuestion(plan.id).task_id, null);
      s.db.close();
    });
  }

  test("opening an already-migrated DB again changes nothing", () => {
    const file = legacyDb();
    const a = new Store(file);
    a.addQuestion("r1", null, "plan q", []);
    const before = { schema: schemaSql(a), questions: a.listQuestions("r1"), tasks: a.listTasks("r1"), runs: a.listRuns() };
    a.db.close();

    const b = new Store(file);
    assert.equal(version(b), 3);
    assert.deepEqual(schemaSql(b), before.schema);
    assert.deepEqual(b.listQuestions("r1"), before.questions);
    assert.deepEqual(b.listTasks("r1"), before.tasks);
    assert.deepEqual(b.listRuns(), before.runs);
    b.db.close();
  });

  test("version 3: a run's docs update is stored, pending until acknowledged, newest first (REQ-HITL-08)", () => {
    const s = new Store(dbFile());
    s.addProject({ id: "p", name: "P", repo_path: "/p" });
    const a = s.createRun("specs/a", "A", "main", "done", "p");
    assert.equal(a.docs_update_json, null);
    assert.equal(s.getRun(a.id).docs_update_ack_at, null);
    s.db.prepare("UPDATE runs SET created_at = '2026-01-01' WHERE id = ?").run(a.id);
    const b = s.createRun("specs/b", "B", "main", "done", "p");
    s.createRun("specs/c", "C", "main", "done", "p"); // no docs update
    s.setDocsUpdate(a.id, '{"a":1}');
    s.setDocsUpdate(b.id, '{"b":1}');
    assert.deepEqual(s.pendingDocsUpdates("p").map((r) => r.id), [b.id, a.id]);
    s.ackDocsUpdate(a.id, "2026-11-09T00:00:00Z");
    assert.equal(s.getRun(a.id).docs_update_ack_at, "2026-11-09T00:00:00Z");
    assert.deepEqual(s.pendingDocsUpdates("p").map((r) => r.id), [b.id]);
    // A replaced item is back in the inbox.
    s.setDocsUpdate(a.id, '{"a":2}');
    assert.equal(s.getRun(a.id).docs_update_ack_at, null);
    assert.equal(s.getRun(a.id).docs_update_json, '{"a":2}');
    s.db.close();
  });

  test("a DB from a newer orch is refused", () => {
    const file = dbFile();
    const db = new Database(file);
    db.pragma("user_version = 99");
    db.close();
    assert.throws(() => new Store(file), /schema version 99 is newer/);
  });
});

describe("Store: projects", () => {
  test("add, get by id and path, list, archive, touch", () => {
    const s = new Store(dbFile());
    const p = s.addProject({ id: "app", name: "App", repo_path: "/r/app" });
    assert.equal(p.archived, false);
    s.addProject({ id: "lib", name: "Lib", repo_path: "/r/lib" });
    assert.equal(s.getProject("app").repo_path, "/r/app");
    assert.equal(s.getProjectByPath("/r/lib").id, "lib");
    assert.equal(s.getProject("nope"), undefined);
    assert.throws(() => s.addProject({ id: "dup", name: "Dup", repo_path: "/r/app" }), /UNIQUE/);

    s.setProjectArchived("lib", true);
    assert.equal(s.getProject("lib").archived, true);
    assert.deepEqual(s.listProjects().map((x) => x.id), ["app"]);
    assert.deepEqual(s.listProjects({ archived: true }).map((x) => x.id), ["app", "lib"]);

    s.touchProjectStart("app", "2026-05-05T00:00:00.000Z");
    assert.equal(s.getProject("app").last_start_at, "2026-05-05T00:00:00.000Z");

    const run = s.createRun("/r/app/specs/1", "R", "main", "ready", "app");
    assert.equal(s.getRun(run.id).project_id, "app");
    assert.deepEqual(s.listRuns("app").map((r) => r.id), [run.id]);
    assert.deepEqual(s.listRuns("lib"), []);
    s.db.close();
  });
});

describe("Store: phases and new task columns", () => {
  test("upsertPhase is idempotent; updatePhase and listPhases", () => {
    const s = new Store(dbFile());
    const run = s.createRun("/x", "R", "main");
    const p1 = s.upsertPhase(run.id, "Setup", 0);
    s.upsertPhase(run.id, "Core", 1);
    assert.equal(p1.status, "pending");
    assert.equal(p1.fixup_rounds, 0);
    s.updatePhase(p1.id, { status: "validating", fixup_rounds: 1 });
    const again = s.upsertPhase(run.id, "Setup", 5);
    assert.equal(again.id, p1.id);
    assert.equal(again.status, "validating");
    assert.equal(again.idx, 0);
    assert.deepEqual(s.listPhases(run.id).map((p) => [p.name, p.status, p.fixup_rounds]), [["Setup", "validating", 1], ["Core", "pending", 0]]);
    assert.equal(s.getPhase(p1.id).name, "Setup");
    s.db.close();
  });

  test("files_owned, validate_mode, synthetic and costs round-trip", () => {
    const s = new Store(dbFile());
    const run = s.createRun("/x", "R", "main");
    const base = {
      run_id: run.id, title: "t", description: "", acceptance: [], depends_on: [], parallel: 0, phase: null, order_idx: 0,
      status: "pending", attempt: 0, max_attempts: 2, merge_policy: "auto", validate_cmd: null, worktree: null, branch: null,
      pr_url: null, session_id: null, summary: null, files: [], last_feedback: null,
    };
    const a = s.insertTask({ ...base, key: "T001" });
    assert.deepEqual(s.getTask(a.id).files_owned, []);
    const b = s.insertTask({ ...base, key: "FIX-1.1", files_owned: ["src/a.ts", "src/b/**"], validate_mode: "ui", synthetic: true, cost_usd: 0.5, agent_ms: 1200 });
    const got = s.getTask(b.id);
    assert.deepEqual(got.files_owned, ["src/a.ts", "src/b/**"]);
    assert.equal(got.validate_mode, "ui");
    assert.equal(got.synthetic, true);
    assert.equal(got.cost_usd, 0.5);
    assert.equal(got.agent_ms, 1200);
    s.updateTask(b.id, { files_owned: ["c.ts"], synthetic: false });
    assert.deepEqual(s.getTask(b.id).files_owned, ["c.ts"]);
    assert.equal(s.getTask(b.id).synthetic, false);
    s.db.close();
  });
});
