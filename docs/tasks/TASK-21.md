# TASK-21: Context assembly with per-part budgets
**Status:** todo · **Wave:** 14 · **Depends on:** TASK-18 · **Parallel:** Yes

## Goal
A pure function builds the spec part of a worker's or validator's context: brief, cited requirement rows, named contracts, project rules, in that order, each within its own budget, with explicit truncation markers and a list of cuts for the orchestrator to record. Without a brief, the old excerpt is rebuilt with `spec.md` first and per-file budgets. New settings carry the budgets and file locations.

## Covers
REQ-WORK-09, REQ-WORK-10 (pure half; wiring in TASK-22)

## Read first
- [CLAUDE.md](../../CLAUDE.md)
- [requirements.md §5.4](../requirements.md#54-worker-execution--context-work): REQ-WORK-09, -10 and edge cases
- [architecture.md §9](../architecture.md#9-worker--hand-off-brief) and [§19](../architecture.md#19-settings--environment)
- [decisions/0003](../decisions/0003-fresh-context-and-handoff-brief.md): bounded hand-off
- `src/orchestrator.ts` `specContext()` (the code this replaces), `src/prompts.ts` `clip()`, `src/config.ts` `handoff`
- `test/fixtures/spec-dir/full/`, `speckit/`, `test/fixtures/requirements.sample.md` and the context expectations (TASK-18)

## Scope
- `src/core/context.ts` (pure):
  - `extractReqRows(requirementsMd, ids)`: for each `REQ-<DOMAIN>-NN`, the table row and the acceptance-criteria bullets that cite it; missing IDs → `"REQ-X-NN: not found in <file>"` lines.
  - `resolveContracts(spec, names)`: a `## Contracts` subsection of `spec.md` by heading, else a file in the folder; both present → section wins plus a warning.
  - `assembleSpecContext({brief, reqRows, contracts, rules, specFiles}, budgets)`: returns `{text, cuts: [{part, from, to}]}`. Order with a brief: brief, requirements, contracts, rules. Order without: `spec.md`, `data-model.md`, `plan.md`, other `*.md`, `contracts/*`, then rules. Each part is clipped on its own with the existing marker style (`… (truncated, N more chars)`).
- `src/config.ts`: `handoff.briefChars` (8000), `handoff.reqChars` (4000), `handoff.contractChars` (6000), `handoff.rulesChars` (6000), `handoff.requirementsFile` (`docs/requirements.md`), `handoff.projectFiles` (`["AGENTS.md"]`); `handoff.contextFiles` default becomes `["spec.md", "data-model.md", "plan.md"]`; `specChars` now applies per file. Document each in the comments and in `orch.config.example.json` if one exists.
- `test/unit/context.test.mjs`: the T003 expectation from the `full` fixture (order and contents, cut at 8,000), the `speckit` expectation (all of `spec.md`, `plan.md` cut), missing REQ ID, contract section vs file.

## Out of scope
Calling the new function from the orchestrator, prompts, decisions (TASK-22). Reading files (the caller passes contents).

## Target files
- `src/core/context.ts`
- `src/config.ts`
- `test/unit/context.test.mjs`

## Done when
- Unit: the fixture context expectations pass without edits to the fixtures.
- Unit: given a 20,000-character brief and `briefChars: 8000`, `cuts` has one entry for `brief` and the text contains exactly one truncation marker.
- `npm run check` passes (core purity; `AGENTS.md` and `docs/requirements.md` are not vendor names).
- `npm run typecheck && npm test` pass; architecture §9 and §19 and the user guide's settings reference list the new settings; this brief's status line and the task index are updated in the same PR.
