# HTTP API

The dashboard and the `orch` command both use orch's HTTP API. You can use it too, for scripts and integrations. All requests and responses use JSON.

## Base address and authentication

The API is at orch's address, `http://127.0.0.1:4800` by default.

When an access token is set, send it with every request, in one of these ways:

- An `Authorization: Bearer <token>` header.
- The `orch_token` cookie that the dashboard sets when you sign in.

Requests without a valid token get `401` with `{"error":"unauthorized"}`. Three routes never need a token: the dashboard page (`GET /`), `GET /api/health` and `POST /api/login`.

For example:

```bash
curl -H "Authorization: Bearer $ORCH_TOKEN" http://127.0.0.1:4800/api/state
```

## Errors

Errors return `{"error": "<message>"}` with one of these status codes:

| Code | Meaning |
| :--- | :--- |
| `400` | The request isn't valid, or the action isn't allowed in the current state. |
| `401` | The token is missing or wrong. |
| `404` | The item doesn't exist. |
| `409` | A sign-in for that program is already running, or none is. |
| `501` | Signing in from the dashboard isn't supported on this server's operating system. The body also has `command`, the command to run by hand. |

## Server

| Method and path | Body | Returns |
| :--- | :--- | :--- |
| `GET /api/health` | None | `{ok, version, uptimeSec}` |
| `POST /api/login` | `{token}` | Sets the sign-in cookie and returns `{ok, auth: true}`. With access control off, returns `{ok, auth: false}`. A wrong token returns `401`. |
| `GET /api/events/stream` | None | A live stream of server-sent events: `event` for new log entries, `change` for state changes (including `settings`) and `account` for a sign-in flow's lines and end. |

## Settings

The Settings tab uses these routes. Secrets are write-only: a read returns `{"set": true}` or `{"set": false}` in place of the token, the ntfy token and every adapter environment value.

| Method and path | Body | Returns |
| :--- | :--- | :--- |
| `GET /api/settings/schema` | None | Every setting: `{key, scope, type, default, enum, min, max, description, group, secret, restart, advanced}`. |
| `GET /api/settings/server` | None | `{settings, restartRequired, path}`: `server.json` over the defaults, and the keys saved since orch started that need a restart. |
| `PUT /api/settings/server` | `{settings}` | `{ok, restartRequired}`. `settings` holds only the keys to change; a secret sent as `{"set": true}`, or left out, keeps its stored value, and `null` removes a key. `400` with the reason, and `server.json` unchanged, when a key isn't a server setting or the value is refused. |
| `POST /api/settings/notify-test` | None | `{ok: true}`, or `{ok: false, error}`. Sends one message, `orch: test notification`, with the saved ntfy address and token. |
| `GET /api/projects/:id/settings` | None | `{settings, effective, warnings, error, path, exists}`: the project file, the settings orch will use, and the problems found in the file. |
| `PUT /api/projects/:id/settings` | `{settings}` or `{settings, replace: true}` | `{ok, committed, reason, warnings, path}`. Without `replace`, `settings` holds only the keys to change. `400` with the reason, and the file unchanged, for a server-only key or a refused value. `committed` is `false`, with `reason`, when the checkout wasn't clean or wasn't on the base branch; the file is still written. |

## Agent accounts

| Method and path | Body | Returns |
| :--- | :--- | :--- |
| `GET /api/accounts` | None | One row per adapter in `agents.adapters` plus `gh`: `{id, kind, type, command, version, status, detail, loginActive, canLogin, loginNotice, manualCommand}`. `status` is `signed_in`, `signed_out` or `unknown`. A program that can't be started has `version: null` and a `detail` that starts with `not installed`. Each check has a 15-second limit. |
| `GET /api/accounts/:id/login` | None | `{active, lines}`: what a running sign-in has printed so far. |
| `POST /api/accounts/:id/login` | None | Starts the program's own sign-in. `409` if one is running, `501` on an unsupported system. |
| `POST /api/accounts/:id/login/input` | `{text}` | Sends `text` and **Enter** to the running sign-in. Empty `text` sends only **Enter**. |
| `POST /api/accounts/:id/login/cancel` | None | Stops the running sign-in. |

The lines and the end of a sign-in arrive on the live stream as `account` events: `{id, line}`, then `{id, done: true, exitCode}`, then `{id, account}` with the new row. orch doesn't store them.

## Projects

| Method and path | Body or query | Returns |
| :--- | :--- | :--- |
| `GET /api/projects` | `?archived=1` to include archived projects | A list of `{id, name, repo, archived, error, run, inboxCount}` |
| `POST /api/projects` | `{path, name?}` | The project, with `configCreated` set to the starter settings path if one was created |
| `DELETE /api/projects/:id` | None | `{ok}`. Archives the project. |
| `GET /api/projects/:id/state` | `?run=<run-id>` | The state of the project and run: tasks, decisions, questions, phases, inbox, runs, settings, and `totals` with the cost and agent time of the run and the project (`{costUsd, agentMs}`; `costUsd` is `null` when no agent reported a cost) |
| `POST /api/projects/:id/plan` | `{specDir, llm, dryRun?}` | The new run. With `dryRun`, the preview instead: `{dir, title, tasks, hasBriefs, conflicts, problems, cycle}`, where each task carries its brief fields (`brief`, `fromBrief`, the effective `depends_on`) and `problems` are the folder checks (`{kind, rule, file, line, message}`). |
| `GET /api/inbox` | None | Inbox items from every project, each with `project_id` and `project_name` |

## Runs and state

| Method and path | Body or query | Returns |
| :--- | :--- | :--- |
| `GET /api/state` | `?project=<project-id>` | The state of the project's current or newest run. Without `project`, uses the first project by name. |
| `GET /api/runs/:id` | None | The state of that run |
| `POST /api/plan` | `{specDir, llm, project?}` | The new run. Without `project`, orch uses the project whose repo contains `specDir`. |
| `POST /api/runs/:id/approve` | None | `{ok}` |
| `POST /api/runs/:id/start` | None | `{ok}` |
| `POST /api/runs/:id/pause` | None | `{ok}` |
| `POST /api/runs/:id/stop` | None | `{ok}` |
| `GET /api/runs/:id/docs-update` | None | The run's "Update project docs" item: `{type, run_id, title, detail, update, text, ack_at}`, where `text` is what **Copy** gives. `404` when the run has none. |
| `POST /api/runs/:id/docs-update/ack` | None | `{ok}`. Acknowledges the item, so it leaves the inbox. `400` when the run has none. |
| `GET /api/runs/:id/events` | `?after=<event-id>&limit=<n>` | The run's log entries |

## Tasks

| Method and path | Body or query | Returns |
| :--- | :--- | :--- |
| `POST /api/tasks/:id/retry` | None | `{ok}` |
| `POST /api/tasks/:id/skip` | None | `{ok}` |
| `POST /api/tasks/:id/stop` | None | `{ok}` |
| `POST /api/tasks/:id/merge` | None | `{ok}` |
| `POST /api/tasks/:id/mark-merged` | None | `{ok}` |
| `POST /api/tasks/:id/edit` | Any of `title`, `description`, `acceptance`, `depends_on`, `merge_policy`, `validate_cmd`, `validate_mode` (`standard` or `ui`), `max_attempts`, `files_owned` (an array of paths or globs). A value of the wrong type or any other field is `400`. | `{ok}` |
| `POST /api/tasks/:id/request-changes` | `{feedback}`, not empty | `{ok}`. Only for tasks waiting for review or CI. |
| `GET /api/tasks/:id/diff` | None | `{base, head, files, truncated}`, where each file has `path`, `status`, `additions`, `deletions`, `binary` and `patch`. `404` with the reason when the task has no working copy. |
| `GET /api/tasks/:id/events` | `?after=<event-id>&limit=<n>` | The task's log entries |

Task IDs in these paths are the `id` values that the state endpoints return, not task keys such as `T003`.

## Questions and decisions

| Method and path | Body | Returns |
| :--- | :--- | :--- |
| `POST /api/questions/:id/answer` | `{answer}` | `{ok}`. A second answer returns `400` "already answered". |
| `POST /api/ask` | Used by `orch ask` | The question |
| `POST /api/decide` | Used by `orch decide` | The decision |

## Phases

The phase ids are in the `phases` list of the project state and in phase inbox items (`phase_id`). Both actions need a phase that waits on you; otherwise they return `400`.

| Method and path | Body | Returns |
| :--- | :--- | :--- |
| `POST /api/phases/:id/revalidate` | None | `{ok}`. Runs phase validation again. |
| `POST /api/phases/:id/accept` | None | `{ok}`. Accepts the phase so later phases continue. |
