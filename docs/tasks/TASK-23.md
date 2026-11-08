# TASK-23: "Update project docs" inbox item at the end of a run
**Status:** todo · **Wave:** 16 · **Depends on:** TASK-22 · **Parallel:** No

## Goal
When a run completes, orch tells the owner what to fold back into the project record: the REQ IDs the merged tasks covered, the decisions made during the run, the plan edits made in the dashboard, and the contracts the merged tasks named. It is an inbox item with a notification, built from stored facts with no LLM, and it closes when acknowledged. Its text is what the `orch-spec` fold-back mode takes as input.

## Covers
REQ-HITL-08

## Read first
- [CLAUDE.md](../../CLAUDE.md)
- [requirements.md §5.6](../requirements.md#56-human-in-the-loop-hitl): REQ-HITL-08 and edge cases
- [architecture.md §14](../architecture.md#14-inbox-decisions--notifications), [§20](../architecture.md#20-data-model--persistence)
- [decisions/0005](../decisions/0005-decisions-and-inbox.md)
- `src/orchestrator.ts` (run completion, where the "run complete" notification is sent), `src/db.ts` (migrations, TASK-07), `src/server.ts` (`/api/inbox`), `dashboard/index.html` (inbox rendering, TASK-11), `src/core/phases.ts` for the pattern of an inbox item with an Accept action

## Scope
- `src/db.ts`: migration adding `runs.docs_update_json` (text, null) and `runs.docs_update_ack_at` (integer, null).
- `src/core/docsUpdate.ts` (pure): `buildDocsUpdate(run, tasks, decisions, humanEdits)` → `{reqs: [...], decisions: [...], planEdits: [...], contracts: [...]}`, or `null` when no task merged. REQ IDs come from each merged task's brief `covers` (fall back to `REQ-…` matches in criteria); contracts from the brief; plan edits from human decisions of kind "edit" on tasks of the run.
- `src/orchestrator.ts`: on run completion, store the JSON, and send a notification "Update project docs: <project> <run title>" alongside the existing run-complete one (or fold into it).
- `src/server.ts`: include the item in `/api/inbox` (kind `docs_update`, with the project label) while unacknowledged; `POST /api/runs/:id/docs-update/ack` sets `docs_update_ack_at` and records a human decision.
- `dashboard/index.html`: render the item with the four lists and a **Copy** button (plain text in the shape the skill's fold-back mode expects) and **Acknowledge**.
- `src/cli.ts`: `orch docs-update [runId]` prints the text; `--ack` acknowledges.
- `scripts/e2e-briefs.mjs`: extend with the REQ-HITL-08 scenario (two REQs, two worker decisions, one dashboard edit → one item; ack removes it; an all-skipped run creates none).

## Out of scope
Running the skill or editing docs automatically (the owner runs fold-back). Changing the existing "run complete" semantics.

## Target files
- `src/db.ts`
- `src/core/docsUpdate.ts`
- `src/orchestrator.ts`
- `src/server.ts`
- `src/cli.ts`
- `dashboard/index.html`
- `scripts/e2e-briefs.mjs`
- `test/unit/docsUpdate.test.mjs`

## Done when
- Unit: `buildDocsUpdate` returns the expected four lists for a fixture run, and `null` for an all-skipped run.
- e2e: the REQ-HITL-08 scenario passes; the notification text names the project.
- `npm run typecheck && npm test` pass; architecture §14 and §20, the user guide's inbox page and the CLI reference are updated; this brief's status line and the task index are updated in the same PR.
