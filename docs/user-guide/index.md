# orch user manual

orch runs AI coding agents through a feature's task list, one task at a time or several in parallel, and merges the results for you. You approve the plan, answer the questions the agents can't settle, and review the changes you marked as risky. orch does the rest: it schedules tasks, retries failures, opens and merges pull requests, and records every decision it makes.

orch runs on your own server. One orch serves all of your projects, and you use it from a browser dashboard or from the `orch` command line.

## Who this manual is for

This manual is for the owner who installs and operates orch. It assumes you're comfortable with a terminal, git and GitHub, and that you already use an AI coding agent such as Claude Code. You don't need to know how orch is built.

## How a feature moves through orch

1. You write a feature spec that ends in a `tasks.md` task list. The `orch-spec` skill that ships with orch writes one with a complete brief per task. Spec Kit produces one too, and so does any tool that follows the same format.
2. You ask orch to plan the feature. When every task has a brief with acceptance criteria, orch builds the plan from the briefs. Otherwise a planner agent adds acceptance criteria to each task and checks the order.
3. You review the plan, edit it if you want, and approve it.
4. You start the run. For each task, a worker agent writes the code in its own copy of the repo. A test command checks it, and a separate validator agent checks it against the acceptance criteria.
5. orch merges each validated task, either straight away or after your review, and moves on to the next one.
6. Anything that needs you appears in the **Inbox** and on your phone.
7. When the run finishes, you bring the results back into your project's documents, so the next feature starts from an up-to-date record.

## Feature availability

Every feature in this manual is available in the current release. For a summary of what's available and what orch doesn't do, see [Feature status](feature-status.md).

## Contents

### Get started

| Page | What it covers |
| :--- | :--- |
| [Key concepts](concepts.md) | Projects, runs, tasks, agents, the test gate, the validator, the inbox, and decisions |
| [Install orch](install.md) | Prerequisites, installation, running as a service, upgrading, and uninstalling |
| [Run in Docker](how-to/run-in-docker.md) | Running orch in a container instead of directly on the server |
| [Set up orch on a home server](how-to/set-up-a-home-server.md) | End-to-end walkthrough: keys, Docker, credentials, your first project, your first plan |
| [Quickstart: your first run](quickstart.md) | From a registered repo to a merged task in one sitting |

### Use orch

| Page | What it covers |
| :--- | :--- |
| [Add and manage projects](how-to/manage-projects.md) | Register repos, list them, archive and restore them |
| [Write specs with the orch-spec skill](how-to/write-specs-with-orch-spec.md) | Write the project record and feature folders with task briefs, run them, and bring the results back |
| [Import a Spec Kit folder](how-to/import-a-spec-kit-folder.md) | Plan a Spec Kit folder as it is, or add briefs with the skill's adopt mode |
| [Plan a feature](how-to/plan-a-feature.md) | Prepare `tasks.md`, draft a plan, preview a plan, answer plan questions |
| [Review and approve a plan](how-to/review-a-plan.md) | Edit criteria, dependencies, merge policy and test commands, then approve |
| [Run and control a run](how-to/control-a-run.md) | Start, pause, stop, and recover after a restart |
| [Work with the inbox](how-to/work-with-the-inbox.md) | Answer questions, retry or skip failed tasks, act on review items |
| [Review and merge a task](how-to/review-and-merge.md) | Read a task's diff, merge it, or send it back with feedback |
| [Choose how tasks merge](how-to/choose-merge-mode.md) | Pull request mode or local merge, automatic or manual merge policy |
| [Use the pull request feedback loop](how-to/use-pr-feedback.md) | Let CI failures and review comments go back to the worker |
| [Run tasks in parallel](how-to/run-in-parallel.md) | Per-project and global limits, fairness, and owned files |
| [Validate whole phases](how-to/validate-phases.md) | Check each phase on the base branch and create fix-up tasks |
| [Validate UI tasks in a browser](how-to/validate-ui-tasks.md) | Let the validator test a running copy of your app |
| [Choose agents and models](how-to/configure-agents.md) | Pick Claude Code, Antigravity CLI or Codex CLI per role, set models, customize prompts |
| [Secure remote access](how-to/secure-access.md) | Access token, network address, health check |
| [Get push notifications](how-to/set-up-notifications.md) | Send inbox alerts to your phone with ntfy |
| [Track cost and agent time](how-to/track-cost.md) | See what each task, run and project cost |
| [Archive old activity logs](how-to/archive-event-logs.md) | Keep the database small by archiving old agent logs |

### Reference

| Page | What it covers |
| :--- | :--- |
| [Dashboard reference](reference/dashboard.md) | Every area, tab, lane, button and dialog |
| [Task statuses](reference/task-statuses.md) | What each status means and what you can do from it |
| [CLI reference](reference/cli.md) | Every `orch` command, flag and exit code |
| [Project settings](reference/project-settings.md) | Every key in `orch.config.json` |
| [Server settings](reference/server-settings.md) | Every key in `server.json`, plus environment variables |
| [Task file format](reference/tasks-file.md) | How orch reads `tasks.md` and works out dependencies |
| [What agents see and do](reference/agents.md) | Agent inputs, `orch decide` and `orch ask`, and the results agents return |
| [HTTP API](reference/http-api.md) | Endpoints for scripts and integrations |
| [Feature status](feature-status.md) | What's available now and what orch doesn't do |

### Help

| Page | What it covers |
| :--- | :--- |
| [Troubleshooting](troubleshooting.md) | Error messages and symptoms, their causes, and fixes |
