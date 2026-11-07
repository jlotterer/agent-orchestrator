# TASK-04: Regression e2e for built lifecycle behaviour
**Status:** todo · **Wave:** 2 · **Depends on:** TASK-02 · **Parallel:** Yes (with TASK-03)

## Goal
Pin down the behaviour orch already has but that no test covers, so later refactors (multi-project, auth) can't silently break it. Add the end-to-end scenarios below; fix small bugs they reveal.

## Covers
REQ-INTAKE-03, REQ-INTAKE-05, REQ-INTAKE-06, REQ-INTAKE-08, REQ-INTAKE-09 (part), REQ-SCHED-03, REQ-SCHED-04, REQ-SCHED-05, REQ-SCHED-06, REQ-SCHED-07, REQ-SCHED-08, REQ-WORK-01, REQ-WORK-02, REQ-WORK-03, REQ-WORK-04, REQ-WORK-05, REQ-WORK-06, REQ-WORK-07, REQ-WORK-08, REQ-VAL-01, REQ-VAL-03, REQ-VAL-04, REQ-HITL-03, REQ-HITL-04, REQ-HITL-05, REQ-HITL-06 (part), REQ-GIT-01, REQ-GIT-02, REQ-GIT-04, REQ-GIT-05, REQ-GIT-06, REQ-ADAPT-02, REQ-ADAPT-03, REQ-ADAPT-04, REQ-NFR-01, REQ-NFR-07

## Read first
- [CLAUDE.md](../../CLAUDE.md)
- [requirements.md §5.3](../requirements.md#53-scheduling--run-control-sched)
- [requirements.md §5.4](../requirements.md#54-worker-execution--context-work)
- [requirements.md §5.7](../requirements.md#57-git--merge-git)
- [architecture.md §7.4](../architecture.md#74-run-control)
- [architecture.md §8](../architecture.md#8-task-state-machine)
- [architecture.md §9](../architecture.md#9-worker--hand-off-brief)
- [architecture.md §11](../architecture.md#11-git--merge)
- [architecture.md §21.2](../architecture.md#212-testing-architecture)
- `scripts/lib/e2e.mjs` (TASK-02), `scripts/fake-agent.mjs`

## Scope
- `scripts/e2e-lifecycle.mjs` with independent scenarios, each in its own temp repo:
- (a) stop mid-task → agent gone, task pending, branch commits kept; start again → completes. (b) `kill -9` the daemon mid-task, restart → task pending with an activity event, run completes. (c) agent timeout (`agents.timeoutMinutes: 0.05`, worker marker `SLEEP_LONG`) → attempt failed with timeout feedback. (d) `git.setupCommand` exiting 1 → attempt failed with its output. (e) worker marker `NO_COMMIT` → "no commits" feedback, then failed in the inbox. (f) plan of a dir without `tasks.md` → 400 naming `tasks.md`. (g) planner marker `PLANNER_FAIL` in `spec.md` → plan awaiting approval with imported tasks plus an orchestrator fallback decision. (h) pause, answer the question while paused, resume → the answer reaches the worker. (i) local merge with a dirty tracked file in the main checkout → inbox, attempts unchanged. (j) two `[P]` tasks editing the same file (marker `CONFLICT_FILE`) → one merges, the other's merge failure lands in the inbox with attempts unchanged. (k) a skipped dependency lets its dependant start. (l) answering a question twice → the second is refused. (m) editing acceptance criteria before approval → a human decision names the task.
- `scripts/fake-agent.mjs`: add the markers above (keep existing behaviour for existing markers).
- If a scenario reveals a bug confined to one function, fix it here and say so in the PR. Otherwise mark the scenario `todo` with the reason and list it in the PR.

## Out of scope
Multi-project, auth, PR-mode scenarios (other tasks own them).

## Target files
- `scripts/e2e-lifecycle.mjs`
- `scripts/fake-agent.mjs`
- `package.json`

## Done when
- `npm run test:e2e` runs `e2e-lifecycle.mjs`, and all scenarios (a)–(m) pass, or are marked `todo` with a reason in the PR.
- Scenario (b) shows no lost decisions or questions after the restart (counts compared before and after).
- `npm test` passes.
- `npm run typecheck` passes and docs touched by this change (README, architecture, decisions) are updated in the same PR, including this brief's status line.
