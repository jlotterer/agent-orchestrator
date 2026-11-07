# 0013: Project settings live in the repo; server settings are separate

- **Status:** Accepted, 2026-11-07
- **Requirements affected:** REQ-PROJ-05, REQ-PROJ-06, REQ-ADAPT-01

## Context
With many projects, settings split into per-project (branch, tests, git/PR, roles) and server-wide (network, auth, notifications, agent CLI definitions). Settings should be versioned and visible to reviewers and agents.

## Decision
Each repo has `orch.config.json` with project keys only. `$ORCH_HOME/server.json` holds server keys and project defaults. Project files cannot define agent commands, credentials, network or auth; roles may only pick adapters the server defines. Effective config is rebuilt at run creation/start.

## Alternatives rejected
- **Settings in the DB edited in the UI.** Unversioned, invisible to agents.
- **File plus UI overrides.** Two sources of truth.

## Consequences
- A cloned repo cannot make orch run arbitrary agent binaries or leak server credentials (test commands are already arbitrary by design).
