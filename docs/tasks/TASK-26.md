# TASK-26: orch-spec follow-ups: align the check script with orch, cross-check them, run adopt mode for real
**Status:** done · **Wave:** 15 · **Depends on:** TASK-19, TASK-20 · **Parallel:** Yes

## Goal
The skill's `check-feature.mjs` and orch's `src/core/brief.ts` implement the same folder checks (architecture §6.4) in two places, because the skill must run dependency-free from `~/.claude/skills`. Today they agree on every fixture, but two differences were found in the TASK-19 review, and nothing would catch future drift. After this task the two checkers are proven identical on every fixture by a test, the skill reports exactly what `orch plan --dry-run` reports, and adopt mode has had its real run.

## Covers
REQ-SPEC-03 (the "passes the script ⇒ no `--dry-run` warnings" half, now as a mechanical cross-check), REQ-SPEC-04 (adopt mode real run; the manual half of REQ-SPEC-01 for that mode)

## Read first
- [CLAUDE.md](../../CLAUDE.md)
- [architecture.md §6.4](../architecture.md#64-feature-folder-and-brief-contract): the folder checks table and the **Skill** paragraph
- `src/core/brief.ts` `checkFeature` (TASK-20): note that the parallel-overlap loop skips a pair when either task's effective `depends_on` names the other, and its message for a non-identical overlap (`T002's src/auth/** overlaps src/auth/x.ts`)
- `skills/orch-spec/scripts/check-feature.mjs` and `scripts/lib/feature.mjs` (TASK-19): the overlap loop compares every effectively parallel pair, and its non-identical message is worded the other way round
- `skills/orch-spec/SKILL.md` adopt mode; `skills/orch-spec/scripts/scaffold-briefs.mjs`; `test/fixtures/spec-dir/speckit/`
- `test/unit/check-feature.test.mjs`, `test/unit/brief.test.mjs`

## Scope
- `skills/orch-spec/scripts/check-feature.mjs`: skip a parallel pair when one task's effective dependencies (brief `depends_on` ∪ earlier phases, as `lib/feature.mjs` already computes) include the other, and use orch's exact message for a non-identical overlap. The script must never be looser than orch; after this change it is equal.
- `test/unit/check-feature.test.mjs`: a cross-check that, for every folder under `test/fixtures/spec-dir/`, runs the skill's `checkFeature` and orch's `readFeature`/`checkFeature` from `dist/core/brief.js` and asserts the same `[{kind, rule, file, line, message}]` for the rules both implement (`marker`, `version`, `parallel-overlap`, `brief-size`, `test-only`); the skill's author-only rules are filtered out of its side. The test is skipped, not failed, when `dist/` is absent, so the skill's own tests still run without a build. Add a case where a later-phase `[P]` task shares a file with an earlier `[P]` task and assert neither checker warns.
- **Adopt mode real run** (prompts are product): run `/orch-spec adopt` on a copy of `test/fixtures/spec-dir/speckit/` (or a real Spec Kit folder) with a real agent; the folder must pass `check-feature.mjs --no-requirements` afterwards with `tasks.md` byte-identical and T001 still ticked. Record the run in the PR as TASK-19 did (the owner's answers supplied up front, every clarity problem quoted), and fold any SKILL.md or template fixes into this PR.
- `skills/README.md` and architecture §6.4 **Skill** paragraph: say the two checkers are cross-checked by the fixture test and that the overlap rule skips dependent pairs.
- Known gaps to close while there: `check-feature.mjs` `--json` should carry `chars`/`limit` on `brief-size` as orch does; `scaffold-briefs.mjs` should refuse a folder whose `tasks/` already has a brief for every task with a clear message instead of silence.

## Out of scope
Fold-back mode's real run (TASK-23, which ships the inbox item it needs). Changing the §6.4 rules or any fixture's expected output ([0020](../decisions/0020-pure-core-and-fixtures.md)). Making the skill import orch's `dist/` (settled: the skill stays standalone).

## Target files
- `skills/orch-spec/**`
- `skills/README.md`
- `test/unit/check-feature.test.mjs`
- `docs/architecture.md` (§6.4 Skill paragraph only)

## Done when
- Unit: the cross-check passes for `full`, `bad`, `speckit`, `version` and `nocriteria`; the new cross-phase `[P]` case warns in neither checker; existing TASK-19 tests still pass.
- Manual: the adopt real run is recorded in the PR with the before/after `tasks.md` diff (empty) and the check output (empty).
- `npm run check` passes (no runtime dependency added); `npm run typecheck && npm test` pass; this brief's status line and the task index are updated in the same PR.
