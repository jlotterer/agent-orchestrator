# orch — competitive context and next steps

Originally exported from a Claude chat on 2026-11-07, when orch was one day old. Revised on 2026-11-08 after waves 1–12 shipped, and again on **2026-11-09** after waves 13–17 (the spec-skill wave, TASK-18..26) shipped and a second competitor set was studied: the interactive agent workspaces Solo, Conductor, herdr, Orca, Superset (now Paradev), T3 Code and cmux (§2.2). Intended as working context for the coding agent continuing development of `orch`. Competitor facts in §2.1 are as of 2026-11-07 and were not re-researched; facts in §2.2 are as of 2026-11-09, taken from the vendors' own sites and repos.

Where the canonical detail lives: [requirements.md](requirements.md) (what, with `built`/`new` status per REQ), [architecture.md](architecture.md) (how), [decisions/](decisions/README.md) (why, 23 records), [tasks/README.md](tasks/README.md) (the roadmap, waves 1–17), [user-guide/feature-status.md](user-guide/feature-status.md) (what a user gets today).

## 1. What orch is (recap, as of 2026-11-09)

`orch` is a self-hosted orchestrator for AI coding agents. One daemon manages several projects (git repos). It imports a feature folder (Spec Kit `tasks.md`, optionally with one authored brief per task), has a planner add acceptance criteria where a brief has none, then runs each task as worker → deterministic test gate → independent validator → PR/merge, validates each phase as a whole on the base branch, and shows everything in a dashboard with one inbox for decisions that need the owner. It ships the `orch-spec` skill that writes exactly what it reads.

Size and stack: ~7,100 lines of TypeScript (strict, NodeNext ESM) plus an ~860-line single-file dashboard and the `skills/orch-spec/` skill; Node ≥ 22 ([0022](decisions/0022-node-22-floor.md)); `better-sqlite3` is the only runtime dependency ([0009](decisions/0009-locked-stack.md)). MIT. 26 roadmap tasks done in 17 waves, all run as orch-style PRs (TASK-22 onward through orch itself); all 47+ requirements `built`, none `new`.

### Design principles (all recorded as decisions)
- **The orchestrator is deterministic code** ([0001](decisions/0001-deterministic-orchestrator.md)). An LLM is called only for the planner, worker, validator and phase-validator roles; never for scheduling, retries, git, merges or the PR loop. Readiness, task transitions, PR-poll actions, file-ownership overlap, phase completion, brief parsing and context assembly are pure functions in `src/core/` pinned by owner-reviewed fixture tables ([0020](decisions/0020-pure-core-and-fixtures.md)).
- **SQLite owned by the daemon is the single source of truth** for projects, runs, tasks, phases, events, decisions and questions ([0002](decisions/0002-sqlite-single-source-of-truth.md)). Agents are disposable; a daemon crash loses at most the in-flight attempt.
- **Fresh context per role invocation, with a bounded hand-off brief** assembled from the authored brief, the cited REQ rows, named contracts, project rules, earlier workers' summaries, the decisions log and the owner's answers ([0003](decisions/0003-fresh-context-and-handoff-brief.md)).
- **Maker/checker.** A deterministic gate, then an independent validator that sees the task, criteria, worker's claims, diff and gate output, never the worker's transcript, and must cite evidence per criterion. The validator may run on a different adapter or model ([0004](decisions/0004-independent-validation.md)).
- **Decisions and questions are first-class records; one inbox** ([0005](decisions/0005-decisions-and-inbox.md)). Every autonomous choice goes through `decide()`; everything needing the owner is an inbox item plus a push notification.
- **One worktree, one branch, one PR per task; risky work waits for the owner** ([0006](decisions/0006-worktree-branch-pr-per-task.md)).
- **Vendor code lives only in adapters** ([0007](decisions/0007-agent-adapters.md)); an invariants check fails CI on vendor names elsewhere.
- **Spec Kit `tasks.md` is the input contract, not a dependency** ([0008](decisions/0008-speckit-input-contract.md)); **orch owns the skill that writes it** ([0023](decisions/0023-orch-owns-spec-skill.md)).

### Flow
```
orch-spec skill: project mode (record) once; feature mode (specs/NNN/ with tasks.md + tasks/T00N.md briefs) per feature
spec folder  ->  orch plan [--dry-run|--review|--no-llm]  ->  [owner approves; plan questions block starts]  ->  orch run
for each task (dependency order, file ownership respected, N per project, M across projects):
  worktree -> worker (fresh context + brief + REQ rows + contracts + rules + hand-off) -> commit
           -> validation command (deterministic gate)
           -> validator agent (fresh context; standard mode reads the diff, UI mode drives the running app)
           -> PR -> CI / review feedback rounds -> merge (auto, or wait for owner) -> tick tasks.md -> next
when a phase's tasks are all done:
  base branch -> phase test command -> phase validator -> PASS: next phase | FAIL: fix-up task FIX-<n>.<round>
when the run is done: inbox item "Update project docs" (fold-back mode of the skill)
```

### States
- Task: `pending | running | validating | needs_input | pr_checks | pr_open | failed | done | skipped`
- Run: `planning | plan_pending | ready | running | paused | done | stopped | failed`
- Phase: `pending | validating | passed | needs_human` (`failed` reserved)

### What shipped, by wave
| Area | Now built | Task / decision |
| :--- | :--- | :--- |
| Test harness | `npm test` = build → unit → invariants → e2e; CI on Node 22 and 24; 8 e2e suites (happy path, PR loop, lifecycle regressions, auth, multi-project, phases, UI mode, briefs) with a fake agent, fake `gh` and fake app | TASK-01..04, 25 |
| Pure core | `src/core/` readiness, transitions, PR poll, ownership, phases, graph, brief, context; fixture-driven | TASK-03, 20, 21, [0020](decisions/0020-pure-core-and-fixtures.md) |
| Review | Hand-rolled diff viewer in the task panel; **Send back** starts a fix round with the owner's note | TASK-06, [0018](decisions/0018-hand-rolled-diff-viewer.md) |
| Config | `$ORCH_HOME/server.json` (network, token, notifications, adapters, global agent cap) vs `<repo>/orch.config.json` (project keys only; server keys refused) | TASK-05, [0013](decisions/0013-project-config-in-repo.md) |
| Security | Bearer-token auth for API, SSE, CLI and agents; refuses a non-loopback bind without a token; open `/api/health` | TASK-08, [0014](decisions/0014-bearer-token-auth.md) |
| Multi-project | One daemon, many repos; one unfinished run per project; `scheduler.maxAgents` shared fairly; project switcher and global inbox; legacy single-repo upgrade | TASK-07, 09, 10, 11, [0011](decisions/0011-multi-project-daemon.md), [0012](decisions/0012-global-agent-cap.md) |
| Retention | Old runs' event logs archived to gzip JSONL, then deleted; decisions and costs kept | TASK-12, [0019](decisions/0019-event-archive-retention.md) |
| Planning | `orch plan --dry-run`; plan-level questions block every task start; approval refuses dependency cycles | TASK-13 |
| Parallelism | Planner or brief declares `files_owned`; overlapping tasks are serialized automatically with a decision; validator reports out-of-scope edits as findings | TASK-14, [0017](decisions/0017-file-ownership.md) |
| Phase validation | Detached worktree on the base branch, phase command, phase validator; FAIL creates `FIX-<phase>.<round>` tasks; inbox after `maxFixups` | TASK-15, [0015](decisions/0015-phase-validation-fixups.md) |
| UI validation | `validate_mode: ui`: orch starts the app under test on a free port, the validator exercises it in a browser (Playwright MCP), orch always stops it; `BLOCKED` when no browser tool | TASK-16, [0016](decisions/0016-ui-validation-app-lifecycle.md) |
| Cost | Cost and agent time per task, run and project; display-only | TASK-17 |
| Spec layer | Brief contract (architecture §6.4) and feature-folder fixtures; `src/core/brief.ts` reads briefs and checks the folder; `src/core/context.ts` assembles spec context with per-part budgets; plan from briefs with no planner call, `--review`, planner only for brief-less tasks; rules and contracts to worker, validator and phase validator | TASK-18, 20, 21, 22, [0023](decisions/0023-orch-owns-spec-skill.md) |
| Skill | `skills/orch-spec/`: project, feature, fold-back and adopt modes; `check-feature.mjs` cross-checked against orch's own checker over every fixture; real runs of feature, fold-back and adopt modes | TASK-19, 26 |
| Fold-back | End-of-run "Update project docs" inbox item with a copyable fold-back prompt, notification, ack, `orch docs-update` | TASK-23 |
| Docs | User guide (`docs/user-guide/`): how-tos for the spec workflow, inbox, parallelism, phases, UI validation, cost, projects, archive; feature status | TASK-24, [0021](decisions/0021-docs-split-and-dogfooding.md) |
| Adapters | Claude Code (`-p --output-format stream-json`, `--permission-mode bypassPermissions`) and Gemini CLI (`--yolo --skip-trust`); adapter and model per role, overridable per project | [0007](decisions/0007-agent-adapters.md) |
| PR loop | CI failures and `/orch` review comments go back to the worker's own session; round budget separate from attempts; merged/closed PRs detected | R1, [0010](decisions/0010-pr-feedback-loop.md) |

### Layout
```
src/orchestrator.ts   side-effecting coordinator: project contexts, tick, runTask, validate, phases, PR poll, human actions
src/core/*            PURE decisions: readiness, transitions, prpoll, ownership, phases, graph, brief, context
src/adapters/*        claude.ts, gemini.ts, runner.ts (spawn, stream-json, extractJson)
src/speckit.ts        tasks.md parser (pure) + spec dir reader + ticker
src/db.ts             SQLite + user_version migrations: projects, runs, tasks, phases, events, decisions, questions
src/config.ts, paths.ts, projects.ts, auth.ts, appserver.ts, archive.ts, costs.ts, prfeedback.ts, notify.ts, prompts.ts
src/server.ts         node:http REST + SSE, auth gate, serves the dashboard
src/cli.ts            owner commands (project add/list/remove, plan, approve, run, docs-update, …) and agent-facing decide/ask
prompts/*.md          planner, worker, validator, validator-ui, phase-validator (overridable at <repo>/.orch/prompts/)
skills/orch-spec/     SKILL.md, templates/, reference/, scripts/check-feature.mjs
dashboard/index.html  the UI, no build step
specs/001-orch-roadmap/   orch's own tasks in the format orch reads
test/fixtures/, test/unit/, scripts/e2e*.mjs, scripts/fake-{agent,gh,app}.mjs, scripts/check-invariants.mjs
Dockerfile, docker-compose, orch.service
```

### Config highlights
- Server (`server.json`): `host`, `port`, `publicUrl`, `auth.{token,allowInsecure}`, `notify.{ntfyUrl,ntfyToken}`, `agents.{timeoutMinutes,adapters.<name>,roles.<role>}`, `scheduler.{maxAgents,tickSeconds}`, `retention.eventDays`, `defaults.*`.
- Project (`orch.config.json`): `baseBranch`, `scheduler.{maxParallel,maxAttempts,resumeOnRetry}`, `validation.{command,agent,phase.*,ui.*}`, `git.{pr,mergePolicy,squash,copyFiles,setupCommand,tickTasksMd,feedback.*}`, `handoff.{specChars,historyChars,contextFiles,briefChars,reqChars,contractChars,rulesChars,requirementsFile,projectFiles}`, `roles.{planner,worker,validator,phaseValidator}`.

### Spec layer
Reads Spec Kit `tasks.md` (phases from headings, `[P]`, "depends on T00X", `- [x]` imported as done); any markdown with `- [ ] T001 …` lines works. When `tasks/T00N.md` briefs exist (YAML frontmatter `orch: 1`, `covers`, `depends_on`, `parallel`, `merge_policy`, `validate`, `files_owned`), the plan is built deterministically from them and the planner is called only for tasks without criteria. The `orch-spec` skill writes the project record (requirements with REQ IDs, architecture, decision records, `AGENTS.md`, roadmap) once, a feature folder per feature, folds a run's results back into the record, and adopts plain Spec Kit folders by adding briefs. Plain Spec Kit folders still import, with less context.

### Test status
- `npm test`: 17 unit test files plus fixture tables (readiness, transitions, PR poll, ownership, phases, extract-json, tasks-md, spec-dir and feature-folder fixtures), the invariants check, and 8 e2e suites against the fake agent, fake `gh` and fake app. CI runs on every PR.
- Real runs: orch dogfoods its own roadmap (TASK-22 onward ran through orch); the skill's feature, fold-back and adopt modes each have one recorded real run (TASK-19, 23, 26). **Still open:** one real UI-mode run with a browser MCP (TASK-16), one real plan where the planner emits `files_owned` (TASK-14), and the Gemini adapter has never run against a live account (requirements Q1).
- Known limits: Linux/macOS/WSL2/Docker only (UI mode needs process groups; `better-sqlite3` crashes on the Windows host, so Windows development runs tests in a `node:22` container). Cost is display-only; no spend caps. Agents run with permissions bypassed (`bypassPermissions`, `--yolo`); the host, not orch, is the trust boundary.

## 2. How orch compares to the competition

Two different competitor sets have been studied. §2.1 (2026-11-07) covers the products that do what orch does: autonomous, spec-to-PR orchestration. §2.2 (2026-11-09) covers the interactive agent workspaces, which do not do what orch does but are what most developers reach for when they say "run several coding agents". The short version is unchanged: orch sits in a real gap between Factory Missions and Agent Orchestrator, now with the spec layer built; the interactive workspaces are a different category, crowded and well funded, and orch should not try to become one, but they show several UX gaps orch can close inside its own architecture.

### 2.1 Autonomous orchestrators (as of 2026-11-07)

| | orch (2026-11-09) | Factory Missions | Agent Orchestrator (ex-Composio) | Others (Symphony, ralph-tui, GitHub Agentic Workflows) |
|---|---|---|---|---|
| Roles | Planner (only for brief-less tasks), worker, validator, phase validator; orchestrator is deterministic code with fixture-pinned pure decisions | Orchestrator, workers, validators, research agents; orchestrator is itself an agent | Orchestrator agent + worker agents; no validator role | Mostly single-role loops; Symphony is a spec, not a runtime |
| Unit of work | One task → one worktree → one PR; phases validated as a whole; one daemon, many repos | Whole project → milestones → features | One issue → one worktree → one PR | One ticket/issue → one PR |
| Validation | Deterministic gate, then independent fresh-context validator with per-criterion evidence and gate output; optional different adapter/model; UI mode where orch starts the app and the validator drives a browser; phase validation on the base branch with automatic fix-up tasks | Milestone validation; workers launch the app and QA flows, incl. browser | CI retry + review-comment routing; no independent reviewer | CI only |
| Human decisions | Global inbox: plan approval, plan and task questions (worker pauses, resumes own session), failures, manual merges, stuck CI, phases needing the owner, end-of-run docs update; diff viewer with Send back; ntfy push | Talk to the orchestrator; Mission Control | Escalation when agent is stuck; dashboard | GitHub UI |
| Decisions log | Every planner/worker/validator/phase-validator/orchestrator/human decision with rationale, including every auto-serialization, fix round and merge | Not a first-class record | No | No |
| Spec layer | Own skill writes a project record (REQ IDs, decision records, rules) and per-task briefs that orch plans from deterministically; fold-back after each run; plain Spec Kit `tasks.md` still imports | Its own planner re-plans from your description | GitHub Issues or Linear | Linear (Symphony), prd.json/Beads (ralph-tui), Issues |
| PR lifecycle | CI failures and `/orch` comments routed back to the worker's session; round budget; waits for checks before auto-merge; merged/closed detected | Mission Control | CI failures and review comments injected into the agent's session | CI only |
| Agent | Claude Code and Gemini CLI adapters; adapter + model per role, per project | Droid; multi-model per role | 30+ harnesses as of v0.13 | Varies |
| Runs where | Linux server / WSL2 / Docker; systemd unit; token auth for remote access | CLI, Desktop, Web; Droid Computers for walk-away; OpenCompute self-hosted sandboxes (private preview) | Your machine, daemon + web dashboard | Actions runners / your machine |
| Lock-in | None; MIT; ~8,000 lines you own; vendor code confined to adapters by CI | Proprietary; captured skills live in `.factory/` | MIT, open source | Open spec / open source |
| Maturity | 26 roadmap tasks shipped, the later ones through orch itself; fixture tables + 8 e2e suites; three skill real runs; zero outside users | Thousands of missions; median ~2 h, longest 16 days | ~8.5k stars, ~1k forks, 3,000+ tests | Varies; Symphony is weeks old |
| Cost | Your Claude/Gemini plan; cost and agent time shown per task/run/project | Subscription + consumption | Your Claude plan | Actions minutes or your plan |

### 2.2 Interactive agent workspaces (as of 2026-11-09)

Seven products were looked at: [Solo](https://soloterm.com/), [Conductor](https://www.conductor.build/), [herdr](https://herdr.dev/), [Orca](https://www.onorca.dev/), [Superset, now Paradev](https://paradev.com/), [T3 Code](https://t3.codes/) and [cmux](https://cmux.com/). They share one shape: a desktop app (or a local web app) in which **you** start an agent from a prompt, usually in its own git worktree, watch it in a terminal or chat pane, approve its tool calls, review its diff and open a PR. The human is the orchestrator; the product makes being the orchestrator pleasant. None of them has a planner, a test gate, an independent validator, phase validation, a spec input or a decisions log. Two are at the terminal-multiplexer end (cmux, herdr), one is a process manager (Solo), and four are full workspaces with diff review and PR pages (Conductor, Orca, Paradev, T3 Code).

| | orch | Solo | Conductor | herdr | Orca | Paradev (ex-Superset) | T3 Code | cmux |
|---|---|---|---|---|---|---|---|---|
| Tagline | Self-hosted orchestrator for AI coding agents | "The meta-harness for coding agents" | "Run parallel coding agents on your Mac" | "An app for running coding agents that you shape by asking" | "Ship 100x with the agent IDE" | "Run an army of coding agents" | "The open-source control plane for coding agents" | "The terminal built for multitasking, organization, and programmability" |
| Category | Batch orchestrator: spec in, PRs out, owner on the inbox | Process manager / control plane (Tauri) | Parallel-agent workspace | Customizable terminal app on a terminal runtime | Agent IDE with embedded browser | Agent workspace with cloud sandboxes and automations | Agent control surface (Electron + local web + hosted web) | Native terminal (Ghostty) with agent notifications |
| Who drives | orch; the owner answers an inbox | You | You | You (agents can start helper agents) | You (coordinator agents can run workers) | You, or scheduled/event automations | You | You |
| Platform | Linux / WSL2 / Docker daemon; web dashboard | macOS, Windows, Linux | macOS only; iOS companion | macOS, Linux, Windows | macOS, Windows, Linux; iOS and Android companion | macOS; Linux experimental; no Windows; iOS companion (Pro) | macOS, Windows, Linux; hosted web; iOS and Android | macOS 14+ only; iOS beta |
| Agents | Claude Code, Gemini CLI | Claude Code, Codex, Amp, Gemini, OpenCode, Copilot CLI, Kimi, Antigravity, any CLI | Claude Code, Codex, Cursor, OpenCode | Claude Code, Codex, any program | ~27 named, any CLI | Claude Code, Codex, OpenCode, Gemini, Cursor, Amp, Droid, Kiro, Grok, Copilot, Devin, any CLI | Claude Code, Codex, Cursor, Grok Build, OpenCode, Antigravity, fx | Claude Code, Codex, OpenCode, Gemini, Kiro, Aider, Goose, Amp, Cline, Cursor Agent, any CLI |
| Isolation | One worktree + branch per task, created by orch | None built in (worktrees recognized) | One worktree + branch per workspace | "One worktree per issue" via prompt; not built in | One worktree per task | One worktree + branch per task; cloud sandboxes | Worktree per thread (default) | None locally; cloud VMs (paid) |
| Permissions | Bypassed (`bypassPermissions`, `--yolo`); the host is the trust boundary | Agent's own | Tool approval in app | Agent's own | Agent's own | Inline tool approvals in chat | Four modes: Supervised, Auto-accept edits, Auto, Full access | Agent's own |
| "Needs you" | Inbox + ntfy push; task pauses on `orch ask`, resumes own session with the answer | Working / idle / waiting / blocked badges, native notifications | Sounds and colors, AskUserQuestion UI | Working / done / needs-you via OSC 7501; board layout; ntfy mod | Companion app pings, reply in chat; Notifications & Inbox | Sidebar status, dock badge, chime | Inbox, approvals in conversation | Notification rings, badges, popover, macOS notifications |
| Steering a running agent | No (stop, or answer a question; Send back after validation) | Yes, terminal | Yes, chat + steering | Yes, terminal; `hc send` | Yes | Yes | Yes, switch model mid-thread | Yes, terminal |
| Review / PR | Hand-rolled diff viewer; Send back with a note; PR via `gh`; CI and review comments routed back to the worker | None | Diff viewer, code review, Checks tab, PR page, GitHub Actions view | Start a reviewer agent on the branch | Diff viewer, inline comments to the agent, commit/push, GitHub/Linear/Jira drawers | Changes pane, PR pane with checks and threads, line-select to agent, shareable Pages | Per-turn diff review, one-button commit+push+PR, PR page with merge/auto-merge/stacks, AI review guide, agent **watches** PR and wakes on failed checks or comments | None found |
| Task intake | Feature folder (`tasks.md` + briefs) or any `- [ ] T001` markdown | Built-in todos with dependencies, scratchpads, prompt templates (MCP/HTTP/CLI) | GitHub issues, Linear, "workspace from issue/PR" | Prompt | Linear, Jira, GitHub | Slack, Linear; automations on schedule or events (Sentry, Slack, PR review requests) | Prompt | Prompt |
| Validation | Test gate, independent validator, phase validator, UI mode | Runs project commands from `solo.yml` | Setup/run scripts, `CONDUCTOR_PORT` | `hc run` | Agents run tests; scheduled "flaky-test sweeps" | `.paradev/config.json` setup/teardown/run; in-app browser with per-worktree ports | None | In-app browser with socket API for agents to verify web changes |
| Browser | Validator drives a Playwright MCP against the app orch started; owner sees nothing | No | No | No | Embedded Chromium; Design Mode (click element → agent) | In-app browser; click-to-select element → agent | No | Split in-app browser, DOM/console/network API |
| License / price | MIT, free | Closed; free up to 4 projects, Pro $99/yr | Not stated; **joining Meta 2026-11-04**; cloud shuts 2026-11-20; local app maintained until early 2027 | Apache 2.0, free | MIT, free; enterprise contact | MIT; app free; automations and mobile need Pro | MIT, free | GPL app, free; cloud VMs $50–200/mo |
| Local vs hosted | Local daemon you own; remote via token + SSH/Tailscale | Local | Local (cloud winding down) | Local; other machines over SSH | Local; SSH hosts, self-hosted servers | Local + vendor cloud sandboxes | Local server, hosted web, remote environments | Local + vendor cloud VMs |
| Status | 1 owner, 0 outside users | Commercial | Acquired | Early | ~120k stars claimed | Renamed from Superset | ~54k stars; "very very early" | Shipping |

#### What this set tells us
- **Different category, not a substitute.** Every one of the seven keeps the human as the orchestrator. orch removes that role and replaces it with code plus an inbox. Nothing in §2.2 does orch's job, and orch does none of theirs well (no terminal, no steering, no browser pane, no issue intake). Factory Missions and Agent Orchestrator remain orch's true peers.
- **The closest competitor in this set is T3 Code.** It is the only one that calls itself a control plane, is MIT and local-server first, is reachable from a phone, puts a worktree under every thread, has an inbox, and has the one feature that overlaps orch's PR loop: an agent that watches its PR and is woken by failed checks or review comments. It is also the one most likely to grow an autonomous mode (it is "very very early" and has 54k stars of pull). Paradev is second: event- and schedule-driven automations, Linear/Slack intake, setup/run scripts, an SDK and MCP server, and cloud sandboxes. Both still lack a spec input, a planner, a validator and a decisions log.
- **The interactive-cockpit space is saturated.** Seven products in one year, two above 50k stars, one bought by Meta, all free at the base tier, several with iOS apps and embedded browsers. A one-owner project cannot win on cockpit UX, and does not need to.
- **Convergent features are now table stakes.** Worktree per task (all), "needs you" status with a push to the phone (all), diff review with comments routed to the agent (four), a browser pane the agent and the human share (three), issue-tracker intake (three), graded permission modes (T3 Code, Conductor, Paradev), agent breadth (five to twenty-seven agents each).
- **Complementary, not competing.** A developer can author a feature folder with the `orch-spec` skill inside T3 Code, Conductor or Paradev, hand the folder to orch for the walk-away run, and open orch's worktree in the same cockpit when a task lands in the inbox. orch does not have to own the interactive hours; it has to be easy to hand work to and to take work back from.

### Where orch is ahead
- **Validation is independent at two levels.** AO has no validator; Missions validates milestones; none of the interactive workspaces has one at all. orch runs a gate, a fresh-context task validator (optionally another vendor) that must cite evidence per criterion and reports out-of-scope edits and rule or contract violations, then a phase validator on the merged base branch that creates fix-up tasks on failure.
- **Decisions and questions are first-class.** No competitor in either set offers a chronological log of every judgement call with rationale, nor a worker that pauses on a question, pushes to your phone, and resumes its own session with the answer.
- **The orchestrator is code, and provably so.** Scheduling, transitions, PR-poll actions, ownership overlap, phase completion, brief parsing and context assembly are pure functions tested by owner-reviewed fixtures; an invariants check keeps `fs`, child processes, the DB and the clock out of them.
- **The spec is the input, and orch keeps it honest.** Decision 0023 shipped: a project record with REQ IDs and decision records, briefs written by the owner's interview rather than reconstructed by a planner, a deterministic plan when briefs are complete, and a fold-back inbox item after every run. No competitor has an equivalent; the interactive workspaces take a prompt or an issue.
- **Safe parallelism without a smart orchestrator.** File ownership declared in the brief or by the planner serializes overlapping tasks deterministically; a global agent cap is shared fairly across projects.
- **The PR loop is closed.** CI logs and review comments return to the worker's own session with a round budget; auto-merge waits for checks. Only T3 Code (watch a PR, wake on failure) and AO have an equivalent.

### Where orch is behind
- **Cold start.** Nothing happens until there is a feature folder. Every interactive workspace goes from prompt to running agent in seconds. orch has no "quick task from one line" path, and the planner that could write the criteria for such a task only runs inside `orch plan <specDir>`.
- **The running worker is a black box.** The dashboard shows a live event log, not a terminal; the owner cannot type to a worker, add a note mid-task, or change the model mid-thread. The only interventions are stop, answer a question the agent chose to ask, and Send back after validation. All seven workspaces let you steer.
- **All-or-nothing trust.** Agents run with permissions bypassed, so orch is only safe on a dedicated host or in a container. T3 Code, Conductor and Paradev offer graded permission modes with approvals surfaced to the human. This is a deliberate consequence of walk-away operation, but it should be stated in the docs as a deployment requirement, not left implicit.
- **Review is coarser than the field's.** Send back takes one free-text note for the whole diff. Orca, Paradev and T3 Code anchor comments to lines and send them to the agent; T3 Code and Paradev have a PR page with checks and threads. orch's diff viewer is hand-rolled (0018) and could carry line anchors without a new dependency.
- **The owner never sees the app under test.** UI mode starts the app and lets the validator drive it, but the dashboard does not show the URL or a preview. Orca, Paradev and cmux put a browser beside the agent.
- **Intake is spec-only.** No GitHub Issues, Linear, Jira or Slack intake; adopt mode is the nearest path. Three of the seven workspaces and both autonomous peers take issues.
- **Long horizons and re-planning.** Unchanged: no mid-run re-plan; after approval nothing reasons about the project as a whole except the phase validator.
- **Real-run evidence.** UI mode, planner-emitted `files_owned` and the Gemini adapter still have zero live runs.
- **Breadth of harnesses.** Two adapters against five to twenty-seven. Codex in particular is now in every workspace's first row.
- **Platform and polish.** No native Windows (the owner develops on Windows and runs tests in Docker), no TLS, no mobile layout for the inbox, an 860-line vanilla dashboard against native apps with embedded browsers.
- **A maintainer.** Unchanged: one owner, zero outside users.

## 3. Should orch be rearchitected?

No. The second competitor set confirms the position rather than undermining it. The seven interactive workspaces compete on cockpit UX in a market that is crowded, free and funded; orch's value is in the parts none of them has (deterministic orchestration, spec intake, independent validation, phase validation, decisions log). Rebuilding orch as a desktop app or an interactive terminal product would abandon 0001 and 0009, discard the fixture-pinned core, and enter a race it cannot win. What the set does show is a handful of UX gaps that can be closed **inside** the current architecture without a new dependency or a new runtime, and one positioning change: orch should be easy to hand work to from a cockpit and easy to take work back from.

Concretely, the next UX work should be, in order of value per line of code:

1. **Quick task.** `orch task "<one line>"` and a dashboard button that create a one-task run in the current project, call the planner for criteria, and go straight to `plan_pending`. Reuses the existing planner, states and inbox; adds one CLI command, one route and a small core function. Closes the cold-start gap.
2. **Notes to a running worker.** An inbox-adjacent action "Add note" that stops the current attempt and resumes the worker's own session with the note, recorded as a decision of kind `human`. The resume path already exists for questions and fix rounds; this is the same path with a different trigger. Closes most of the steering gap without a terminal.
3. **Line-anchored Send back.** Let the owner attach comments to diff lines in the existing viewer; the fix round brief lists them as `file:line: note`. The PR-feedback code already formats inline review comments this way.
4. **Show the app under test.** During UI validation, and optionally on demand for a task in `pr_open`, show the app's URL in the task panel so the owner can open it. The app lifecycle is already orch's (0016); this is a display change.
5. **Mobile inbox.** A narrow-width layout for the inbox and task panel so the ntfy tap lands on something usable. CSS only.
6. **A Codex adapter**, when a real worker or validator needs it. The adapter interface is four functions; Codex is the second agent in every competitor's list.
7. **Hand-off from cockpits.** Document the pattern: author with the skill in any workspace, `orch plan`, open orch's worktree path in the workspace when a task needs you. Consider an MCP server exposing `plan`, `approve`, `inbox` and `answer` so a cockpit's agent can drive orch; T3 Code, Paradev, Solo and Conductor all speak MCP.

Not recommended: a terminal in the dashboard (needs a PTY dependency or a WebSocket framework, banned by 0009, and steering via notes covers the need), graded permission modes (would make walk-away runs stall; document the host requirement instead), an embedded browser, native Windows.

## 4. Recommended next work (actionable)

Status of the earlier recommendations: the spec-skill wave (TASK-18..26) **shipped**; the CI/review loop, UI-mode validator, pure core and hardening items from the first draft are **built**; "stay deterministic" and "don't chase harness count" are **held**.

1. **Close the three open manual checks before the next prompt change.** One real UI-mode task with Claude Code and the Playwright MCP (attach the verdict to TASK-16); one real plan where the planner emits `files_owned` (TASK-14); one live Gemini run as validator (requirements Q1). Each needs a host with a signed-in agent, which the Windows build host cannot provide; use the home server.
2. **Write the UX wave as a feature folder with the skill** (`specs/002-ux-gaps/`): quick task, notes to a running worker, line-anchored Send back, app-under-test link, mobile inbox, in that order. Each is a small task with a brief; run them through orch. This is the first non-roadmap feature folder and the first real test of fold-back on a second feature.
3. **Keep the orchestrator deterministic.** A quick task adds a planner call for a brief-less task, which the existing rule already allows; nothing else in the UX wave touches an LLM. New decision logic goes in `src/core/` with fixtures, per 0020.
4. **Do not chase harness count.** Add Codex when a real run needs it, not before; keep vendor names inside `src/adapters/`.
5. **State the trust boundary in the docs.** README and the home-server guide should say plainly that agents run with permissions bypassed and that orch belongs on a dedicated host or in the container.
6. **Still open from the first draft:** mid-run re-plan, per-role reasoning-effort settings, Linear/GitHub Issues import (adopt mode is the nearer path; the quick task is nearer still for single issues).
7. **Hardening targets:** the fold-back loop on a repo with several features (does the record stay consistent after three or four fold-backs?); a long-running UI app that ignores SIGTERM; archive behaviour when `ORCH_HOME` is on a slow mount.

## 5. Sources consulted

### 2026-11-07 (§2.1)
- Factory: Introducing Missions — https://factory.com/news/missions
- Factory docs: Missions — https://docs.factory.ai/cli/features/missions
- Factory docs: Missions configuration & reference — https://docs.factory.com/missions/reference
- AI Engineer talk: The Multi-Agent Architecture That Actually Ships (Factory) — https://ai.engineer/talks/ow1we5PzK-o-production-multi-agent-architecture
- AlphaSignal: Factory's Missions on Desktop — https://alphasignal.ai/news/factory-s-missions-let-droids-build-code-autonomously-for-two-weeks
- Factory: Introducing OpenCompute — https://factory.com/news/opencompute
- Composio blog: The Self-Improving AI System That Built Itself — https://composio.dev/blog/the-self-improving-ai-system-that-built-itself
- Agent Orchestrator research note (maintainer transfer) — https://rywalker.com/research/agent-orchestrator
- Composio Agent Orchestrator (Learn AI wiki) — https://ai.miraheze.org/wiki/Composio_Agent_Orchestrator
- LLM Explorer: Composio Agent Orchestrator — https://llm-explorer.com/agent/agent-orchestrator

### 2026-11-09 (§2.2; vendor pages, claims not independently verified)
- Solo — https://soloterm.com/
- Conductor — https://www.conductor.build/ , /docs , /changelog (0.93.0 "Conductor is joining Meta", 2026-11-04), /docs/concepts/workspaces-and-branches , /docs/concepts/parallel-agents
- herdr — https://herdr.dev/ , /guide/ , /core/
- Orca — https://www.onorca.dev/ , /docs , /enterprise
- Paradev (formerly Superset; superset.sh redirects) — https://paradev.com/ , https://github.com/ParadevAI/Paradev
- T3 Code — https://t3.codes/ , /download , https://github.com/pingdotgg/t3code (docs/user/permission-modes.md, docs/user/source-control.md)
- cmux — https://cmux.com/ , /pricing , /docs/getting-started

orch-side facts in §1–4 come from the repo at commit `293bc1d` (main, 2026-11-09).
