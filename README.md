# orch.

An orchestrator / worker / validator runner for Claude Code, with a live dashboard.

You write a spec with the `orch-spec` skill that ships here ([Writing specs](#writing-specs)), with GitHub Spec Kit, or with any tool that produces a `tasks.md` task list. `orch` turns `tasks.md` into a plan, runs each task
in its own git worktree with a **fresh-context worker**, checks the result with an **independent
validator**, opens the PR, merges it, and moves on. Every decision an agent makes is logged.
Anything that needs *you* lands in an inbox and pings your phone.

**User manual:** [docs/user-guide/](docs/user-guide/index.md) covers installation, concepts, how-to guides and
reference for every shipped feature. [Feature status](docs/user-guide/feature-status.md) lists what's coming next:
authored task briefs read by orch itself ([decision 0023](docs/decisions/0023-orch-owns-spec-skill.md)); the `orch-spec` skill that writes them has shipped ([skills/README.md](skills/README.md)).

```
spec.md / plan.md / tasks.md  ──►  orch plan  ──►  [you approve]  ──►  orch run
                                                                        │
                      ┌─────────────────────────────────────────────────┘
                      ▼
          for each task (respecting dependencies, N in parallel):
          worktree ─► worker (fresh context + hand-off brief) ─► commit
                   ─► validation command (deterministic gate)
                   ─► validator agent (fresh context, PASS/FAIL with evidence)
                   ─► PR ─► merge (auto, or wait for you) ─► tick tasks.md ─► next
          when a phase's tasks are all done:
          base branch ─► phase test command ─► phase validator ─► PASS: next phase
                                                               FAIL: fix-up task FIX-<n>.<round>
```

## Why it looks like this

* **Fresh context per task.** Each worker starts clean. What it needs from earlier tasks arrives as
  a short hand-off brief the orchestrator writes from the previous workers' summaries, the
  decisions log, and your answers. Nothing depends on a single long session staying coherent.
* **Validation is a different agent.** The validator never sees the worker's reasoning, only the
  task, the acceptance criteria and the diff. It runs the tests itself and must cite evidence per
  criterion. Set `agent.validatorModel` to a different model for a second opinion.
* **The orchestrator is code, not a model.** It only calls an LLM for two things: drafting the plan
  and nothing else. Scheduling, retries, git and merges are deterministic and inspectable.
* **Decisions are first-class.** Agents run `orch decide "..." --why "..."` when they make a
  judgement call. Blocking ambiguity is `orch ask "..." --options "A,B"`; the task pauses, you
  answer from the dashboard or phone, and the worker resumes *its own session* with the answer.

## Install

Requirements: Node 22+, git, [Claude Code](https://docs.claude.com/en/docs/claude-code) logged in,
and `gh` (GitHub CLI) if you want PRs. Linux or WSL2.

```bash
git clone <this repo> ~/orch && cd ~/orch
npm install && npm run build
npm link            # puts `orch` on your PATH (optional; agents get it automatically)
```

## Set up

One daemon serves all your projects (repos). It keeps all of its state in one data directory,
`$ORCH_HOME` (default `~/.orch`):

```
~/.orch/
├── server.json             server settings (network, access token, notifications, agent CLIs, global agent limit)
├── orch.db                 SQLite: every project's runs, tasks, decisions, questions
└── worktrees/<project>/    one worktree per active task
```

Each repo carries its own project settings in `<repo>/orch.config.json`. Changes to that file take
effect at the next run start, without restarting orch.

### First project

```bash
cd ~/projects/myapp
orch init           # writes orch.config.json (single-file format)
# edit it: validation.command, notify.ntfyUrl, git.pr, ...
orch serve          # dashboard on http://<host>:4800
```

On its first start, `orch serve` converts the single file into the two-file layout, once:

1. It writes `$ORCH_HOME/server.json` from the server keys (`host`, `port`, `publicUrl`, `auth`,
   `notify`, `agents`, `scheduler.tickSeconds`, `git.ghCommand`). The global agent limit
   `scheduler.maxAgents` starts at the file's `scheduler.maxParallel`.
2. It saves the original as `orch.config.json.bak` and rewrites `orch.config.json` with the project
   keys only.
3. It registers the repo as a project. If the old database (`dbPath`, by default `.orch/orch.db`)
   exists, orch copies it to `$ORCH_HOME/orch.db` and assigns every existing run to the project, so
   past runs, decisions and questions stay visible.

An existing single-repo install upgrades the same way. The upgrade runs only while `server.json`
does not exist, and it is recorded in the **Decisions** tab.

### More projects

With the daemon running, register each further repo by the path of its top-level directory:

```bash
orch project add ~/projects/otherapp --name otherapp
# registered project otherapp "otherapp" at /home/you/projects/otherapp
# created starter settings file /home/you/projects/otherapp/orch.config.json; set validation.command there
orch project list                # id, name, current run status, open inbox items, repo
orch project remove otherapp     # archive it
```

* A path that isn't a git repository root is refused. So is a repo that is already registered; the
  message names its project.
* If the repo has no `orch.config.json`, orch writes a starter file with the detected base branch and
  an empty `validation.command`. Fill in the test command before the first run.
* `orch project remove` archives the project: it leaves the default list (see it with
  `orch project list --archived`) and the inbox, but the repo and the project's history stay. It is
  refused while the project has an unfinished run; stop that run first. `orch project add` with the
  same path restores the project with its runs.

The dashboard does the same from the project switcher at the top left. It shows the selected
project with a status dot for its run and its open inbox count; its menu lists every project and
has **Add project…** (path, optional name; errors such as "not a git repository" appear in the
dialog) and **Archive this project…**. Board, Plan, Decisions, Activity and the run selector show
the selected project only, and the browser remembers your choice. A project whose repo is missing or
whose settings don't load shows the error in place of the board; the others keep running. The
**Inbox** on the left is global: every item carries its project's name, and clicking one switches to
that project.

### Project settings: `<repo>/orch.config.json`

| key | what |
|---|---|
| `baseBranch` | branch to branch from and merge into (`main`) |
| `validation.command` | the deterministic gate run in every worktree before the validator (`npm test`, `pytest`, …) |
| `validation.phase` | `{enabled, command, maxFixups}`: validate each phase on the base branch once its tasks are done (default on; `command` empty = `validation.command`; `maxFixups` 2). See [Phase validation](#phase-validation) |
| `validation.ui` | `{startCommand, url, readyTimeoutSeconds, env}`: how orch starts your app for tasks in UI validation mode (`url` default `http://127.0.0.1:{port}/`, timeout 120 s). See [UI validation mode](#ui-validation-mode) |
| `scheduler.maxParallel` | tasks of this project running at once. `1` = sequential. Raise it once you trust the dependency graph |
| `scheduler.maxAttempts` | worker attempts before a task goes to your inbox (`2`) |
| `git.pr` | `true` = push + `gh pr create` + `gh pr merge`; `false` = merge locally, no GitHub needed |
| `git.mergePolicy` | default `auto` (merge when validated) or `manual` (wait for you). The planner marks risky tasks `manual` on its own |
| `git.feedback` | PR mode only: wait for CI before auto-merging, and send CI failures and `/orch` review comments back to the worker. See [Merging](#merging) |
| `git.copyFiles` / `git.setupCommand` | e.g. `[".env"]` and `npm ci` for each new worktree |
| `roles.{planner,worker,validator,phaseValidator}` | override which adapter and model a role uses in this project (`phaseValidator` defaults to the validator's), e.g. `{"adapter": "gemini", "model": "pro"}`. The adapter must be defined in `server.json` |

A project file can't set server keys (`agents`, `host`, `port`, `publicUrl`, `auth`, `notify`,
`dbPath`, `worktreeDir`, `repo`, `git.ghCommand`). orch refuses to plan or start a project whose
file has one, and the error names the key. So a cloned repo can't change which agent binaries run
or which credentials they get. Unknown keys are ignored with a warning in the run's activity. Full
example: [orch.config.example.json](orch.config.example.json).

### Server settings: `$ORCH_HOME/server.json`

| key | what |
|---|---|
| `host` / `port` | where the dashboard and API listen. Default `127.0.0.1:4800` (this machine only) |
| `auth.token` | access token for the dashboard, API, live stream and CLI. `ORCH_TOKEN` in the environment overrides it. Empty = no auth. See [Access token](#access-token) |
| `auth.allowInsecure` | `true` lets orch listen on a non-local `host` without a token. Default `false` |
| `notify.ntfyUrl` | `https://ntfy.sh/<your-topic>` for push notifications. Titles start with `[<project name>]` |
| `publicUrl` | what the notification links to, e.g. `http://my-server:4800` |
| `scheduler.maxAgents` | agent sessions running at once across all projects (workers, validators, planners, phase validators). Default `2`; `1` = strictly one at a time |
| `agents.roles.{planner,worker,validator,phaseValidator}` | default adapter and model per role for every project (`phaseValidator` falls back to `validator`) |
| `agents.adapters.claude.extraArgs` | defaults to `--permission-mode bypassPermissions`. Tighten with `--allowedTools` if you prefer |
| `agents.adapters.gemini.extraArgs` | defaults to `--yolo --skip-trust` (both required for headless runs in a worktree) |
| `retention.eventDays` | archive the agent event logs of runs finished more than this many days ago. Default `30`; `0` = keep forever. See [Event log retention](#event-log-retention) |
| `defaults` | project settings applied under every project's own file (same keys as `orch.config.json`) |

Full example: [examples/server.example.json](examples/server.example.json).

### Access token

By default orch listens on `127.0.0.1` only. To reach it from another machine, set `host` to
`0.0.0.0` (or an interface address) **and** an access token; orch refuses to start on a non-local
address without one, and the error names both `auth.token` and `auth.allowInsecure`.

```bash
export ORCH_TOKEN=$(openssl rand -hex 32)   # or put it in auth.token in server.json
orch serve
```

With a token set:

* every API call and the live stream need it; requests without it get `401 {"error":"unauthorized"}`;
* the dashboard asks for it once and keeps it in an `HttpOnly`, `SameSite=Strict` cookie;
* the `orch` CLI sends it from `ORCH_TOKEN` or `server.json`, and agents get it in their environment
  automatically, so `orch decide` and `orch ask` keep working;
* `GET /api/health` stays open and returns `{ok, version, uptimeSec}` for monitoring.

The token, the ntfy token and adapter `env` values are never written to the database, the event log
or agent prompts. There is no TLS: use SSH, Tailscale, a private network or an HTTPS reverse proxy.

For a server, use the included `orch.service` (systemd). Run the `sed` from your first project's
repo, so the first start finds its `orch.config.json` and upgrades it; state goes to `~/.orch`:

```bash
sed "s#WORKDIR#$PWD#; s#ORCHBIN#$(which orch)#; s#USER#$USER#" ~/orch/orch.service | sudo tee /etc/systemd/system/orch.service
sudo systemctl enable --now orch
```

## Daily use

1. Write the spec with Spec Kit as usual: `/speckit.specify`, `/speckit.plan`, `/speckit.tasks`.
   You end up with `specs/003-thing/{spec.md,plan.md,tasks.md}`.
2. `orch plan specs/003-thing` (or **New plan…** in the dashboard). The plan goes to the project
   whose repo contains the folder. Each project has at most one unfinished run (planning, awaiting
   approval, ready, running or paused); planning or starting another is refused with the name of
   the unfinished one. If every task has a brief with acceptance criteria (`tasks/T001.md`, see
   [Writing specs](#writing-specs)), the plan comes from the briefs and no agent runs; otherwise the planner reads the spec,
   writes acceptance criteria for every task without them, checks the dependency graph, lists the files each
   task owns, flags risky tasks as manual-merge, and logs its decisions. If something in the spec is ambiguous enough to matter it
   asks instead of guessing: a question about the spec as a whole shows in the inbox with a **Plan**
   label, and no task starts until you answer it (you can still approve and start the run).
   To preview first, `orch plan specs/003-thing --dry-run` prints the phases, tasks, `[P]` flags and
   dependencies without creating a run or calling an agent. If the folder has task briefs (`tasks/T001.md`
   beside `tasks.md`), the preview also shows which fields each brief sets and the folder checks: an
   unresolved `TBD`, `TODO` or `[NEEDS CLARIFICATION` marker is an error that stops `orch plan` unless you
   pass `--allow-open`; two parallel tasks sharing a file, an oversized brief or a tests-only task are warnings.
3. Open the dashboard. **Plan** tab: read the acceptance criteria, click any task to edit them,
   its dependencies, merge policy or owned files. **Approve plan**. Approval is refused if the dependencies form a
   cycle; the error names the tasks in it, so edit one of them and approve again.
4. **Start**. Watch the **Board** or walk away. Your phone buzzes when:
   * a worker asks a question → answer with one tap or a sentence
   * a task fails after its retries → inspect the log, retry or skip
   * a manual-merge task is validated → open it, read its **Diff** in the task view (or the PR), then
     **Merge now**, or **Send back** with a note on what to change (in PR mode, a `/orch …` comment
     on the PR works too)
   * a PR's CI keeps failing, or its checks hang → look at the PR
   * the run finishes
5. **Decisions** tab is the audit trail: every planner, worker, validator and human decision with
   its rationale, in order. **Activity** is the run-level event stream. Past runs of the project are
   in the run selector next to the run controls.

The tile in the top bar shows what the selected run and its project cost and how much agent time
they used (`Run $0.42 · 6m 10s  Project $3.17 · 1h 2m`); the task view's **Cost** row shows the same for one
task, across all its attempts and fix rounds. A run's total is its tasks plus its planner and phase
validators. Money is what the agent CLI reports (Claude Code does, Gemini CLI doesn't): a cost no
agent reported shows "n/a", not $0. Cost is display-only; there are no spend caps. Totals are kept
on the task and run rows, so archiving event logs never changes them.

The green dot at the top right means live updates are connected. If the connection drops (for
example while orch restarts) it turns amber and the dashboard retries after 1 s, then 2, 4, … up to
every 30 s, and reloads everything once it is back. No page reload is needed.

Sending a task back starts a fix round with your text under "Feedback from the owner": the worker
resumes its session, then the gate and validator run again and the task returns to your inbox (it is
not capped by `maxRounds`). It is recorded as a human decision.

CLI equivalents: `orch status`, `orch approve`, `orch run|pause|stop`, `orch answer <id> <text>`,
`orch retry|skip|merge T003`.

### Event log retention

Agent event logs (every tool call and message) are the bulk of the database. When a run has been
finished (`done`, `stopped` or `failed`) for more than `retention.eventDays` days (default 30), orch
writes its events to `$ORCH_HOME/archive/<project>/<runId>-events.jsonl.gz` (one JSON event per line)
and then deletes them from the database. This happens when `orch serve` starts and every 24 hours
after; `orch archive-events` does it now. Decisions, questions, task summaries, feedback and costs are
kept, and the run gets a decision naming the archive file. The task's **Log** then shows
"Log archived to <path>"; read the file with `zcat <path>`.

If the file can't be written (for example, the archive directory isn't writable), nothing is deleted:
the run gets an error event and the next pass tries again. Unfinished runs are never archived.

### Which project a command acts on

Every project command (`status`, `plan`, `approve`, `run`, `pause`, `stop`, `retry`, `skip`, `merge`,
`stop-task`) picks its project in this order:

1. `--project <id>`
2. the `ORCH_PROJECT` environment variable
3. the project whose repo contains the current directory (for `orch plan`, the spec folder first)
4. the only project, when just one is registered

Otherwise the command stops and lists the projects. `orch answer` needs no project, because question
ids are unique across projects.

Exit codes: `0` success, `1` failure (the reason is on stderr, after `error:`), `2` usage error, which
includes a missing argument, an unknown command and a project that can't be determined.

### Task files

`orch` reads Spec Kit's `tasks.md` format:

```markdown
## Phase 2: Core
- [ ] T003 [P] Implement POST /auth/signup in src/routes/auth.ts
- [ ] T004 [P] Implement POST /auth/login
- [ ] T005 Add auth middleware (depends on T004)
```

Rules: tasks depend on every task in earlier phases; a task without `[P]` also depends on the
previous task in its phase; "depends on T00X" in the text adds an edge. The planner can override
all of this, and so can you in the dashboard. Already-ticked tasks (`- [x]`) are imported as done.
Any markdown file that follows the `- [ ] T001 …` convention works, Spec Kit or not.

### What the agents see

* **Worker**: the task, acceptance criteria, the feature's `spec.md`, `data-model.md` and `plan.md` (`handoff.contextFiles`, capped by `handoff.specChars`),
  the hand-off brief, the files it owns, and any feedback from a failed attempt. Prompt: `prompts/worker.md`.
* **Validator**: the task, criteria, the worker's summary (as claims to check), the diff, the test
  gate's output, and the changed files outside the task's owned files, which it reports as `findings`
  (never a FAIL by themselves). It runs the checks itself. Prompt: `prompts/validator.md`, or
  `prompts/validator-ui.md` in UI mode, which adds the running app's address.
* **Phase validator**: the phase's tasks with their criteria and workers' summaries, the spec excerpt and the
  phase command's output, in a checkout of the base branch. Prompt: `prompts/phase-validator.md`.
* **Planner**: all spec files plus the parsed task list. Prompt: `prompts/planner.md`.

Override any prompt by copying it to `<repo>/.orch/prompts/<name>.md`.

### Retries and context

A failed attempt (gate, validator, or worker-reported failure) re-runs the worker with the feedback.
With `scheduler.resumeOnRetry: true` (default) it resumes the same Claude session so it keeps what it
learned; set it to `false` for a clean start each time. Answering a question never consumes an
attempt. "Re-run from scratch" in the dashboard resets attempts and starts fresh in the same
worktree.

### Phase validation

When every task of a phase is done or skipped (at least one done), orch validates the phase as a whole
on the base branch: a detached worktree at `origin/<base>` (or `<base>`), `git.setupCommand`, then
`validation.phase.command` (else `validation.command`), then the phase validator agent. Phases are
validated one at a time, in order, and each validation takes one of the `scheduler.maxAgents` slots.
Tasks of later phases wait until the phase has passed. A phase already finished when the run starts (all
ticked `[x]`, or finished by a run that was in flight across the upgrade) passes without a check. A PASS is a decision; a FAIL creates a fix-up
task `FIX-<phase>.<round>` (description = the failure, acceptance = the unmet criteria plus "phase
validation passes", merge auto) that every later unfinished task now depends on, also recorded as a
decision. Fix-up tasks run like any task, are never ticked in `tasks.md`, and carry a **fix-up** badge.
After `validation.phase.maxFixups` rounds (`0` = straight away) the phase goes to the inbox with
**Re-run validation** and **Accept phase**. `validation.phase.enabled: false` turns it all off.

### UI validation mode

For tasks that change what users see, the validator can check the criteria against the running app in
a browser. The planner proposes `validate_mode: "ui"` for such tasks; change it in the Plan tab's edit
dialog (**Validation mode**) or with `POST /api/tasks/:id/edit {"validate_mode": "ui"}`.

Tell orch how to start the app in `orch.config.json`:

```json
{
  "validation": {
    "command": "npm test",
    "ui": { "startCommand": "npm run dev -- --port $PORT --host 127.0.0.1", "readyTimeoutSeconds": 120, "env": { "NODE_ENV": "development" } }
  }
}
```

After the test gate passes, orch picks a free port, runs `startCommand` with `sh -c` in the task's
worktree with `PORT` set, and polls `validation.ui.url` (default `http://127.0.0.1:{port}/`) every
second until it answers with a status below 500. The validator gets that address. orch always stops
the app's whole process group afterwards (SIGTERM, then SIGKILL after 5 s): after the verdict, when you
stop the task or the run, when orch shuts down, and, from a pidfile in `$ORCH_HOME/run/`, on the next
start after a crash. Your app must listen on `$PORT`.

* The app doesn't answer within `readyTimeoutSeconds`, or exits: the attempt fails, and the feedback
  holds the app's last 3000 characters of output.
* The validator answers `BLOCKED` because it has no browser tool, or `startCommand` isn't set: the task
  fails at once, without retries, and goes to your inbox. Fix the setup, then **Re-run from scratch**.

**Give the validator a browser.** orch doesn't drive a browser itself; the validator's agent program
does, with its own tools. For Claude Code, add the Playwright MCP server for the user that runs orch
(headless on a server):

```bash
claude mcp add --scope user playwright -- npx -y @playwright/mcp@latest --headless
claude mcp list    # playwright: ✓ connected
```

The built-in `claude` adapter runs with `--permission-mode bypassPermissions`, so the browser tools need
no approval. To give only validators a browser, define a second adapter in `server.json` (e.g.
`"claude-ui"` with `"extraArgs": ["--permission-mode", "bypassPermissions", "--mcp-config", "/home/you/playwright-mcp.json"]`)
and point the project's `roles.validator` at it. In Docker, install the browser in the image
(`npx playwright install --with-deps chromium`). UI mode needs Linux or macOS (process groups).

### Merging

* `git.pr: true`: push, `gh pr create`, wait for the PR's checks (auto), then
  `gh pr merge --squash --delete-branch`; or wait in the inbox (manual). If the merge fails
  (conflict, required checks, auth) the task goes to the inbox as **merge needs you**; fix it on
  GitHub and click **Merged elsewhere**, or **Re-run**.
* `git.pr: false`: rebases the task branch and squash-merges into `baseBranch` locally. Needs
  `baseBranch` checked out and clean in the repo. Good for a server that is the only writer.
  Manual-merge tasks wait in the inbox; review them with the **Diff** section of the task view
  (changed files with +/− counts, a collapsible diff per file) and **Merge now** or **Send back**.
  The diff is available while the task has a worktree, so not after it is merged.

#### The PR feedback loop (`git.feedback`, PR mode)

While a task's PR is open, orch polls it every `pollSeconds` (default 60):

* **CI fails** → the failed checks and the tail of their GitHub Actions logs go back to the worker
  as feedback. The worker resumes its own session, fixes and commits; orch re-runs the gate and the
  validator, pushes, and waits for CI again. Auto tasks sit in the **Waiting on CI** lane meanwhile
  and merge only once checks pass (`waitForChecks`).
* **A reviewer wants changes** → a "Request changes" review, or any PR comment with a line that
  starts with `/orch` (`trigger`), sends every new human comment since the last round, including
  inline `file:line` comments, back to the worker the same way. Use `/orch` on your own PRs:
  GitHub doesn't let a PR's author request changes, and orch opens PRs with your `gh` account.
  Comments from bots (`[bot]` logins, `ignoreAuthors`) never trigger a round.
* **Merged or closed on GitHub** → orch notices: merged marks the task done, closed marks it failed.

Fix rounds have their own budget (`maxRounds`, default 3); each round gets the full
`maxAttempts` for validation. The task goes to your inbox instead of running another round when
the rounds are used up, when a round produces no new commits, when checks stay pending past
`checksTimeoutMinutes`, when "changes requested" is still open after a fix (an auto task waits for
you rather than merging over a reviewer), or when someone pushed commits to the PR branch that
conflict with orch's local branch. Commits that only add to the branch (e.g. applied suggestions)
are pulled in before the next round. Every round is logged in the **Decisions** tab.

If a PR has no checks at all, orch waits `noChecksGraceSeconds` (90) after each push for CI to
show up, then merges. Set `feedback.enabled: false` to merge right after the PR is created.

After a merge, the task is ticked in `tasks.md` on the base branch (committed in local mode; left
as a working-tree change in PR mode so you can commit it with your next push).

### Parallelism

`scheduler.maxParallel: 2` runs two tasks of a project at once when the dependency graph allows it.
Each has its own worktree and branch; merges into one repo are serialized.

Several projects can run at the same time. `scheduler.maxAgents` in `server.json` caps the agent
sessions across all of them (a running planner counts too), because they share your agent
subscription. When slots are scarce, the project that started a task least recently goes next, so
one busy project cannot starve another. The usual failure mode is two parallel tasks
editing the same file. To prevent it, the planner gives each task `files_owned` (files or globs,
editable in the Plan tab), and orch never runs two tasks of a project together when their owned
files overlap (compared up to the first wildcard, so `src/auth/**` and `src/auth/login.ts` overlap).
It records an orchestrator decision ("Holding T003 until T002 finishes…"), and the Plan tab shows
"not with" for each such pair. Tasks without owned files are unconstrained. If you still see
conflicts, add dependency edges in the Plan tab.

## Mixing agents (Claude for coding, Gemini for validation)

Each role runs through an *adapter*: a small module that knows how to launch one agent CLI
headlessly and how to read its event stream. Two ship today:

| adapter | CLI | invocation | resume |
|---|---|---|---|
| `claude` | Claude Code | `claude -p --output-format stream-json --verbose` | `--resume <session>` |
| `gemini` | Gemini CLI | `gemini -p … --output-format stream-json --yolo --skip-trust` | `--resume <session>` |

Pick per role in `server.json` for every project:

```json
"agents": {
  "roles": {
    "planner":   { "adapter": "claude", "model": "" },
    "worker":    { "adapter": "claude", "model": "" },
    "validator": { "adapter": "gemini", "model": "pro" }
  }
}
```

A project can choose differently among the adapters the server defines, with `roles` in its
`orch.config.json`, for example `"roles": { "validator": { "adapter": "claude", "model": "opus" } }`.

The validator is the natural place for a second vendor: it only reads the diff and runs tests,
and a model from a different lab shares fewer blind spots with the worker than another Claude
model does. Workers are better left on Claude Code, since that is the harness your skills,
hooks and `CLAUDE.md` are written for. Gemini CLI authenticates on its own (`gemini` once
interactively, or `GEMINI_API_KEY` in `agents.adapters.gemini.env`).

Everything downstream of the adapter is shared: the prompts, the JSON contract at the end of
each agent's final message, `orch decide` / `orch ask`, retries, resume, and the dashboard log.
Adding another CLI (Codex, OpenCode, …) means one file in `src/adapters/` implementing
`launch()` and `parseLine()`; see `src/adapters/gemini.ts` for the shape.

Status: the Claude adapter is exercised end to end against the real CLI. The Gemini adapter is
written against Gemini CLI 0.67's stream-json event schema (read from the CLI source) and
tested with a fake agent that speaks that dialect, but it has not yet been run against a live
Gemini account here. Expect to tune `prompts/validator.md` slightly for Gemini's style on the
first few runs; the JSON extractor is forgiving (last fenced block, else last object).

## Writing specs

orch reads a `tasks.md` task list and, when they exist, one brief per task under `tasks/`. Two ways to write them:

* **The `orch-spec` skill** (ships in [skills/orch-spec/](skills/orch-spec/); install and modes in [skills/README.md](skills/README.md)). In Claude Code, `/orch-spec New project. …` interviews you once and writes the project record (`AGENTS.md`, `docs/requirements.md` with REQ IDs, `docs/architecture.md`, `docs/decisions/`, `docs/roadmap.md`); `/orch-spec Feature F02` writes `specs/002-<name>/` with `spec.md`, `tasks.md` and a self-contained brief per task, then checks the folder with `skills/orch-spec/scripts/check-feature.mjs`. After a run, `/orch-spec Fold back …` brings the record up to date. The folder contract is [architecture §6.4](docs/architecture.md#64-feature-folder-and-brief-contract); the workflow is [proposals/spec-workflow.md](docs/proposals/spec-workflow.md).
* **GitHub Spec Kit** or any tool that writes the `tasks.md` format above. `/orch-spec adopt specs/NNN-<name>` adds briefs to such a folder without changing its task keys or ticks.

`orch plan --dry-run` reads the briefs and runs the same folder checks as the script (markers, parallel overlap, oversized briefs, test-only tasks). When every task has a brief with acceptance criteria, `orch plan` builds the plan from the briefs and calls no agent; the planner writes criteria only for tasks without them. `orch plan --review` has the planner review the whole plan: it may add criteria and correct dependencies, never remove or rewrite a brief's criteria, and each change is a decision. The `[P]` conflicts, the warnings and an `--allow-open` override are recorded as decisions too. Workers and validators get the task's brief, the requirement rows it cites (from `docs/requirements.md`, setting `handoff.requirementsFile`), the contracts it names and the project rules file (`AGENTS.md`, `handoff.projectFiles`); the validator rejects a change that breaks a rule or a contract and quotes it.

## Testing

```bash
npm test            # build, unit tests, invariants check, all e2e scripts
npm run test:unit   # node --test test/unit/*.test.mjs (against dist/, so build first)
npm run check       # invariants: one runtime dependency; vendor names only in src/adapters/
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run typecheck` and `npm test` on Ubuntu with
Node 22 and 24 for every push to `main` and every pull request.

`test/unit/` holds the `node:test` unit tests. They import the compiled modules from `dist/`.
`perf.test.mjs` seeds a run of 200 tasks with 100,000 events and checks that the project snapshot
the dashboard loads builds in under a second.

`scripts/e2e.mjs` runs the whole loop against a fake agent (`scripts/fake-agent.mjs`) in a throwaway
repo, with workers on the Claude adapter and the validator on the Gemini adapter: planning,
approval, two parallel workers, a question answered mid-task with session resume, a gate failure
retried, a validator rejection retried, a `--dry-run` preview that creates nothing, a plan question
that holds every task until answered, a dependency cycle refused at approval, the review diff of a manual-merge task, sending it back
with owner feedback that reaches the worker, the merge approval, and tasks.md ticked on main.

`scripts/e2e-pr.mjs` runs PR mode against a fake `gh` (`scripts/fake-gh.mjs`) and a local bare
`origin`: a CI failure fed back and fixed before auto-merge, a `/orch` review comment fixed before a
manual merge (with a bot comment that must be ignored), and a PR merged by hand on "GitHub".

`scripts/e2e-auth.mjs` checks the access token end to end: 401 without it, the open health check,
`orch status` with and without `ORCH_TOKEN`, the dashboard login cookie on the live stream, a fake
worker's `orch decide` getting through, the refusal to listen on `0.0.0.0` without a token, and no
token in the database file, the events or any prompt.

`scripts/e2e-lifecycle.mjs` pins down the rest of the task lifecycle in 13 independent scenarios,
each in its own throwaway repo: stopping a run mid-task, `kill -9` of the daemon and restart (no lost
decisions or questions), agent timeout, a failing setup command, a worker that commits nothing, a
feature directory without `tasks.md`, a failing planner, answering while paused, a dirty main checkout
at merge time, two parallel tasks conflicting on one file, skipping a failed dependency, answering a
question twice, and editing acceptance criteria before approval. Run a subset by letter:
`node scripts/e2e-lifecycle.mjs b h`.

`scripts/e2e-phase.mjs` checks phase validation: phase 1 fails (`PHASE_TRAP` in the spec), `FIX-1.1`
appears with the failure while phase 2 waits, the fix-up merges, phase 1 passes on re-validation and
phase 2 runs; `tasks.md` never gets a `FIX-` key. With `maxFixups: 0` the failure is a phase inbox
item: Re-run validates again, Accept lets phase 2 proceed. A phase ticked before the run, and a run in flight
across the upgrade (`kill -9`, phase rows deleted, restart), pass their finished phase without a check.
Run one scenario with `node scripts/e2e-phase.mjs b`.

`scripts/e2e-ui.mjs` checks UI validation mode with a fake app (`scripts/fake-app.mjs`): a UI task
passes only when the fake validator gets HTTP 200 from the address it was given, both validator prompts
carry the gate output, an app that never gets ready (`NEVER_READY`, 3 s timeout) fails the attempt with
its output, a `BLOCKED` verdict fails the task on attempt 1, and the app is stopped after `kill -9` and
restart, on stopping the task, and on daemon shutdown. Each scenario checks that no app process or
pidfile is left. Run one with `node scripts/e2e-ui.mjs d`.

`scripts/e2e-multi.mjs` runs one daemon over two registered repos with `scheduler.maxAgents: 1`: never
more than one active task, the second project's task starting before the first project's third,
refused plans and starts naming the unfinished run, worktrees under `ORCH_HOME`, and notification
titles carrying the project name (captured by a local HTTP sink). The `projects` scenario drives the
CLI against a daemon with no projects: `orch project add` refusing a non-git directory and printing
the starter settings path, project selection from the current directory, `--project` and
`ORCH_PROJECT`, exit code 2 outside both repos and for usage errors, the global inbox labelled by
project, archiving refused while a run is running, archive and restore, plus `orch archive-events`
on a run backdated 40 days (gzip file, "Log archived to" from the log endpoints, decisions kept), and
the dashboard's stable element ids (`projectSwitcher`, `projectMenu`, `projectList`, `btnAddProject`,
`btnArchiveProject`, `addProjectDlg`, `addProjectErr`, `globalInbox`, `inboxCount`, `projectError`,
`runSel`, `board`, `live`). The `legacy` scenario
upgrades a single-repo install with a 0.1-schema database and checks that the old run stays visible.

Every daemon an e2e script starts gets `ORCH_HOME` set to a directory in its temp folder, so a test run
never touches `~/.orch`. Scripts that start from a single `orch.config.json` exercise the upgrade too.

All e2e scripts use the shared helpers in `scripts/lib/e2e.mjs` (`makeRepo`, `writeConfig`, `startDaemon`,
`api`, `waitFor`, `cleanup`), so a new scenario is mostly its config, a polling loop and its assertions.
A failed run keeps its throwaway repo and prints its path.

`scripts/check-invariants.mjs` fails if `package.json` has any runtime dependency besides
`better-sqlite3`, or if `claude`, `gemini` or `anthropic` appears in `src/**/*.ts` outside
`src/adapters/` (the built-in adapter defaults in `src/config.ts` are allowlisted in the script), or if a
file in `src/core/` imports `node:fs`, `node:child_process` or the database, or reads the clock.

`test/fixtures/` holds the spec-first fixture tables for the risky logic (tasks.md parser, JSON
extraction, readiness, task transitions, PR-poll decisions, file ownership, phase validation). Their expected outputs are owner-reviewed;
see [test/fixtures/README.md](test/fixtures/README.md) for the formats and the `pending` marker.
`test/unit/core.test.mjs` runs every case (`npm run test:unit`); cases marked `pending` are reported as
skipped until the task that builds them removes the marker.

The e2e tests need Linux or macOS (they spawn `.mjs` files and `sh`). On Windows, run them in a
container. Copy the source in so the container's `npm ci` does not replace your Windows `node_modules`:
`docker run --rm --init -v "$PWD:/src:ro" node:22 sh -c "mkdir /w && cd /src && tar --exclude=./node_modules --exclude=./dist --exclude=./.git -cf - . | tar -xf - -C /w && cd /w && npm ci && npm test"`.

## Layout

```
src/orchestrator.ts   per-project contexts; gathers facts, calls src/core, performs side effects: plan → approve → run → validate → merge
src/core/             pure decisions: readiness (who starts), task transitions, PR-poll actions, phase validation and fix-ups
src/adapters/         one adapter per agent CLI (claude.ts, gemini.ts) + the shared process runner
src/git.ts            worktrees, diffs, push, gh pr create/merge/view, CI logs, local merge
src/prfeedback.ts     PR feedback loop helpers: check verdicts, review comments, worker feedback text
src/speckit.ts        tasks.md parser and ticker
src/config.ts         settings: server.json and per-project loaders, plus the single-file format read by the upgrade
src/paths.ts          ORCH_HOME layout (server.json, orch.db, worktrees/, archive/, run/)
src/db.ts             SQLite: projects, runs, tasks, phases, events, decisions, questions; versioned migrations
src/projects.ts       project registry: register a repo, archive, find the project for a directory
src/costs.ts          cost and agent time per task and run row; run and project totals
src/archive.ts        event retention: old runs' events to archive/<project>/<runId>-events.jsonl.gz, then deleted
src/server.ts         REST + SSE, serves the dashboard; token gate, /api/health, /api/login
src/auth.ts           token check (Bearer or cookie), login cookie, bind guard
src/cli.ts            `orch` (human commands, the agent-facing decide/ask, the single-repo upgrade in `serve`)
prompts/*.md          the role prompts (planner, worker, validator, phase validator)
dashboard/index.html  the UI, no build step
```

## Safety notes

Workers run headless with `--permission-mode bypassPermissions` inside their worktree. That is the
point of the tool, but it means a worker can run anything your user can. Run the daemon as a
low-privilege (non-root) user on a machine you don't mind an agent working in (the Docker image runs
as uid 1000), set an [access token](#access-token) if anyone else can reach the port, keep secrets out of
`git.copyFiles` unless the task needs them, and use `--allowedTools` in `agents.adapters.claude.extraArgs` if you
want a tighter leash. Manual merge policy is your other lever: the planner already uses it for auth,
migrations, billing and irreversible changes.
