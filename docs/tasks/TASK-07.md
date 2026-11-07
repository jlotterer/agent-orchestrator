# TASK-07: Project registry and versioned DB migrations
**Status:** todo · **Wave:** 4 · **Depends on:** TASK-05 · **Parallel:** Yes (with TASK-08)

## Goal
Give the database a versioned migration path and the tables and columns that multi-project, phases, ownership, UI mode, costs and archiving need. Add the project registry module.

## Covers
REQ-PROJ-01 (part), REQ-PROJ-02, REQ-PROJ-04, REQ-OPS-05

## Read first
- [CLAUDE.md](../../CLAUDE.md)
- [requirements.md §5.1](../requirements.md#51-projects-proj)
- [architecture.md §5.3](../architecture.md#53-registry)
- [architecture.md §20](../architecture.md#20-data-model--persistence)
- [decision 0011](../decisions/0011-multi-project-daemon.md)
- [decision 0002](../decisions/0002-sqlite-single-source-of-truth.md)
- `src/db.ts` (current `TASK_MIGRATIONS`)

## Scope
- `src/db.ts`: a `PRAGMA user_version` migration runner. Migration 1 is today's schema plus the R1 columns, idempotent on existing DBs. Migration 2 adds the `projects` table, `runs.project_id`, `runs.cost_usd`, `runs.agent_ms`, `runs.archived_at`, `tasks.files_owned` (default `'[]'`), `tasks.validate_mode` (default `'standard'`), `tasks.synthetic` (default 0), `tasks.cost_usd`, `tasks.agent_ms`, and the `phases` table, and rebuilds `questions` with a nullable `task_id`.
- `Store` methods: `addProject`, `getProject`, `getProjectByPath`, `listProjects({archived})`, `setProjectArchived`, `touchProjectStart`, `upsertPhase`, `listPhases(runId)`, `updatePhase`, and `addQuestion(runId, taskId | null, …)`. The JSON columns map to arrays.
- `src/projects.ts`: `registerProject(store, path, {name?})` per architecture §5.3 (realpath, git toplevel check, slug id with suffixes, un-archive on re-add, starter config via `writeStarterProjectConfig`). Returns `{project, configCreated?}`. Add `archiveProject(store, id)`, refused with a run-naming error when an unfinished run exists, and `resolveProjectForCwd(projects, cwd)`.
- `src/types.ts`: `Project`, `Phase`, and the new Task/Run fields.

## Out of scope
Daemon use of projects (TASK-09), API/CLI (TASK-10).

## Target files
- `src/db.ts`
- `src/projects.ts`
- `src/types.ts`
- `test/unit/db.test.mjs`
- `test/unit/projects.test.mjs`

## Done when
- Given a DB created with the pre-migration schema (built in the test) with a run, a task, a decision and a question, opening it with `Store` keeps all rows and sets `user_version` to 2.
- Opening an already-migrated DB again changes nothing.
- Registering a non-git directory throws "not a git repository". Registering the same path twice throws naming the existing project id.
- Archiving a project with a `paused` run throws naming the run. Re-registering an archived path un-archives it.
- `npm test` passes.
- `npm run typecheck` passes and docs touched by this change (README, architecture, decisions) are updated in the same PR, including this brief's status line.
