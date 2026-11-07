# TASK-10: Projects API, global inbox and CLI scoping
**Status:** todo · **Wave:** 6 · **Depends on:** TASK-09 · **Parallel:** No

## Goal
Expose projects over HTTP and the CLI: register, list, archive, per-project state, and a global inbox. Make every CLI command project-aware with consistent exit codes.

## Covers
REQ-PROJ-01, REQ-PROJ-03 (part), REQ-PROJ-04, REQ-HITL-01 (part), REQ-UI-07, REQ-UI-08, REQ-NFR-06

## Read first
- [CLAUDE.md](../../CLAUDE.md)
- [requirements.md §5.1](../requirements.md#51-projects-proj)
- [requirements.md §5.10](../requirements.md#510-interfaces-ui)
- [architecture.md §15.1](../architecture.md#151-http-api)
- [architecture.md §15.2](../architecture.md#152-cli)
- [architecture.md §5.4](../architecture.md#54-cli-project-resolution)
- [architecture.md §14](../architecture.md#14-inbox-decisions--notifications)

## Scope
- `src/server.ts`: the project routes of architecture §15.1 (`/api/projects`, `DELETE /api/projects/:id`, `/api/projects/:id/state`, `/api/inbox`, `/api/projects/:id/plan`). The `change` SSE payloads include `projectId`.
- `src/orchestrator.ts`: a per-project `snapshot(projectId, runId?)` with `inboxCount`, and `globalInbox()` whose items carry `project_id` and `project_name`. Neither may scan the events table.
- `src/cli.ts`: `project add <path> [--name]`, `project list`, and `project remove <id>`. Add the global `--project` flag and `ORCH_PROJECT`, resolving via `resolveProjectForCwd` (§5.4). Exit codes: 0 / 1 (`error:` on stderr) / 2 (usage, including an ambiguous project, listing the projects).
- `test/unit/perf.test.mjs`: seed a DB with 200 tasks and 100k events and assert the project snapshot builds in under 1 s.
- Extend `scripts/e2e-multi.mjs` with the CLI assertions under Done when. Update `README.md`.

## Out of scope
Dashboard (TASK-11).

## Target files
- `src/server.ts`
- `src/cli.ts`
- `src/orchestrator.ts`
- `test/unit/perf.test.mjs`
- `scripts/e2e-multi.mjs`
- `README.md`

## Done when
- e2e: `orch project add <non-git dir>` exits 1 with "not a git repository", and `orch project add <repo>` prints the starter config path.
- e2e: inside repo B, `orch status` shows B; outside both repos, it exits 2 listing both; `orch answer` with no args exits 2.
- e2e: `GET /api/inbox` returns items from both projects with `project_name`; `DELETE` on a project with a running run returns 400.
- `perf.test.mjs` passes.
- `npm test` passes.
- `npm run typecheck` passes and docs touched by this change (README, architecture, decisions) are updated in the same PR, including this brief's status line.
