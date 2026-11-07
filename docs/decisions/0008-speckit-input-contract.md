# 0008: Spec Kit tasks.md is the input contract, not a dependency

- **Status:** Accepted, 2026-11-07
- **Requirements affected:** REQ-INTAKE-01, REQ-INTAKE-02, REQ-GIT-05

## Context
The owner authors specs with GitHub Spec Kit and wants to keep that flow.

## Decision
orch reads any markdown with `- [ ] T001 …` lines using Spec Kit semantics (phases, `[P]`, explicit dependencies) and ticks tasks after merge. It never requires Spec Kit to be installed.

## Alternatives rejected
- **orch's own planner from free text (Missions).** Replaces the owner's authoring flow.
- **Issue trackers as the only source.** Out of scope this round.

## Consequences
- Parser changes MUST keep the fixture files in `test/fixtures/tasks-md/` passing.
