# TASK-05: Server/project config split and ORCH_HOME
**Status:** done · **Wave:** 3 · **Depends on:** TASK-03 · **Parallel:** Yes (with TASK-06)

## Goal
Introduce the two-level configuration (server settings in `ORCH_HOME`, project settings in each repo) and the `ORCH_HOME` path layout, while the daemon keeps running single-repo through a compatibility adapter until TASK-09.

## Covers
REQ-PROJ-05, REQ-PROJ-06 (part), REQ-OPS-06 (part)

## Read first
- [CLAUDE.md](../../CLAUDE.md)
- [requirements.md §5.1](../requirements.md#51-projects-proj)
- [architecture.md §5.1](../architecture.md#51-orch_home-layout)
- [architecture.md §5.2](../architecture.md#52-project-settings-file)
- [architecture.md §19](../architecture.md#19-settings--environment)
- [decision 0013](../decisions/0013-project-config-in-repo.md)
- `src/config.ts` (current)

## Scope
- `src/paths.ts`: `orchHome()`, `serverConfigPath()`, `dbPath()`, `worktreesDir(projectId)`, `archiveDir(projectId)`, `runDir()`. All derive from `ORCH_HOME` (default `~/.orch`).
- `src/config.ts`: types `ServerConfig` and `ProjectConfig`, plus `loadServerConfig(home)` with the defaults of §19 (including `auth`, `retention`, `scheduler.maxAgents`, `git.ghCommand`, `defaults`). `loadProjectConfig(repoPath, server)` returns the effective project config (precedence per §5.2), throws on forbidden keys (message names the key), returns warnings for unknown keys, and checks `roles.*.adapter` exists on the server. Add `writeStarterProjectConfig(repoPath, {baseBranch})`, and `toLegacyConfig(server, project, repoPath)` returning today's `Config` shape so `orchestrator.ts` needs no change yet.
- `examples/server.example.json`. Rewrite `orch.config.example.json` to project keys only.
- `test/unit/config.test.mjs`: precedence (built-in < server defaults < project), each forbidden key rejected, unknown key warning, unknown adapter in roles rejected, `ORCH_HOME` override.

## Out of scope
DB/registry (TASK-07), daemon wiring and legacy upgrade execution (TASK-09), auth enforcement (TASK-08).

## Target files
- `src/config.ts`
- `src/paths.ts`
- `test/unit/config.test.mjs`
- `examples/server.example.json`
- `orch.config.example.json`

## Done when
- Given a project file with `agents.adapters`, `loadProjectConfig` throws an error containing `agents`.
- Given server `defaults.scheduler.maxParallel: 3` and no project value, the effective `maxParallel` is 3; given a project value of 1, it is 1.
- Existing single-config behaviour is unchanged: `npm test` passes.
- `npm run typecheck` passes and docs touched by this change (README, architecture, decisions) are updated in the same PR, including this brief's status line.
