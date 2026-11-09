# orch — competitive context and next steps

Originally exported from a Claude chat on 2026-11-07, when orch was one day old. Revised on 2026-11-08 after waves 1–12 of the roadmap (TASK-01..17) shipped and decision [0023](decisions/0023-orch-owns-spec-skill.md) was accepted. Intended as working context for the coding agent continuing development of `orch`. Competitor facts in §2 are as of 2026-11-07 and were not re-researched for this revision.

Where the canonical detail lives: [requirements.md](requirements.md) (what, with `built`/`new` status per REQ), [architecture.md](architecture.md) (how), [decisions/](decisions/README.md) (why, 23 records), [tasks/README.md](tasks/README.md) (the roadmap, waves 1–16), [user-guide/feature-status.md](user-guide/feature-status.md) (what a user gets today).

## 1. What orch is (recap, as of 2026-11-08)

`orch` is a self-hosted orchestrator for AI coding agents. One daemon manages several projects (git repos). It imports a Spec Kit `tasks.md`, has a planner add acceptance criteria, then runs each task as worker → deterministic test gate → independent validator → PR/merge, validates each phase as a whole on the base branch, and shows everything in a dashboard with one inbox for decisions that need the owner.

Size and stack: ~5,700 lines of TypeScript (strict, NodeNext ESM) plus an ~840-line single-file dashboard; Node ≥ 22 ([0022](decisions/0022-node-22-floor.md)); `better-sqlite3` is the only runtime dependency ([0009](decisions/0009-locked-stack.md)). MIT. 17 roadmap tasks done in 12 waves, all of them run as orch-style PRs; 47 requirements `built`, 15 `new` (the spec-skill wave, §3).

### Design principles (all recorded as decisions)
- **The orchestrator is deterministic code** ([0001](decisions/0001-deterministic-orchestrator.md)). An LLM is called only for the planner, worker, validator and phase-validator roles; never for scheduling, retries, git, merges or the PR loop. Readiness, task transitions, PR-poll actions, file-ownership overlap and phase completion are pure functions in `src/core/` pinned by owner-reviewed fixture tables (211 cases) ([0020](decisions/0020-pure-core-and-fixtures.md)).
- **SQLite owned by the daemon is the single source of truth** for projects, runs, tasks, phases, events, decisions and questions ([0002](decisions/0002-sqlite-single-source-of-truth.md)). Agents are disposable; a daemon crash loses at most the in-flight attempt.
- **Fresh context per role invocation, with a bounded hand-off brief** assembled from earlier workers' summaries, the decisions log and the owner's answers ([0003](decisions/0003-fresh-context-and-handoff-brief.md)).
- **Maker/checker.** A deterministic gate, then an independent validator that sees the task, criteria, worker's claims, diff and gate output, never the worker's transcript, and must cite evidence per criterion. The validator may run on a different adapter or model ([0004](decisions/0004-independent-validation.md)).
- **Decisions and questions are first-class records; one inbox** ([0005](decisions/0005-decisions-and-inbox.md)). Every autonomous choice goes through `decide()`; everything needing the owner is an inbox item plus a push notification.
- **One worktree, one branch, one PR per task; risky work waits for the owner** ([0006](decisions/0006-worktree-branch-pr-per-task.md)).
- **Vendor code lives only in adapters** ([0007](decisions/0007-agent-adapters.md)); an invariants check fails CI on vendor names elsewhere.
- **Spec Kit `tasks.md` is the input contract, not a dependency** ([0008](decisions/0008-speckit-input-contract.md)), now extended by 0023 (below).

### Flow
```
spec folder (tasks.md + spec/plan)  ->  orch plan [--dry-run]  ->  [owner approves; plan questions block starts]  ->  orch run
for each task (dependency order, file ownership respected, N per project, M across projects):
  worktree -> worker (fresh context + hand-off brief) -> commit
           -> validation command (deterministic gate)
           -> validator agent (fresh context; standard mode reads the diff, UI mode drives the running app)
           -> PR -> CI / review feedback rounds -> merge (auto, or wait for owner) -> tick tasks.md -> next
when a phase's tasks are all done:
  base branch -> phase test command -> phase validator -> PASS: next phase | FAIL: fix-up task FIX-<n>.<round>
```

### States
- Task: `pending | running | validating | needs_input | pr_checks | pr_open | failed | done | skipped`
- Run: `planning | plan_pending | ready | running | paused | done | stopped | failed`
- Phase: `pending | validating | passed | needs_human` (`failed` reserved)

### What shipped since the first draft (waves 1–12)
| Area | Now built | Task / decision |
| :--- | :--- | :--- |
| Test harness | `npm test` = build → unit → invariants → e2e; CI on Node 22 and 24; 7 e2e suites (happy path, PR loop, 13 lifecycle regressions, auth, multi-project, phases, UI mode) with a fake agent, fake `gh` and fake app | TASK-01..04 |
| Pure core | `src/core/` readiness, transitions, PR poll, ownership, phases, graph; fixture-driven | TASK-03, [0020](decisions/0020-pure-core-and-fixtures.md) |
| Review | Hand-rolled diff viewer in the task panel; **Send back** starts a fix round with the owner's note | TASK-06, [0018](decisions/0018-hand-rolled-diff-viewer.md) |
| Config | `$ORCH_HOME/server.json` (network, token, notifications, adapters, global agent cap) vs `<repo>/orch.config.json` (project keys only; server keys refused) | TASK-05, [0013](decisions/0013-project-config-in-repo.md) |
| Security | Bearer-token auth for API, SSE, CLI and agents; refuses a non-loopback bind without a token; open `/api/health` | TASK-08, [0014](decisions/0014-bearer-token-auth.md) |
| Multi-project | One daemon, many repos; one unfinished run per project; `scheduler.maxAgents` shared fairly; project switcher and global inbox; legacy single-repo upgrade | TASK-07, 09, 10, 11, [0011](decisions/0011-multi-project-daemon.md), [0012](decisions/0012-global-agent-cap.md) |
| Retention | Old runs' event logs archived to gzip JSONL, then deleted; decisions and costs kept | TASK-12, [0019](decisions/0019-event-archive-retention.md) |
| Planning | `orch plan --dry-run`; plan-level questions block every task start; approval refuses dependency cycles | TASK-13 |
| Parallelism | Planner declares `files_owned`; overlapping tasks are serialized automatically with a decision; validator reports out-of-scope edits as findings | TASK-14, [0017](decisions/0017-file-ownership.md) |
| Phase validation | Detached worktree on the base branch, phase command, phase validator; FAIL creates `FIX-<phase>.<round>` tasks; inbox after `maxFixups` | TASK-15, [0015](decisions/0015-phase-validation-fixups.md) |
| UI validation | `validate_mode: ui`: orch starts the app under test on a free port, the validator exercises it in a browser (Playwright MCP), orch always stops it; `BLOCKED` when no browser tool | TASK-16, [0016](decisions/0016-ui-validation-app-lifecycle.md) |
| Cost | Cost and agent time per task, run and project; display-only | TASK-17 |
| Adapters | Claude Code and Gemini CLI; adapter and model per role, overridable per project | [0007](decisions/0007-agent-adapters.md) |
| PR loop | CI failures and `/orch` review comments go back to the worker's own session; round budget separate from attempts; merged/closed PRs detected | R1, [0010](decisions/0010-pr-feedback-loop.md) |

### Layout
```
src/orchestrator.ts   side-effecting coordinator: project contexts, tick, runTask, validate, phases, PR poll, human actions
src/core/*            PURE decisions: readiness, transitions, prpoll, ownership, phases, graph
src/adapters/*        claude.ts, gemini.ts, runner.ts (spawn, stream-json, extractJson)
src/speckit.ts        tasks.md parser (pure) + spec dir reader + ticker
src/db.ts             SQLite + user_version migrations: projects, runs, tasks, phases, events, decisions, questions
src/config.ts, paths.ts, projects.ts, auth.ts, appserver.ts, archive.ts, costs.ts, prfeedback.ts, notify.ts, prompts.ts
src/server.ts         node:http REST + SSE, auth gate, serves the dashboard
src/cli.ts            owner commands (project add/list/remove, plan, approve, run, …) and agent-facing decide/ask
prompts/*.md          planner, worker, validator, validator-ui, phase-validator (overridable at <repo>/.orch/prompts/)
dashboard/index.html  the UI, no build step
test/fixtures/, test/unit/, scripts/e2e*.mjs, scripts/fake-{agent,gh,app}.mjs, scripts/check-invariants.mjs
Dockerfile, docker-compose, orch.service
```

### Config highlights
- Server (`server.json`): `host`, `port`, `publicUrl`, `auth.{token,allowInsecure}`, `notify.{ntfyUrl,ntfyToken}`, `agents.{timeoutMinutes,adapters.<name>,roles.<role>}`, `scheduler.{maxAgents,tickSeconds}`, `retention.eventDays`, `defaults.*`.
- Project (`orch.config.json`): `baseBranch`, `scheduler.{maxParallel,maxAttempts,resumeOnRetry}`, `validation.{command,agent,phase.*,ui.*}`, `git.{pr,mergePolicy,squash,copyFiles,setupCommand,tickTasksMd,feedback.*}`, `handoff.{specChars,historyChars,contextFiles}`, `roles.{planner,worker,validator,phaseValidator}`.

### Spec layer
Reads Spec Kit `tasks.md` (phases from headings, `[P]`, "depends on T00X", `- [x]` imported as done); any markdown with `- [ ] T001 …` lines works. 15 parser fixtures cover CRLF, h3 headings, forward references, self and unknown dependencies, and key widths.

**Agreed but not built (decision [0023](decisions/0023-orch-owns-spec-skill.md), [proposal](proposals/spec-workflow.md)):** orch ships its own spec skill, `skills/orch-spec/`, that writes exactly what orch reads. Once per project it produces a project record (requirements with REQ IDs, architecture, decision records, `AGENTS.md` rules, roadmap); once per feature it produces `specs/NNN-name/` with `spec.md`, `tasks.md` and one self-contained brief per task (`tasks/T00N.md` with YAML frontmatter: `orch: 1`, `covers`, `depends_on`, `parallel`, `merge_policy`, `validate`). When every task has a brief, `orch plan` builds the plan deterministically with no planner call; workers and validators get the brief, the cited REQ rows, the named contracts and the project rules; and when a run completes an inbox item lists what to fold back into the record. Plain Spec Kit folders still import, with less context. This is waves 13–16, TASK-18..24.

### Test status
- `npm test`: ~125 unit tests plus 211 fixture cases, the invariants check, and 7 e2e suites (about 30 scenarios) against the fake agent, fake `gh` and fake app. CI runs on every PR.
- Real runs: the first one-task Claude Code run (planner, worker, validator; ~$0.20) from the original chat, plus orch dogfooding its own roadmap. **Still open:** one real UI-mode run with a browser MCP (TASK-16), one real run where the planner emits `files_owned` (TASK-14), and the Gemini adapter has never run against a live account (requirements Q1).
- Known limits: Linux/macOS/WSL2/Docker only (UI mode needs process groups; `better-sqlite3` crashes on the Windows host, so Windows development runs tests in a `node:22` container). Cost is display-only; no spend caps.

## 2. How orch compares to the competition

Short version: orch sits in a real gap between Factory Missions and Composio's Agent Orchestrator (AO). It has the Missions architecture (planner/worker/validator, now plus phase validators) with AO's openness, plus three things neither has: a decisions audit trail, a human-decision inbox, and (once 0023 ships) a spec process that keeps a project record coherent across features. Since the first draft it has closed the two biggest gaps that were named then (the post-merge-button PR lifecycle, and browser-driven UI validation). What it still lacks is a maintainer other than its owner, external users, and breadth of agent harnesses.

| | orch (2026-11-08) | Factory Missions | Agent Orchestrator (ex-Composio) | Others (Symphony, ralph-tui, GitHub Agentic Workflows) |
|---|---|---|---|---|
| Roles | Planner, worker, validator, phase validator; orchestrator is deterministic code with fixture-pinned pure decisions | Orchestrator, workers, validators, research agents; orchestrator is itself an agent | Orchestrator agent + worker agents; no validator role | Mostly single-role loops; Symphony is a spec, not a runtime |
| Unit of work | One task → one worktree → one PR; phases validated as a whole; one daemon, many repos | Whole project → milestones → features | One issue → one worktree → one PR | One ticket/issue → one PR |
| Validation | Deterministic gate, then independent fresh-context validator with per-criterion evidence and gate output; optional different adapter/model; UI mode where orch starts the app and the validator drives a browser; phase validation on the base branch with automatic fix-up tasks | Milestone validation; workers launch the app and QA flows, incl. browser | CI retry + review-comment routing; no independent reviewer | CI only |
| Human decisions | Global inbox: plan approval, plan and task questions (worker pauses, resumes own session), failures, manual merges, stuck CI, phases needing the owner; diff viewer with Send back; ntfy push | Talk to the orchestrator; Mission Control | Escalation when agent is stuck; dashboard | GitHub UI |
| Decisions log | Every planner/worker/validator/phase-validator/orchestrator/human decision with rationale, including every auto-serialization, fix round and merge | Not a first-class record | No | No |
| Spec layer | Native Spec Kit `tasks.md`; any `- [ ] T001` markdown. Planned (0023): own skill writing a project record plus per-task briefs orch reads deterministically, with fold-back after each run | Its own planner re-plans from your description | GitHub Issues or Linear | Linear (Symphony), prd.json/Beads (ralph-tui), Issues |
| PR lifecycle | CI failures and `/orch` comments routed back to the worker's session; round budget; waits for checks before auto-merge; merged/closed detected | Mission Control | CI failures and review comments injected into the agent's session | CI only |
| Agent | Claude Code and Gemini CLI adapters; adapter + model per role, per project | Droid; multi-model per role | 30+ harnesses as of v0.13 | Varies |
| Runs where | Linux server / WSL2 / Docker; systemd unit; token auth for remote access | CLI, Desktop, Web; Droid Computers for walk-away; OpenCompute self-hosted sandboxes (private preview) | Your machine, daemon + web dashboard | Actions runners / your machine |
| Lock-in | None; MIT; ~6,500 lines you own; vendor code confined to adapters by CI | Proprietary; captured skills live in `.factory/` | MIT, open source | Open spec / open source |
| Maturity | 17 roadmap tasks shipped through orch itself; ~125 unit tests + 211 fixtures + ~30 e2e scenarios; one external-style real run; zero outside users | Thousands of missions; median ~2 h, longest 16 days | ~8.5k stars, ~1k forks, 3,000+ tests | Varies; Symphony is weeks old |
| Cost | Your Claude/Gemini plan; cost and agent time shown per task/run/project | Subscription + consumption | Your Claude plan | Actions minutes or your plan |

### Where orch is ahead
- **Validation is independent at two levels.** AO has no validator; Missions validates milestones. orch runs a gate, a fresh-context task validator (optionally another vendor) that must cite evidence per criterion and reports out-of-scope edits, then a phase validator on the merged base branch that creates fix-up tasks on failure. UI mode now covers the browser case that was a gap in the first draft.
- **Decisions and questions are first-class.** Neither competitor offers a chronological log of every judgement call with rationale, nor a worker that pauses on a question, pushes to your phone, and resumes its own session with the answer. Plan-level questions block the run until answered.
- **The orchestrator is code, and provably so.** Scheduling, transitions, PR-poll actions, ownership overlap and phase completion are pure functions in `src/core/` tested by owner-reviewed fixtures; an invariants check keeps `fs`, child processes, the DB and the clock out of them. Factory's own numbers (orchestration ~2% of a 16-hour run) suggest the orchestrator does not need to be clever.
- **It consumes the spec instead of replacing it, and will soon keep the spec honest.** Spec Kit folders import directly and get ticked on merge. Decision 0023 goes further than either competitor: a project record with REQ IDs and decision records, briefs written by the owner's interview rather than reconstructed by a planner, and a fold-back step after every run so the record does not drift.
- **Safe parallelism without a smart orchestrator.** File ownership declared by the planner serializes overlapping tasks deterministically; a global agent cap is shared fairly across projects.
- **The PR loop is no longer a gap.** CI logs and review comments (including inline `file:line`) return to the worker's own session with a round budget; auto-merge waits for checks. This was the first draft's top recommendation; it shipped as R1.

### Where orch is behind
- **Long horizons and re-planning.** Factory's longest mission ran 16 days. orch has no mid-run re-plan; after approval nothing reasons about the project as a whole except the phase validator. 0023 addresses coherence *between* runs (the project record and fold-back), not *within* one.
- **Real-run evidence.** The fake-agent harness is thorough, but UI mode, `files_owned` planning and the Gemini adapter have each had zero or one live run. Prompts are product and need real runs per change.
- **Breadth of harnesses.** Two adapters (Claude Code, Gemini CLI) against AO's 30+. The adapter interface is small, so Codex/OpenCode/Aider are feasible, but they are an explicit non-goal for now.
- **Spec authoring is still Spec Kit's job until TASK-19 lands.** Today the planner reconstructs criteria from one-line tasks and a clipped spec excerpt; the task validator gets no spec at all. This is the motivation for 0023 and the next wave.
- **A maintainer.** AO moved from ComposioHQ to its creator's personal account by June 2026 and is effectively a one-person project. orch is a one-owner project with no outside users. Both are riskier than Factory.
- **Platform.** No native Windows (WSL2/Docker only), no TLS (use SSH, Tailscale or a reverse proxy), no multi-user, no spend caps. All deliberate non-goals.

## 3. Recommended next work (actionable)

Status of the first draft's six recommendations: 1 (CI/review loop) **built** as R1; 2 (browser-QA validator) **built** as TASK-16 UI mode; 3 (stay deterministic) **held and strengthened** by 0020; 4 (don't chase harness count) **held**, with Gemini added via a small adapter; 5 (hardening: parser edge cases, worktree cleanup after crash, serialized merges on shared files, SSE reconnect) **all built** (fixtures, `recover()` + lifecycle e2e, file ownership, TASK-11); 6 (nice-to-haves) **open**, see below.

1. **Ship the spec-skill wave (TASK-18..24), in order.** TASK-18 fixtures first (owner reviews expected outputs, manual merge), then TASK-19 (the `orch-spec` skill: project, feature, fold-back and adopt modes plus a check script) and TASK-20/21 in parallel (brief parsing in `src/core/brief.ts`; pure context assembly with per-part budgets in `src/core/context.ts`), then TASK-22 (deterministic plan from briefs, planner only for brief-less tasks, `--review`; rules and contracts to every role), TASK-23 (end-of-run "Update project docs" inbox item) and TASK-24 (docs). This is the one piece of work that changes orch's position in the table above. Dogfood it: TASK-23's own folder is the first real feature-mode run.
2. **Close the open manual checks before the next prompt change.** One real UI-mode task with Claude Code and the Playwright MCP (attach the verdict to TASK-16); one real plan where the planner emits `files_owned` (TASK-14); one live Gemini run as validator (requirements Q1). Each is a documented acceptance step that is still unticked.
3. **Keep the orchestrator deterministic.** Do not drift toward "the orchestrator is an agent." 0023 was designed to this rule: a brief that already carries criteria removes an LLM call rather than adding one. New decision logic goes in `src/core/` with fixtures, per 0020.
4. **Do not chase harness count.** The adapter interface (`launch`, `parseLine`, `finish`, `supportsResume`) is enough; add a third adapter only when a real validator or worker needs it, and keep vendor names inside `src/adapters/`.
5. **Hardening targets now:** brief parser edge cases once TASK-20 exists (frontmatter without `orch:`, flow lists with spaces, CRLF); the fold-back loop on a repo with many features (does the record stay consistent after three or four fold-backs?); a long-running UI app that ignores SIGTERM; archive behaviour when `ORCH_HOME` is on a slow mount.
6. **Still open from the first draft:** mid-run re-plan ("re-plan from task N onward"; now partly covered by phase fix-ups, but nothing re-orders remaining tasks), per-role reasoning-effort settings (adapters take a model, not an effort), Linear/GitHub Issues import (a non-goal while 0023 lands; the skill's adopt mode is the nearer path).

## 4. Sources consulted for the comparison (2026-11-07)
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

orch-side facts in §1–3 come from the repo at commit `1e4ab87` plus branch `docs/spec-workflow-0023` (commit `005a924`: the 0023 record, the proposal, the new REQs and the TASK-18..24 briefs), which was not yet merged to main. The links to the 0023 record and the proposal resolve once it is.
