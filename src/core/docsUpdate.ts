/**
 * The "Update project docs" inbox item of a finished run (REQ-HITL-08, architecture §14). Pure: built from
 * stored facts (tasks, their briefs' text, decisions), no LLM, no I/O. Its plain text is the input of the
 * `orch-spec` skill's fold-back mode.
 */
import type { Decision, Run, Task } from "../types.js";
import { parseBrief } from "./brief.js";

/** The summary orch gives a task that `tasks.md` already ticked at import: it was not merged by this run. */
export const ALREADY_COMPLETE_SUMMARY = "(already complete before this run)";

/** Actors whose decisions are listed: the agents' own choices. Orchestrator bookkeeping and verdicts are not. */
const DECISION_ACTORS = ["planner", "worker"];

export interface DocsUpdate {
  /** The run's feature folder (as the orchestrator passes it: relative to the repo when possible). */
  feature: string;
  /** REQ IDs cited by merged tasks; `notMerged` = tasks of the run citing it that did not merge, with their status. */
  reqs: { id: string; tasks: string[]; notMerged: { task: string; status: string }[] }[];
  /** Planner and worker decisions of the run, in order. */
  decisions: { actor: string; task: string | null; text: string; rationale: string | null }[];
  /** The owner's dashboard edits to tasks of the run (REQ-INTAKE-09), in order. */
  planEdits: { task: string | null; text: string; detail: string | null }[];
  /** Contracts named by merged tasks' briefs. */
  contracts: { name: string; tasks: string[] }[];
}

/** A task as `buildDocsUpdate` needs it: the row plus its brief's text (null without a brief). */
export type DocsTask = Pick<Task, "id" | "key" | "status" | "summary" | "acceptance"> & { brief: string | null };

const REQ_ID = /\bREQ-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+\b/g;

/** True when this run merged the task (done, and not ticked in `tasks.md` before the run). */
export function mergedInRun(t: Pick<Task, "status" | "summary">): boolean {
  return t.status === "done" && t.summary !== ALREADY_COMPLETE_SUMMARY;
}

/** The REQ IDs a task cites: its brief's `covers`, else `REQ-…` IDs found in its acceptance criteria. */
export function taskCites(t: DocsTask): string[] {
  const brief = t.brief !== null ? parseBrief(t.key, t.brief) : null;
  if (brief?.supported && brief.cites.length) return brief.cites;
  const out: string[] = [];
  for (const c of t.acceptance) for (const m of c.match(REQ_ID) ?? []) if (!out.includes(m)) out.push(m);
  return out;
}

function taskContracts(t: DocsTask): string[] {
  const brief = t.brief !== null ? parseBrief(t.key, t.brief) : null;
  return brief?.supported && brief.contracts ? [...new Set(brief.contracts.map((c) => c.name))] : [];
}

/**
 * The four lists of a finished run, or null when no task merged in it (an all-skipped run gets no item).
 * `decisions` are the run's decisions (only planner and worker ones are listed); `humanEdits` are the owner's
 * "Edited task …" decisions on tasks of the run.
 */
export function buildDocsUpdate(run: Pick<Run, "spec_dir">, tasks: DocsTask[], decisions: Decision[], humanEdits: Decision[]): DocsUpdate | null {
  const merged = tasks.filter(mergedInRun);
  if (!merged.length) return null;
  const keyOf = new Map(tasks.map((t) => [t.id, t.key]));

  const reqs = new Map<string, DocsUpdate["reqs"][number]>();
  for (const t of merged) for (const id of taskCites(t)) {
    if (!reqs.has(id)) reqs.set(id, { id, tasks: [], notMerged: [] });
    reqs.get(id)!.tasks.push(t.key);
  }
  for (const t of tasks) {
    if (merged.includes(t) || t.summary === ALREADY_COMPLETE_SUMMARY) continue;
    for (const id of taskCites(t)) reqs.get(id)?.notMerged.push({ task: t.key, status: t.status });
  }

  const contracts = new Map<string, string[]>();
  for (const t of merged) for (const name of taskContracts(t)) contracts.set(name, [...(contracts.get(name) ?? []), t.key]);

  return {
    feature: run.spec_dir,
    reqs: [...reqs.values()],
    decisions: decisions
      .filter((d) => DECISION_ACTORS.includes(d.actor))
      .map((d) => ({ actor: d.actor, task: d.task_id ? keyOf.get(d.task_id) ?? null : null, text: d.text, rationale: d.rationale })),
    planEdits: humanEdits.map((d) => ({ task: d.task_id ? keyOf.get(d.task_id) ?? null : null, text: d.text, detail: d.rationale })),
    contracts: [...contracts].map(([name, keys]) => ({ name, tasks: keys })),
  };
}

/** The item's title, also the notification title (before ntfy's `[<project>] ` prefix). */
export function docsUpdateTitle(projectName: string, runTitle: string): string {
  return `Update project docs: ${projectName} ${runTitle}`;
}

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();

/**
 * The plain text the dashboard's Copy button and `orch docs-update` give, in the shape the skill's fold-back
 * mode reads: the title line, the feature folder, then `## REQ IDs`, `## Decisions`, `## Plan edits`,
 * `## Contracts`, one `- ` item per line, `none` for an empty list.
 */
export function docsUpdateText(projectName: string, runTitle: string, u: DocsUpdate): string {
  const out = [docsUpdateTitle(projectName, runTitle), `Feature folder: ${u.feature}`];
  const list = (heading: string, items: string[]) => {
    out.push("", `## ${heading}`);
    if (!items.length) out.push("none");
    for (const i of items) out.push(`- ${oneLine(i)}`);
  };
  list("REQ IDs", u.reqs.map((r) => `${r.id} (${r.tasks.join(", ")}${r.notMerged.length ? `; not merged: ${r.notMerged.map((n) => `${n.task} ${n.status}`).join(", ")}` : ""})`));
  list("Decisions", u.decisions.map((d) => `${d.actor}${d.task ? ` ${d.task}` : ""}: ${d.text}${d.rationale ? ` — why: ${d.rationale}` : ""}`));
  list("Plan edits", u.planEdits.map((e) => `${e.task ?? "plan"}: ${e.detail ?? e.text}`));
  list("Contracts", u.contracts.map((c) => `${c.name} (${c.tasks.join(", ")})`));
  return out.join("\n") + "\n";
}
