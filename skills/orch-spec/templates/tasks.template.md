<!--
Template notes (do not copy into the output):
- tasks.md stays exactly the Spec Kit format orch has always read (architecture §6.1): `##` headings are phases;
  a task line is `- [ ] T001 [P] <title>`. Nothing else is parsed. The key names the brief: tasks/T001.md.
- Every task in a later phase depends on every task in earlier phases (REQ-INTAKE-02), so put independent work in
  the same phase and mark it [P]. Within a phase, a task without [P] depends on the previous task.
- [P] only when the tasks share no target files and neither imports a module the other creates. The brief's
  `parallel:` wins over the mark if they differ. A dependency on a non-adjacent sibling goes in the brief's
  `depends_on` (orch honours it); the task then has no [P].
- Keys are stable: never renumber, never reuse. New tasks get the next key.
- orch ticks a task `[x]` when it is done (git.tickTasksMd), on the base branch. Do not pre-tick.
-->
# Tasks: <Feature title>

Feature folder with one brief per task under `tasks/`. `[P]` = may run in parallel with siblings.

## Phase 1: Foundation
- [ ] T001 <Shared types, scaffold, fixture tables: the files every later task needs>

## Phase 2: Core
- [ ] T002 [P] <…>
- [ ] T003 [P] <…>

## Phase 3: Integration
- [ ] T004 <Wires the parallel parts together; depends on the whole of phase 2>
