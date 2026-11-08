# Work with the inbox

The **Inbox** is the one place that lists everything that needs you. If you set up notifications, every new item also sends one to your phone. Each item has its actions on it, so most items take one or two selections.

In the current release, the inbox shows the items of the project shown in the dashboard. **Planned:** one inbox for all projects, with each item labeled with its project. Selecting an item switches the dashboard to that project.

When nothing needs you, the inbox shows "Nothing needs you right now."

## Inbox items at a glance

The inbox shows these kinds of items.

| Item | Why it appears | Actions |
| :--- | :--- | :--- |
| Plan awaits your approval | A new plan is ready. | **Approve plan** |
| `<task>` asks | A worker or the planner asked a question. | One button per offered answer, or your own answer and **Send** |
| **failed** `<task>` | A task used up its attempts, or failed for another reason. | **Inspect**, **Retry**, **Skip** |
| **review** `<task>` | A task passed validation and waits for you, or merging needs you. | **Inspect**, **Merge now**, **Send back**, **Merged elsewhere**, **Re-run** |
| Phase needs you (**Planned**) | A phase failed validation more times than allowed. | Re-run phase validation, accept the phase |

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

**Planned.** When a phase fails validation more times than its fix-up limit allows, orch stops creating fix-up tasks and puts the phase in your inbox. You can re-run the phase validation, or accept the phase as it is so later phases can continue. See [Validate whole phases](validate-phases.md).
