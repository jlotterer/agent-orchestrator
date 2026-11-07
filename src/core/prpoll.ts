/**
 * What to do about a watched PR (architecture §12.2). Pure: the orchestrator fetches the PR
 * (`Git.prStatus`) and the local branch head, passes `now`, applies `patch`, and turns the
 * action into a `pr_action` transition (§8 T18). Fixtures: test/fixtures/pr-poll.json.
 */
import type { TaskStatus } from "../types.js";
import { freshFeedback, isTrigger, summarizeChecks, type Check, type ChecksSummary, type FeedbackItem, type PrStatus } from "../prfeedback.js";

export type PrActionName = "mark_done" | "mark_failed" | "fix_round" | "inbox" | "wait" | "merge";
export type FixKind = "ci" | "review";

export interface PrPollTask {
  key: string;
  status: TaskStatus;
  fix_rounds: number;
  pr_url: string | null;
  branch: string | null;
  pr_feedback_at: string | null;
  pr_pushed_at: string | null;
  updated_at: string;
  ci_head: string | null;
  ci_status: string | null;
}

export interface PrPollConfig {
  trigger: string;
  ignoreAuthors: string[];
  maxRounds: number;
  noChecksGraceSeconds: number;
  checksTimeoutMinutes: number;
}

export interface PrPollInput {
  task: PrPollTask;
  pr: PrStatus;
  /** Local branch head; null when unknown (then the PR head is trusted). */
  localSha: string | null;
  /** ISO-8601 time of the poll. */
  now: string;
  config: PrPollConfig;
}

export interface PrAction {
  action: PrActionName;
  kind?: FixKind;
  /** Human-readable why: decision rationale, inbox text or notification. */
  reason: string;
  patch?: Partial<{ pr_feedback_at: string; ci_status: ChecksSummary; ci_head: string }>;
  /** Review fix round: every fresh feedback item, oldest first. */
  items?: FeedbackItem[];
  /** CI fix round: the failed checks. */
  failedChecks?: Check[];
}

export function decidePrAction(input: PrPollInput): PrAction {
  const { task, pr, localSha, config } = input;
  const now = Date.parse(input.now);

  // 1–2. Terminal PR states win over everything else.
  if (pr.state === "MERGED") return { action: "mark_done", reason: `PR was merged on GitHub: ${pr.url}` };
  if (pr.state === "CLOSED") return { action: "mark_failed", reason: `PR was closed without merging: ${pr.url}` };

  // 3. Review feedback: a "changes requested" review or a trigger comment since the watermark.
  const fresh = freshFeedback(pr.feedback, task.pr_feedback_at, config.ignoreAuthors);
  const triggers = fresh.filter((i) => isTrigger(i, config.trigger));
  if (triggers.length) {
    const watermark = new Date(Math.max(...fresh.map((i) => Date.parse(i.ts)))).toISOString();
    const authors = [...new Set(triggers.map((i) => i.author))].join(", ");
    // All fresh human feedback goes to the worker, not only the trigger: it is the reviewer's full context.
    return { action: "fix_round", kind: "review", reason: `review feedback from ${authors}`, items: fresh, patch: { pr_feedback_at: watermark } };
  }

  // 4. Checks, only once GitHub reports them for the commit we pushed.
  const current = !localSha || pr.headSha === localSha;
  let summary: ChecksSummary = current ? summarizeChecks(pr.checks) : "pending";
  const sincePush = now - Date.parse(task.pr_pushed_at ?? task.updated_at);
  if (summary === "none" && sincePush < config.noChecksGraceSeconds * 1000) summary = "pending"; // CI may not have registered yet
  const patch: PrAction["patch"] = task.ci_status !== summary ? { ci_status: summary } : {};
  const out = (a: Omit<PrAction, "patch">, extra: PrAction["patch"] = {}): PrAction => {
    const p = { ...patch, ...extra };
    return Object.keys(p).length ? { ...a, patch: p } : a;
  };

  // 5. Pending.
  if (summary === "pending") {
    if (task.status === "pr_checks" && sincePush > config.checksTimeoutMinutes * 60_000) {
      return out({ action: "inbox", reason: `PR checks did not finish within ${config.checksTimeoutMinutes} minutes: ${pr.url}` });
    }
    return out({ action: "wait", reason: "PR checks pending" });
  }

  // 6. Failing: one CI fix round per head commit.
  if (summary === "fail") {
    const failed = pr.checks.filter((c) => c.state === "fail");
    const names = failed.map((c) => c.name).join(", ");
    if (task.ci_head === pr.headSha) {
      // Already acted on this commit's failure; only an auto task still waiting needs moving along.
      if (task.status === "pr_checks") return out({ action: "inbox", reason: `CI still failing on ${pr.headSha.slice(0, 10)}: ${names}` });
      return out({ action: "wait", reason: `CI failure on ${pr.headSha.slice(0, 10)} already handled` });
    }
    if (task.fix_rounds >= config.maxRounds) {
      return out({ action: "inbox", reason: `CI failing (${names}) and all ${config.maxRounds} fix rounds are used: ${pr.url}` }, { ci_head: pr.headSha });
    }
    return out({ action: "fix_round", kind: "ci", reason: `failed checks: ${names}`, failedChecks: failed }, { ci_head: pr.headSha });
  }

  // 7. Pass / none: auto tasks merge now; manual tasks stay with the owner (the inbox shows CI status).
  if (task.status !== "pr_checks") return out({ action: "wait", reason: "waiting for the owner to merge" });
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    return out({ action: "inbox", reason: `Checks pass, but a reviewer's "changes requested" is still open on ${pr.url}. Merge once you're satisfied.` });
  }
  return out({ action: "merge", reason: summary === "none" ? "PR checks passed (no checks configured on the PR)" : `PR checks passed (${pr.checks.length} checks)` });
}
