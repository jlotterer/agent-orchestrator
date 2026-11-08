# Server settings

Server settings apply to the whole orch server and every project. They live in `server.json` in the data directory, `~/.orch/server.json` by default. If the file doesn't exist, orch uses the defaults. Restart orch after you change it.

For a full example, see `examples/server.example.json` in the orch source.

## Network and access

| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `host` | string | `127.0.0.1` | The address orch listens on. `0.0.0.0` listens on every interface and requires an access token. |
| `port` | integer | `4800` | The port for the dashboard and API. |
| `publicUrl` | URL | `http://localhost:4800` | The address notifications link to. |
| `auth.token` | string | `""` | The access token. Empty turns access control off. The `ORCH_TOKEN` environment variable overrides it. See [Secure remote access](../how-to/secure-access.md). |
| `auth.allowInsecure` | boolean | `false` | `true` lets orch listen on a network address without a token. |

## Notifications

| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `notify.ntfyUrl` | URL | `""` | The ntfy topic address, such as `https://ntfy.sh/<topic>`. Empty turns notifications off. See [Get push notifications](../how-to/set-up-notifications.md). |
| `notify.ntfyToken` | string | `""` | An access token for a protected ntfy topic. |

## Agents

| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `agents.timeoutMinutes` | integer | `90` | The longest an agent session may run before orch ends it and counts the attempt as failed. |
| `agents.adapters.<name>.type` | `claude` or `gemini` | Not applicable | Which kind of adapter this is. |
| `agents.adapters.<name>.command` | string | `claude` or `gemini` | The program to run. |
| `agents.adapters.<name>.extraArgs` | list of strings | `claude`: `["--permission-mode", "bypassPermissions"]`; `gemini`: `["--yolo", "--skip-trust"]` | Arguments added to every launch. |
| `agents.adapters.<name>.env` | object | `{}` | Extra environment variables for the program, such as `GEMINI_API_KEY`. Never stored or logged. |
| `agents.roles.planner` | `{ "adapter", "model" }` | `claude`, default model | The default agent for planning. |
| `agents.roles.worker` | `{ "adapter", "model" }` | `claude`, default model | The default agent for writing code. |
| `agents.roles.validator` | `{ "adapter", "model" }` | `claude`, default model | The default agent for validation. |
| `agents.roles.phaseValidator` | `{ "adapter", "model" }` | The validator's setting | The default agent for phase validation. |

The adapters `claude` and `gemini` are defined by default. A role's `adapter` must name a defined adapter, or orch refuses to start. See [Choose agents and models](../how-to/configure-agents.md).

## Scheduling

| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `scheduler.maxAgents` | integer | `2` | The most agent sessions running at once across all projects. Planners, workers and validators all count. |
| `scheduler.tickSeconds` | integer | `5` | How often the scheduler checks for work to start. |

## Retention

| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `retention.eventDays` | integer | `30` | **Planned.** Days after a run finishes before its agent logs are archived. `0` never archives. See [Archive old activity logs](../how-to/archive-event-logs.md). |

## GitHub

| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `git.ghCommand` | string | `gh` | The GitHub CLI program to run. |

## Project defaults

| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `defaults` | object | `{}` | Project settings applied under every project's own `orch.config.json`. Uses the same keys as [Project settings](project-settings.md). It can't contain server keys. |

For example, to make every project review all merges unless its own file says otherwise:

```json
"defaults": { "git": { "mergePolicy": "manual" } }
```

## Environment variables

These environment variables affect orch and the `orch` command.

| Variable | Used by | Description |
| :--- | :--- | :--- |
| `ORCH_HOME` | Server and command | The data directory. Default: `~/.orch`. |
| `ORCH_TOKEN` | Server and command | The access token. Overrides `auth.token`. |
| `ORCH_URL` | Command | The server address, for example `http://my-server:4800`. Default: `http://127.0.0.1:<port>`. |
| `ORCH_PROJECT` | Command | **Planned.** The project commands act on, unless `--project` is given. |
| `ORCH_CONFIG` | Server | Only for upgrading a single-repo installation: the old settings file. |

orch sets these for agents inside a task. You don't set them yourself:

| Variable | Description |
| :--- | :--- |
| `ORCH_URL` | The server address. |
| `ORCH_TOKEN` | The access token, when one is set. |
| `ORCH_TASK_ID`, `ORCH_RUN_ID` | The task and run the agent works on. |
| `ORCH_ACTOR` | The agent's role, used as the actor of its decisions. |
