/**
 * PR feedback loop (roadmap R1): pure helpers that turn `gh` JSON into check verdicts and
 * review feedback, and format both as worker feedback. No I/O here; see Git.prStatus().
 */

export type CheckState = "pass" | "fail" | "pending";
export interface Check { name: string; state: CheckState; conclusion: string; url: string | null; jobId: string | null }
export type ChecksSummary = "pass" | "fail" | "pending" | "none";

export interface FeedbackItem {
  kind: "review" | "comment" | "inline";
  author: string;
  body: string;
  ts: string;
  /** Review state (CHANGES_REQUESTED, APPROVED, COMMENTED) for kind=review. */
  state?: string;
  /** File and line for kind=inline. */
  path?: string;
  line?: number | null;
  isBot?: boolean;
}

export interface PrStatus {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  headSha: string;
  reviewDecision: string;
  checks: Check[];
  feedback: FeedbackItem[];
}

const PASS_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/** Normalize `statusCheckRollup` (CheckRun and StatusContext entries). */
export function normalizeChecks(rollup: any[] | null | undefined): Check[] {
  const out: Check[] = [];
  for (const c of rollup ?? []) {
    if (!c || typeof c !== "object") continue;
    if (c.__typename === "StatusContext" || ("context" in c && !("conclusion" in c))) {
      const s = String(c.state ?? "").toUpperCase();
      out.push({
        name: String(c.context ?? "status"), conclusion: s, url: c.targetUrl ?? null, jobId: null,
        state: s === "SUCCESS" ? "pass" : s === "PENDING" || s === "EXPECTED" || !s ? "pending" : "fail",
      });
    } else {
      const status = String(c.status ?? "").toUpperCase();
      const conclusion = String(c.conclusion ?? "").toUpperCase();
      const url: string | null = c.detailsUrl ?? null;
      const name = c.workflowName && c.name && c.workflowName !== c.name ? `${c.workflowName} / ${c.name}` : String(c.name ?? c.workflowName ?? "check");
      out.push({
        name, conclusion: conclusion || status, url, jobId: url?.match(/\/actions\/runs\/\d+\/job\/(\d+)/)?.[1] ?? null,
        state: status !== "COMPLETED" ? "pending" : PASS_CONCLUSIONS.has(conclusion) ? "pass" : "fail",
      });
    }
  }
  return out;
}

/** Any failure wins over pending: there's no point waiting for the rest once one check is red. */
export function summarizeChecks(checks: Check[]): ChecksSummary {
  if (!checks.length) return "none";
  if (checks.some((c) => c.state === "fail")) return "fail";
  if (checks.some((c) => c.state === "pending")) return "pending";
  return "pass";
}

/** Flatten reviews, conversation comments (from `gh pr view`) and inline comments (REST) into one list. */
export function collectFeedback(view: any, inline: any[]): FeedbackItem[] {
  const items: FeedbackItem[] = [];
  for (const r of view?.reviews ?? []) {
    items.push({ kind: "review", author: r.author?.login ?? "?", body: String(r.body ?? ""), ts: r.submittedAt ?? "", state: String(r.state ?? "").toUpperCase() });
  }
  for (const c of view?.comments ?? []) {
    items.push({ kind: "comment", author: c.author?.login ?? "?", body: String(c.body ?? ""), ts: c.createdAt ?? "" });
  }
  for (const c of inline ?? []) {
    items.push({
      kind: "inline", author: c.user?.login ?? "?", body: String(c.body ?? ""), ts: c.created_at ?? "",
      path: c.path, line: c.line ?? c.original_line ?? null, isBot: c.user?.type === "Bot",
    });
  }
  return items.filter((i) => i.ts).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

export function isIgnoredAuthor(item: FeedbackItem, ignore: string[]): boolean {
  const a = item.author.toLowerCase();
  return !!item.isBot || a.endsWith("[bot]") || ignore.some((x) => x.toLowerCase() === a);
}

/** Items newer than the watermark, not from ignored authors, with content (an empty COMMENTED review is noise). */
export function freshFeedback(items: FeedbackItem[], sinceIso: string | null, ignore: string[]): FeedbackItem[] {
  const since = sinceIso ? Date.parse(sinceIso) : 0;
  return items.filter((i) => Date.parse(i.ts) > since && !isIgnoredAuthor(i, ignore) && (i.body.trim() || i.state === "CHANGES_REQUESTED"));
}

/** Does this item ask orch to act? A "changes requested" review, or a comment line starting with the trigger. */
export function isTrigger(item: FeedbackItem, trigger: string): boolean {
  if (item.kind === "review" && item.state === "CHANGES_REQUESTED") return true;
  if (!trigger.trim()) return false;
  const esc = trigger.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*${esc}(\\s|$)`, "m").test(item.body);
}

const NO_PUSH = "Fix it in this worktree, run the tests, and commit. Do not push or touch the PR; the orchestrator re-validates and updates it.";

export function formatReviewFeedback(items: FeedbackItem[], prUrl: string, round: number, maxRounds: number): string {
  const lines = items.map((i) => {
    const where = i.kind === "inline" ? ` on \`${i.path}${i.line ? `:${i.line}` : ""}\`` : "";
    const what = i.kind === "review" ? (i.state === "CHANGES_REQUESTED" ? " requested changes" : " reviewed") : " commented";
    const body = i.body.trim() ? `\n  ${i.body.trim().replace(/\n/g, "\n  ")}` : "";
    return `- **${i.author}**${what}${where}:${body || " (no text)"}`;
  });
  return `## Review feedback on the pull request (round ${round}/${maxRounds})\nPR: ${prUrl}\nAddress every point below. ${NO_PUSH}\n\n${lines.join("\n")}`;
}

export function formatCiFeedback(failed: Check[], logs: Record<string, string>, prUrl: string, sha: string, round: number, maxRounds: number): string {
  const list = failed.map((c) => `- ${c.name}: ${c.conclusion}${c.url ? ` (${c.url})` : ""}`).join("\n");
  const excerpts = failed.filter((c) => logs[c.name]).map((c) => `### Log excerpt: ${c.name}\n\`\`\`\n${logs[c.name]}\n\`\`\``).join("\n\n");
  return `## CI failed on the pull request (round ${round}/${maxRounds})\nPR: ${prUrl} at ${sha.slice(0, 10)}\n${NO_PUSH}\n\nFailed checks:\n${list}${excerpts ? `\n\n${excerpts}` : "\n\n(no log available; reproduce locally with the project's test command)"}`;
}

/** Keep the end of a log: CI errors are usually at the bottom. */
export function tail(s: string, max: number): string {
  if (s.length <= max) return s;
  return `… (${s.length - max} earlier chars omitted)\n` + s.slice(s.length - max);
}
