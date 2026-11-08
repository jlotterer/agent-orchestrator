# Key concepts

This page explains the terms you see throughout orch and how the pieces fit together. Read it once before your first run.

## The big picture

orch is a scheduler for AI coding agents. It isn't an agent itself. Every choice about what runs next, when to retry, and when to merge is made by ordinary code that follows fixed rules, so you can predict and inspect it. orch calls an AI model only to plan a feature, to write code, and to check code.

One orch *server* (also called the daemon) runs on a machine you control. It serves the dashboard on port `4800` by default and keeps all of its state in one data directory, `~/.orch`. Nothing important lives only inside an agent's session, so you can restart orch at any time without losing work.

## Projects

A *project* is a git repository that orch manages. You register each repo once. Each project has:

- A name and an ID. The ID comes from the repo's folder name, for example `myapp`.
- A settings file in the repo, `orch.config.json`. It holds things like the test command and the branch to merge into. See [Project settings](reference/project-settings.md).
- Its own runs, history and inbox items.

Server-wide settings, such as the network address, the access token and which agent programs orch launches, live separately in `~/.orch/server.json`. A project's settings file can't change them. That way, a repo you cloned can't change which programs run on your server or which credentials they get.

## Features, runs and plans

You describe a feature with [Spec Kit](https://github.com/github/spec-kit), which produces a folder such as `specs/003-checkout/` with `spec.md`, `plan.md` and `tasks.md`.

A *run* is one execution of one feature's task list in one project. When you plan a feature, orch creates a run and imports the tasks into it. The run then moves through these statuses:

| Run status | Meaning |
| :--- | :--- |
| `planning` | The planner agent is reading the spec and enriching the tasks. |
| `plan_pending` | The plan is ready and waits for your approval. |
| `ready` | You approved the plan. It waits for you to start it. |
| `running` | Tasks are being worked on. |
| `paused` | Running agents finish their current step, but nothing new starts. |
| `stopped` | You stopped the run. Unfinished tasks went back to pending. You can start it again. |
| `done` | Every task is done or skipped. |

Each project has at most one *unfinished* run at a time (planning, awaiting approval, ready, running, or paused). Finish or stop it before you plan the next feature in the same project. Different projects can run at the same time.

## Tasks and phases

A *task* is one line of `tasks.md`, such as `- [ ] T003 [P] Add the signup endpoint`. Each task gets its own git branch, its own working copy of the repo, and, in pull request mode, its own pull request.

A *phase* is a group of tasks under one `##` heading in `tasks.md`. Tasks in a later phase wait until every task in earlier phases is done. Inside a phase, tasks marked `[P]` can run side by side. For the full rules, see [Task file format](reference/tasks-file.md).

Each task has these properties, which you can review and edit in the plan:

- **Acceptance criteria**: checkable statements that define "done". The planner writes them, and the validator checks each one.
- **Dependencies**: the tasks that must finish first.
- **Merge policy**: `auto` (orch merges when the task passes) or `manual` (orch waits for your review). The planner marks risky tasks, such as authentication, database migrations, billing and irreversible changes, as `manual`.
- **Test command**: an optional task-specific command that replaces the project's test command for this task.
- **Attempt limit**: how many times a worker can try before the task goes to your inbox. The default is 2.
- **Validation mode** (**Planned**): `standard`, or `ui` to test the running app in a browser.
- **Owned files**: the files or folders the task expects to change. orch uses them to avoid running two tasks that touch the same files at once.

## Agents and roles

orch launches an AI coding agent program, such as Claude Code or Gemini CLI, for each piece of work. Each launch has one *role*:

| Role | What it does |
| :--- | :--- |
| Planner | Reads the whole spec once per feature. Adds acceptance criteria, checks dependencies, sets merge policies, and asks you about anything ambiguous. |
| Worker | Writes the code for one task in that task's working copy and commits it. |
| Validator | Checks one task's changes against its acceptance criteria and runs the tests itself. It never sees the worker's reasoning. |
| Phase validator (**Planned**) | Checks a whole phase on the base branch after all of its tasks merge. |

You choose the agent program and model for each role. For example, you can use Claude Code for workers and Gemini CLI for validators, so the checker shares fewer blind spots with the author. See [Choose agents and models](how-to/configure-agents.md).

Every agent session starts with a fresh context. Instead of one long conversation, each worker gets a *hand-off brief*: the task and its criteria, an excerpt of the spec and plan, summaries of earlier tasks, the decisions so far, your earlier answers, and feedback from any failed attempt.

## Attempts, the test gate and validation

One *attempt* is one worker session plus the checks that follow it. For each attempt:

1. The worker writes and commits code. If it leaves changes uncommitted, orch commits them. An attempt with no commits fails.
2. The *test gate* runs: your project's test command (for example `npm test`) in the task's working copy. If it exits with a non-zero code, the attempt fails and the output goes back to the worker.
3. The *validator* runs in a fresh session. It returns **PASS** or **FAIL**, with evidence for each acceptance criterion. Anything other than PASS fails the attempt, and the reasons go back to the worker.

When an attempt fails and attempts remain, the worker tries again with the failure as feedback. By default, it resumes its earlier session so it keeps what it learned. When no attempts remain, the task fails and appears in your inbox.

## Merging

When a task passes validation, orch merges it in one of two ways, set per project:

- **Pull request mode**: orch pushes the branch, opens a pull request with the GitHub CLI, waits for CI, and merges it.
- **Local merge mode**: orch squash-merges the branch into the base branch of your local checkout. GitHub isn't needed.

After a task merges, orch ticks its line in `tasks.md` (`- [ ]` becomes `- [x]`) on the base branch. See [Choose how tasks merge](how-to/choose-merge-mode.md).

## Fix rounds

In pull request mode, orch keeps watching each open pull request. If CI fails, or a reviewer asks for changes, orch sends that feedback back to the worker. This is a *fix round*. The worker fixes the problem, orch runs the gate and the validator again, and then pushes. Fix rounds have their own limit, separate from attempts (default 3). You can also start a fix round yourself with **Send back**. See [Use the pull request feedback loop](how-to/use-pr-feedback.md).

## The inbox

The **Inbox** lists everything that needs you:

- A plan that waits for approval
- A question from an agent
- A failed task
- A task that waits for review or merge, including merge failures and pull request problems
- A phase that failed validation too many times (**Planned**)

Each inbox item has its actions right on it. When a new item appears, orch also sends a push notification if you set one up. When a worker asks a question, only that task pauses. Answering doesn't use up an attempt, and the worker continues in its own session.

## Decisions

A *decision* is a recorded choice with who made it, when, which task it applies to, and why. The planner, workers, validators, orch itself, and you all make decisions. orch records every choice it makes on its own, such as each retry, fix round, merge and fallback. Every action you take on a task is recorded as a human decision. The **Decisions** tab shows them all, in order. It's the audit trail for the run.

## Where things are stored

| What | Where |
| :--- | :--- |
| Server settings | `~/.orch/server.json` |
| Runs, tasks, decisions, questions and logs for every project | `~/.orch/orch.db` |
| Working copies of active tasks | `~/.orch/worktrees/<project>/` |
| Archived agent logs (**Planned**) | `~/.orch/archive/<project>/` |
| Project settings | `<repo>/orch.config.json` |
| Task ticks | `tasks.md` on the base branch of the repo |

orch never writes its own state into task branches. Set the `ORCH_HOME` environment variable to use a different data directory than `~/.orch`.
