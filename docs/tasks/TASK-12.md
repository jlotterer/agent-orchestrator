# TASK-12: Event archive and retention
**Status:** done · **Wave:** 7 · **Depends on:** TASK-07, TASK-09 · **Parallel:** Yes (with TASK-11)

## Goal
Keep the database bounded. Archive agent event logs of runs that finished long ago to compressed files, then delete them, without touching decisions, questions, task data or costs.

## Covers
REQ-OPS-04

## Read first
- [CLAUDE.md](../../CLAUDE.md)
- [requirements.md §5.11](../requirements.md#511-operations--security-ops)
- [architecture.md §17](../architecture.md#17-retention--archive)
- [architecture.md §5.1](../architecture.md#51-orch_home-layout)
- [decision 0019](../decisions/0019-event-archive-retention.md)

## Scope
- `src/archive.ts`: `archiveEligibleRuns(store, {now, eventDays, archiveRoot}): Promise<{archived: string[], errors: string[]}>` per architecture §17 (stream to a `.tmp` file, fsync, rename, then a single transaction that deletes the run's events and sets `archived_at`).
- `src/db.ts`: `listArchivableRuns(beforeIso)`, `iterateRunEvents(runId)`, `deleteRunEventsAndMarkArchived(runId, ts)`.
- `src/cli.ts`: run at `serve` startup and every 24 h; add an `orch archive-events` command.
- `src/server.ts`: for archived runs, task and run event endpoints return one synthetic `info` event "Log archived to <path>".

## Out of scope
Dashboard changes (none needed: info events already render).

## Target files
- `src/archive.ts`
- `src/db.ts`
- `src/cli.ts`
- `src/server.ts`
- `test/unit/archive.test.mjs`

## Done when
- Unit: given a run finished 40 days ago with 3 events and `eventDays: 30`, the archive file exists, gunzips to 3 JSON lines, the events are gone, and the decisions remain.
- Unit: given an unfinished run 90 days old, nothing is archived.
- Unit: given an unwritable archive root, no events are deleted and an error is returned.
- `npm test` passes.
- `npm run typecheck` passes and docs touched by this change (README, architecture, decisions) are updated in the same PR, including this brief's status line.
