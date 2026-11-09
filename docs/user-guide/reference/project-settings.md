# Project settings

Each project's settings live in `orch.config.json` at the top of its repo. orch reads the file again whenever you plan or start a run in that project, so changes apply from the next run without a restart. A run that's already going keeps the settings it started with.

Every key is optional. When a key is missing, orch uses the value from `defaults` in `server.json`, and then the built-in default.

For a full example, see `orch.config.example.json` in the orch source.

## Keys a project file can't set

These are server settings. If a project file contains any of them, orch refuses to plan or start that project, and the error names each key: `agents`, `host`, `port`, `publicUrl`, `auth`, `notify`, `dbPath`, `worktreeDir`, `repo`, `git.ghCommand`.

This stops a cloned repo from changing which programs run on your server or which credentials they get.

orch ignores unknown keys and shows a warning in the run's **Activity** tab.

## General

| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `name` | string | The repo folder name | Display name. |
| `baseBranch` | string | `main` | The branch tasks start from and merge into. |

## Scheduling (`scheduler`)

| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `scheduler.maxParallel` | integer | `1` | How many of this project's tasks run at once. `1` runs them one after another. See [Run tasks in parallel](../how-to/run-in-parallel.md). |
| `scheduler.maxAttempts` | integer | `2` | How many worker attempts a task gets before it fails and goes to your inbox. |
| `scheduler.resumeOnRetry` | boolean | `true` | Whether a retry resumes the worker's earlier session. `false` starts each attempt fresh. |

## Validation (`validation`)

| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `validation.command` | string | `""` | The test gate command, run in each task's working copy before the validator, for example `npm test`. Empty skips the gate. A task's own test command replaces it. Times out after 20 minutes. |
| `validation.agent` | boolean | `true` | Whether the validator agent runs. `false` lets the test gate decide alone. |
| `validation.phase.enabled` | boolean | `true` | Whether to validate each phase on the base branch. See [Validate whole phases](../how-to/validate-phases.md). |
| `validation.phase.command` | string | `""` | The phase test command. Empty uses `validation.command`. |
| `validation.phase.maxFixups` | integer | `2` | Fix-up tasks per phase before the phase goes to your inbox. |
| `validation.ui.startCommand` | string | `""` | The command that starts your app for UI validation. See [Validate UI tasks in a browser](../how-to/validate-ui-tasks.md). |
| `validation.ui.url` | string | `http://127.0.0.1:{port}/` | The app address given to the validator. `{port}` is replaced with the chosen port. |
| `validation.ui.readyTimeoutSeconds` | integer | `120` | How long to wait for the app to answer. |
| `validation.ui.env` | object | `{}` | Extra environment variables for the app. |

## Git and merging (`git`)

| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `git.pr` | boolean | `true` | `true`: push, open a pull request, and merge on GitHub. `false`: merge into the local base branch. See [Choose how tasks merge](../how-to/choose-merge-mode.md). |
| `git.mergePolicy` | `auto` or `manual` | `auto` | The default merge policy for tasks. The planner can set `manual` on individual tasks. |
| `git.squash` | boolean | `true` | `true`: squash merge. `false`: in pull request mode, a merge commit; in local mode, a fast-forward merge. |
| `git.copyFiles` | list of paths | `[]` | Files copied from the repo into each new working copy, such as `[".env"]`. |
| `git.setupCommand` | string | `""` | A command run in each new working copy before the worker starts, such as `npm ci`. Times out after 15 minutes. |
| `git.tickTasksMd` | boolean | `true` | Whether to tick merged tasks in `tasks.md` on the base branch. |

### Pull request feedback (`git.feedback`)

These keys apply only in pull request mode. See [Use the pull request feedback loop](../how-to/use-pr-feedback.md).

| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `git.feedback.enabled` | boolean | `true` | Whether orch watches open pull requests. `false` merges `auto` tasks right after the pull request is created. |
| `git.feedback.waitForChecks` | boolean | `true` | Whether `auto` tasks wait for checks to pass before merging. |
| `git.feedback.pollSeconds` | integer | `60` | How often orch checks each open pull request. |
| `git.feedback.maxRounds` | integer | `3` | Fix rounds from CI and reviews before the task goes to your inbox. **Send back** isn't limited. |
| `git.feedback.checksTimeoutMinutes` | integer | `60` | How long checks may stay pending after a push before the task goes to your inbox. |
| `git.feedback.noChecksGraceSeconds` | integer | `90` | How long to wait after a push for checks to appear before treating a pull request without checks as passing. |
| `git.feedback.trigger` | string | `/orch` | A comment line that starts with this text starts a fix round. |
| `git.feedback.ignoreAuthors` | list of strings | `[]` | Accounts whose comments never start a fix round. Bots are always ignored. |
| `git.feedback.logChars` | integer | `6000` | How many characters of failed CI logs to send to the worker. |

## Worker context (`handoff`)

| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `handoff.contextFiles` | list of file names | `["spec.md", "data-model.md", "plan.md"]` | The feature files given to a worker whose task has no brief, in this order. Files that don't exist are skipped. `tasks.md` is never included. |
| `handoff.specChars` | integer | `12000` | The size limit of the feature file excerpt, in characters. The planner gets twice this. |
| `handoff.historyChars` | integer | `6000` | The size limit of the summary of earlier tasks, decisions and answers, in characters. |
| `handoff.briefChars` | integer | `8000` | The size limit of a task brief (`tasks/T001.md`), in characters. |
| `handoff.reqChars` | integer | `4000` | The size limit of the requirement rows and acceptance criteria for the requirement IDs a brief cites, in characters. |
| `handoff.contractChars` | integer | `6000` | The size limit of each contract a brief names, in characters. |
| `handoff.rulesChars` | integer | `6000` | The size limit of each project rules file, in characters. |
| `handoff.requirementsFile` | path | `docs/requirements.md` | The requirements file, relative to the repository, that cited rows are taken from. A row that isn't found is noted in the worker's context, not treated as an error. |
| `handoff.projectFiles` | list of paths | `["AGENTS.md"]` | Project rules files, relative to the repository, given to agents when they exist. |

Text over a limit is cut with a visible marker, not dropped.

The brief, requirement, contract and rules settings take effect when task briefs ship; see [Coming later](../feature-status.md#coming-later). Until then, a worker receives the `contextFiles` excerpt as one block of up to `handoff.specChars` characters. After that, each file and each part has its own limit, so a long `plan.md` can't cut `spec.md`, and every cut is recorded as a decision.

## Agent roles (`roles`)

| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `roles.planner` | `{ "adapter", "model" }` | From `server.json` | The agent and model for planning. |
| `roles.worker` | `{ "adapter", "model" }` | From `server.json` | The agent and model for writing code. |
| `roles.validator` | `{ "adapter", "model" }` | From `server.json` | The agent and model for validation. |
| `roles.phaseValidator` | `{ "adapter", "model" }` | The validator's setting | The agent and model for phase validation. |

`adapter` must name an adapter defined in `server.json`. An empty `model` uses the agent program's default. See [Choose agents and models](../how-to/configure-agents.md).

## Example

```json
{
  "name": "shop",
  "baseBranch": "main",
  "scheduler": { "maxParallel": 2, "maxAttempts": 2 },
  "validation": { "command": "npm test" },
  "git": {
    "pr": true,
    "mergePolicy": "auto",
    "copyFiles": [".env.test"],
    "setupCommand": "npm ci",
    "feedback": { "maxRounds": 3, "ignoreAuthors": ["dependabot"] }
  },
  "roles": { "validator": { "adapter": "gemini", "model": "pro" } }
}
```
