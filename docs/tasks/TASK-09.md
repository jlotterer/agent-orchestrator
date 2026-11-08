# TASK-09: Multi-project orchestration and global agent cap
**Status:** done · **Wave:** 5 · **Depends on:** TASK-03, TASK-07, TASK-08 · **Parallel:** No

## Goal
Make one daemon run many projects. Each project gets its effective config, git context and merge lock. Each project has at most one unfinished run. A global cap limits concurrent agents, and starts are shared fairly between projects. Existing single-repo installs upgrade automatically.

## Covers
REQ-PROJ-06, REQ-PROJ-07, REQ-PROJ-08, REQ-PROJ-09, REQ-PROJ-10, REQ-SCHED-01, REQ-HITL-02, REQ-ADAPT-01, REQ-OPS-06

## Read first
- [CLAUDE.md](../../CLAUDE.md)
- [requirements.md §5.1](../requirements.md#51-projects-proj)
- [architecture.md §5](../architecture.md#5-projects--configuration)
- [architecture.md §5.5](../architecture.md#55-legacy-upgrade)
- [architecture.md §7.1](../architecture.md#71-readiness)
- [architecture.md §7.3](../architecture.md#73-tick)
- [architecture.md §7.4](../architecture.md#74-run-control)
- [architecture.md §14](../architecture.md#14-inbox-decisions--notifications)
- [decision 0011](../decisions/0011-multi-project-daemon.md)
- [decision 0012](../decisions/0012-global-agent-cap.md)
- [decision 0013](../decisions/0013-project-config-in-repo.md)

## Scope
- `src/orchestrator.ts`: construct it from `ServerConfig` + `Store`. Keep a map of `ProjectContext` (effective config, `Git`, merge lock), rebuilt at run creation and start. `plan(projectId, specDir, opts)` and `start(runId)` refuse while the project has another unfinished run. The tick spans all projects and calls `selectReady` with `maxAgents` and `busyAgents` (planners counted). Update `projects.last_start_at` when starting. Worktrees go under `worktreesDir(project)`. Roles resolve per project. Keep the legacy routes working against a default project (the first non-archived one).
- `src/core/readiness.ts` and `test/fixtures/readiness.json`: implement cross-project fairness, and remove the `pending: TASK-09` markers.
- `src/notify.ts`: titles are prefixed with `[<project name>] `.
- `src/cli.ts` (`serve` only): use `ORCH_HOME`, and perform the legacy upgrade of architecture §5.5 (with its decision record entry).
- `scripts/e2e-multi.mjs`: two repos with `maxAgents: 1`. Assert by polling that never more than one task is active, that the second project's single task starts before the first project's third, that refused plans name the unfinished run, and that notifications captured by a local HTTP sink contain project names. Add a legacy-upgrade scenario: start from an old-style `orch.config.json` plus the DB from a previous run → the project is registered and the old run is visible.
- Update the existing e2e scripts to set `ORCH_HOME` to their temp dir. Update `docs/docker.md` (one `/work` data dir as `ORCH_HOME`, repos as projects), `orch.service`, and `README.md`.

## Out of scope
Projects HTTP API and CLI project commands (TASK-10), dashboard switcher (TASK-11).

## Target files
- `src/orchestrator.ts`
- `src/core/readiness.ts`
- `test/fixtures/readiness.json`
- `src/notify.ts`
- `src/cli.ts`
- `scripts/e2e-multi.mjs`
- `scripts/e2e.mjs`
- `scripts/e2e-pr.mjs`
- `scripts/e2e-lifecycle.mjs`
- `scripts/e2e-auth.mjs`
- `package.json`
- `docs/docker.md`
- `orch.service`
- `README.md`

## Done when
- The `e2e-multi.mjs` assertions above pass.
- All readiness fixtures without `pending` pass, including the fairness cases.
- All earlier e2e scenarios pass unchanged apart from setting `ORCH_HOME`.
- `npm test` passes.
- `npm run typecheck` passes and docs touched by this change (README, architecture, decisions) are updated in the same PR, including this brief's status line.
