# Use the pull request feedback loop

In pull request mode, orch keeps watching each task's open pull request. When CI fails or a reviewer asks for changes, orch sends the feedback back to the worker, which fixes it in its own session. You review results instead of chasing red builds.

Prerequisite: the project uses pull request mode. See [Choose how tasks merge](choose-merge-mode.md#use-pull-request-mode).

The loop is on by default. Its settings live under `git.feedback` in the project's `orch.config.json`. For every key, see [Project settings](../reference/project-settings.md#pull-request-feedback-gitfeedback).

## What orch watches for

While a task's pull request is open, orch checks it every `pollSeconds` (60 by default) and reacts:

| What happens on GitHub | What orch does |
| :--- | :--- |
| CI fails on the commit orch pushed | Sends the names of the failed checks and the end of their GitHub Actions logs to the worker. This happens at most once per commit. |
| A reviewer submits a "Request changes" review | Sends every new human comment since the last round to the worker, including inline comments with their file and line. |
| Someone comments with a line that starts with `/orch` | Same as a "Request changes" review. |
| All checks pass on an `auto` task | Merges the pull request. |
| The pull request has no checks | Waits `noChecksGraceSeconds` (90 by default) after each push for CI to appear, and then treats it as passing. |
| The pull request is merged on GitHub | Marks the task done. |
| The pull request is closed without merging | Marks the task failed. |

Each time orch sends feedback to the worker, that's a *fix round*. The worker fixes the problem and commits. orch runs the test gate and the validator again, pushes, and waits for CI again. Each round gets the task's full number of attempts for validation. Every round is recorded in the **Decisions** tab.

orch ignores comments from bots (accounts whose names end in `[bot]`) and from any account listed in `ignoreAuthors`.

## Ask for changes on your own pull requests

orch opens pull requests with your `gh` account, and GitHub doesn't let a pull request's author request changes. To send feedback on your own pull request, add a comment with a line that starts with `/orch`:

```text
/orch Use the existing date helper instead of adding a new one.
```

orch sends that comment, and every other new human comment since the last round, to the worker. To use a different trigger word, set `git.feedback.trigger`.

You can also send feedback from the dashboard with **Send back**. See [Review and merge a task](review-and-merge.md#send-a-task-back-with-feedback).

## When orch hands the pull request to you

Instead of starting another fix round or merging, orch puts the task in your inbox as a **review** item when:

- The task used up its fix rounds (`maxRounds`, 3 by default).
- A fix round produced no new commits.
- CI fails again on a commit it already failed on.
- Checks stay pending longer than `checksTimeoutMinutes` (60 by default) after a push.
- A "Request changes" review is still open after a fix. orch doesn't merge over a reviewer.
- Someone pushed commits to the pull request branch that conflict with orch's branch.

Commits that someone else pushes on top of orch's branch, such as applied review suggestions, are fine. orch includes them before the next round.

## Change how the loop behaves

Set these keys under `git.feedback` in `orch.config.json`:

```json
"git": {
  "feedback": {
    "enabled": true,
    "waitForChecks": true,
    "pollSeconds": 60,
    "maxRounds": 3,
    "trigger": "/orch",
    "ignoreAuthors": ["dependabot"]
  }
}
```

- To merge `auto` tasks without waiting for CI, set `waitForChecks` to `false`.
- To turn off the whole loop and merge right after the pull request is created, set `enabled` to `false`.
