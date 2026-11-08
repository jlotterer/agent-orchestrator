# TASK-11: Dashboard: projects, global inbox, reconnect
**Status:** done · **Wave:** 7 · **Depends on:** TASK-10 · **Parallel:** Yes (with TASK-12)

## Goal
Bring multi-project to the dashboard: a project switcher with status and inbox counts, adding and archiving projects, a global inbox labelled by project, per-project board, plan and decisions, and resilient live updates.

## Covers
REQ-PROJ-03, REQ-HITL-01, REQ-UI-01, REQ-UI-02, REQ-UI-05

## Read first
- [CLAUDE.md](../../CLAUDE.md)
- [requirements.md §5.10](../requirements.md#510-interfaces-ui)
- [requirements.md §5.6](../requirements.md#56-human-in-the-loop-hitl)
- [architecture.md §15.3](../architecture.md#153-dashboard)
- [architecture.md §15.1](../architecture.md#151-http-api)
- [decision 0011](../decisions/0011-multi-project-daemon.md)

## Scope
- `dashboard/index.html`:
  - A project switcher in the top bar with a status dot (run status) and an inbox count per project. An Add project dialog (path, optional name) shows API errors inline. An Archive action asks for confirmation.
  - A global inbox: every item shows a project tag, and clicking an item switches to its project.
  - Board, Plan, Decisions, Activity and the run selector are scoped to the selected project. The selection persists in `localStorage` (wrapped in try/catch).
  - A project error state (repo missing or bad config) is shown in place of the board.
  - SSE reconnect per §15.3: backoff from 1 s to 30 s, and a full refresh on reconnect.

## Out of scope
New API (TASK-10 done); diff viewer (TASK-06 done).

## Target files
- `dashboard/index.html`

## Done when
- e2e (in `e2e-multi.mjs`): the served HTML contains the switcher and global inbox containers (stable element ids documented in the PR).
- **Manual:** with two projects, one with an open question, the switcher shows counts, the inbox tags both, and switching shows the right board. Screenshots in dark and light themes and at phone width.
- **Manual:** restart the daemon with the dashboard open → live updates resume within 30 s without a reload.
- `npm test` passes.
- `npm run typecheck` passes and docs touched by this change (README, architecture, decisions) are updated in the same PR, including this brief's status line.
