# TASK-06: Diff review and send back to the worker
**Status:** todo · **Wave:** 3 · **Depends on:** TASK-03 · **Parallel:** Yes (with TASK-05)

## Goal
Let the owner review a task's code changes in the dashboard and send it back with written feedback. This is the missing review surface for local-merge mode, and a quicker path than GitHub in PR mode.

## Covers
REQ-UI-03, REQ-UI-04, REQ-HITL-07, REQ-GIT-03

## Read first
- [CLAUDE.md](../../CLAUDE.md)
- [requirements.md §5.10](../requirements.md#510-interfaces-ui)
- [requirements.md §5.6](../requirements.md#56-human-in-the-loop-hitl)
- [architecture.md §11](../architecture.md#11-git--merge)
- [architecture.md §12.3](../architecture.md#123-fix-round)
- [architecture.md §8](../architecture.md#8-task-state-machine)
- [architecture.md §15.1](../architecture.md#151-http-api)
- [architecture.md §15.3](../architecture.md#153-dashboard)
- [decision 0018](../decisions/0018-hand-rolled-diff-viewer.md)

## Scope
- `src/git.ts`: `diffFiles(worktree): Promise<{base, head, files: {path, status, additions, deletions, binary, patch}[], truncated}>` per architecture §11.
- `src/server.ts`: `GET /api/tasks/:id/diff` (404 with a reason when the worktree is gone) and `POST /api/tasks/:id/request-changes {feedback}`.
- `src/orchestrator.ts`: `requestChanges(taskId, feedback)` for `pr_open|pr_checks` tasks. It uses transition T17 and `startFixRound` kind `human` (owner text under "## Feedback from the owner", round cap ignored, remote sync skipped in local mode), with a human decision.
- `src/core/transitions.ts` and `test/fixtures/transitions.json`: implement T17 and remove its `pending` marker.
- `dashboard/index.html`: a Diff section in the task drawer, loaded on expand. It shows the file list with +/− counts and a collapsible unified diff per file, with added and removed lines coloured, a binary note, and a truncation notice. Add a Send back textarea and button for `pr_open|pr_checks` tasks, also on the inbox merge card.
- `scripts/e2e.mjs`: before approving T004's merge, `GET` its diff (expects `impl/T004.txt` with additions ≥ 1), then request changes with "add a trailing note". After the worker round, merge and assert `impl/T004.txt` contains `note`. `scripts/fake-agent.mjs`: on retry with "trailing note" in the prompt, write `OK note`.

## Out of scope
Syntax highlighting or side-by-side diffs. Project-scoped UI (TASK-11).

## Target files
- `src/git.ts`
- `src/server.ts`
- `src/orchestrator.ts`
- `src/core/transitions.ts`
- `test/fixtures/transitions.json`
- `dashboard/index.html`
- `scripts/e2e.mjs`
- `scripts/fake-agent.mjs`
- `README.md`

## Done when
- The e2e assertions above pass, and `e2e-pr.mjs` still passes (covers REQ-GIT-03).
- The T17 fixture cases pass.
- **Manual:** screenshots of the diff viewer in dark and light themes attached to the PR.
- `npm run typecheck` passes and docs touched by this change (README, architecture, decisions) are updated in the same PR, including this brief's status line.
