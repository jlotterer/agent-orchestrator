# Feature status

This manual describes all of orch, including features that are still in development. This page lists what's available in the current release and what's planned. Throughout the manual, planned features are marked **Planned**.

## Available now

| Area | Features |
| :--- | :--- |
| Planning | Import `tasks.md` with phases, `[P]` markers, explicit dependencies and done tasks; planner agent for acceptance criteria, dependencies, merge policy and task test commands; fallback to the imported tasks if the planner fails; plan review and editing; approval before any task runs |
| Running | Start, pause and stop; one unfinished run per project; recovery after a restart; per-project parallel limit; global agent limit shared fairly across projects |
| Workers | One working copy and branch per task; hand-off brief; session resume on retry; attempt limit; time limit; copied files and setup command |
| Validation | Test gate; independent validator agent with evidence per criterion; validator on a different agent program or model |
| You in the loop | Inbox for plan approval, questions, failed tasks and review items; push notifications with the project name; questions that pause only one task; decisions log; retry, skip, stop, merge now, merged elsewhere, send back |
| Merging | Pull request mode with `gh`; local merge mode; automatic and manual merge policies; `tasks.md` ticks on the base branch |
| Pull request loop | CI failures and review comments sent back to the worker; `/orch` comments; fix round limit; merged or closed pull requests detected |
| Agents | Claude Code and Gemini CLI adapters; per-role agent and model, with per-project overrides; prompt overrides per project |
| Dashboard | Board, Plan, Decisions and Activity tabs; task panel with live log; diff viewer; send back; run history |
| Projects | Several projects in one server; per-project settings file in the repo; server settings kept apart from project settings; automatic upgrade of single-repo installations |
| Operations | Access token for the dashboard, API and command line; refusal to listen on a network without a token; open health check; systemd unit; Docker image; automatic database upgrades |

## Planned

| Feature | What it adds | Where it's described |
| :--- | :--- | :--- |
| Project commands | `orch project add`, `list` and `remove`; `--project` and `ORCH_PROJECT`; exit code `2` for usage errors; a global inbox in the API | [Add and manage projects](how-to/manage-projects.md), [CLI reference](reference/cli.md) |
| Multi-project dashboard | Project switcher with status and inbox counts; add and archive from the dashboard; one inbox for all projects; automatic reconnect after a lost connection | [Dashboard reference](reference/dashboard.md) |
| Log archiving | Agent logs of old finished runs moved to compressed files; `orch archive-events`; `retention.eventDays` | [Archive old activity logs](how-to/archive-event-logs.md) |
| Plan questions and preview | Plan questions not tied to a task, which hold the whole run until answered; `orch plan --dry-run`; approval refused for dependency loops | [Plan a feature](how-to/plan-a-feature.md), [Review and approve a plan](how-to/review-a-plan.md) |
| Owned files | Tasks declare the files they own; overlapping tasks never run at the same time; validator reports changes outside owned files | [Run tasks in parallel](how-to/run-in-parallel.md#owned-files) |
| Phase validation | Each phase checked on the base branch; automatic fix-up tasks; phase inbox items | [Validate whole phases](how-to/validate-phases.md) |
| UI validation mode | orch starts your app and the validator tests it in a browser; test gate output given to every validator | [Validate UI tasks in a browser](how-to/validate-ui-tasks.md) |
| Cost and agent time | Totals per task, run and project in the dashboard | [Track cost and agent time](how-to/track-cost.md) |

These features are planned in roughly the order listed. Details, including setting names and dashboard labels, can change before they're released.

## Not planned

These are outside orch's scope:

- Writing specs from free text. orch starts from Spec Kit's `tasks.md`.
- Running agents in a vendor's cloud. orch runs agents on your own machine.
- Several users or teams with roles. orch has one owner.
- Spending limits. orch shows cost but doesn't enforce limits.
- Running natively on Windows. Use WSL2 or Docker.
- Other agent programs, such as Codex, OpenCode or Aider, for now. The adapter design allows them later.
