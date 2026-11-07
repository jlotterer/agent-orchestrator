# 0016: UI validation: orch manages the app under test

- **Status:** Accepted, 2026-11-07
- **Requirements affected:** REQ-VAL-08, REQ-VAL-09

## Context
Web UI changes need behavioural checks in a browser; competitors (Missions) do this. Agents left to start servers leak processes and clash on ports.

## Decision
For tasks in UI mode, orch starts the project's start command in the worktree on a free port, waits for readiness, gives the URL to the validator, and always stops the process group afterwards (pidfiles cover crashes). The validator drives the app with its own CLI's browser tooling.

## Alternatives rejected
- **Validator starts the app.** Orphaned servers, port clashes, nondeterminism.
- **orch-owned browser automation.** Dependency and vendor coupling.

## Consequences
- Browser tooling is configured per agent CLI (e.g. Playwright MCP); orch stays vendor-neutral.
