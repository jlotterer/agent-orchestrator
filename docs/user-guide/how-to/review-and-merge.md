# Review and merge a task

Tasks with the `manual` merge policy wait for your review after they pass validation. You can read the changes in the dashboard, merge them, or send the task back with written feedback.

## Read a task's changes

1. Open the task. Select **Inspect** on its inbox card, or select its card on the **Board**. It's in the **Review / merge** lane.
2. In the **Task** panel, expand **Diff**. orch loads the task's changes against its base branch.
3. Read the list of changed files. Each file shows its change type and its added and removed line counts.
4. Expand a file to read its diff. Added and removed lines are colored.

Things to know about the diff:

- It shows only the task's own commits, not other changes on the base branch.
- A binary file shows "Binary file; no diff shown."
- Very large diffs stop at a size limit. Files past the limit keep their line counts and show "Not shown: the diff size limit was reached."
- The diff is available while the task has a working copy. After a task merges, its working copy is removed, so read merged changes in git or on GitHub instead.

In pull request mode, you can also select **PR** in the task details to review on GitHub.

## Merge a task

- In the **Task** panel or on the inbox card, select **Merge now**.
- Or run `orch merge <task-key>`.

orch merges the task the same way as an automatic merge. In pull request mode, that's a squash merge on GitHub that deletes the branch. In local merge mode, it's a squash merge into your local base branch. If the merge fails, the error appears and the task stays where it is.

## Send a task back with feedback

Use this when the change is close but needs work. The worker resumes its own session with your text under "Feedback from the owner". orch then runs the test gate and the validator again, and the task comes back to your inbox.

1. In the **Task** panel, find **Send back to the worker**.
2. In the text box, describe what should change, for example "rename the flag to `--force`".
3. Select **Send back**.

You can also select **Send back** on the inbox card, which opens the same text box in a dialog.

Sending back isn't limited by the fix round limit, and it's recorded as a human decision. You can't send back empty feedback.

In pull request mode, you can also comment on the pull request with a line that starts with `/orch`. See [Use the pull request feedback loop](use-pr-feedback.md).

## Mark a task as merged elsewhere

If you merged a task's changes yourself, for example on GitHub after fixing a conflict, tell orch so it can continue:

- Select **Merged elsewhere**.

The task becomes done and its working copy is removed.

In pull request mode, orch also notices by itself when a pull request is merged on GitHub, within one polling interval (60 seconds by default).

## Start a task over

- Select **Re-run from scratch** in the **Task** panel, or **Re-run** on the inbox card. Or run `orch retry <task-key>`.

The task's attempts and fix rounds reset to zero, and a new worker session starts in the same working copy.
