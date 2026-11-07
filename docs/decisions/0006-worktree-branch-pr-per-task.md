# 0006: One worktree, one branch, one PR per task; risky work waits for the owner

- **Status:** Accepted, 2026-11-07
- **Requirements affected:** REQ-WORK-01, REQ-GIT-01 … REQ-GIT-06

## Context
The owner already works PR-per-task. Parallel agents must not share a working tree. Some changes (auth, migrations, billing, irreversible) need human review.

## Decision
Each task gets a git worktree outside the repo and its own branch and PR. Merge policy is `auto` or `manual` per task; the planner marks risky tasks `manual`. Merge-step failures go to the inbox without consuming worker attempts. `tasks.md` ticks happen on the base branch only.

## Alternatives rejected
- **Shared working tree.** Unsafe in parallel.
- **Ticks on task branches.** Adjacent-line conflicts between parallel branches.

## Consequences
- Agents MUST NOT write orch state into task branches.
