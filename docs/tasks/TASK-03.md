# TASK-03: Extract the pure decision core
**Status:** done · **Wave:** 2 · **Depends on:** TASK-01, TASK-02 · **Parallel:** Yes (with TASK-04)

## Goal
Move the scheduling, task-transition and PR-poll decisions out of `orchestrator.ts` into pure functions in `src/core/`, and make the approved fixtures pass. Behaviour stays the same except where the fixtures' Behaviour changes list says otherwise.

## Covers
REQ-NFR-05, REQ-INTAKE-01, REQ-INTAKE-02, REQ-SCHED-01 (part), REQ-WORK-03 (part), REQ-PRFB-01, REQ-PRFB-02, REQ-PRFB-03, REQ-PRFB-04, REQ-PRFB-05, REQ-PRFB-06, REQ-PRFB-07

## Read first
- [CLAUDE.md](../../CLAUDE.md)
- [architecture.md §7.1](../architecture.md#71-readiness)
- [architecture.md §8](../architecture.md#8-task-state-machine)
- [architecture.md §12.2](../architecture.md#122-pr-action-decision)
- [architecture.md §6.1](../architecture.md#61-tasks-file-parser)
- [architecture.md §21.2](../architecture.md#212-testing-architecture)
- [decision 0020](../decisions/0020-pure-core-and-fixtures.md)
- `test/fixtures/README.md` (from TASK-01)

## Scope
- `src/core/readiness.ts`: `selectReady(input: ReadinessInput): ReadinessResult` exactly as in architecture §7.1. Until TASK-09 the orchestrator passes one project with `maxAgents = maxParallel` and `busyAgents = 0`.
- `src/core/ownership.ts`: `ownedOverlap(a: string[], b: string[]): boolean`, a stub returning `false` (TASK-14 implements it).
- `src/core/transitions.ts`: `nextTaskState(task, event, cfg)` with the event union and `effect` names of §8 (rows T1–T16, T18). The orchestrator applies `patch`, records `decision`, sends `notify`, and performs `effect`.
- `src/core/prpoll.ts`: `decidePrAction(input)` per §12.2. `pollPr` gathers facts, calls it, and executes the action.
- `src/speckit.ts` / `src/adapters/runner.ts`: fix `parseTasksMd` / `extractJson` where the approved fixtures require it.
- `test/unit/core.test.mjs`: load every fixture file in `test/fixtures/`, skip cases with a `pending` field, and run the matching pure function with `assert.deepStrictEqual`.
- Extend `scripts/check-invariants.mjs`: files in `src/core/` must not import `node:fs`, `node:child_process` or `../db`, and must not call `Date.now()` or `new Date()` without arguments.

## Out of scope
Multi-project scheduling (TASK-09), ownership logic (TASK-14), phases (TASK-15), request changes (TASK-06), UI mode (TASK-16).

## Target files
- `src/core/readiness.ts`
- `src/core/transitions.ts`
- `src/core/prpoll.ts`
- `src/core/ownership.ts`
- `src/orchestrator.ts`
- `src/speckit.ts`
- `src/adapters/runner.ts`
- `test/unit/core.test.mjs`
- `scripts/check-invariants.mjs`

## Done when
- Every fixture case without `pending` passes in `npm run test:unit`.
- `npm test` passes, including both existing e2e scenarios with unchanged assertions.
- `npm run check` passes, including the new core-purity rule.
- `orchestrator.ts` contains no inline retry or PR-merge decision logic (reviewer check: `failOrRetry` and `pollPr` delegate to `src/core`).
- `npm run typecheck` passes and docs touched by this change (README, architecture, decisions) are updated in the same PR, including this brief's status line.
