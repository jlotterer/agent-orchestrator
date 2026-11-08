# Dashboard reference

The dashboard is at orch's address, `http://127.0.0.1:4800` by default. It updates live, without reloading. This page describes each area.

<!-- TODO(screenshot): Full dashboard with a running run, the inbox on the left, the Board tab, and a task open on the right -->

## Top bar

The top bar shows the run's title and status, and the run controls.

| Control | What it does |
| :--- | :--- |
| Run selector | Switches to another run of the project, including finished ones. |
| **New plan** | Opens the **New plan from a Spec Kit feature** dialog. See [Plan a feature](../how-to/plan-a-feature.md#draft-a-plan-from-the-dashboard). |
| **Approve plan** | Approves the plan that waits for approval. |
| **Start** | Starts or resumes the run. |
| **Pause** | Lets running agents finish their step and starts nothing new. |
| **Stop** | Ends running agents. Their tasks go back to pending. |
| Live indicator | Shows whether the live update connection is up. |
| Project switcher (**Planned**) | Lists every project with a status dot and its inbox count. Includes **Add project** and **Archive**. |
| Cost and time tile | Shows the cost and agent time of the run and the project. A cost that no agent program reported shows "n/a". See [Track cost and agent time](../how-to/track-cost.md). |

## Inbox

The left column lists everything that needs you, with actions on each item. Its heading shows the number of items. See [Work with the inbox](../how-to/work-with-the-inbox.md).

Below it, **Setup** summarizes the project's effective settings: repo, base branch, parallel limit, attempts, merge mode and default policy, test command, whether the validator is on, the pull request loop settings, whether notifications are on, and the agent used for each role.

## Board tab

The **Board** shows every task of the run as a card, in one lane per status:

| Lane | Tasks in it |
| :--- | :--- |
| **Pending** | Waiting to start: for dependencies, for a free slot, or for a retry. |
| **Running** | A worker is working on it. |
| **Validating** | The test gate or the validator is checking it. |
| **Needs input** | Its worker asked a question and waits for your answer. |
| **Waiting on CI** | Its pull request is open and orch waits for checks before merging. |
| **Review / merge** | It waits for your review, or merging needs you. |
| **Failed** | It ran out of attempts, or its pull request was closed. |
| **Done** | Merged or skipped. |

Select a card to open it in the **Task** panel. For details on each status, see [Task statuses](task-statuses.md).

## Plan tab

The **Plan** tab lists the tasks by phase. Each row shows the task key and status, the title and acceptance criteria, its dependencies, and its merge policy and test command. Select a row to open the task and edit it. See [Review and approve a plan](../how-to/review-a-plan.md).

The **Plan** tab also shows each task's owned files and, under **not with**, the tasks that own some of the same files and so never run beside it. Each phase heading shows the phase's validation status and fix-up rounds, and fix-up tasks carry a **fix-up** badge. Tasks in UI validation mode show **🖥 UI validation**, and **⚠ no start command** if the project has no `validation.ui.startCommand`. The **Task** panel shows the mode under **Mode**.

## Decisions tab

The **Decisions** tab is the audit trail of the run: every decision made by the planner, workers, validators, orch itself and you, in order, with its time, task and reason.

## Activity tab

The **Activity** tab is the run's event stream: status changes, git actions, agent starts and ends, errors and notices. When nothing can move forward without you, it shows one "waiting on you" entry that lists the blocked tasks.

## Task panel

The right column shows the selected task. When no task is selected, it shows "Select a task to see its plan, log, and actions."

| Section | Contents |
| :--- | :--- |
| Header | Task key, status, title and description. |
| Details | **Depends on**, **Merge** (policy and **PR** link), **Branch**, **Attempts** (used of allowed), **PR checks** with fix rounds, **Sent back** count, and **Validate** (the test command). |
| **Acceptance criteria** | The task's criteria. |
| **Worker summary** | What the worker says it did, and the files it touched. |
| **Last feedback** | The most recent failure output or validator reasons. |
| Actions | Buttons for what you can do in the task's current status. |
| **Send back to the worker** | A text box and **Send back** button, for tasks waiting for review. |
| **Diff** | The task's changes against its base. Expand to load. See [Review and merge a task](../how-to/review-and-merge.md). |
| **Log** | The live agent log: agent text, tool calls and results, errors and session details. |
| **Cost** | The task's cost ("n/a" when no agent program reported one) and agent time, across all of its sessions. |

The actions depend on the task's status:

| Action | Shown when the task is |
| :--- | :--- |
| **Edit** | Pending, failed, or waiting for review, in a run that isn't done. |
| **Stop** | Running or validating. |
| **Re-run from scratch** | Failed, waiting for review or CI, done, or skipped. |
| **Skip** | Pending, failed, or waiting for input. |
| **Merge now**, **Merged elsewhere** | Waiting for review or CI. |

## Dialogs

| Dialog | Opened by | Fields |
| :--- | :--- | :--- |
| **New plan from a Spec Kit feature** | **New plan** | **Spec directory**, the planner checkbox, **Draft plan** |
| **Edit task** | **Edit** | **Title**, **Acceptance criteria (one per line)**, **Depends on (comma-separated task keys)**, **Merge policy**, **Validation command (blank = project default)**, **Validation mode**, **Owned files (one path or glob per line; blank = unconstrained)** |
| **Send** *task* **back to the worker** | **Send back** on an inbox card | A text box for your feedback |
| **Sign in to orch** | Any request when an access token is set and the browser has none | **Access token**, **Sign in** |

## Live updates

The dashboard keeps a live connection to orch. **Planned:** if the connection drops, for example when orch restarts, the dashboard reconnects on its own, waiting a little longer after each failed try (from 1 second up to 30 seconds), and then refreshes everything.

The dashboard works on a phone-sized screen, in light and dark themes.
