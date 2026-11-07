# 0017: File ownership: auto-serialize overlaps; advisory scope findings

- **Status:** Accepted, 2026-11-07
- **Requirements affected:** REQ-SCHED-02, REQ-VAL-05, REQ-INTAKE-04

## Context
Parallel `[P]` tasks that touch the same files produce merge conflicts that land in the inbox.

## Decision
The planner declares owned files/globs per task. The scheduler never runs two tasks with overlapping ownership at once (static-prefix overlap, conservative), records a decision and shows the implicit edge. The validator reports edits outside owned files as findings, not as a FAIL. Empty ownership means unconstrained.

## Alternatives rejected
- **Strict FAIL on out-of-scope edits.** False failures from narrow globs.
- **Warn at approval only.** Relies on the owner noticing.
- **Exact glob intersection.** Complex; static prefix is good enough.

## Consequences
- Over-serialization is the accepted cost.
