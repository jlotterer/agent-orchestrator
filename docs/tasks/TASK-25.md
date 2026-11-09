# TASK-25: Make phase e2e scenario (d) deterministic
**Status:** done (2026-11-09; cause: test timing, kill before the worker's first commit; see the PR) · **Wave:** 15 · **Depends on:** — · **Parallel:** No (run it before TASK-22 if the fix touches `src/orchestrator.ts`)

## Goal
CI on `main` is green on every run again. `scripts/e2e-phase.mjs` scenario (d), "a run in flight across the upgrade", times out intermittently ("timed out after 120000ms waiting for run done after the upgrade") when it runs last in the `npm test` chain, on GitHub Actions and in the `node:22` container, while it passes every time in isolation. The flake has been red on `main` since at least commit `3bf3c80` (before TASK-19/20/21) and hides any new failure behind it. Either the scenario is timing-fragile and must wait on the right signal, or the post-restart recovery path is slow under load and that is a product defect; this task finds out which and fixes it.

## Covers
REQ-NFR-01 (restart loses no state; the in-flight attempt is redone), REQ-NFR-07 (e2e coverage of restart recovery)

## Read first
- [CLAUDE.md](../../CLAUDE.md)
- [architecture.md §7.4](../architecture.md#74-run-control) (`recover()`), [§10.3](../architecture.md#103-phase-validation) (phase rows created on upgrade: `newPhaseRows`), [§21.2](../architecture.md#212-testing-architecture)
- `scripts/e2e-phase.mjs` (scenario `d`, the `restart()` helper in `setup()`), `scripts/lib/e2e.mjs` (`waitFor`, `startDaemon`), `scripts/fake-agent.mjs` (`SLEEP_LONG`: the worker writes its pid to `$FAKE_STATE_DIR`, sleeps, exits if orphaned)
- `src/orchestrator.ts` `recover()` and the tick's phase check; `src/core/phases.ts` `newPhaseRows`
- Evidence: CI runs 42547284033 (3bf3c80, node 24), 42555128331 and 42555808597 (both nodes), 42557941796 (0c4e0a2, node 22) all fail only on (d); the PR run 42557879141 passed both nodes. Memory of the owner's sessions: scenario (b) of `e2e-lifecycle` needed `--init` in Docker for a similar orphan reason.

## Scope
- Diagnose first, in the container, with the whole `npm test` chain running before it (that is the failing condition): add timing output to scenario (d) (time to daemon ready after restart, time to T006 `done`, time to phase 2 `passed`) and run it at least five times. Decide between:
  - **Timing:** the orphaned `SLEEP_LONG` worker from the killed daemon, or the restarted daemon's first tick, takes longer than the budget under load → wait on intermediate signals (daemon ready; T006 back to `pending` by `recover()`; T006 `running` again; phase 2 `validating`) each with its own budget, so a failure names the step, and raise the final budget only if the measured path needs it.
  - **Product:** `recover()` or `newPhaseRows` leaves the run in a state the tick does not pick up without another event (for example a phase row created `pending` for a finished phase whose tasks are `done` but never revalidated, or the resumed T006 held by a stale slot) → fix it in `src/orchestrator.ts` / `src/core/phases.ts` with a fixture case in `test/fixtures/phases.json` and keep the e2e as the regression.
- Whatever the cause, every `waitState` in `e2e-phase.mjs` and `e2e-lifecycle.mjs` that waits for `run.status === "done"` after a restart gets a label naming the step it is in, so the next flake reports where it stalled.
- `test/fixtures/README.md` or `scripts/e2e-phase.mjs` header: one line on what (d) waits for and why the budgets are what they are.

## Out of scope
Other scenarios. Changing `--init` or the Docker recipe (documented in README "Testing"). Reducing CI parallelism.

## Target files
- `scripts/e2e-phase.mjs`, `scripts/lib/e2e.mjs`
- `src/orchestrator.ts`, `src/core/phases.ts`, `test/fixtures/phases.json` (only if the cause is a product defect)
- `test/fixtures/README.md` (only if a fixture case is added)

## Done when
- `node scripts/e2e-phase.mjs` passes ten consecutive times in the `node:22` container when run after the rest of `npm run test:e2e`, and three consecutive CI runs on `main` are green on Node 22 and 24.
- If a product defect was found: a `phases.json` or readiness fixture case pins it, with the owner's review of the expected output ([0020](../decisions/0020-pure-core-and-fixtures.md)).
- `npm run typecheck && npm test` pass; this brief's status line and the task index are updated in the same PR; the PR records the measured timings and the cause.
