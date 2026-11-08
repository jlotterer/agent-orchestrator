# Task statuses

Every task has one status at a time. The dashboard shows it on the task card, and `orch status` prints it. This page lists each status, how a task gets there, and what you can do.

| Status | Board lane | Meaning | What you can do |
| :--- | :--- | :--- | :--- |
| `pending` | **Pending** | Waiting to start. Its dependencies aren't done, no slot is free, or it's waiting for a retry. | Edit, skip |
| `running` | **Running** | A worker is writing code. | Stop |
| `validating` | **Validating** | The test gate or the validator is checking the work. | Stop |
| `needs_input` | **Needs input** | The worker asked a question and stopped. | Answer, skip |
| `pr_checks` | **Waiting on CI** | An `auto` task's pull request is open, and orch waits for checks before merging. | Merge now, send back, merged elsewhere, re-run |
| `pr_open` | **Review / merge** | The task waits for your review, or merging or the pull request needs you. | Edit, merge now, send back, merged elsewhere, re-run |
| `failed` | **Failed** | The task ran out of attempts, its pull request was closed without merging, or its UI validation was blocked (the validator couldn't use a browser, or the project has no start command for the app). | Edit, retry, skip |
| `done` | **Done** | Merged. Its working copy is removed. | Re-run |
| `skipped` | **Done** | You skipped it. Tasks that depend on it can start. | Re-run |

## How a task moves between statuses

A typical task goes through these steps:

1. `pending` → `running`: orch starts it when its dependencies are done and a slot is free.
2. `running` → `validating`: the worker finishes. orch commits anything it left uncommitted.
3. `validating` → one of:
   - `done`, for an `auto` task in local merge mode, or in pull request mode without waiting for CI.
   - `pr_checks`, for an `auto` task in pull request mode that waits for CI.
   - `pr_open`, for a `manual` task.
4. `pr_checks` → `done` when checks pass and orch merges.

Other moves:

| From | Event | To |
| :--- | :--- | :--- |
| `running` | The worker asks a question. | `needs_input` |
| `needs_input` | You answer, and the run is running. The same session continues. | `running` |
| `needs_input` | You answer while the run is paused. | `pending` |
| `running` or `validating` | The attempt fails, and attempts remain. | `pending`, then a retry with the failure as feedback |
| `running` or `validating` | The attempt fails, and no attempts remain. | `failed` |
| `running` or `validating` | You stop the task or the run, or orch restarts. | `pending` |
| `validating` or `pr_checks` | Merging fails. Worker attempts aren't used. | `pr_open` |
| `validating` | A fix round produced no new commits. | `pr_open` |
| `pr_checks` or `pr_open` | CI fails, a reviewer asks for changes, or you send it back. | `pending`, for a fix round |
| `pr_checks` or `pr_open` | The pull request is merged on GitHub, or you select **Merge now**. | `done` |
| `pr_checks` or `pr_open` | The pull request is closed without merging. | `failed` |
| Any status except `running` and `validating` | You select **Retry** or **Re-run**. Attempts and fix rounds reset. | `pending` |
| Any status except `running` and `validating` | You select **Skip**. | `skipped` |
| Any status | You select **Merged elsewhere**. | `done` |

An attempt fails when the worker reports failure, crashes, times out, its setup command fails, it makes no commits, the test gate fails, or the validator doesn't return PASS.

If you try an action that the task's status doesn't allow, such as stopping a task that isn't running, orch refuses it with an error.

## Run statuses

For the statuses of a whole run (`planning`, `plan_pending`, `ready`, `running`, `paused`, `stopped`, `done`), see [Key concepts](../concepts.md#features-runs-and-plans).
