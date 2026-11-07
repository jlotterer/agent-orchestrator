# TASK-16: UI validation mode and gate output for validators
**Status:** todo · **Wave:** 11 · **Depends on:** TASK-15 · **Parallel:** No

## Goal
Let UI tasks be validated against the running app: orch starts the app, the validator drives it with its browser tooling, and orch always cleans up. Also give every validator the test-gate output.

## Covers
REQ-VAL-02, REQ-VAL-08, REQ-VAL-09, REQ-INTAKE-04 (part), REQ-INTAKE-09 (part)

## Read first
- [CLAUDE.md](../../CLAUDE.md)
- [requirements.md §5.5](../requirements.md#55-validation-val)
- [architecture.md §10.4](../architecture.md#104-ui-validation-mode)
- [architecture.md §10.1](../architecture.md#101-gate)
- [architecture.md §10.2](../architecture.md#102-validator)
- [architecture.md §13.2](../architecture.md#132-json-contracts)
- [architecture.md §8](../architecture.md#8-task-state-machine)
- [decision 0016](../decisions/0016-ui-validation-app-lifecycle.md)

## Scope
- `src/appserver.ts`: `startApp({cwd, startCommand, urlTemplate, env, readyTimeoutSeconds, pidDir, taskId}) → {url, stop(), output()}` and `killLeftovers(pidDir)`, per architecture §10.4.
- `src/orchestrator.ts`: for `validate_mode === "ui"`, start the app after the gate, pass `app_url`, and stop it in `finally`, on stop and on shutdown. `recover()` calls `killLeftovers`. Pass `gate_output` to all validators. Handle the `BLOCKED` verdict (T19).
- `src/core/transitions.ts` and `test/fixtures/transitions.json`: implement T19 and remove its `pending` marker.
- Prompts: `prompts/validator-ui.md` (new), `prompts/validator.md` (`{{gate_output}}`), and `prompts/planner.md` (proposes `validate_mode`).
- `dashboard/index.html`: the mode select in the edit dialog, and the mode shown in the Plan tab.
- `scripts/fake-app.mjs`: an HTTP server on `PORT` (with a `NEVER_READY` env mode). `scripts/e2e-ui.mjs`: the e2e checks listed under Done when.
- Update `README.md` with how to give Claude Code a browser tool (e.g. Playwright MCP).

## Out of scope
orch-owned browser automation (rejected in decision 0016).

## Target files
- `src/appserver.ts`
- `src/orchestrator.ts`
- `src/core/transitions.ts`
- `test/fixtures/transitions.json`
- `prompts/validator-ui.md`
- `prompts/validator.md`
- `prompts/planner.md`
- `dashboard/index.html`
- `scripts/fake-app.mjs`
- `scripts/e2e-ui.mjs`
- `scripts/fake-agent.mjs`
- `package.json`
- `README.md`

## Done when
- e2e: a UI-mode task. The fake validator fetches `app_url` and PASSes only if it gets 200; afterwards no `fake-app` process remains (checked by pidfile and `kill -0`).
- e2e: `NEVER_READY` with a 3 s readiness timeout → the attempt fails with the app output in the feedback.
- e2e: a fake validator returning `BLOCKED` → the task fails immediately (attempt 1), and the inbox shows it.
- e2e: kill the daemon during UI validation and restart → the leftover app process is killed.
- Unit/e2e: the validator prompt contains the gate output.
- **Manual:** one real UI task with Claude Code plus a browser MCP; attach the verdict.
- `npm test` passes.
- `npm run typecheck` passes and docs touched by this change (README, architecture, decisions) are updated in the same PR, including this brief's status line.
