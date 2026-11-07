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
  | "pr_open"        // validated, PR open, merge policy manual
  | "failed"         // retries exhausted or hard error; needs human
  | "done"
  | "skipped";

export type MergePolicy = "auto" | "manual";

export interface Run {
  id: string;
  spec_dir: string;
  title: string;
  status: RunStatus;
  base_branch: string;
  created_at: string;
  updated_at: string;
  notes: string | null;
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
  session_id: string | null;   // worker's claude session id (for --resume)
  summary: string | null;      // worker's final summary (used in hand-offs)
  files: string[];             // files the worker reported touching
  last_feedback: string | null;
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
  task_id: string;
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
