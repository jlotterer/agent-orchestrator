# TASK-13: Plan questions, plan preview and cycle check
**Status:** done · **Wave:** 8 · **Depends on:** TASK-11, TASK-12 · **Parallel:** No

## Goal
Fix the plan-question workaround: questions about the whole spec are not attached to a task, and they hold the run until answered. Add a no-side-effect plan preview, and refuse to approve plans with dependency cycles.

## Covers
REQ-INTAKE-07, REQ-INTAKE-10, REQ-SCHED-01 (part)

## Read first
- [CLAUDE.md](../../CLAUDE.md)
- [requirements.md §5.2](../requirements.md#52-spec-intake--planning-intake)
- [architecture.md §6.2](../architecture.md#62-planner)
- [architecture.md §6.3](../architecture.md#63-approval-gates)
- [architecture.md §7.1](../architecture.md#71-readiness)
- [architecture.md §14](../architecture.md#14-inbox-decisions--notifications)

## Scope
- `src/core/graph.ts`: `findCycle(tasks: {key, dependsOn}[]): string[] | null`.
- `src/core/readiness.ts` and `test/fixtures/readiness.json`: implement `planQuestionsOpen` gating, and remove the `pending: TASK-13` markers.
- `src/orchestrator.ts`: planner questions are stored with `task_id NULL`. The readiness input counts open plan questions. `approvePlan` refuses a cycle, naming its keys. The snapshot inbox includes plan questions with no task. Add `previewPlan(specDir)` returning the parsed tasks.
- `src/server.ts` (`dryRun` on the plan route) and `src/cli.ts` (`orch plan --dry-run` prints phases, tasks, `[P]` flags and dependencies).
- `dashboard/index.html`: render plan questions with a "Plan" label, and show the cycle error on approval.
- `scripts/fake-agent.mjs`: the planner asks a plan question when `spec.md` contains `PLAN_QUESTION`. `scripts/e2e.mjs`: add that scenario.

## Out of scope
Planner prompt changes beyond questions.

## Target files
- `src/core/graph.ts`
- `src/core/readiness.ts`
- `test/fixtures/readiness.json`
- `src/orchestrator.ts`
- `src/server.ts`
- `src/cli.ts`
- `dashboard/index.html`
- `scripts/fake-agent.mjs`
- `scripts/e2e.mjs`
- `test/unit/graph.test.mjs`

## Done when
- Unit: `findCycle` returns `["T1","T2","T1"]` for T1→T2→T1 and `null` for a DAG.
- e2e: with `PLAN_QUESTION`, the inbox has a question with no task key. After start, no task runs until it is answered, then the run completes.
- e2e: `orch plan <dir> --dry-run` exits 0, prints all task keys, and no new run exists afterwards.
- e2e: editing dependencies into a cycle makes approval return 400 naming both keys.
- `npm test` passes.
- `npm run typecheck` passes and docs touched by this change (README, architecture, decisions) are updated in the same PR, including this brief's status line.
