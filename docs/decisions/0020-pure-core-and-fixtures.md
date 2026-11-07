# 0020: Pure decision functions pinned by owner-reviewed fixtures

- **Status:** Accepted, 2026-11-07
- **Requirements affected:** REQ-NFR-05, REQ-SCHED-01, REQ-PRFB-01 … REQ-PRFB-07

## Context
The riskiest logic (task transitions incl. the PR loop, readiness across projects, the tasks.md parser, JSON extraction) is easy to get subtly wrong and easy for agents to "improve". It currently lives inside side-effecting code.

## Decision
Extract these decisions into pure functions in `src/core/` and drive their tests from fixture tables in `test/fixtures/`, written spec-first (TASK-01) and reviewed by the owner before implementation.

## Alternatives rejected
- **Black-box golden files and more e2e only.** Slow, imprecise, hard to locate failures.

## Consequences
- Changing a fixture's expected output is a behaviour change: it needs the owner's review in the PR.
- `src/core/` MUST NOT import fs, child_process, or read the clock.
