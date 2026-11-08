# Run and control a run

After you approve a plan, you start the run and orch works through the tasks on its own. You can pause or stop it at any time, and orch recovers by itself after a restart.

## Start a run

Prerequisite: the plan is approved. The run status is `ready`.

- In the dashboard top bar, select **Start**.
- Or run `orch run`.

orch starts each task as soon as all of these are true:

- Every task it depends on is done or skipped.
- It has no open question.
- No plan question is open (**Planned**).
- The project has room under its parallel limit, `scheduler.maxParallel` (default 1).
- The server has room under its global agent limit, `scheduler.maxAgents` (default 2).
- No running task in the same project owns any of the same files (**Planned**).

Go to the **Board** tab to follow progress. Select a task card to see its live log.

## Pause a run

Pausing lets agents that are already working finish their current step, and starts nothing new.

- In the top bar, select **Pause**, or run `orch pause`.

You can still answer questions while the run is paused. The answers take effect when you resume.

To resume, select **Start** or run `orch run`.

## Stop a run

Stopping ends running agent sessions within a few seconds. Their tasks go back to pending. Their working copies and commits are kept, so the next attempt continues from there.

- In the top bar, select **Stop**, or run `orch stop`.

The run status changes to `stopped`. To continue later, select **Start** or run `orch run`. A stopped run counts as finished, so you can also plan a new feature in the project instead.

## Stop a single task

- In the **Task** panel of a running or validating task, select **Stop**.
- Or run `orch stop-task <task-key>`.

The task goes back to pending, and the rest of the run continues. If you stopped it during validation, the next attempt checks the existing commits again.

## Check status from the command line

- Run:

  ```bash
  orch status
  ```

  orch prints the run ID, title and status, one line per task with its status, key, title and pull request link, and the open inbox items.

## What happens when orch restarts

If orch stops or crashes during a run, nothing that was recorded is lost. When it starts again:

- Tasks that were mid-attempt go back to pending, with their working copies kept. The **Activity** tab says why.
- A run that was planning goes back to awaiting approval, with the imported tasks.
- Questions, answers and decisions are kept.

At most, the attempt that was in progress runs again.

## When the run waits for you

When nothing in a run can move forward without you, for example because every remaining task waits on a question or a failed task, orch adds one "waiting on you" entry to the **Activity** tab. It lists the blocked tasks and why. Go to the **Inbox** to act on them. See [Work with the inbox](work-with-the-inbox.md).

## When the run finishes

The run status changes to `done` when every task is done or skipped. orch sends a "run complete" notification if you set up notifications.

To look at an earlier run, choose it in the run selector in the dashboard top bar.
