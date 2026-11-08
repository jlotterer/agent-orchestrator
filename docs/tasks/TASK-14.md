# TASK-14: File ownership: safe parallelism
**Status:** done · **Wave:** 9 · **Depends on:** TASK-13 · **Parallel:** No

## Goal
Prevent parallel tasks from editing the same files. The planner declares owned files per task, the scheduler never runs overlapping tasks together and logs why, and the validator reports out-of-scope edits without failing on them.

## Covers
REQ-INTAKE-04 (part), REQ-INTAKE-09 (part), REQ-SCHED-02, REQ-VAL-05, REQ-HITL-06 (part)

## Read first
- [CLAUDE.md](../../CLAUDE.md)
- [requirements.md §5.3](../requirements.md#53-scheduling--run-control-sched)
- [requirements.md §5.5](../requirements.md#55-validation-val)
- [architecture.md §7.2](../architecture.md#72-ownership-overlap)
- [architecture.md §7.1](../architecture.md#71-readiness)
- [architecture.md §10.2](../architecture.md#102-validator)
- [architecture.md §13.2](../architecture.md#132-json-contracts)
- [decision 0017](../decisions/0017-file-ownership.md)

## Scope
- `src/core/ownership.ts`: `ownedOverlap` per architecture §7.2, plus `outOfScope(files, owned): string[]` using `path.matchesGlob` (see design assumption DA1).
- `test/fixtures/ownership.json`: at least 10 overlap cases (equal paths, glob vs file, sibling dirs, `**` at root, empty lists). Add the cases to the core test runner, and remove the `pending: TASK-14` markers in `readiness.json`.
- `src/core/readiness.ts`: apply the overlap check (§7.1 step 4).
- `src/orchestrator.ts`: apply planner `files_owned`. Log one decision per held-back pair per run. Pass owned files to the worker prompt, and the out-of-scope list to the validator. Store validator `findings`. The edit API accepts `files_owned`.
- `prompts/planner.md`, `prompts/worker.md`, `prompts/validator.md`: update the contracts per §13.2.
- `dashboard/index.html`: owned files and implicit overlap edges in the Plan tab; owned files in the edit dialog; findings in the task drawer.
- `scripts/fake-agent.mjs` and `scripts/e2e.mjs`: the planner gives T002 and T003 overlapping `files_owned`. Assert they never run concurrently and that an orchestrator decision names both.

## Out of scope
Exact glob intersection (rejected in decision 0017).

## Target files
- `src/core/ownership.ts`
- `src/core/readiness.ts`
- `test/fixtures/ownership.json`
- `test/fixtures/readiness.json`
- `test/unit/core.test.mjs`
- `src/orchestrator.ts`
- `prompts/planner.md`
- `prompts/worker.md`
- `prompts/validator.md`
- `dashboard/index.html`
- `scripts/fake-agent.mjs`
- `scripts/e2e.mjs`

## Done when
- All ownership and readiness fixtures pass.
- The e2e assertions above pass.
- Unit: `outOfScope(["src/a.ts","README.md"], ["src/**"])` returns `["README.md"]`.
- **Manual:** one real run with Claude Code where the planner emits `files_owned`; attach the plan screenshot.
  _Open: not done in the TASK-14 session (no real agent run there); the owner does it on the next real run._
- `npm test` passes.
- `npm run typecheck` passes and docs touched by this change (README, architecture, decisions) are updated in the same PR, including this brief's status line.
