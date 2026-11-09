# Plan a feature

Planning turns a feature's `tasks.md` into a run that orch can execute. orch imports the tasks, works out their order, and, unless you turn it off, asks a planner agent to add acceptance criteria and check the plan.

## Prepare the feature folder

orch reads a feature folder, such as `specs/003-checkout/`. It needs:

- `tasks.md` (required): the task list. See [Task file format](../reference/tasks-file.md).
- `spec.md` and `plan.md` (recommended): the planner reads them, and workers get an excerpt of them.

Spec Kit's `/speckit.specify`, `/speckit.plan` and `/speckit.tasks` commands create these files. Any Markdown task list that follows the `- [ ] T001 …` format works, with or without Spec Kit.

Put the feature folder inside the project's repo. orch uses its location to pick the project.

## Draft a plan from the command line

1. Make sure the project has no unfinished run. Each project can have only one run that's planning, awaiting approval, ready, running or paused.
2. Run:

   ```bash
   orch plan <spec-folder>
   ```

   `<spec-folder>` is the feature folder, for example `specs/003-checkout`. It can be relative to your current folder.

3. Wait for the planner. It usually takes a minute or two. orch then prints the run ID, its title and its status, `plan_pending`.
4. Review the plan in the dashboard. See [Review and approve a plan](review-a-plan.md).

To import the tasks without running the planner, add `--no-llm`. The run goes straight to `plan_pending` with the tasks as written, with no acceptance criteria. The validator then judges each task against its description.

## Draft a plan from the dashboard

1. In the top bar, select **New plan…**.
2. In **Spec directory**, enter the feature folder, for example `specs/003-checkout`. You can use an absolute path or a path relative to the repo.
3. To skip the planner, clear the **Run the planner agent to write acceptance criteria and check dependencies** checkbox.
4. Select **Draft plan**.

The new run appears in the run selector in the top bar.

## What the planner does

The planner reads every file in the feature folder and the imported task list. For each task, it proposes:

- Acceptance criteria: two to six checkable statements, such as "test X passes" or "endpoint returns Y".
- Dependencies: the smallest set of tasks that must merge first. It adds missing ones and removes wrong ones.
- A merge policy: `manual` for tasks a person should review, such as authentication, data migrations, billing, deleting data, public API changes, or anything irreversible; `auto` otherwise.
- A task-specific test command, when the task needs a narrower or different check.
- A validation mode, `standard` or `ui`.
- The files the task owns.

It records each choice in the **Decisions** tab with its reasoning. If something in the spec is ambiguous enough to matter, it asks you instead of guessing.

If the planner fails or returns nothing usable, orch keeps the imported tasks unchanged, records that as a decision, and the plan still waits for your approval.

## Answer plan questions

When the planner has a question about the spec as a whole, it appears in the **Inbox** with a **Plan** label instead of a task key. A plan question isn't tied to any task: no task in the run starts until you answer them all. You can still approve and start the run while a plan question is open. The **Plan** tab shows a note while plan questions are open.

To answer:

- In the **Inbox**, select one of the offered answers, or enter your own and select **Send**.
- Or, from the command line, run `orch answer <question-number> <answer>`. To find the number, run `orch status`.

## Preview a plan without creating a run

Preview shows how orch reads a feature folder: phases, tasks, `[P]` markers, each task's brief, dependencies and the folder checks. It doesn't create a run or call an agent, so it's a fast way to check a folder before you plan it.

- Run:

  ```bash
  orch plan <spec-folder> --dry-run
  ```

  orch prints each phase with its tasks, whether the task has a brief (`tasks/T001.md` beside `tasks.md`) and which fields the brief sets, and what each task depends on:

  ```text
  dry run: "Checkout" (/home/you/projects/shop/specs/003-checkout) for project shop: 3 tasks; nothing was created

  Phase 1: Setup
    [ ]     T001  Add the cart model
              brief: tasks/T001.md (fields: depends_on, parallel, merge_policy, validate_mode, files_owned, acceptance)
              depends on: none

  Phase 2: Core
    [ ] [P] T002  Add the checkout endpoint
              brief: no
              depends on: T001

  checks: no problems
  ```

  A task without a brief shows `brief: no`; the planner writes its acceptance criteria. When a brief's `parallel` value differs from the `[P]` marker in `tasks.md`, the brief wins and the preview lists the difference under `conflicts`.

  If the dependencies form a loop, the preview ends with a warning naming the tasks in it.

### Folder checks

The preview, and `orch plan` itself, check the folder and list each problem with its file and line:

| Problem | Kind | What to do |
| :--- | :--- | :--- |
| `unresolved marker "TBD"` in `spec.md`, a brief or a file under `contracts/` (`TBD`, `TODO` or `[NEEDS CLARIFICATION`) | error | Resolve the open point, or pass `--allow-open` to plan anyway. Other files, such as `plan.md`, aren't scanned. |
| `unsupported brief format orch: 2; this orch reads orch: 1` | error | The brief was written for another version of the brief format. Change its `orch:` line. |
| `T002 and T003 are both parallel and both list src/auth/session.ts` | warning | Two tasks that may run at the same time change the same file. Make one of them depend on the other, or give the file to one task. |
| `brief is 8265 characters; handoff.briefChars is 8000` | warning | Workers get the brief cut to the limit. Shorten it or raise the `handoff.briefChars` setting. |
| `task appears to add only tests: every target file is a test path` | warning | Check whether the task should also change code. Files under a `fixtures/` folder don't count as tests. |

With an error, `orch plan --dry-run` exits with code 1 and `orch plan` refuses to create the run:

```text
checks: 1 error, 3 warnings
  error   spec.md:15  unresolved marker "TBD"
  warning tasks/T003.md:22  T002 and T003 are both parallel and both list src/auth/session.ts
  ...
  fix the 1 error or pass --allow-open to plan anyway
```

To go ahead regardless, add `--allow-open`. The errors are then listed as warnings and the plan proceeds.

## Errors when planning

| Message | Cause and fix |
| :--- | :--- |
| "spec dir not found: `<path>`" | The folder doesn't exist. Check the path. |
| "no tasks.md in `<path>`. Run /speckit.tasks first." | The folder has no `tasks.md`. Create it. |
| "no tasks found in `<path>/tasks.md`" | No line matches the `- [ ] T001 …` format. See [Task file format](../reference/tasks-file.md). |
| "project '`<id>`' already has an unfinished run `<run-id>` (`<status>`, "`<title>`"); finish or stop it first" | Approve and finish that run, or stop it, then plan again. |
| "1 error in `<path>`; fix it or pass --allow-open to plan anyway" | A folder check found an unresolved marker or an unsupported brief. The lines above the message name the file and line. Fix them, or run again with `--allow-open`. |

If every task in `tasks.md` is already ticked (`- [x]`), orch imports them as done. The run finishes as soon as you start it.
