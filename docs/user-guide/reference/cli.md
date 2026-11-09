# CLI reference

The `orch` command starts the server and controls it. Except for `orch serve`, `orch init` and `orch archive-events`, every command talks to a running orch server over HTTP.

```text
orch <command> [arguments] [--project <project-id>]
```

## Commands at a glance

The following table lists every command.

| Command | What it does |
| :--- | :--- |
| [`orch serve`](#orch-serve) | Start the server and dashboard. |
| [`orch project add`](#orch-project-add) | Register a git repo as a project. |
| [`orch project list`](#orch-project-list) | List projects. |
| [`orch project remove`](#orch-project-remove) | Archive a project. |
| [`orch plan`](#orch-plan) | Import a feature's `tasks.md` and draft a plan. |
| [`orch approve`](#orch-approve) | Approve a plan. |
| [`orch run`](#orch-run-orch-pause-orch-stop) | Start or resume the current run. |
| [`orch pause`](#orch-run-orch-pause-orch-stop) | Pause the current run. |
| [`orch stop`](#orch-run-orch-pause-orch-stop) | Stop the current run. |
| [`orch status`](#orch-status) | Show the run, its tasks and the inbox. |
| [`orch answer`](#orch-answer) | Answer a question. |
| [`orch retry`, `orch skip`, `orch merge`, `orch stop-task`](#task-commands) | Act on one task. |
| [`orch archive-events`](#orch-archive-events) | Archive old runs' agent logs now. |
| [`orch help`](#orch-help) | Show the list of commands. |
| [`orch decide`](#orch-decide) | For agents: record a decision. |
| [`orch ask`](#orch-ask) | For agents: ask you a question and stop. |
| [`orch init`](#orch-init) | Older setup path: write a single-file settings file in the current folder. |

## Global options

| Option | Description |
| :--- | :--- |
| `--project <project-id>` | The project the command acts on. See [Project selection](#project-selection). |
| `--help` | Show the list of commands, like `orch help`. |

### Project selection

Commands that act on a project (`status`, `plan`, `approve`, `run`, `pause`, `stop`, `retry`, `skip`, `merge`, `stop-task`) pick it in this order:

1. `--project <project-id>`
2. The `ORCH_PROJECT` environment variable
3. The project whose repo contains the current folder. For `orch plan`, the spec folder is checked first.
4. The only project, when only one is registered

If none applies, the command stops with exit code `2`, "which project? Run inside a project's repo or pass --project <id> (or set ORCH_PROJECT)", and a list of projects. With no project registered, the message is "no projects registered. Add one with: orch project add <path>". A `--project` or `ORCH_PROJECT` value that matches no project fails with "no project '`<id>`'".

## Exit codes

| Code | Meaning |
| :--- | :--- |
| `0` | Success. |
| `1` | Failure. The reason is on standard error, after `error:`. |
| `2` | Usage error: a missing argument, an unknown command, or a project that can't be determined. |

## Connection and token

The command finds the server and its token like this:

- **Address:** `ORCH_URL` if set, otherwise `http://127.0.0.1:<port>`, with the port from `$ORCH_HOME/server.json`.
- **Token:** `ORCH_TOKEN` if set, otherwise `auth.token` from `$ORCH_HOME/server.json`.

If the server can't be reached, the command fails with exit code `1` and "cannot reach orch at `<address>` (is `orch serve` running?)".

---

## orch serve

Starts the orch server, the scheduler and the dashboard. It runs until you stop it with **Ctrl+C** or a stop signal. Run it under systemd or Docker for permanent use.

```bash
orch serve [--config <path>]
```

| Option | Description |
| :--- | :--- |
| `--config <path>` | Only for upgrading a single-repo installation: the old settings file to upgrade. By default, orch looks in the current folder and its parents. `ORCH_CONFIG` does the same. |

On start, orch:

1. Upgrades a single-repo installation, if it finds one and `server.json` doesn't exist yet. See [Install orch](../install.md#upgrade-from-a-single-repo-installation).
2. Refuses to start on a network address without an access token. See [Secure remote access](../how-to/secure-access.md).
3. Returns tasks that were active to pending, and plans that were being drafted to awaiting approval.
4. Listens on `host` and `port` from `server.json`, `127.0.0.1:4800` by default.

If no project is registered, it warns "no projects registered in `<path>`" and keeps running.

## orch project add

Registers a git repo as a project. If the repo has no `orch.config.json`, orch creates a starter file and prints its path.

```bash
orch project add <repo-path> [--name <name>]
```

| Argument | Description |
| :--- | :--- |
| `<repo-path>` | The top-level folder of the repo. |
| `--name <name>` | Optional display name. The default is the folder name. |

Adding a path that belongs to an archived project restores that project. See [Add and manage projects](../how-to/manage-projects.md#add-a-project).

## orch project list

Lists projects: ID, name, current run status and ID, repo path, open inbox items, and any error.

```bash
orch project list [--archived]
```

| Option | Description |
| :--- | :--- |
| `--archived` | Include archived projects. |

`orch project ls` does the same.

## orch project remove

Archives a project. The repo and the project's history are kept. Refused while the project has an unfinished run.

```bash
orch project remove <project-id>
```

`orch project archive` does the same.

## orch plan

Imports a feature folder's `tasks.md` into a new run and, by default, runs the planner. The command waits for the planner, then prints the run ID, title and status.

```bash
orch plan <spec-folder> [--no-llm] [--dry-run] [--allow-open]
```

| Argument | Description |
| :--- | :--- |
| `<spec-folder>` | The feature folder, for example `specs/003-checkout`. |
| `--no-llm` | Import the tasks without running the planner. |
| `--dry-run` | Print the phases, tasks, `[P]` markers, each task's brief and the fields it sets, the dependencies and the folder checks, without creating a run or calling an agent. Exits with code 1 when a check reports an error. |
| `--allow-open` | Plan (or preview) a folder whose checks report an error, such as an unresolved `TBD`, `TODO` or `[NEEDS CLARIFICATION` marker in `spec.md`, a brief or a contract file. The errors are listed as warnings. |

Refused while the project has an unfinished run, and refused when the folder checks report an error unless you pass `--allow-open`. See [Plan a feature](../how-to/plan-a-feature.md#preview-a-plan-without-creating-a-run) for the preview output and the checks.

## orch approve

Approves a plan that waits for approval.

```bash
orch approve [<run-id>]
```

Without `<run-id>`, it approves the project's current run.

## orch run, orch pause, orch stop

Control the project's current run.

```bash
orch run
orch pause
orch stop
```

| Command | Effect |
| :--- | :--- |
| `orch run` | Starts an approved or stopped run, or resumes a paused one. `orch start` does the same. |
| `orch pause` | Running agents finish their step. Nothing new starts. |
| `orch stop` | Ends running agents. Their tasks return to pending, with working copies and commits kept. |

See [Run and control a run](../how-to/control-a-run.md).

## orch status

Prints the project (ID, name and repo path, plus any error) and its current run: the run ID, title and status, one line per task with its status, key, title and pull request link, and then the inbox items.

```bash
orch status
```

Example output:

```text
project shop "shop" (/home/you/projects/shop)
run 3f9c2a1b "Checkout" [running]
  done        T001  Add the cart model
  running     T002  Add the checkout endpoint
  needs_input T003  Add the payment form

inbox:
  [question] #12 Which payment provider should the form use?
```

## orch answer

Answers a question. The number is shown in `orch status` and in the dashboard.

```bash
orch answer <question-number> <answer text>
```

The rest of the line after the number is the answer, so you don't need quotation marks. A question can be answered only once.

## Task commands

Act on one task of the current run, by its key, such as `T003`.

```bash
orch retry <task-key>
orch skip <task-key>
orch merge <task-key>
orch stop-task <task-key>
```

| Command | Effect | Same as |
| :--- | :--- | :--- |
| `orch retry` | Starts the task again with attempts and fix rounds reset. | **Retry**, **Re-run**, **Re-run from scratch** |
| `orch skip` | Skips the task. Tasks that depend on it can start. | **Skip** |
| `orch merge` | Merges a task that waits for review. | **Merge now** |
| `orch stop-task` | Stops a running or validating task and returns it to pending. | **Stop** in the **Task** panel |

If the key isn't in the run, the command fails with "task `<key>` not found in `<project-id>` run `<run-id>`".

## orch archive-events

Archives the agent logs of finished runs older than `retention.eventDays`, the same as the daily automatic archive. It reads the database directly, so it works whether or not orch is running. See [Archive old activity logs](../how-to/archive-event-logs.md).

```bash
orch archive-events
```

If `retention.eventDays` is `0`, it prints "retention.eventDays is 0: event archiving is off" and does nothing. If writing an archive fails, it exits with `1`.

## orch help

Shows the list of commands.

```bash
orch help
```

---

## Commands for agents

Agents run these inside a task. orch sets `ORCH_URL`, `ORCH_TASK_ID`, `ORCH_RUN_ID`, `ORCH_ACTOR` and, when one is set, `ORCH_TOKEN` for them, and puts `orch` on their `PATH`. You don't need to run them yourself. See [What agents see and do](agents.md).

### orch decide

Records a decision with its reason in the **Decisions** tab, without pausing.

```bash
orch decide "<decision>" --why "<reason>"
```

### orch ask

Asks you a question, optionally with answer choices, and tells the agent to stop. Only that task pauses. When you answer, the agent continues in the same session.

```bash
orch ask "<question>" --options "<choice 1>,<choice 2>"
```

It works only inside a task. Elsewhere, it fails with "orch ask must be run inside an orchestrated task (ORCH_TASK_ID not set)".

---

## orch init

An older way to set up a first project, kept for compatibility. Use [`orch project add`](#orch-project-add) instead. It doesn't appear in `orch help`.

Writes an `orch.config.json` in the current folder, in the single-file format. When you then run `orch serve` from the same folder, and `$ORCH_HOME/server.json` doesn't exist yet, orch splits the file into server and project settings and registers the folder as a project.

```bash
orch init
```
