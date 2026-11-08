# TASK-18: Feature-folder fixtures and the brief contract
**Status:** done (2026-11-08; expected outputs checked mechanically against `parseTasksMd` and a scratch transcription of §6.4; owner review of the expected outputs is the manual merge step) · **Wave:** 13 · **Depends on:** — · **Parallel:** Yes · **Merge policy:** manual (owner reviews the expected outputs, as for TASK-01)

## Goal
Pin down, before any code, what orch reads from a feature folder that contains authored task briefs (`tasks/T00N.md`), what it warns about, and in what order it assembles a worker's context. The fixtures are the executable spec for TASK-19, TASK-20 and TASK-21. The contract itself moves from the proposal into architecture.md so it has one home.

## Covers
REQ-INTAKE-11, REQ-INTAKE-13, REQ-INTAKE-14, REQ-WORK-09, REQ-WORK-10, REQ-SPEC-03 (fixtures only; the code lands in later tasks)

## Read first
- [CLAUDE.md](../../CLAUDE.md)
- [proposals/spec-workflow.md, Part 2](../proposals/spec-workflow.md#part-2-the-feature-folder-contract): the contract to transcribe
- [decisions/0023](../decisions/0023-orch-owns-spec-skill.md) and [decisions/0020](../decisions/0020-pure-core-and-fixtures.md)
- [requirements.md §5.2](../requirements.md#52-spec-intake--planning-intake) and [§5.4](../requirements.md#54-worker-execution--context-work): the acceptance criteria the fixtures must make testable
- `test/fixtures/tasks-md/` and `test/fixtures/README.md` (from TASK-01): follow the same layout and the same "expected output is a JSON file next to the input" convention

## Scope
- `test/fixtures/spec-dir/full/`: a complete feature folder: `spec.md` (Goal, Covers, Out of scope, a `## Contracts` section with two named contracts, Risky logic), `tasks.md` (two phases; T001, T002 `[P]`, T003 `[P]`, T004), `tasks/T001.md`…`T004.md` with frontmatter per the contract, and `contracts/auth-api.md`. T004's `tasks.md` line says `[P]` but its brief says `parallel: false` (the conflict case).
- `test/fixtures/spec-dir/bad/`: the same shape with exactly four problems: a `TBD` marker in `spec.md`, two `[P]` tasks naming the same target file, one brief over 8,000 characters, and one task whose title and target files are test-only.
- `test/fixtures/spec-dir/speckit/`: a plain Spec Kit folder (no `tasks/`): `spec.md` of about 3,000 characters, `plan.md` of about 15,000, `data-model.md`, `contracts/one.md`.
- `test/fixtures/spec-dir/version/`: one brief with `orch: 2`.
- Expected outputs, one JSON file per folder: the parsed tasks (key, dependencies, parallel, merge policy, validate mode and command, owned files, criteria, cited REQs, contracts, brief found), the warnings and errors (file, line, message), and for T003 the ordered list of context parts with their budgets and which are cut at `briefChars: 8000`, `specChars: 12000`.
- A small `test/fixtures/requirements.sample.md` with rows REQ-AUTH-01..04 and criteria bullets, used by the context expectations.
- `docs/architecture.md` §6: add a subsection "Feature folder and brief contract" transcribed from the proposal's Part 2, and make the proposal link to it.
- `test/fixtures/README.md`: describe the new folders.

## Out of scope
Any parser, check script or orchestrator change (TASK-19, TASK-20, TASK-21). Changing existing fixtures.

## Target files
- `test/fixtures/spec-dir/**`
- `test/fixtures/requirements.sample.md`
- `test/fixtures/README.md`
- `docs/architecture.md` (§6 only)
- `docs/proposals/spec-workflow.md` (Part 2 becomes a pointer)

## Done when
- Each fixture folder has an expected-output JSON that a reviewer can check by hand against the contract in architecture §6.
- The `bad` expectations list exactly four problems, each naming a file and line.
- The `speckit` expectation shows `spec.md` complete and `plan.md` cut, in the order spec, data-model, plan, contracts.
- Owner has reviewed the expected outputs (merge policy manual).
- `npm run typecheck && npm test` still pass (no consumer yet); this brief's status line and the task index are updated in the same PR.
