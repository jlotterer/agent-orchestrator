import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Run, Task, Event, Decision, Question, TaskStatus, RunStatus, Project, Phase } from "./types.js";

/*
 * Schema versions (architecture §20 "Migrations & versioning"). `PRAGMA user_version` holds the
 * version; the Store constructor applies migrations `user_version+1 .. SCHEMA_VERSION` in order,
 * one transaction each. Never edit a released migration: add a new one.
 */

/** Version 1 base tables: the 0.1 schema (R1 task columns included for fresh databases). */
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  spec_dir TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  acceptance TEXT NOT NULL DEFAULT '[]',
  depends_on TEXT NOT NULL DEFAULT '[]',
  parallel INTEGER NOT NULL DEFAULT 0,
  phase TEXT,
  order_idx INTEGER NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  merge_policy TEXT NOT NULL DEFAULT 'auto',
  validate_cmd TEXT,
  worktree TEXT,
  branch TEXT,
  pr_url TEXT,
  session_id TEXT,
  summary TEXT,
  files TEXT NOT NULL DEFAULT '[]',
  last_feedback TEXT,
  fix_rounds INTEGER NOT NULL DEFAULT 0,
  pr_head TEXT,
  pr_pushed_at TEXT,
  pr_feedback_at TEXT,
  ci_head TEXT,
  ci_status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, key)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  task_id TEXT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id, id);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, id);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  task_id TEXT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  text TEXT NOT NULL,
  rationale TEXT
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  text TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  answer TEXT,
  answered_at TEXT
);
`;

/** R1 columns added after 0.1; migration 1 adds whichever an existing database lacks. */
const R1_TASK_COLUMNS: [string, string][] = [
  ["fix_rounds", "INTEGER NOT NULL DEFAULT 0"],
  ["pr_head", "TEXT"],
  ["pr_pushed_at", "TEXT"],
  ["pr_feedback_at", "TEXT"],
  ["ci_head", "TEXT"],
  ["ci_status", "TEXT"],
];

function addColumns(db: Database.Database, table: string, cols: [string, string][]) {
  const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name));
  for (const [col, type] of cols) if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

/** Migrations by target version (index 0 → version 1). Each is safe on a DB that already has part of it. */
const MIGRATIONS: ((db: Database.Database) => void)[] = [
  // 1: the 0.1 schema plus the R1 PR-feedback columns.
  (db) => {
    db.exec(SCHEMA_V1);
    addColumns(db, "tasks", R1_TASK_COLUMNS);
  },
  // 2: projects and phases; cost/time and archive columns; ownership, UI-mode and synthetic task
  //    columns; questions.task_id nullable (plan questions).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repo_path TEXT NOT NULL UNIQUE,
        archived INTEGER NOT NULL DEFAULT 0,
        last_start_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS phases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        name TEXT NOT NULL,
        idx INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        fixup_rounds INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, name)
      );
    `);
    addColumns(db, "runs", [
      ["project_id", "TEXT"],
      ["cost_usd", "REAL"],
      ["agent_ms", "INTEGER"],
      ["archived_at", "TEXT"],
    ]);
    addColumns(db, "tasks", [
      ["files_owned", "TEXT NOT NULL DEFAULT '[]'"],
      ["validate_mode", "TEXT NOT NULL DEFAULT 'standard'"],
      ["synthetic", "INTEGER NOT NULL DEFAULT 0"],
      ["cost_usd", "REAL"],
      ["agent_ms", "INTEGER"],
    ]);
    db.exec("CREATE INDEX IF NOT EXISTS runs_project ON runs(project_id, created_at)");
    // SQLite cannot drop NOT NULL in place: rebuild the table, keeping ids (and so the AUTOINCREMENT high-water mark).
    const taskId = (db.prepare("PRAGMA table_info(questions)").all() as any[]).find((c) => c.name === "task_id");
    if (taskId?.notnull) {
      db.exec(`
        CREATE TABLE questions_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          task_id TEXT,
          ts TEXT NOT NULL,
          text TEXT NOT NULL,
          options TEXT NOT NULL DEFAULT '[]',
          answer TEXT,
          answered_at TEXT
        );
        INSERT INTO questions_new (id, run_id, task_id, ts, text, options, answer, answered_at)
          SELECT id, run_id, task_id, ts, text, options, answer, answered_at FROM questions;
        DROP TABLE questions;
        ALTER TABLE questions_new RENAME TO questions;
      `);
    }
    db.exec("CREATE INDEX IF NOT EXISTS questions_run ON questions(run_id, id)");
  },
  // 3: the run's "Update project docs" item (REQ-HITL-08): its lists as JSON and when the owner acknowledged it.
  (db) => {
    addColumns(db, "runs", [
      ["docs_update_json", "TEXT"],
      ["docs_update_ack_at", "TEXT"],
    ]);
  },
];

/** The schema version this build writes. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** Bring `db` up to SCHEMA_VERSION. Returns the versions applied (empty when already current). */
export function migrate(db: Database.Database): number[] {
  const from = db.pragma("user_version", { simple: true }) as number;
  if (from > SCHEMA_VERSION) {
    throw new Error(`database schema version ${from} is newer than this orch supports (${SCHEMA_VERSION}); upgrade orch`);
  }
  const applied: number[] = [];
  for (let v = from + 1; v <= SCHEMA_VERSION; v++) {
    db.transaction(() => {
      MIGRATIONS[v - 1](db);
      db.pragma(`user_version = ${v}`);
    })();
    applied.push(v);
  }
  return applied;
}

const now = () => new Date().toISOString();

/** Task fields the Store fills in when a caller leaves them out. */
type TaskDefaulted =
  | "fix_rounds" | "pr_head" | "pr_pushed_at" | "pr_feedback_at" | "ci_head" | "ci_status"
  | "files_owned" | "validate_mode" | "synthetic" | "cost_usd" | "agent_ms";
export type NewTask = Omit<Task, "id" | "created_at" | "updated_at" | TaskDefaulted> & Partial<Pick<Task, TaskDefaulted>>;

function rowToTask(r: any): Task {
  return {
    ...r,
    acceptance: JSON.parse(r.acceptance),
    depends_on: JSON.parse(r.depends_on),
    files: JSON.parse(r.files),
    files_owned: JSON.parse(r.files_owned),
    synthetic: !!r.synthetic,
  };
}
function rowToEvent(r: any): Event {
  return { ...r, data: JSON.parse(r.data) };
}
function rowToQuestion(r: any): Question {
  return { ...r, options: JSON.parse(r.options) };
}
function rowToProject(r: any): Project {
  return { ...r, archived: !!r.archived };
}

export class Store {
  db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    migrate(this.db);
  }

  // ---- projects ----
  addProject(p: { id: string; name: string; repo_path: string }): Project {
    const project: Project = { ...p, archived: false, last_start_at: null, created_at: now(), updated_at: now() };
    this.db
      .prepare(`INSERT INTO projects (id, name, repo_path, archived, last_start_at, created_at, updated_at)
                VALUES (@id, @name, @repo_path, 0, NULL, @created_at, @updated_at)`)
      .run({ id: project.id, name: project.name, repo_path: project.repo_path, created_at: project.created_at, updated_at: project.updated_at });
    return project;
  }
  getProject(id: string): Project | undefined {
    const r = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    return r ? rowToProject(r) : undefined;
  }
  getProjectByPath(repoPath: string): Project | undefined {
    const r = this.db.prepare("SELECT * FROM projects WHERE repo_path = ?").get(repoPath);
    return r ? rowToProject(r) : undefined;
  }
  /** Non-archived projects by name; `{archived: true}` includes the archived ones too. */
  listProjects(opts: { archived?: boolean } = {}): Project[] {
    const sql = opts.archived
      ? "SELECT * FROM projects ORDER BY name, id"
      : "SELECT * FROM projects WHERE archived = 0 ORDER BY name, id";
    return (this.db.prepare(sql).all() as any[]).map(rowToProject);
  }
  setProjectArchived(id: string, archived: boolean) {
    this.db.prepare("UPDATE projects SET archived = ?, updated_at = ? WHERE id = ?").run(archived ? 1 : 0, now(), id);
  }
  /** Record that a task started in this project (fair share across projects, §7.1). */
  touchProjectStart(id: string, at: string = now()) {
    this.db.prepare("UPDATE projects SET last_start_at = ?, updated_at = ? WHERE id = ?").run(at, now(), id);
  }

  // ---- runs ----
  createRun(specDir: string, title: string, baseBranch: string, status: RunStatus = "planning", projectId: string | null = null): Run {
    const run: Run = {
      id: crypto.randomUUID().slice(0, 8),
      project_id: projectId,
      spec_dir: specDir,
      title,
      status,
      base_branch: baseBranch,
      created_at: now(),
      updated_at: now(),
      notes: null,
      cost_usd: null,
      agent_ms: null,
      archived_at: null,
      docs_update_json: null,
      docs_update_ack_at: null,
    };
    this.db
      .prepare(`INSERT INTO runs (id, project_id, spec_dir, title, status, base_branch, created_at, updated_at, notes)
                VALUES (@id, @project_id, @spec_dir, @title, @status, @base_branch, @created_at, @updated_at, @notes)`)
      .run({
        id: run.id, project_id: run.project_id, spec_dir: run.spec_dir, title: run.title, status: run.status,
        base_branch: run.base_branch, created_at: run.created_at, updated_at: run.updated_at, notes: run.notes,
      });
    return run;
  }
  getRun(id: string): Run | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Run | undefined;
  }
  /** All runs, newest first; with `projectId`, only that project's. */
  listRuns(projectId?: string): Run[] {
    return projectId === undefined
      ? (this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC").all() as Run[])
      : (this.db.prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as Run[]);
  }
  /** The run the scheduler should act on: the most recent one that isn't finished. */
  activeRun(): Run | undefined {
    return this.db
      .prepare(`SELECT * FROM runs WHERE status NOT IN ('done','stopped','failed') ORDER BY created_at DESC LIMIT 1`)
      .get() as Run | undefined;
  }
  setRunStatus(id: string, status: RunStatus) {
    this.db.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
  }
  /** Store a finished run's "Update project docs" lists (REQ-HITL-08); a new item is unacknowledged. */
  setDocsUpdate(id: string, json: string) {
    this.db.prepare("UPDATE runs SET docs_update_json = ?, docs_update_ack_at = NULL, updated_at = ? WHERE id = ?").run(json, now(), id);
  }
  ackDocsUpdate(id: string, ts: string = now()) {
    this.db.prepare("UPDATE runs SET docs_update_ack_at = ?, updated_at = ? WHERE id = ?").run(ts, now(), id);
  }
  /** A project's runs with an unacknowledged docs update, newest first. */
  pendingDocsUpdates(projectId: string): Run[] {
    return this.db
      .prepare("SELECT * FROM runs WHERE project_id = ? AND docs_update_json IS NOT NULL AND docs_update_ack_at IS NULL ORDER BY created_at DESC")
      .all(projectId) as Run[];
  }
  setRunNotes(id: string, notes: string) {
    this.db.prepare("UPDATE runs SET notes = ?, updated_at = ? WHERE id = ?").run(notes, now(), id);
  }

  // ---- tasks ----
  insertTask(t: NewTask): Task {
    const task: Task = {
      fix_rounds: 0, pr_head: null, pr_pushed_at: null, pr_feedback_at: null, ci_head: null, ci_status: null,
      files_owned: [], validate_mode: "standard", synthetic: false, cost_usd: null, agent_ms: null,
      ...t, id: crypto.randomUUID().slice(0, 8), created_at: now(), updated_at: now(),
    };
    this.db
      .prepare(`INSERT INTO tasks (id, run_id, key, title, description, acceptance, depends_on, parallel, phase, order_idx,
                status, attempt, max_attempts, merge_policy, validate_cmd, worktree, branch, pr_url, session_id, summary, files,
                last_feedback, fix_rounds, pr_head, pr_pushed_at, pr_feedback_at, ci_head, ci_status,
                files_owned, validate_mode, synthetic, cost_usd, agent_ms, created_at, updated_at)
                VALUES (@id, @run_id, @key, @title, @description, @acceptance, @depends_on, @parallel, @phase, @order_idx,
                @status, @attempt, @max_attempts, @merge_policy, @validate_cmd, @worktree, @branch, @pr_url, @session_id, @summary, @files,
                @last_feedback, @fix_rounds, @pr_head, @pr_pushed_at, @pr_feedback_at, @ci_head, @ci_status,
                @files_owned, @validate_mode, @synthetic, @cost_usd, @agent_ms, @created_at, @updated_at)`)
      .run({
        ...task,
        acceptance: JSON.stringify(task.acceptance),
        depends_on: JSON.stringify(task.depends_on),
        files: JSON.stringify(task.files),
        files_owned: JSON.stringify(task.files_owned),
        synthetic: task.synthetic ? 1 : 0,
      });
    return task;
  }
  getTask(id: string): Task | undefined {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return r ? rowToTask(r) : undefined;
  }
  getTaskByKey(runId: string, key: string): Task | undefined {
    const r = this.db.prepare("SELECT * FROM tasks WHERE run_id = ? AND key = ?").get(runId, key);
    return r ? rowToTask(r) : undefined;
  }
  listTasks(runId: string): Task[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE run_id = ? ORDER BY order_idx").all(runId) as any[]).map(rowToTask);
  }
  updateTask(id: string, patch: Partial<Task>) {
    const cols: string[] = [];
    const vals: any = { id, updated_at: now() };
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id") continue;
      cols.push(`${k} = @${k}`);
      vals[k] = Array.isArray(v) ? JSON.stringify(v) : typeof v === "boolean" ? (v ? 1 : 0) : v;
    }
    cols.push("updated_at = @updated_at");
    this.db.prepare(`UPDATE tasks SET ${cols.join(", ")} WHERE id = @id`).run(vals);
  }
  setTaskStatus(id: string, status: TaskStatus) {
    this.updateTask(id, { status });
  }
  deleteTasks(runId: string) {
    this.db.prepare("DELETE FROM tasks WHERE run_id = ?").run(runId);
  }

  // ---- phases ----
  /** The phase row for (run, name), created `pending` if missing. An existing row is returned unchanged. */
  upsertPhase(runId: string, name: string, idx: number): Phase {
    this.db
      .prepare(`INSERT INTO phases (run_id, name, idx, status, fixup_rounds, updated_at) VALUES (?, ?, ?, 'pending', 0, ?)
                ON CONFLICT(run_id, name) DO NOTHING`)
      .run(runId, name, idx, now());
    return this.db.prepare("SELECT * FROM phases WHERE run_id = ? AND name = ?").get(runId, name) as Phase;
  }
  getPhase(id: number): Phase | undefined {
    return this.db.prepare("SELECT * FROM phases WHERE id = ?").get(id) as Phase | undefined;
  }
  listPhases(runId: string): Phase[] {
    return this.db.prepare("SELECT * FROM phases WHERE run_id = ? ORDER BY idx, id").all(runId) as Phase[];
  }
  updatePhase(id: number, patch: Partial<Pick<Phase, "status" | "fixup_rounds" | "idx">>) {
    const cols: string[] = [];
    const vals: any = { id, updated_at: now() };
    for (const k of ["status", "fixup_rounds", "idx"] as const) {
      if (patch[k] === undefined) continue;
      cols.push(`${k} = @${k}`);
      vals[k] = patch[k];
    }
    cols.push("updated_at = @updated_at");
    this.db.prepare(`UPDATE phases SET ${cols.join(", ")} WHERE id = @id`).run(vals);
  }

  // ---- events ----
  addEvent(runId: string, taskId: string | null, kind: string, data: any): Event {
    const ts = now();
    const info = this.db
      .prepare("INSERT INTO events (run_id, task_id, ts, kind, data) VALUES (?, ?, ?, ?, ?)")
      .run(runId, taskId, ts, kind, JSON.stringify(data));
    return { id: Number(info.lastInsertRowid), run_id: runId, task_id: taskId, ts, kind, data };
  }
  listEvents(opts: { runId?: string; taskId?: string; afterId?: number; limit?: number }): Event[] {
    const where: string[] = [];
    const params: any[] = [];
    if (opts.runId) { where.push("run_id = ?"); params.push(opts.runId); }
    if (opts.taskId) { where.push("task_id = ?"); params.push(opts.taskId); }
    if (opts.afterId) { where.push("id > ?"); params.push(opts.afterId); }
    const sql = `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
    params.push(opts.limit ?? 500);
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToEvent).reverse();
  }

  // ---- event archive (§17) ----
  /** Finished, unarchived runs that last changed before `beforeIso` and still have events, oldest first. */
  listArchivableRuns(beforeIso: string): Run[] {
    return this.db
      .prepare(`SELECT * FROM runs WHERE status IN ('done','stopped','failed') AND archived_at IS NULL AND updated_at < ?
                AND EXISTS (SELECT 1 FROM events WHERE events.run_id = runs.id) ORDER BY updated_at`)
      .all(beforeIso) as Run[];
  }
  /**
   * A run's events in id order, read in pages so the connection is free between pages: a caller may
   * await (e.g. stream backpressure) while iterating without blocking other queries on this Store.
   */
  *iterateRunEvents(runId: string, pageSize = 500): Generator<Event> {
    const stmt = this.db.prepare("SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?");
    let after = 0;
    for (;;) {
      const rows = stmt.all(runId, after, pageSize) as any[];
      for (const r of rows) yield rowToEvent(r);
      if (rows.length < pageSize) return;
      after = rows[rows.length - 1].id;
    }
  }
  /** In one transaction: delete the run's events and set `archived_at`. Returns the number of events deleted. */
  deleteRunEventsAndMarkArchived(runId: string, ts: string = now()): number {
    return this.db.transaction(() => {
      const deleted = this.db.prepare("DELETE FROM events WHERE run_id = ?").run(runId).changes;
      this.db.prepare("UPDATE runs SET archived_at = ? WHERE id = ?").run(ts, runId);
      return deleted;
    })();
  }

  // ---- decisions ----
  addDecision(runId: string, taskId: string | null, actor: string, text: string, rationale: string | null): Decision {
    const ts = now();
    const info = this.db
      .prepare("INSERT INTO decisions (run_id, task_id, ts, actor, text, rationale) VALUES (?, ?, ?, ?, ?, ?)")
      .run(runId, taskId, ts, actor, text, rationale);
    return { id: Number(info.lastInsertRowid), run_id: runId, task_id: taskId, ts, actor, text, rationale };
  }
  listDecisions(runId: string): Decision[] {
    return this.db.prepare("SELECT * FROM decisions WHERE run_id = ? ORDER BY id").all(runId) as Decision[];
  }

  // ---- questions ----
  /** `taskId` null = a question about the whole plan (§14). */
  addQuestion(runId: string, taskId: string | null, text: string, options: string[]): Question {
    const ts = now();
    const info = this.db
      .prepare("INSERT INTO questions (run_id, task_id, ts, text, options) VALUES (?, ?, ?, ?, ?)")
      .run(runId, taskId, ts, text, JSON.stringify(options));
    return { id: Number(info.lastInsertRowid), run_id: runId, task_id: taskId, ts, text, options, answer: null, answered_at: null };
  }
  getQuestion(id: number): Question | undefined {
    const r = this.db.prepare("SELECT * FROM questions WHERE id = ?").get(id);
    return r ? rowToQuestion(r) : undefined;
  }
  listQuestions(runId: string, openOnly = false): Question[] {
    const sql = openOnly
      ? "SELECT * FROM questions WHERE run_id = ? AND answer IS NULL ORDER BY id"
      : "SELECT * FROM questions WHERE run_id = ? ORDER BY id";
    return (this.db.prepare(sql).all(runId) as any[]).map(rowToQuestion);
  }
  openQuestionsForTask(taskId: string): Question[] {
    return (this.db.prepare("SELECT * FROM questions WHERE task_id = ? AND answer IS NULL ORDER BY id").all(taskId) as any[]).map(rowToQuestion);
  }
  answerQuestion(id: number, answer: string) {
    this.db.prepare("UPDATE questions SET answer = ?, answered_at = ? WHERE id = ?").run(answer, now(), id);
  }
}
