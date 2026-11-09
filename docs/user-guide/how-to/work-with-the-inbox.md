# Work with the inbox

The **Inbox** is the one place that lists everything that needs you. If you set up notifications, every new item also sends one to your phone. Each item has its actions on it, so most items take one or two selections.

The inbox covers all of your projects. Each item is labeled with its project. Selecting an item switches the dashboard to that project and opens its task. The buttons on an item act without switching, except **Inspect** and **Send back…**, which switch first.

When nothing needs you, the inbox shows "Nothing needs you right now." With several projects, it adds "in any project".

## Inbox items at a glance

The inbox shows these kinds of items.

| Item | Why it appears | Actions |
| :--- | :--- | :--- |
| Plan awaits your approval | A new plan is ready. | **Approve plan** |
| `<task>` asks | A worker or the planner asked a question. | One button per offered answer, or your own answer and **Send** |
| **failed** `<task>` | A task used up its attempts, or failed for another reason. | **Inspect**, **Retry**, **Skip** |
| **review** `<task>` | A task passed validation and waits for you, or merging needs you. | **Inspect**, **Merge now**, **Send back**, **Merged elsewhere**, **Re-run** |
| **phase** `<phase>` | A phase failed validation more times than allowed, or its validation couldn't run. | **Re-run validation**, **Accept phase** |
| **docs** Update project docs | A run finished and merged at least one task. | **Copy**, **Acknowledge** |

## Answer a question

Workers ask only when a wrong guess would be expensive to undo. Only the asking task pauses, and answering doesn't use up an attempt.

1. Read the question in the inbox card.
2. Select one of the offered answers. Or enter your own answer in **or type an answer**, and then select **Send** or press **Enter**.

The task continues in the same agent session, with your answer.

To answer from the command line, run:

```bash
orch answer <question-number> <answer>
```

To find the question number, run `orch status`. The inbox section lists questions as `[question] #<number> <text>`.

A question can be answered only once. A second answer is refused with "already answered".

## Handle a failed task

A task fails when its worker, the test gate or the validator fails on every allowed attempt, or when its pull request was closed without merging.

1. On the inbox card, select **Inspect**. The **Task** panel opens.
2. Read **Last feedback**. It holds the output of the failing test command, the validator's reasons, or the error.
3. Read the live log under **Log** for more detail.
4. Choose what to do:
   - To try again with a clean count of attempts, select **Retry**. If the task needs a different approach, first edit its acceptance criteria or test command. See [Review and approve a plan](review-a-plan.md#edit-a-task).
   - To give up on the task, select **Skip**. Tasks that depend on it can then start.

From the command line, run `orch retry <task-key>` or `orch skip <task-key>`.

> [!TIP]
> If agents fail because they hit their vendor's usage limit, pause the run, wait for the limit to reset, and then retry the failed tasks and start the run again. Nothing is lost.

## Act on a task that waits for review

A **review** card appears when:

- A task with `manual` merge policy passes validation.
- Merging failed, for example because of a conflict, a rejected push, or missing permission. The card shows "Merge step failed" and the error. This doesn't use up worker attempts.
- In pull request mode, CI keeps failing, checks hang, a reviewer still asks for changes, or someone pushed conflicting commits to the branch.
- A fix round produced no new commits.

The card shows the pull request link (in pull request mode), the CI status, and how many fix rounds ran. Choose one action:

| Action | What it does |
| :--- | :--- |
| **Inspect** | Opens the task, where you can read its diff. See [Review and merge a task](review-and-merge.md). |
| **Merge now** | Merges the task right away. |
| **Send back** | Opens a dialog where you write what should change. The worker resumes with your text. |
| **Merged elsewhere** | Marks the task done, for example after you merged or fixed it on GitHub yourself. |
| **Re-run** | Starts the task again from scratch, with attempts and fix rounds reset. |

From the command line, run `orch merge <task-key>`.

## Handle a phase that needs you

When a phase fails validation more times than its fix-up limit allows, orch stops creating fix-up tasks and puts the phase in your inbox with the latest failure. Tasks in later phases wait until you act:

- Select **Re-run validation** to validate the phase again, for example after you fixed the base branch by hand.
- Select **Accept phase** to take the phase as it is, so later phases can continue.

See [Validate whole phases](validate-phases.md).

## Update the project docs after a run

When a run finishes, orch adds an **Update project docs** item and sends a notification titled "Update project docs: <project> <run title>". The item lists what to bring back into your project's documents:

- **REQ IDs**: the requirements the merged tasks cover, from each brief's `covers` list (or the `REQ-…` IDs in a task's acceptance criteria when it has no brief). A requirement that a skipped or failed task also covers shows "not merged" with that task and its status, for example `not merged: T004 skipped`.
- **Decisions**: the decisions the planner and the workers recorded during the run.
- **Plan edits**: the changes you made to tasks in the dashboard, with their new values, for example `T002: merge_policy = "manual"`.
- **Contracts**: the contracts the merged tasks' briefs name.

A run in which no task merged, for example because every task was skipped, gets no item. Starting a new run doesn't remove the item of the previous one.

1. On the inbox card, select **Copy**.
2. In Claude Code, in the project's repository, run the `orch-spec` skill's fold-back mode and paste the text. The skill updates the requirement statuses, decision records, briefs, architecture and roadmap. See [skills/README.md](../../../skills/README.md).
3. Review and commit the changes on the base branch.
4. Select **Acknowledge**. The item leaves the inbox, and a decision records it.

From the command line, `orch docs-update` prints the same text, and `orch docs-update --ack` acknowledges it.
