# TASK-15: Phase validation and fix-up tasks
**Status:** todo · **Wave:** 10 · **Depends on:** TASK-14 · **Parallel:** No

## Goal
Validate each phase as a whole once its tasks are done. Run the phase test command and a phase validator agent on the base branch, create fix-up tasks automatically when it fails, and involve the owner after repeated failures.

## Covers
REQ-VAL-06, REQ-VAL-07, REQ-HITL-01 (part), REQ-HITL-06 (part), REQ-ADAPT-01 (part)

## Read first
- [CLAUDE.md](../../CLAUDE.md)
- [requirements.md §5.5](../requirements.md#55-validation-val)
- [architecture.md §10.3](../architecture.md#103-phase-validation)
- [architecture.md §7.1](../architecture.md#71-readiness)
- [architecture.md §14](../architecture.md#14-inbox-decisions--notifications)
- [architecture.md §13.2](../architecture.md#132-json-contracts)
- [architecture.md §15.1](../architecture.md#151-http-api)
- [decision 0015](../decisions/0015-phase-validation-fixups.md)

## Scope
- `src/core/phases.ts`: `phasesToValidate(tasks, phases)` and `planFixup(phase, round, verdict, laterTasks)`, which returns the synthetic task plus the dependency edges to add. Write `test/fixtures/phases.json` with at least 8 cases, and remove the `pending: TASK-15` markers elsewhere.
- `src/core/readiness.ts`: tasks of later phases wait while an earlier phase is not `passed`.
- `src/git.ts`: `addDetachedWorktree(dir, ref)`.
- `src/orchestrator.ts`: the phase validation flow of architecture §10.3 (busy-agent accounting, `phaseValidator` role defaulting to the validator role, decisions, synthetic `FIX-<phaseIdx>.<round>` tasks never ticked in `tasks.md`, and a `needs_human` inbox item with Re-run and Accept).
- `src/server.ts`: `POST /api/phases/:id/revalidate` and `POST /api/phases/:id/accept`.
- `prompts/phase-validator.md`: the contract per §13.2.
- `dashboard/index.html`: a phase status per phase in the Plan tab, a fix-up badge on synthetic tasks, and the phase inbox card.
- `scripts/e2e-phase.mjs` and `scripts/fake-agent.mjs`: the phase validator FAILs once when `PHASE_TRAP` is in the spec, then passes after the fix-up.

## Out of scope
Browser-based phase checks (TASK-16 covers UI mode per task only).

## Target files
- `src/core/phases.ts`
- `src/core/readiness.ts`
- `test/fixtures/phases.json`
- `test/fixtures/readiness.json`
- `test/fixtures/transitions.json`
- `src/git.ts`
- `src/orchestrator.ts`
- `src/server.ts`
- `prompts/phase-validator.md`
- `dashboard/index.html`
- `scripts/e2e-phase.mjs`
- `scripts/fake-agent.mjs`
- `package.json`

## Done when
- e2e: phase 1 completes → phase validation FAIL → `FIX-1.1` appears with the failure text, phase 2 tasks wait, then `FIX-1.1` done → re-validation PASS → phase 2 runs → run done. The decisions log contains both phase results and the fix-up creation.
- e2e: with `maxFixups: 0`, a failure produces a phase inbox item; Accept lets phase 2 proceed.
- e2e: `tasks.md` is never modified for `FIX-` keys.
- `npm test` passes.
- `npm run typecheck` passes and docs touched by this change (README, architecture, decisions) are updated in the same PR, including this brief's status line.
