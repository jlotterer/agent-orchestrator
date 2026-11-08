# Review and approve a plan

No task runs until you approve the plan. Use the time to check that each task has the right acceptance criteria, dependencies and merge policy. Each edit you make is recorded as a human decision.

## Read the plan

1. In the dashboard, go to the **Plan** tab. If the run isn't shown, choose it in the run selector in the top bar.
2. For each phase, read the tasks. Each row shows:
   - The task key and status.
   - The title and the acceptance criteria. A task without criteria shows "no acceptance criteria (validator will use the description)".
   - The dependencies, as "after T001, T002" or "no deps".
   - The merge policy and, if the task has one, its own test command.
   - The files each task owns, and under **not with**, the tasks it never runs beside because they own some of the same files.
   - **🖥 UI validation** for tasks in UI validation mode. If the project has no start command for the app, the row also shows **⚠ no start command**.
3. Go to the **Decisions** tab to read why the planner made each choice.

## Edit a task

You can edit a task before approval. After approval, you can still edit tasks that haven't started yet, and tasks that failed or wait for review.

1. On the **Plan** tab, select the task. The **Task** panel opens.
2. Select **Edit**.
3. In the **Edit task** dialog, change any of these fields:

   | Field | What to enter |
   | :--- | :--- |
   | **Title** | A short name for the task. |
   | **Acceptance criteria (one per line)** | One checkable statement per line. |
   | **Depends on (comma-separated task keys)** | For example, `T001, T003`. |
   | **Merge policy** | **auto — merge when validated**, or **manual — wait for my review**. |
   | **Validation command (blank = project default)** | A task-specific test command, or nothing to use the project's `validation.command`. |
   | **Validation mode** | `standard`, or `ui` to test the running app. See [Validate UI tasks in a browser](validate-ui-tasks.md). |
   | Owned files | Files or folders the task changes, one per line, such as `src/auth/**`. Leave it blank for no restriction. See [Run tasks in parallel](run-in-parallel.md). |

4. Select **Save**.

The **Decisions** tab now shows a human decision that names the task.

You can also change a task's attempt limit through the [HTTP API](../reference/http-api.md). The dashboard doesn't have a field for it.

## Approve the plan

- In the top bar, select **Approve plan**. The run status changes to `ready`.

You can also select **Approve plan** on the "Plan awaits your approval" card in the **Inbox**, or run `orch approve`.

**Planned:** orch refuses to approve a plan whose dependencies form a loop, such as T001 depending on T002 and T002 depending on T001. The error names the tasks in the loop. Edit one of their dependencies, and then approve again.

Next, start the run. See [Run and control a run](control-a-run.md).
