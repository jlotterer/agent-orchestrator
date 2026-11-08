# Task file format

orch reads a feature's tasks from `tasks.md` in the feature folder. It uses Spec Kit's format, but any Markdown file that follows the rules on this page works.

## Example

```markdown
## Phase 1: Setup
- [ ] T001 Create the project skeleton

## Phase 2: Core
- [ ] T002 [P] Implement POST /auth/signup in src/routes/auth.ts
- [ ] T003 [P] Implement POST /auth/login
- [ ] T004 Add auth middleware (depends on T003)
- [x] T005 Write the README section
```

## Lines orch reads

| Element | Format | Notes |
| :--- | :--- | :--- |
| Phase | A heading that starts with `##` or `###` | Every task below it, up to the next such heading, belongs to that phase. |
| Task | `- [ ] T001 <text>` | `*` bullets and indented lines also work. The ID is `T` followed by 2 to 4 digits. |
| Parallel marker | `[P]` right after the ID | The task may run at the same time as other tasks in its phase. |
| Done task | `- [x] T001 <text>` | Imported as already done. |

The task's title is its text, cut to 110 characters. Its description is the full text. Other lines are ignored by the importer, but the planner reads the whole file and the spec.

## How orch works out dependencies

A task depends on:

1. Every task in earlier phases.
2. The previous task in its own phase, unless it's marked `[P]`.
3. Any task named in its text with "depends on", "after" or "requires", such as "(depends on T003)" or "after T001 and T002". The words aren't case-sensitive.

orch drops a dependency on a task that doesn't exist, and a dependency of a task on itself.

In the example:

- T002 and T003 depend on T001, and can run at the same time.
- T004 depends on T001 and on T003, because it isn't marked `[P]` and also names T003. It doesn't depend on T002.
- T005 is already done.

The planner can change these dependencies, and so can you. See [Review and approve a plan](../how-to/review-a-plan.md#edit-a-task). To check how orch reads a file before you plan it, use `orch plan <spec-folder> --dry-run` (**Planned**).

## What orch writes back

After a task merges, orch changes its line from `- [ ]` to `- [x]` on the base branch. It never changes `tasks.md` on task branches, and it never adds fix-up tasks to it. Workers are told not to edit `tasks.md`, `spec.md` or `plan.md`.

To turn ticking off, set `git.tickTasksMd` to `false` in the project settings.
