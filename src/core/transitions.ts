/**
 * The task state machine (architecture §8). Pure: the orchestrator ("shell") applies `patch`,
 * records `decision`, sends `notify` and performs `effect` in order. Values produced by an effect
 * (pr_url, pr_head, pr_pushed_at, pr_feedback_at, a new branch/worktree) are written by the shell
 * after the effect succeeds; if a merge effect fails, the shell sends `merge_failed` (T9) instead.
 * Fixtures: test/fixtures/transitions.json.
 */
import type { MergePolicy, TaskStatus } from "../types.js";
import type { PrActionName, FixKind } from "./prpoll.js";

export interface TransitionTask {
  key: string;
  status: TaskStatus;
  attempt: number;
  max_attempts: number;
  fix_rounds: number;
  merge_policy: MergePolicy;
  branch: string | null;
  worktree: string | null;
  pr_url: string | null;
  pr_head: string | null;
  last_feedback: string | null;
  synthetic?: boolean;
}

export interface TransitionConfig {
  /** PR mode (git.pr) vs local merges. */
  pr: boolean;
  feedback: { enabled: boolean; waitForChecks: boolean; maxRounds: number };
}

export type TaskEvent =
  | { type: "start" }
  | { type: "worker_blocked" }
  | { type: "attempt_failed"; feedback: string }
  | { type: "worker_done" }
  | { type: "validated"; branchSha: string | null }
  | { type: "merge_failed"; error: string }
  | { type: "answered"; openQuestions: number; runStatus: string }
  | { type: "human_retry" }
  | { type: "human_skip" }
  | { type: "human_stop" }
  | { type: "run_stop" }
  | { type: "daemon_restart" }
  | { type: "human_merge" }
  | { type: "human_mark_merged" }
  | { type: "human_request_changes"; feedback: string }
  | { type: "pr_action"; action: PrActionName; kind?: FixKind; feedback?: string; reason?: string };

export type Effect = "merge_local" | "push_and_pr" | "merge_pr" | "kill_agent" | "remove_worktree";

export type TaskPatch = Partial<{
  status: TaskStatus;
  attempt: number;
  fix_rounds: number;
  last_feedback: string | null;
  ci_status: string | null;
  ci_head: string | null;
  worktree: string | null;
}>;

export interface TransitionResult {
  status: TaskStatus;
  /** Field changes decided by the transition (status excluded; it is in `status`). */
  patch?: TaskPatch;
  decision?: { actor: "orchestrator" | "human"; text: string; rationale: string | null };
  notify?: { title: string; body: string; priority?: "high"; tags?: string[] };
  /** Ordered side effects the shell performs before applying the result. */
  effect?: Effect[];
  /** The event is not allowed from the current state; nothing changes. */
  rejected?: boolean;
  /** Why the event was rejected (for API errors). */
  reason?: string;
}

const ACTIVE: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["running", "validating"]);
const WATCHED: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["pr_checks", "pr_open"]);

function reject(task: TransitionTask, reason: string): TransitionResult {
  return { status: task.status, rejected: true, reason };
}

/** Done, removing the worktree first when there is one. */
function finish(task: TransitionTask, before: Effect[], extra: TaskPatch = {}): TransitionResult {
  const effect = [...before];
  const patch: TaskPatch = { ...extra };
  if (task.worktree) { effect.push("remove_worktree"); patch.worktree = null; }
  return { status: "done", ...(Object.keys(patch).length ? { patch } : {}), ...(effect.length ? { effect } : {}) };
}

/** Park the task with the owner (pr_open + notify). Idempotent for the same message. */
function toInbox(task: TransitionTask, feedback: string): TransitionResult {
  if (task.status === "pr_open" && task.last_feedback === feedback) return { status: "pr_open" };
  return {
    status: "pr_open",
    patch: { last_feedback: feedback },
    notify: { title: `${task.key}: PR needs you`, body: feedback, priority: "high", tags: ["warning"] },
  };
}

const firstLine = (s: string, max = 200) => {
  const l = s.split("\n")[0];
  return l.length > max ? l.slice(0, max) : l;
};

export function nextTaskState(task: TransitionTask, event: TaskEvent, cfg: TransitionConfig): TransitionResult {
  const active = ACTIVE.has(task.status);
  switch (event.type) {
    // T1
    case "start":
      if (task.status !== "pending") return reject(task, `task is ${task.status}, not pending`);
      return { status: "running", patch: { attempt: task.attempt + 1 } };

    // T2
    case "worker_blocked":
      if (task.status !== "running") return reject(task, `task is ${task.status}, not running`);
      return { status: "needs_input", notify: { title: `${task.key} needs your input`, body: "Worker blocked", priority: "high", tags: ["question"] } };

    // T3 / T4
    case "attempt_failed": {
      if (!active) return reject(task, `task is ${task.status}, not active`);
      const patch = { last_feedback: event.feedback };
      if (task.attempt < task.max_attempts) {
        return {
          status: "pending", patch,
          decision: { actor: "orchestrator", text: `Retrying ${task.key} (attempt ${task.attempt + 1}/${task.max_attempts})`, rationale: firstLine(event.feedback) },
        };
      }
      return { status: "failed", patch, notify: { title: `${task.key} failed`, body: event.feedback, priority: "high", tags: ["x"] } };
    }

    // T5
    case "worker_done":
      if (task.status !== "running") return reject(task, `task is ${task.status}, not running`);
      return { status: "validating" };

    // T6 / T7 / T8 / T8a
    case "validated": {
      if (task.status !== "validating") return reject(task, `task is ${task.status}, not validating`);
      const ready = { title: `${task.key} ready for review`, body: task.branch ? `branch ${task.branch}` : "", tags: ["eyes"] };
      if (!cfg.pr) {
        if (task.merge_policy === "manual") return { status: "pr_open", notify: ready };
        return finish(task, ["merge_local"]);
      }
      // T8a: a fix round that pushed nothing new re-runs the same CI / ignores the reviewer. The owner decides.
      if (task.fix_rounds > 0 && !!event.branchSha && event.branchSha === task.pr_head) {
        const feedback = `Fix round ${task.fix_rounds} produced no new commits.\n\n${task.last_feedback ?? ""}`;
        return {
          status: "pr_open", effect: ["push_and_pr"], patch: { ci_status: null, last_feedback: feedback },
          notify: { title: `${task.key}: PR needs you`, body: feedback, priority: "high", tags: ["warning"] },
        };
      }
      if (task.merge_policy === "manual") return { status: "pr_open", effect: ["push_and_pr"], patch: { ci_status: null }, notify: ready };
      if (cfg.feedback.enabled && cfg.feedback.waitForChecks) return { status: "pr_checks", effect: ["push_and_pr"], patch: { ci_status: null } };
      return finish(task, ["push_and_pr", "merge_pr"], { ci_status: null });
    }

    // T9
    case "merge_failed": {
      if (task.status !== "validating" && task.status !== "pr_checks") return reject(task, `task is ${task.status}; no merge step to fail`);
      const feedback = `Merge step failed: ${event.error}`;
      return { status: "pr_open", patch: { last_feedback: feedback }, notify: { title: `${task.key}: merge needs you`, body: event.error, priority: "high", tags: ["warning"] } };
    }

    // T10 / T11
    case "answered":
      if (task.status !== "needs_input") return reject(task, `task is ${task.status}, not needs_input`);
      if (event.openQuestions > 0) return { status: "needs_input" };
      return { status: event.runStatus === "running" ? "running" : "pending" };

    // T12
    case "human_retry":
      if (active) return reject(task, "task is active");
      return {
        status: "pending", patch: { attempt: 0, fix_rounds: 0, ci_head: null, ci_status: null },
        decision: { actor: "human", text: `Retry requested for ${task.key}`, rationale: null },
      };

    // T13
    case "human_skip": {
      if (active) return reject(task, "task is active; stop it first");
      const decision = { actor: "human" as const, text: `Skipped ${task.key}`, rationale: null };
      if (!task.worktree) return { status: "skipped", decision };
      return { status: "skipped", patch: { worktree: null }, effect: ["remove_worktree"], decision };
    }

    // T14
    case "human_stop":
    case "run_stop":
    case "daemon_restart": {
      if (!active) return reject(task, `task is ${task.status}, not active`);
      if (event.type === "daemon_restart") return { status: "pending" };
      if (event.type === "run_stop") return { status: "pending", effect: ["kill_agent"] };
      return { status: "pending", effect: ["kill_agent"], decision: { actor: "human", text: `Stopped ${task.key}`, rationale: null } };
    }

    // T15
    case "human_merge": {
      if (!WATCHED.has(task.status)) return reject(task, `task is ${task.status}, not pr_open`);
      const r = finish(task, [cfg.pr ? "merge_pr" : "merge_local"]);
      return { ...r, decision: { actor: "human", text: `Approved merge of ${task.key}`, rationale: null } };
    }

    // T16
    case "human_mark_merged": {
      const r = finish(task, []);
      return { ...r, decision: { actor: "human", text: `Marked ${task.key} as merged externally`, rationale: null } };
    }

    // T17: the owner sends the task back with written feedback. A fix round of kind `human`
    // (§12.3): same budget reset as T18's fix_round, but the round cap does not apply.
    case "human_request_changes": {
      if (!WATCHED.has(task.status)) return reject(task, `task is ${task.status}, not awaiting review`);
      const text = event.feedback.trim();
      if (!text) return reject(task, "feedback is empty");
      const round = task.fix_rounds + 1;
      const where = task.pr_url ? `${task.key}'s PR` : task.key;
      return {
        status: "pending",
        patch: { attempt: 0, fix_rounds: round, last_feedback: `## Feedback from the owner\n\n${text}`, ci_status: null },
        decision: { actor: "human", text: `Sending owner feedback on ${where} back to the worker (round ${round})`, rationale: firstLine(text) },
      };
    }

    // T18
    case "pr_action":
      if (!WATCHED.has(task.status)) return reject(task, `task is ${task.status}; its PR is not watched`);
      return prAction(task, event, cfg);
  }
}

function prAction(task: TransitionTask, event: Extract<TaskEvent, { type: "pr_action" }>, cfg: TransitionConfig): TransitionResult {
  const feedback = event.feedback ?? event.reason ?? "";
  switch (event.action) {
    case "wait":
      return { status: task.status };
    case "mark_done": {
      const r = finish(task, []);
      return { ...r, decision: { actor: "orchestrator", text: `${task.key}: PR was merged on GitHub; marking done`, rationale: task.pr_url } };
    }
    case "mark_failed":
      return { status: "failed", patch: { last_feedback: feedback }, notify: { title: `${task.key}: PR closed`, body: task.pr_url ?? feedback, priority: "high", tags: ["x"] } };
    case "inbox":
      return toInbox(task, feedback);
    case "merge": {
      const r = finish(task, ["merge_pr"]);
      return { ...r, decision: { actor: "orchestrator", text: `Merging ${task.key}: PR checks passed`, rationale: event.reason ?? null } };
    }
    case "fix_round": {
      const max = cfg.feedback.maxRounds;
      const round = task.fix_rounds + 1;
      const what = event.kind === "ci" ? "CI failure" : "review feedback";
      if (round > max) return toInbox(task, `New ${what}, but all ${max} fix rounds are used.\n\n${feedback}`);
      // attempt resets so validation retries inside the round get the full budget; fix_rounds caps the rounds.
      return {
        status: "pending",
        patch: { attempt: 0, fix_rounds: round, last_feedback: feedback, ci_status: null },
        decision: { actor: "orchestrator", text: `Sending ${what} on ${task.key}'s PR back to the worker (round ${round}/${max})`, rationale: event.reason ?? null },
      };
    }
  }
}
