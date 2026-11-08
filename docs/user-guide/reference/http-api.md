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

## Server

| Method and path | Body | Returns |
| :--- | :--- | :--- |
| `GET /api/health` | None | `{ok, version, uptimeSec}` |
| `POST /api/login` | `{token}` | Sets the sign-in cookie and returns `{ok, auth: true}`. With access control off, returns `{ok, auth: false}`. A wrong token returns `401`. |
| `GET /api/events/stream` | None | A live stream of server-sent events: `event` for new log entries and `change` for state changes. |

## Projects

**Planned.**

| Method and path | Body or query | Returns |
| :--- | :--- | :--- |
| `GET /api/projects` | `?archived=1` to include archived projects | A list of `{id, name, repo, archived, error, run, inboxCount}` |
| `POST /api/projects` | `{path, name?}` | The project, with `configCreated` set to the starter settings path if one was created |
| `DELETE /api/projects/:id` | None | `{ok}`. Archives the project. |
| `GET /api/projects/:id/state` | `?run=<run-id>` | A snapshot of the project and run: tasks, decisions, questions, inbox, runs and settings |
| `POST /api/projects/:id/plan` | `{specDir, llm, dryRun?}` | The new run. With `dryRun`, the parsed tasks instead. |
| `GET /api/inbox` | None | Inbox items from every project, each with `project_id` and `project_name` |

## Runs and state

| Method and path | Body or query | Returns |
| :--- | :--- | :--- |
| `GET /api/state` | `?project=<project-id>` | A snapshot of the project's current or newest run. Without `project`, uses the first project by name. |
| `GET /api/runs/:id` | None | A snapshot of that run |
| `POST /api/plan` | `{specDir, llm, project?}` | The new run. Without `project`, orch uses the project whose repo contains `specDir`. |
| `POST /api/runs/:id/approve` | None | `{ok}` |
| `POST /api/runs/:id/start` | None | `{ok}` |
| `POST /api/runs/:id/pause` | None | `{ok}` |
| `POST /api/runs/:id/stop` | None | `{ok}` |
| `GET /api/runs/:id/events` | `?after=<event-id>&limit=<n>` | The run's log entries |

## Tasks

| Method and path | Body or query | Returns |
| :--- | :--- | :--- |
| `POST /api/tasks/:id/retry` | None | `{ok}` |
| `POST /api/tasks/:id/skip` | None | `{ok}` |
| `POST /api/tasks/:id/stop` | None | `{ok}` |
| `POST /api/tasks/:id/merge` | None | `{ok}` |
| `POST /api/tasks/:id/mark-merged` | None | `{ok}` |
| `POST /api/tasks/:id/edit` | Any of `title`, `description`, `acceptance`, `depends_on`, `merge_policy`, `validate_cmd`, `max_attempts`, `files_owned` (an array of paths or globs; any other type is `400`). **Planned:** `validate_mode`. | `{ok}` |
| `POST /api/tasks/:id/request-changes` | `{feedback}`, not empty | `{ok}`. Only for tasks waiting for review or CI. |
| `GET /api/tasks/:id/diff` | None | `{base, head, files, truncated}`, where each file has `path`, `status`, `additions`, `deletions`, `binary` and `patch`. `404` with the reason when the task has no working copy. |
| `GET /api/tasks/:id/events` | `?after=<event-id>&limit=<n>` | The task's log entries |

Task IDs in these paths are the internal IDs in snapshots, not task keys such as `T003`.

## Questions and decisions

| Method and path | Body | Returns |
| :--- | :--- | :--- |
| `POST /api/questions/:id/answer` | `{answer}` | `{ok}`. A second answer returns `400` "already answered". |
| `POST /api/ask` | Used by `orch ask` | The question |
| `POST /api/decide` | Used by `orch decide` | The decision |

## Phases

**Planned.**

| Method and path | Body | Returns |
| :--- | :--- | :--- |
| `POST /api/phases/:id/revalidate` | None | `{ok}`. Runs phase validation again. |
| `POST /api/phases/:id/accept` | None | `{ok}`. Accepts the phase so later phases continue. |
