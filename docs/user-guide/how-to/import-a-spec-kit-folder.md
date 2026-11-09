# Import a Spec Kit folder

orch plans a feature folder written with GitHub Spec Kit, or with any tool that writes the same `tasks.md` format, as it is. That path gives agents less to work with than a folder written by the `orch-spec` skill. This page explains the difference and how to close it with the skill's adopt mode.

## Plan a Spec Kit folder as it is

1. Write the feature with Spec Kit's `/speckit.specify`, `/speckit.plan` and `/speckit.tasks` commands. You get a folder such as `specs/003-speckit/` with `spec.md`, `plan.md`, `tasks.md` and often `data-model.md` and `contracts/`.
2. Preview it. A folder without briefs shows `brief: no` for every task:

   ```text
   $ orch plan specs/003-speckit --dry-run
   dry run: "Session authentication" (/home/you/projects/shop/specs/003-speckit) for project shop: 4 tasks; nothing was created

   Phase 3.1: Setup
     [x]     T001  Create src/auth/ and test/auth/ with the session types from data-model.md
               brief: no
               depends on: none

   Phase 3.2: Core
     [ ]     T002  Implement the in-memory session store in src/auth/store.ts
               brief: no
               depends on: T001
     [ ] [P] T003  Login and logout endpoints per contracts/one.md in src/auth/routes.ts
               brief: no
               depends on: T001
     [ ] [P] T004  Auth middleware in src/auth/middleware.ts
               brief: no
               depends on: T001

   checks: no problems
   ```

3. Plan it with `orch plan specs/003-speckit`. The planner agent writes acceptance criteria for every task, checks the dependencies, and proposes merge policies, test commands and owned files. See [Plan a feature](plan-a-feature.md).

## What agents get without briefs

| | Folder with briefs (orch-spec) | Spec Kit folder |
| :--- | :--- | :--- |
| Acceptance criteria | Written with you in the interview, in the brief | Written by the planner agent from the spec |
| Planning | No agent call when every brief has criteria | One planner call per plan |
| Worker context | The brief, the requirement rows it cites, the contracts it names, the project rules file | Excerpts of `spec.md`, `data-model.md` and `plan.md`, in that order, each within its own size limit, then the folder's other files and `contracts/` |
| Validator context | The same brief, requirements, contracts and rules as the worker | The same spec excerpts and rules as the worker |

In both cases workers and validators get the project rules file (`AGENTS.md` by default) when it exists, and the hand-off of earlier work. To change which spec files come first or how much of each a worker gets, see the `handoff.contextFiles` and `handoff.specChars` settings in [Project settings](../reference/project-settings.md#worker-context-handoff).

## Add briefs with adopt mode

The `orch-spec` skill's adopt mode turns a Spec Kit folder into a full feature folder with a brief per task. It never changes the task keys, their order, the `[P]` markers or the ticks in `tasks.md`, so a folder whose tasks are partly done keeps its progress.

1. Install the skill. See [Write specs with the orch-spec skill](write-specs-with-orch-spec.md#before-you-start).
2. In Claude Code, in the project's repository, run:

   ```text
   /orch-spec adopt specs/003-speckit
   ```

3. The skill first writes a skeleton brief for every task that has none, with the task's effective dependencies and parallel flag. It uses `scaffold-briefs.mjs`, which you can also run yourself; `--dry-run` lists what it would write:

   ```text
   $ node ~/orch/skills/orch-spec/scripts/scaffold-briefs.mjs specs/003-speckit --dry-run
   would write tasks/T001.md
   would write tasks/T002.md
   would write tasks/T003.md
   would write tasks/T004.md
   ```

4. The skill fills each brief from `spec.md`, `plan.md`, `data-model.md` and `contracts/`, and adds **Covers** and **Contracts** sections to `spec.md`. It asks you to resolve every `[NEEDS CLARIFICATION]` marker, because orch refuses to plan a folder with unresolved markers unless you pass `--allow-open`.
5. The skill runs its check script and fixes what it reports. Review the briefs, commit the folder, and preview it again: each task now shows `brief: tasks/T00N.md`.

From here the folder works like one the skill wrote: continue with [Step 3 of Write specs with the orch-spec skill](write-specs-with-orch-spec.md#step-3-run-the-feature-with-orch).

## Related pages

- [Task file format](../reference/tasks-file.md)
- [Folder checks](plan-a-feature.md#folder-checks)
- [What agents see and do](../reference/agents.md)
