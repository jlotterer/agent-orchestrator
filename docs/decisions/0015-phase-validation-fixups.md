# 0015: Phase validation creates fix-up tasks automatically

- **Status:** Accepted, 2026-11-07
- **Requirements affected:** REQ-VAL-06, REQ-VAL-07

## Context
Per-task validation checks pieces; nothing checks that a phase works as a whole (Missions' milestone validation).

## Decision
When a phase completes, orch validates it on the base branch (phase command + phase validator). On failure it creates a synthetic fix-up task that later phases wait for, up to a configured number of rounds, then the inbox.

## Alternatives rejected
- **Inbox only.** Stalls the run for routine fixes.
- **Fix-up task needing approval.** Extra owner clicks for the common case.

## Consequences
- Synthetic tasks are never ticked in `tasks.md`. Later phases also wait while an earlier phase validation is running or needs the owner.
