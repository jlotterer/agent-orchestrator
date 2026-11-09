# TASK-21: Context assembly with per-part budgets
**Status:** done (2026-11-08; `src/core/context.ts` and the `handoff.*` settings; the orchestrator calls it in TASK-22) · **Wave:** 14 · **Depends on:** TASK-18 · **Parallel:** Yes

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
  - `extractReqRows({text, name}, ids)`: for each `REQ-<DOMAIN>-NN`, the table rows whose first cell is the ID, then the bullet lines that contain it (edge cases and acceptance criteria), per §6.4; missing IDs → `"REQ-X-NN: not found in <name>"` lines. `name` is the configured path (`docs/requirements.md`) used in the header and the not-found line; the fixtures supply `requirements.sample.md` as `text` with that `name`.
  - `resolveContracts(spec, names)`: a `## Contracts` subsection of `spec.md` by heading, else a file in the folder; both present → section wins plus a warning.
  - `assembleSpecContext({brief, reqRows, contracts, rules: [{text, name}], specFiles}, budgets)`: returns `{text, cuts: [{part, source, from, to}]}`. Order with a brief: brief, requirements, contracts (one part each), rules (one part each). Order without: `handoff.contextFiles` in order, other root `*.md`, `contracts/*`, then rules; never `tasks.md` or `tasks/*`. Each part is clipped on its own with the existing marker style (`… (truncated, N more chars)`) and the headers §6.4 lists.
- `src/config.ts`: `handoff.briefChars` (8000), `handoff.reqChars` (4000), `handoff.contractChars` (6000), `handoff.rulesChars` (6000), `handoff.requirementsFile` (`docs/requirements.md`), `handoff.projectFiles` (`["AGENTS.md"]`); `handoff.contextFiles` default becomes `["spec.md", "data-model.md", "plan.md"]`; `specChars` now applies per file. Document each in the comments and in `orch.config.example.json` if one exists.
- `test/unit/context.test.mjs`: the `full` T003 expectation (order and contents, nothing cut), the `bad` T004 expectation (brief cut at 8,000 with one marker and one `cuts` entry), the `speckit` expectation (all of `spec.md`, `plan.md` cut), missing REQ ID, contract section vs file, an absent rules file.

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
- `npm run typecheck && npm test` pass; architecture §9 and the user guide's settings reference list the new settings; the §19 table gains rows for `handoff.briefChars`, `reqChars`, `contractChars`, `rulesChars`, `requirementsFile` and `projectFiles` and updates the `contextFiles` default (§6.4 already refers to them); this brief's status line and the task index are updated in the same PR.
