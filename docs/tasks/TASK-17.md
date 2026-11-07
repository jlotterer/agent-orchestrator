# TASK-17: Cost and agent-time rollup
**Status:** todo · **Wave:** 12 · **Depends on:** TASK-16 · **Parallel:** No

## Goal
Show what each task, run and project cost in money (where the CLI reports it) and in agent time, stored on rows so archiving events never changes the totals.

## Covers
REQ-UI-06

## Read first
- [CLAUDE.md](../../CLAUDE.md)
- [requirements.md §5.10](../requirements.md#510-interfaces-ui)
- [architecture.md §18](../architecture.md#18-cost--time-rollup)
- [architecture.md §20](../architecture.md#20-data-model--persistence)

## Scope
- `src/orchestrator.ts`: after each `runAgent`, add cost and duration to the task row (worker, validator) or the run row (planner, phase validator) per architecture §18.
- `src/costs.ts`: `runTotals(store, runId)` and `projectTotals(store, projectId)`, returning `{costUsd: number | null, agentMs}`. Snapshots include them.
- `dashboard/index.html`: a cost/time tile in the top bar (run and project), and per-task values in the drawer; "n/a" when null.
- `scripts/e2e.mjs`: the fake Claude reports $0.01 per call. Assert the run total equals the number of Claude-adapter calls × 0.01, and that Gemini-adapter-only cost shows as n/a.

## Out of scope
Spend caps (non-goal).

## Target files
- `src/orchestrator.ts`
- `src/costs.ts`
- `dashboard/index.html`
- `scripts/e2e.mjs`
- `test/unit/costs.test.mjs`

## Done when
- Unit: given tasks with costs 0.10 and 0.05 and a planner cost of 0.02, the run total is 0.17; given all-null costs, `costUsd` is null.
- The e2e assertion above passes.
- `npm test` passes.
- `npm run typecheck` passes and docs touched by this change (README, architecture, decisions) are updated in the same PR, including this brief's status line.
