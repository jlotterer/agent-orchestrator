# TASK-22: Plan from briefs; rules and contracts for every agent
**Status:** todo · **Wave:** 15 · **Depends on:** TASK-20, TASK-21 · **Parallel:** No

## Goal
Wire TASK-20 and TASK-21 into the orchestrator. With briefs, `orch plan` builds the plan without an agent; the planner runs only for brief-less tasks or on `--review`. Workers, task validators and phase validators receive the brief, cited requirements, contracts and project rules. Conflicts, cuts and overrides are recorded as decisions.

## Covers
REQ-INTAKE-11 (plan values), REQ-INTAKE-12, REQ-INTAKE-14 (decisions at plan time), REQ-WORK-09, REQ-WORK-10 (wiring), REQ-WORK-11, REQ-VAL-10, REQ-VAL-11

## Read first
- [CLAUDE.md](../../CLAUDE.md)
- [requirements.md §5.2](../requirements.md#52-spec-intake--planning-intake), [§5.4](../requirements.md#54-worker-execution--context-work), [§5.5](../requirements.md#55-validation-val)
- [architecture.md §6](../architecture.md#6-spec-intake--planner), [§9](../architecture.md#9-worker--hand-off-brief), [§10](../architecture.md#10-validation)
- [decisions/0001](../decisions/0001-deterministic-orchestrator.md), [0004](../decisions/0004-independent-validation.md), [0023](../decisions/0023-orch-owns-spec-skill.md)
- `src/orchestrator.ts`: `plan*`, `specContext`, the worker, validator and phase-validator prompt assembly; `prompts/*.md`; `scripts/lib/e2e.mjs`, `scripts/fake-agent.mjs`, `scripts/e2e.mjs`

## Scope
- `src/orchestrator.ts`:
  - Plan: merge briefs into tasks (`mergeBriefIntoTask`); conflicts, `--allow-open` and warnings from `checkFeature` → `decide()` entries. If every task has criteria from a brief and `--review` is not set, skip the planner and record one decision "plan built from briefs". Otherwise run the planner over the brief-less tasks only, or over all tasks on `--review`; planner output never removes or rewrites brief criteria (additions are appended and recorded).
  - Context: replace `specContext()` with `assembleSpecContext()`; read `handoff.requirementsFile` and `handoff.projectFiles` from the repo on the base branch; record each cut as a decision naming the task, part and size.
  - Validators: task validators get the same spec context as the worker; phase validators get `spec.md` in full, each task's frontmatter and criteria, and the rules.
- `prompts/planner.md`: a review-mode section ("These tasks already have criteria from their briefs. Do not remove or rewrite them…"), and a project-rules section. `prompts/worker.md`: sections "Requirements covered", "Contracts", "Project rules" replacing "Project context (from the spec)" when a brief exists. `prompts/validator.md`, `validator-ui.md`: the same sections plus "Reject a change that breaks a project rule or a named contract; quote it." `prompts/phase-validator.md`: rules section.
- `src/cli.ts`: `plan --review` flag (passes through to the API) and `--allow-open` recording.
- `src/server.ts`: `review` and `allowOpen` on the plan endpoint.
- `scripts/e2e-briefs.mjs` (new, via `scripts/lib/e2e.mjs`): runs `test/fixtures/spec-dir/full` with fake agents: asserts no planner call without `--review`, one planner call when a brief is removed, the worker prompt order (brief, REQ rows, contract, rules), validator prompt containing the brief and not the worker log, and a `fake-agent.mjs` marker that makes the validator reject with a quoted rule and the feedback carrying it. Add to `npm run test:e2e`.
- One real run (prompts are product): record it in the PR.

## Out of scope
The end-of-run inbox item (TASK-23). The user guide page (TASK-24). Dashboard changes beyond showing planner-skipped decisions as they already appear.

## Target files
- `src/orchestrator.ts`
- `src/cli.ts`, `src/server.ts` (plan flags only)
- `prompts/planner.md`, `prompts/worker.md`, `prompts/validator.md`, `prompts/validator-ui.md`, `prompts/phase-validator.md`
- `scripts/e2e-briefs.mjs`, `scripts/fake-agent.mjs` (new markers), `package.json` (test:e2e)

## Done when
- e2e: the assertions above pass in the `node:22` container.
- Unit (`test/unit/core.test.mjs` or a new file): the REQ-INTAKE-12 planner-subset case using the fake planner.
- Manual: one real run of the `full` fixture (or a real feature folder written with the skill) on a scratch repo; the PR records the worker's and validator's prompts.
- `npm run check` passes (no LLM call on the deterministic path; no vendor names outside adapters).
- `npm run typecheck && npm test` pass; architecture §6, §9, §10 and README are updated; this brief's status line and the task index are updated in the same PR.
