# Feature status

This page summarizes what orch does in the current release and what it doesn't do.

## Available now

| Area | Features |
| :--- | :--- |
| Writing specs | The `orch-spec` skill for Claude Code, which ships with orch: project mode writes the project record (rules, requirements, architecture, decisions, roadmap), feature mode writes a feature folder with a brief per task and checks it, fold-back mode brings a run's results back into the record, and adopt mode adds briefs to a Spec Kit folder without changing its tasks ([Write specs with the orch-spec skill](how-to/write-specs-with-orch-spec.md), [Import a Spec Kit folder](how-to/import-a-spec-kit-folder.md)) |
| Planning | Import `tasks.md` with phases, `[P]` markers, explicit dependencies and done tasks; task briefs (`tasks/T001.md` beside `tasks.md`) that set a task's acceptance criteria, dependencies, merge policy, validation mode, test command and owned files; a plan built from the briefs without calling an agent when every task has criteria in its brief; `orch plan --review` to have the planner review the whole plan without removing a brief's criteria; preview with `orch plan --dry-run`, which also shows each task's brief and the folder checks (unresolved markers, parallel tasks sharing a file, oversized briefs, tests-only tasks); import warnings, `[P]` conflicts and `--allow-open` overrides recorded as decisions; planner agent for tasks without brief criteria: acceptance criteria, dependencies, merge policy, task test commands and validation mode; plan questions that hold the whole run until answered; fallback to the imported tasks if the planner fails; plan review and editing; approval before any task runs, refused for dependency loops |
| Running | Start, pause and stop; one unfinished run per project; recovery after a restart; per-project parallel limit; global agent limit shared fairly across projects; owned files, so tasks that touch the same files never run at the same time ([Run tasks in parallel](how-to/run-in-parallel.md#owned-files)) |
| Workers | One working copy and branch per task; the task's brief, the requirements it cites, the contracts it names and the project rules file (`AGENTS.md`), each within its own size limit; without a brief, `spec.md` before `plan.md`, each within its own limit; hand-off brief; session resume on retry; attempt limit; time limit; copied files and setup command |
| Validation | Test gate; independent validator agent with evidence per criterion; validator on a different agent program or model; findings for changes outside a task's owned files; phase validation on the base branch with automatic fix-up tasks ([Validate whole phases](how-to/validate-phases.md)); test gate output given to every validator; validators get the same brief, requirements, contracts and project rules as the worker, never its transcript, and reject a change that breaks a project rule or a named contract, quoting it; UI validation mode, where orch starts your app and the validator tests it in a browser ([Validate UI tasks in a browser](how-to/validate-ui-tasks.md)) |
| You in the loop | Inbox for plan approval, questions, failed tasks, review items and phases that need you; an **Update project docs** item after each run, with **Copy** for the `orch-spec` fold-back mode and `orch docs-update` ([Update the project docs after a run](how-to/work-with-the-inbox.md#update-the-project-docs-after-a-run)); push notifications with the project name; questions that pause only one task; decisions log; retry, skip, stop, merge now, merged elsewhere, send back |
| Merging | Pull request mode with `gh`; local merge mode; automatic and manual merge policies; `tasks.md` ticks on the base branch |
| Pull request loop | CI failures and review comments sent back to the worker; `/orch` comments; fix round limit; merged or closed pull requests detected |
| Agents | Claude Code, Antigravity CLI and Codex CLI adapters (Gemini CLI retired); per-role agent and model, with per-project overrides; prompt overrides per project |
| Dashboard | Project switcher with status and inbox counts; add and archive projects; one inbox for all projects; Board, Plan, Decisions, Activity and Agents tabs (which agent programs and `gh` are installed and signed in, and **Sign in** from the browser); task panel with live log; diff viewer; send back; run history; cost and agent time per task, run and project ([Track cost and agent time](how-to/track-cost.md)); automatic reconnect after a lost connection |
| Projects | Several projects in one server; `orch project add`, `list` and `remove`; `--project` and `ORCH_PROJECT` ([Add and manage projects](how-to/manage-projects.md)); per-project settings file in the repo; server settings kept apart from project settings; automatic upgrade of single-repo installations |
| Operations | Archive of old agent logs to compressed files ([Archive old activity logs](how-to/archive-event-logs.md)); access token for the dashboard, API and command line; refusal to listen on a network without a token; open health check; systemd unit; Docker image; automatic database upgrades |

## Not planned

These are outside orch's scope:

- Running agents in a vendor's cloud. orch runs agents on your own machine.
- Several users or teams with roles. orch has one owner.
- Spending limits. orch shows cost but doesn't enforce limits.
- Running natively on Windows. Use WSL2 or Docker.
- Other agent programs, such as Codex, OpenCode or Aider, for now. The adapter design allows them later.
