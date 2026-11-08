/**
 * Cost and agent-time rollup (architecture §18, REQ-UI-06).
 *
 * Every agent call adds its reported cost and its wall time to a row: the task's for workers and
 * (UI) validators, the run's for the planner and phase validators. Totals are summed from those rows,
 * never from events, so archiving a run's events (§17) never changes them.
 *
 * Cost is NULL until some agent on the row reports one: NULL + x = x, and a CLI that reports no cost
 * adds nothing. A total whose rows are all NULL is null, which the dashboard shows as "n/a".
 */
import type { Store } from "./db.js";

/** What one agent call used: `costUsd` null when the CLI did not report it. */
export interface Usage {
  costUsd: number | null;
  durationMs: number;
}

/** A rollup. `costUsd` is null when no agent in scope reported a cost. */
export interface Totals {
  costUsd: number | null;
  agentMs: number;
}

/** Round away float noise (0.1 + 0.05 + 0.02 → 0.17), keeping micro-dollar precision. */
const money = (x: number | null): number | null => (x === null ? null : Math.round(x * 1e6) / 1e6);

const ADD = (table: "tasks" | "runs") =>
  `UPDATE ${table} SET cost_usd = CASE WHEN @cost IS NULL THEN cost_usd ELSE COALESCE(cost_usd, 0) + @cost END,
                      agent_ms = COALESCE(agent_ms, 0) + @ms WHERE id = @id`;

function add(store: Store, table: "tasks" | "runs", id: string, u: Usage) {
  const cost = typeof u.costUsd === "number" && Number.isFinite(u.costUsd) ? u.costUsd : null;
  const ms = Number.isFinite(u.durationMs) && u.durationMs > 0 ? Math.round(u.durationMs) : 0;
  store.db.prepare(ADD(table)).run({ id, cost, ms });
}

/** Add a worker's or validator's usage to its task row. */
export function addTaskUsage(store: Store, taskId: string, u: Usage) {
  add(store, "tasks", taskId, u);
}

/** Add a planner's or phase validator's usage to its run row. */
export function addRunUsage(store: Store, runId: string, u: Usage) {
  add(store, "runs", runId, u);
}

/** One task's values (its row only). */
export function taskTotals(t: { cost_usd: number | null; agent_ms: number | null }): Totals {
  return { costUsd: money(t.cost_usd ?? null), agentMs: t.agent_ms ?? 0 };
}

/** A run: its own row (planner, phase validators) plus all of its tasks. */
export function runTotals(store: Store, runId: string): Totals {
  const r = store.db
    .prepare(`SELECT r.cost_usd AS rc, r.agent_ms AS rm,
                     (SELECT SUM(cost_usd) FROM tasks WHERE run_id = r.id) AS tc,
                     (SELECT SUM(agent_ms) FROM tasks WHERE run_id = r.id) AS tm
              FROM runs r WHERE r.id = ?`)
    .get(runId) as { rc: number | null; rm: number | null; tc: number | null; tm: number | null } | undefined;
  if (!r) return { costUsd: null, agentMs: 0 };
  return {
    costUsd: money(r.rc === null && r.tc === null ? null : (r.rc ?? 0) + (r.tc ?? 0)),
    agentMs: (r.rm ?? 0) + (r.tm ?? 0),
  };
}

/** A project: every run of it, including archived ones. */
export function projectTotals(store: Store, projectId: string): Totals {
  const r = store.db
    .prepare(`SELECT (SELECT SUM(cost_usd) FROM runs WHERE project_id = @p) AS rc,
                     (SELECT SUM(agent_ms) FROM runs WHERE project_id = @p) AS rm,
                     (SELECT SUM(t.cost_usd) FROM tasks t JOIN runs r ON r.id = t.run_id WHERE r.project_id = @p) AS tc,
                     (SELECT SUM(t.agent_ms) FROM tasks t JOIN runs r ON r.id = t.run_id WHERE r.project_id = @p) AS tm`)
    .get({ p: projectId }) as { rc: number | null; rm: number | null; tc: number | null; tm: number | null };
  return {
    costUsd: money(r.rc === null && r.tc === null ? null : (r.rc ?? 0) + (r.tc ?? 0)),
    agentMs: (r.rm ?? 0) + (r.tm ?? 0),
  };
}
