# 0012: One unfinished run per project; a global cap on concurrent agents

- **Status:** Accepted, 2026-11-07
- **Requirements affected:** REQ-PROJ-07, REQ-PROJ-08, REQ-PROJ-09, REQ-SCHED-01

## Context
All projects draw on the same agent subscription limits, so the scarce resource is concurrent agent sessions, not runs. The owner does not need every project running at once but should be able to.

## Decision
Each project has at most one unfinished run. Any number of projects may run; total concurrent agent sessions (task agents plus planners and phase validators) are capped by `scheduler.maxAgents`; per-project `maxParallel` applies inside it. Starts are distributed fairly across projects.

## Alternatives rejected
- **One project at a time.** A project blocked on a question idles the server.
- **No global cap.** Hits subscription limits.

## Consequences
- `maxAgents: 1` gives strict one-at-a-time behaviour without code changes.
