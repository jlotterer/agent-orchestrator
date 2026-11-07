import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Run, Task, Event, Decision, Question, TaskStatus, RunStatus } from "./types.js";

const SCHEMA = `
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

const now = () => new Date().toISOString();

function rowToTask(r: any): Task {
  return {
    ...r,
    acceptance: JSON.parse(r.acceptance),
    depends_on: JSON.parse(r.depends_on),
    files: JSON.parse(r.files),
  };
}
function rowToEvent(r: any): Event {
  return { ...r, data: JSON.parse(r.data) };
}
function rowToQuestion(r: any): Question {
  return { ...r, options: JSON.parse(r.options) };
}

export class Store {
  db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  // ---- runs ----
  createRun(specDir: string, title: string, baseBranch: string, status: RunStatus = "planning"): Run {
    const run: Run = {
      id: crypto.randomUUID().slice(0, 8),
      spec_dir: specDir,
      title,
      status,
      base_branch: baseBranch,
      created_at: now(),
      updated_at: now(),
      notes: null,
    };
    this.db
      .prepare(`INSERT INTO runs (id, spec_dir, title, status, base_branch, created_at, updated_at, notes)
                VALUES (@id, @spec_dir, @title, @status, @base_branch, @created_at, @updated_at, @notes)`)
      .run(run);
    return run;
  }
  getRun(id: string): Run | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Run | undefined;
  }
  listRuns(): Run[] {
    return this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC").all() as Run[];
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
  setRunNotes(id: string, notes: string) {
    this.db.prepare("UPDATE runs SET notes = ?, updated_at = ? WHERE id = ?").run(notes, now(), id);
  }

  // ---- tasks ----
  insertTask(t: Omit<Task, "id" | "created_at" | "updated_at">): Task {
    const task: Task = { ...t, id: crypto.randomUUID().slice(0, 8), created_at: now(), updated_at: now() };
    this.db
      .prepare(`INSERT INTO tasks (id, run_id, key, title, description, acceptance, depends_on, parallel, phase, order_idx,
                status, attempt, max_attempts, merge_policy, validate_cmd, worktree, branch, pr_url, session_id, summary, files,
                last_feedback, created_at, updated_at)
                VALUES (@id, @run_id, @key, @title, @description, @acceptance, @depends_on, @parallel, @phase, @order_idx,
                @status, @attempt, @max_attempts, @merge_policy, @validate_cmd, @worktree, @branch, @pr_url, @session_id, @summary, @files,
                @last_feedback, @created_at, @updated_at)`)
      .run({
        ...task,
        acceptance: JSON.stringify(task.acceptance),
        depends_on: JSON.stringify(task.depends_on),
        files: JSON.stringify(task.files),
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
      vals[k] = Array.isArray(v) ? JSON.stringify(v) : v;
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
  addQuestion(runId: string, taskId: string, text: string, options: string[]): Question {
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
