/**
 * Phase validation decisions (architecture §10.3, decision 0015): which phase is validated next, and what
 * a failed phase validation adds to the plan. Pure: no I/O, no clock; the orchestrator gathers the facts.
 * Fixtures: test/fixtures/phases.json.
 */
import type { PhaseStatus, TaskStatus } from "../types.js";

/** Phase name of tasks before any heading (`tasks.phase` NULL); phase rows need a name. */
export const NO_PHASE = "";

/** The phase row name of a task's `phase` column. */
export function phaseName(phase: string | null): string {
  return phase ?? NO_PHASE;
}
/** How a phase is named in decisions, notifications and prompts. */
export function phaseLabel(name: string): string {
  return name === NO_PHASE ? "(no phase)" : name;
}

export interface PhaseTaskFact {
  key: string;
  phase: string | null;
  status: TaskStatus;
  orderIdx: number;
}

export interface PhaseFact {
  id: number;
  name: string;
  idx: number;
  status: PhaseStatus;
  fixup_rounds: number;
}

export interface PhaseDue {
  phaseId: number;
  name: string;
  /** `validate`: run the phase command and the phase validator. `pass`: nothing to validate (every task skipped). */
  action: "validate" | "pass";
  reason: string;
}

const FINISHED: ReadonlySet<string> = new Set(["done", "skipped"]);

/** The run's phases in plan order (first task's `orderIdx`), numbered from 1. */
export function phaseList(tasks: PhaseTaskFact[]): { name: string; idx: number }[] {
  const names: string[] = [];
  for (const t of [...tasks].sort((a, b) => a.orderIdx - b.orderIdx)) {
    const n = phaseName(t.phase);
    if (!names.includes(n)) names.push(n);
  }
  return names.map((name, i) => ({ name, idx: i + 1 }));
}

/**
 * Phases to act on now, in order. Phases are validated one at a time in `idx` order: walking the rows,
 * a `passed` phase is skipped over, and the first phase that is not `pending` (validating, failed,
 * needs_human) stops the walk. A `pending` phase is due when it has tasks, all of them (fix-ups included)
 * are done or skipped and at least one is done (`validate`). When all its tasks were skipped there is
 * nothing to validate (`pass`) and the walk continues with the next phase. Anything else stops the walk.
 */
export function phasesToValidate(tasks: PhaseTaskFact[], phases: PhaseFact[]): PhaseDue[] {
  const due: PhaseDue[] = [];
  for (const p of [...phases].sort((a, b) => a.idx - b.idx || a.id - b.id)) {
    if (p.status === "passed") continue;
    if (p.status !== "pending") break;
    const own = tasks.filter((t) => phaseName(t.phase) === p.name);
    if (!own.length) {
      due.push({ phaseId: p.id, name: p.name, action: "pass", reason: "the phase has no tasks" });
      continue;
    }
    if (!own.every((t) => FINISHED.has(t.status))) break;
    if (!own.some((t) => t.status === "done")) {
      due.push({ phaseId: p.id, name: p.name, action: "pass", reason: "every task of the phase was skipped" });
      continue;
    }
    due.push({ phaseId: p.id, name: p.name, action: "validate", reason: `all ${own.length} tasks are done or skipped` });
    break;
  }
  return due;
}

/** The outcome of one phase validation, as the fix-up task needs it. */
export interface PhaseVerdict {
  verdict: "PASS" | "FAIL";
  /** One-paragraph failure: the failed command and its output, or the phase validator's verdict line. */
  failure: string;
  reasons: string[];
  /** Criteria the phase validator found unmet. */
  unmet: string[];
  suggestions: string[];
}

export interface FixupPhase {
  name: string;
  idx: number;
  /** Highest `orderIdx` among the phase's tasks (fix-ups included); the fix-up goes right after it. */
  lastOrderIdx: number;
}

export interface LaterTask {
  key: string;
  orderIdx: number;
  status: TaskStatus;
  dependsOn: string[];
}

export interface FixupPlan {
  task: {
    key: string;
    title: string;
    description: string;
    acceptance: string[];
    phase: string | null;
    orderIdx: number;
    dependsOn: string[];
    mergePolicy: "auto";
    synthetic: true;
  };
  /** Dependencies to add: `taskKey` (a later phase's unfinished task) now also depends on `dependsOn` (the fix-up). */
  edges: { taskKey: string; dependsOn: string }[];
  /** Tasks after the phase move down one place so the fix-up sits at the end of its phase. */
  reorder: { taskKey: string; orderIdx: number }[];
}

const list = (items: string[]) => items.map((s) => `- ${s}`).join("\n");

/**
 * The synthetic fix-up task for a failed phase validation (round = the phase's `fixup_rounds + 1`),
 * key `FIX-<phase idx>.<round>`, plus the edges that make later phases wait for it. `laterTasks` are the
 * tasks of later phases; done and skipped ones get no edge.
 */
export function planFixup(phase: FixupPhase, round: number, verdict: PhaseVerdict, laterTasks: LaterTask[]): FixupPlan {
  const key = `FIX-${phase.idx}.${round}`;
  const label = phaseLabel(phase.name);
  const parts = [`Phase validation of "${label}" failed (fix-up round ${round}). Make the phase pass as a whole.`, verdict.failure.trim()];
  if (verdict.reasons.length) parts.push(`Reasons:\n${list(verdict.reasons)}`);
  if (verdict.suggestions.length) parts.push(`Suggestions:\n${list(verdict.suggestions)}`);
  const orderIdx = phase.lastOrderIdx + 1;
  return {
    task: {
      key,
      title: `Fix phase "${label}" so phase validation passes`,
      description: parts.filter(Boolean).join("\n\n"),
      acceptance: [...verdict.unmet, `Phase validation of "${label}" passes`],
      phase: phase.name === NO_PHASE ? null : phase.name,
      orderIdx,
      dependsOn: [],
      mergePolicy: "auto",
      synthetic: true,
    },
    edges: laterTasks
      .filter((t) => !FINISHED.has(t.status) && !t.dependsOn.includes(key))
      .map((t) => ({ taskKey: t.key, dependsOn: key })),
    reorder: laterTasks
      .filter((t) => t.orderIdx >= orderIdx)
      .sort((a, b) => a.orderIdx - b.orderIdx)
      .map((t) => ({ taskKey: t.key, orderIdx: t.orderIdx + 1 })),
  };
}
