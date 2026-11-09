# Feature status

This page summarizes what orch does in the current release, what's coming next, and what it doesn't do.

## Available now

| Area | Features |
| :--- | :--- |
| Planning | Import `tasks.md` with phases, `[P]` markers, explicit dependencies and done tasks; preview with `orch plan --dry-run`, which also shows each task's brief and the folder checks (unresolved markers, parallel tasks sharing a file, oversized briefs, tests-only tasks); planner agent for acceptance criteria, dependencies, merge policy, task test commands and validation mode; plan questions that hold the whole run until answered; fallback to the imported tasks if the planner fails; plan review and editing; approval before any task runs, refused for dependency loops |
| Running | Start, pause and stop; one unfinished run per project; recovery after a restart; per-project parallel limit; global agent limit shared fairly across projects; owned files, so tasks that touch the same files never run at the same time ([Run tasks in parallel](how-to/run-in-parallel.md#owned-files)) |
| Workers | One working copy and branch per task; hand-off brief; session resume on retry; attempt limit; time limit; copied files and setup command |
| Validation | Test gate; independent validator agent with evidence per criterion; validator on a different agent program or model; findings for changes outside a task's owned files; phase validation on the base branch with automatic fix-up tasks ([Validate whole phases](how-to/validate-phases.md)); test gate output given to every validator; UI validation mode, where orch starts your app and the validator tests it in a browser ([Validate UI tasks in a browser](how-to/validate-ui-tasks.md)) |
| You in the loop | Inbox for plan approval, questions, failed tasks, review items and phases that need you; push notifications with the project name; questions that pause only one task; decisions log; retry, skip, stop, merge now, merged elsewhere, send back |
| Merging | Pull request mode with `gh`; local merge mode; automatic and manual merge policies; `tasks.md` ticks on the base branch |
| Pull request loop | CI failures and review comments sent back to the worker; `/orch` comments; fix round limit; merged or closed pull requests detected |
| Agents | Claude Code and Gemini CLI adapters; per-role agent and model, with per-project overrides; prompt overrides per project |
| Dashboard | Project switcher with status and inbox counts; add and archive projects; one inbox for all projects; Board, Plan, Decisions and Activity tabs; task panel with live log; diff viewer; send back; run history; cost and agent time per task, run and project ([Track cost and agent time](how-to/track-cost.md)); automatic reconnect after a lost connection |
| Projects | Several projects in one server; `orch project add`, `list` and `remove`; `--project` and `ORCH_PROJECT` ([Add and manage projects](how-to/manage-projects.md)); per-project settings file in the repo; server settings kept apart from project settings; automatic upgrade of single-repo installations |
| Operations | Archive of old agent logs to compressed files ([Archive old activity logs](how-to/archive-event-logs.md)); access token for the dashboard, API and command line; refusal to listen on a network without a token; open health check; systemd unit; Docker image; automatic database upgrades |

## Coming later

Today, a worker starts each task from a one-line entry in `tasks.md`, plus whatever the planner agent and a spec excerpt add. That's the weakest point in the process: the spec is often cut short, and the validator sees even less. The next group of releases replaces it with *task briefs* that you write once and that orch reads directly.

None of this is in the current release. Names, commands and settings may change before they ship. The reasoning is recorded in [decision 0023](../decisions/0023-orch-owns-spec-skill.md).

| Area | What's planned |
| :--- | :--- |
| Task briefs | A feature folder can hold one brief per task, such as `tasks/T001.md` beside `tasks.md`. A brief carries the task's goal, acceptance criteria, dependencies, merge policy, validation mode and the files it changes. When a brief exists, orch takes these values from it. |
| Planning without an agent | When every task has a brief, `orch plan` builds the plan from the briefs and calls no agent. The planner runs only for tasks without a brief, or for the whole plan when you ask for a review. Every change the reviewing planner makes is recorded as a decision with its reason. |
| Import checks | *The preview and the checks are available now; recording the warnings as decisions comes with planning from briefs.* The preview shows which tasks have a brief and which fields came from it. It warns when two parallel tasks change the same file, when a brief is too long, and when a task adds only tests. Import refuses a spec that still contains an unresolved marker such as `TBD`, unless you override. |
| More context for agents | Workers receive the brief in full, the requirements it cites, the interfaces it names, and a project rules file (`AGENTS.md` by default). Validators receive the same, but never the worker's transcript. Without a brief, workers get `spec.md` before `plan.md`, each within its own size limit. |
| Validation against project rules | The validator rejects a change that breaks a project rule or a named interface, and quotes the rule in its verdict. |
| Fold-back after a run | When a run completes, an inbox item named **Update project docs** lists the requirements the merged tasks covered, the decisions made during the run, the plan edits you made in the dashboard, and the interfaces that changed. You use it to bring the project's documents up to date. |
| The `orch-spec` skill | A Claude Code skill that ships with orch and writes everything orch reads. Its project mode interviews you once per project and writes requirements, architecture, decision records, project rules and a roadmap. Its feature mode writes the feature folder and its briefs. Its fold-back mode updates the project documents after a run. Its adopt mode adds briefs to an existing Spec Kit folder without changing its tasks. |

Spec Kit folders keep working as they do today, with or without briefs.

## Not planned

These are outside orch's scope:

- Writing specs inside orch. orch starts from a `tasks.md` task list. Writing it is the job of a separate tool: Spec Kit today, and the `orch-spec` skill when it ships.
- Running agents in a vendor's cloud. orch runs agents on your own machine.
- Several users or teams with roles. orch has one owner.
- Spending limits. orch shows cost but doesn't enforce limits.
- Running natively on Windows. Use WSL2 or Docker.
- Other agent programs, such as Codex, OpenCode or Aider, for now. The adapter design allows them later.
