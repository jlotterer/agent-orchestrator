export type RunStatus =
  | "planning"
  | "plan_pending"   // plan drafted, waiting for human approval
  | "ready"          // approved, not started
  | "running"
  | "paused"
  | "done"
  | "stopped"
  | "failed";

export type TaskStatus =
  | "pending"        // waiting on dependencies or scheduler
  | "running"        // worker active
  | "validating"     // validator active
  | "needs_input"    // worker asked a question; waiting on human
  | "pr_checks"      // validated, PR open, auto-merge waiting on CI checks
  | "pr_open"        // validated, PR open, waiting on a human (manual policy, merge error, CI stuck)
  | "failed"         // retries exhausted or hard error; needs human
  | "done"
  | "skipped";

export type MergePolicy = "auto" | "manual";

export type ValidateMode = "standard" | "ui";

/** Phase validation state (architecture §10.3). Schema TASK-07, used by TASK-15. */
export type PhaseStatus = "pending" | "validating" | "passed" | "failed" | "needs_human";

/** A registered repository (architecture §5.3). */
export interface Project {
  id: string;                  // slug of the repo directory name, `-2`, `-3`… on collision
  name: string;
  repo_path: string;           // realpath of the repo root; unique
  archived: boolean;
  last_start_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One phase of a run (architecture §10.3), UNIQUE(run_id, name). */
export interface Phase {
  id: number;
  run_id: string;
  name: string;
  idx: number;
  status: PhaseStatus;
  fixup_rounds: number;
  updated_at: string;
}

export interface Run {
  id: string;
  project_id: string | null;   // null only for runs from before projects existed (until upgraded, §5.5)
  spec_dir: string;
  title: string;
  status: RunStatus;
  base_branch: string;
  created_at: string;
  updated_at: string;
  notes: string | null;
  cost_usd: number | null;     // planner + phase-validator spend (§18); NULL = unknown
  agent_ms: number | null;
  archived_at: string | null;  // when the run's events were archived (§17)
}

export interface Task {
  id: string;
  run_id: string;
  key: string;              // e.g. T001
  title: string;
  description: string;
  acceptance: string[];     // acceptance criteria
  depends_on: string[];     // task keys
  parallel: number;         // 1 if Spec Kit marked [P]
  phase: string | null;
  order_idx: number;
  status: TaskStatus;
  attempt: number;
  max_attempts: number;
  merge_policy: MergePolicy;
  validate_cmd: string | null;
  worktree: string | null;
  branch: string | null;
  pr_url: string | null;
  session_id: string | null;   // worker's agent CLI session id (for resume)
  summary: string | null;      // worker's final summary (used in hand-offs)
  files: string[];             // files the worker reported touching
  last_feedback: string | null;
  fix_rounds: number;          // PR feedback rounds used (CI failures / review comments)
  pr_head: string | null;      // sha last pushed to the PR
  pr_pushed_at: string | null; // when we last pushed to the PR
  pr_feedback_at: string | null; // newest PR comment/review already consumed (watermark)
  ci_head: string | null;      // sha whose CI failure was already acted on
  ci_status: string | null;    // pass | fail | pending | none (last poll)
  files_owned: string[];       // files/globs the planner assigned to this task (§7.2)
  validate_mode: ValidateMode;
  synthetic: boolean;          // orch-created phase fix-up task (§10.3); stored as 0/1
  cost_usd: number | null;     // worker + validator spend (§18); NULL = unknown
  agent_ms: number | null;
  created_at: string;
  updated_at: string;
}

export interface Event {
  id: number;
  run_id: string;
  task_id: string | null;
  ts: string;
  kind: string;               // state | agent | tool | text | git | error | info
  data: any;
}

export interface Decision {
  id: number;
  run_id: string;
  task_id: string | null;
  ts: string;
  actor: string;              // orchestrator | worker | validator | planner | human
  text: string;
  rationale: string | null;
}

export interface Question {
  id: number;
  run_id: string;
  task_id: string | null;     // null = a question about the whole plan
  ts: string;
  text: string;
  options: string[];
  answer: string | null;
  answered_at: string | null;
}

export interface AgentResult {
  ok: boolean;
  text: string;               // final assistant text
  sessionId: string | null;
  isError: boolean;
  costUsd: number | null;
  durationMs: number;
  structured: any | null;     // parsed JSON block from the final message, if any
}
