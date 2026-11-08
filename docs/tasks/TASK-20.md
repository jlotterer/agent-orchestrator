# TASK-20: Read authored briefs and check the feature folder
**Status:** todo · **Wave:** 14 · **Depends on:** TASK-18 · **Parallel:** Yes

## Goal
orch imports a feature folder's `tasks/T00N.md` briefs: frontmatter and sections become task fields, problems become errors or warnings, and the preview shows all of it. Pure parsing lives in `src/core/`; file reading stays in `src/speckit.ts`.

## Covers
REQ-INTAKE-11 (parse and preview; plan values are wired in TASK-22), REQ-INTAKE-13, REQ-INTAKE-14, REQ-INTAKE-15, REQ-SPEC-03 (`--dry-run` half)

## Read first
- [CLAUDE.md](../../CLAUDE.md)
- [requirements.md §5.2](../requirements.md#52-spec-intake--planning-intake): REQ-INTAKE-11, -13, -14, -15 and their edge cases
- [architecture.md §6](../architecture.md#6-spec-intake--planner): brief contract (TASK-18)
- [decisions/0020](../decisions/0020-pure-core-and-fixtures.md): core purity and fixtures
- `src/speckit.ts` (`readSpecDir`, `parseTasksMd`), `src/core/` (existing style), `src/cli.ts` (`plan --dry-run`, TASK-13)
- `test/fixtures/spec-dir/*` and expected JSON (TASK-18)

## Scope
- `src/core/brief.ts` (pure):
  - `parseFrontmatter(text)`: the YAML subset the contract allows (scalars, flow lists, comments). Unknown keys are kept and reported as warnings; anything else is a parse error with a line.
  - `parseBrief(key, text)`: returns `{version, fields, criteria, targetFiles, contracts, cites, warnings, errors}`; version missing or unsupported → error naming the file.
  - `checkFeature(spec)`: markers in `spec.md` and briefs (`[NEEDS CLARIFICATION`, `TBD`, `TODO`) → errors; parallel target-file overlap, brief over `briefChars`, test-only task, unresolved contract, `[P]`/frontmatter conflict → warnings. Each with file, line and message.
  - `mergeBriefIntoTask(imported, brief)`: frontmatter wins; returns the merged task and the conflicts for decisions.
- `src/speckit.ts`: `readSpecDir` also reads `tasks/*.md` and one level of subfolders (`contracts/*`); `files` keeps relative paths. Attach parsed briefs to `ImportedTask` (new optional `brief` field in `src/types.ts`).
- `src/cli.ts`: `plan --dry-run` prints, per task, "brief: yes (fields: …)" or "brief: no", then warnings and errors; errors make it exit 1 unless `--allow-open` is given. `orch plan` (non-dry) refuses on errors the same way; the override is recorded as a decision by TASK-22.
- `test/unit/brief.test.mjs`: drives `parseBrief`, `checkFeature` and `mergeBriefIntoTask` from every `test/fixtures/spec-dir/*` expected JSON; `full` has no warnings, `bad` has exactly four, `version` errors, `speckit` has no briefs.
- `scripts/check-invariants.mjs`: no change expected; confirm `src/core/brief.ts` stays free of fs and clock reads.

## Out of scope
Building the plan from briefs, decisions, prompts, context assembly (TASK-21, TASK-22). The skill's check script (TASK-19).

## Target files
- `src/core/brief.ts`
- `src/speckit.ts`
- `src/types.ts` (`ImportedTask.brief` only)
- `src/cli.ts` (`plan --dry-run` output and `--allow-open`)
- `test/unit/brief.test.mjs`

## Done when
- Unit: every `test/fixtures/spec-dir/*` expected JSON matches without edits to the fixtures.
- `orch plan test/fixtures/spec-dir/bad --dry-run` exits 1 listing the four problems; with `--allow-open` it exits 0 and still lists them as warnings.
- `orch plan test/fixtures/spec-dir/full --dry-run` shows each task's brief fields and no warnings.
- `npm run check` passes (core purity).
- `npm run typecheck && npm test` pass; architecture §6 and the user guide's plan-preview page note the new output; this brief's status line and the task index are updated in the same PR.
