# TASK-01: Spec-first fixtures for the risky logic
**Status:** todo · **Wave:** 1 · **Depends on:** — · **Parallel:** Yes (with TASK-02)

## Goal
Write the fixture tables that define correct behaviour for the riskiest logic: the tasks.md parser, JSON extraction from agent output, task readiness, the task state machine, and the PR-poll decision. There is no implementation in this task. Once the owner approves these tables they are the executable spec that TASK-03 implements against, and later tasks extend.

## Covers
REQ-INTAKE-01 (part), REQ-INTAKE-02 (part), REQ-SCHED-01 (part), REQ-PROJ-08 (part), REQ-PROJ-09 (part), REQ-PRFB-01 … REQ-PRFB-07 (part), REQ-NFR-05 (part)

## Read first
- [CLAUDE.md](../../CLAUDE.md)
- [architecture.md §21.2](../architecture.md#212-testing-architecture)
- [architecture.md §6.1](../architecture.md#61-tasks-file-parser)
- [architecture.md §7.1](../architecture.md#71-readiness)
- [architecture.md §8](../architecture.md#8-task-state-machine)
- [architecture.md §12.2](../architecture.md#122-pr-action-decision)
- [decision 0020](../decisions/0020-pure-core-and-fixtures.md)
- Current behaviour: `src/speckit.ts` (`parseTasksMd`), `src/adapters/runner.ts` (`extractJson`), `src/orchestrator.ts` (`tick`, `failOrRetry`, `finalize`, `pollPr`), `src/prfeedback.ts`

## Scope
- `test/fixtures/README.md`: the format of each file (per architecture §21.2), how a runner should use it, and the `"pending": "TASK-NN"` field. A case with that field describes behaviour a later task builds, and runners skip it until that task removes the field. Add a **Behaviour changes** section listing every case whose expected output differs from what the current code does, each with a one-line reason.
- `test/fixtures/tasks-md/`: at least 10 cases (`<case>.md` + `<case>.expected.json`). Cover: basic phases; `[P]` siblings; explicit `depends on T001, T002`; `after T003 and T004`; `requires`; ticked tasks; `*` bullets and indentation; 2- and 4-digit keys; an unknown dependency (dropped); a self-dependency (dropped); tasks before any heading; `###` headings; CRLF line endings.
- `test/fixtures/extract-json.json`: at least 10 cases. Cover: the last fenced block wins; an invalid last block falls back to the earlier one; fences without the `json` tag; a trailing object without a fence; nested braces; braces in prose before the JSON; no JSON (`null`); CRLF inside the fence.
- `test/fixtures/readiness.json`: at least 14 cases for `selectReady`. Cover: dependencies (done, skipped, unmet); open task question; open plan question (`pending: TASK-13`); `maxParallel`; global `maxAgents` across two projects; `busyAgents`; fairness by `lastStartAt` (`pending: TASK-09`); a paused run is ignored; the resume flag combinations; empty `filesOwned` never blocks; overlapping `filesOwned` produces `heldForOverlap` (`pending: TASK-14`).
- `test/fixtures/transitions.json`: at least one case per row T1–T19 of architecture §8. Mark T17 `pending: TASK-06`, T19 `pending: TASK-16`, and any phase-related case `pending: TASK-15`.
- `test/fixtures/pr-poll.json`: at least one case per step of architecture §12.2. Also cover: a bot trigger ignored; a comment whose ts equals the watermark is not fresh; head mismatch means pending; `none` within the grace period means pending; checks timeout; `ci_head` already acted on while in `pr_checks` goes to the inbox; rounds exhausted; changes requested still open blocks the merge; a pass while `pr_open` means wait.

## Out of scope
Any code under `src/`, and the test runner that executes these fixtures (TASK-03). Ownership and phase fixture files (`ownership.json`, `phases.json`) are created by TASK-14 and TASK-15.

## Target files
- `test/fixtures/README.md`
- `test/fixtures/tasks-md/*`
- `test/fixtures/extract-json.json`
- `test/fixtures/readiness.json`
- `test/fixtures/transitions.json`
- `test/fixtures/pr-poll.json`

## Done when
- Every row T1–T19 of architecture §8 and every step 1–7 of §12.2 has at least one case (list the mapping in `test/fixtures/README.md`).
- Every JSON file parses (`node -e "JSON.parse(require('fs').readFileSync(f))"` for each).
- Expected outputs match the requirements. Where they differ from current code, the case is listed under Behaviour changes.
- **Manual: the owner has reviewed and approved the fixtures** (PR approval). Merge policy for this task: manual.
- `npm run typecheck` passes and docs touched by this change (README, architecture, decisions) are updated in the same PR, including this brief's status line.
