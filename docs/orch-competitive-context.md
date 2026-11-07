# orch — competitive context and next steps

Exported from a Claude chat on 2026-11-07. Intended as working context for the coding agent continuing development of `orch`.

## 1. What orch is (recap)

`orch` is an orchestrator / worker / validator runner for Claude Code with a live dashboard, built on 2026-11-07 (~2,400 lines, TypeScript, Node 20+, SQLite only dependency).

### Design principles
- All state lives in a SQLite database the orchestrator owns; every actor (human, dashboard, agents) reads and writes through it. Nothing lives only in an agent's head.
- The orchestrator is deterministic code. It calls an LLM only to draft the plan. Scheduling, retries, git and merges are plain code.
- Fresh context per task. Each worker starts clean and receives a hand-off brief assembled from earlier workers' summaries, the decisions log, and human answers.
- Validation is a different agent. The validator sees the task, acceptance criteria and the diff; it runs the checks itself and must cite evidence per criterion. `agent.validatorModel` can be a different model.
- Decisions and questions are first-class records. Agents call `orch decide "..." --why "..."` (logged, non-blocking) and `orch ask "..." --options "A,B"` (task pauses with `needs_input`, push notification, worker resumes its own session with the answer; answering does not consume an attempt).

### Flow
```
spec.md / plan.md / tasks.md  ->  orch plan  ->  [human approves]  ->  orch run
for each task (respecting dependencies, N in parallel):
  worktree -> worker (fresh context + hand-off brief) -> commit
           -> validation command (deterministic gate)
           -> validator agent (fresh context, PASS/FAIL with evidence)
           -> PR -> merge (auto, or wait for human) -> tick tasks.md -> next
```

### Task states
`pending | running | validating | needs_input | pr_open | failed | done | skipped`

### Run states
`planning | plan_pending | ready | running | paused | done | stopped | failed`

### Layout
```
src/orchestrator.ts   state machine: plan -> approve -> run -> validate -> merge; questions, decisions, retries
src/agent.ts          runs `claude -p --output-format stream-json`, parses the stream, extracts the JSON block
src/git.ts            worktrees, diffs, push, gh pr create/merge, local merge
src/speckit.ts        tasks.md parser and ticker
src/db.ts             SQLite: runs, tasks, events, decisions, questions
src/server.ts         REST + SSE, serves the dashboard
src/cli.ts            `orch` (human commands and the agent-facing decide/ask)
prompts/*.md          planner / worker / validator role prompts (overridable at <repo>/.orch/prompts/<name>.md)
dashboard/index.html  the UI, no build step
scripts/fake-agent.mjs, scripts/e2e.mjs   end-to-end test harness
orch.service          systemd unit
```

### Config (`orch.config.json`) highlights
- `repo`, `baseBranch`, `worktreeDir`, `dbPath`, `host`, `port`, `publicUrl`
- `agent.command` (default `claude`), `agent.extraArgs` (default `--permission-mode bypassPermissions`), `workerModel`, `validatorModel`, `plannerModel`, `timeoutMinutes`
- `scheduler.maxParallel` (1 = sequential), `tickSeconds`, `maxAttempts` (default 2), `resumeOnRetry`
- `validation.command` (deterministic gate), `validation.agent` (run the validator agent)
- `git.pr` (true = push + `gh pr create` + `gh pr merge --squash --delete-branch`; false = local rebase + squash merge), `git.mergePolicy` (`auto` | `manual`), `git.squash`, `git.copyFiles`, `git.setupCommand`, `git.tickTasksMd`
- `handoff.specChars`, `handoff.historyChars`, `handoff.contextFiles`
- `notify.ntfyUrl`, `notify.ntfyToken`

### Spec layer
Reads GitHub Spec Kit `tasks.md`:
```markdown
## Phase 2: Core
- [ ] T003 [P] Implement POST /auth/signup in src/routes/auth.ts
- [ ] T004 [P] Implement POST /auth/login
- [ ] T005 Add auth middleware (depends on T004)
```
Rules: tasks depend on all tasks in earlier phases; a non-`[P]` task also depends on the previous task in its phase; "depends on T00X" in the text adds an edge. The planner and the dashboard can override edges. `- [x]` tasks import as done.

### Dashboard
Board (lanes per state), Plan (criteria/deps/merge policy, editable before approval), Decisions (audit trail with actor + rationale), Activity (run-level events), task drawer with live agent log, and Inbox (plan approvals, questions, failures past retry limit, manual-merge PRs, merge failures). ntfy push for inbox items.

### Test status
- `npm run test:e2e` runs the whole loop against a fake agent: planning, approval, two parallel workers, a mid-task question with session resume, a gate failure retried, a validator rejection retried, a manual-merge approval, tasks.md ticked on main.
- One real Claude Code run on a one-task spec passed (planner produced criteria + decisions, worker committed, validator passed with evidence; ~30 s of agent time, ~$0.20).
- Docker deployment instructions were also provided in the original chat.

## 2. How orch compares to the competition

Short version: orch sits in a real gap between Factory Missions and Composio's Agent Orchestrator. It has the Missions architecture (planner/worker/validator) with Agent Orchestrator's openness, plus two things neither has: a decisions audit trail and a human-decision inbox. What it lacks is maturity, breadth, and anyone else maintaining it.

| | orch | Factory Missions | Agent Orchestrator (ex-Composio) | Others (Symphony, ralph-tui, GitHub Agentic Workflows) |
|---|---|---|---|---|
| Roles | Planner, worker, validator; orchestrator is deterministic code | Orchestrator, workers, validators, research agents; orchestrator is itself an agent | Orchestrator agent + worker agents; no validator role | Mostly single-role loops; Symphony is a spec, not a runtime |
| Unit of work | One Spec Kit task -> one worktree -> one PR | Whole project -> milestones -> features | One issue -> one worktree -> one PR | One ticket/issue -> one PR |
| Validation | Deterministic gate, then independent fresh-context validator with per-criterion evidence; optional different model | Milestone validation; workers launch the app and QA flows, incl. browser | CI retry + review-comment routing; no independent reviewer | CI only |
| Human decisions | Inbox: plan approval, questions (worker pauses, resumes own session), failures, manual merges | Talk to the orchestrator; Mission Control | Escalation when agent is stuck; dashboard | GitHub UI |
| Decisions log | Every planner/worker/validator/human decision with rationale | Not a first-class record | No | No |
| Spec layer | Native Spec Kit `tasks.md`; any `- [ ] T001` markdown works | Its own planner re-plans from your description | GitHub Issues or Linear | Linear (Symphony), prd.json/Beads (ralph-tui), Issues |
| Agent | Claude Code only (one command string, so swappable) | Droid; multi-model per role | 30+ harnesses as of v0.13 | Varies |
| Runs where | Linux server / WSL2 / Docker | CLI, Desktop, Web; Droid Computers for walk-away; OpenCompute self-hosted sandboxes (private preview) | Your machine, daemon + web dashboard | Actions runners / your machine |
| Lock-in | None; ~2,400 lines you own | Proprietary; captured skills live in `.factory/` | MIT, open source | Open spec / open source |
| Maturity | One real run, one e2e test, zero users | Thousands of missions; median ~2 h, longest 16 days | ~8.5k stars, ~1k forks, 3,000+ tests | Varies; Symphony is weeks old |
| Cost | Your Claude plan | Subscription + consumption | Your Claude plan | Actions minutes or your plan |

### Where orch is ahead
- **Validation is actually independent.** Agent Orchestrator has no validator; it leans on CI and reviewer comments. orch runs a deterministic gate and a fresh-context agent that must cite evidence per acceptance criterion, optionally with a different model. Closer to Missions than to AO.
- **Decisions and questions are first-class.** Neither competitor offers a chronological, filterable log of every judgement call with rationale, nor a worker that pauses on a question, pushes to your phone, and resumes its own session with the answer.
- **It consumes the spec instead of replacing it.** Missions re-plans from a description; AO wants issues. orch reads Spec Kit `tasks.md` directly and ticks it on merge.
- **The orchestrator is code.** Both competitors make the orchestrator an AI agent. orch only calls a model to draft the plan: less flexible, far more predictable and debuggable. Factory's own numbers (orchestration ~2% of a 16-hour run) suggest the orchestrator does not need to be clever.

### Where orch is behind
- **Validation depth for UI work.** Missions validators can drive a browser and exercise flows. orch's validator reads a diff and runs commands. Real gap for web apps.
- **The PR lifecycle after the merge button.** AO injects CI failures back into the agent's session and routes review comments to the agent with context. orch opens the PR and either merges or waits; a failed CI run or review comment lands in the inbox as "merge needs you." Most valuable feature to borrow.
- **Long horizons.** Factory's longest mission ran 16 days. orch is per-task with a hand-off brief capped at a few thousand characters; no re-planning mid-run; nothing reasons about the project as a whole after plan approval.
- **Breadth and hardening.** AO claims 3,000+ tests and 30+ harnesses. orch has one e2e test against a fake agent and one real one-task run. Expect early bugs in: the `tasks.md` parser on unusual formats, worktree cleanup after crashes, parallel merges touching the same file.
- **Multi-model.** Missions sets separate models and reasoning effort per role. orch has per-role model flags but a single agent command, so it is Claude Code unless the runner is swapped.
- **A maintainer.** AO moved from ComposioHQ to its creator's personal account by June 2026 as Composio refocused on MCP infrastructure; it is effectively a one-person project. orch is a zero-person project. Both are riskier than Factory.

## 3. Recommended next work (actionable)

1. **CI / review feedback loop (highest value).** After `gh pr create`, poll `gh pr checks` and `gh pr view --comments`. On a failing check or "changes requested", re-run the worker with the CI logs or review comments as `last_feedback`, reusing the existing validator-feedback retry path. Estimated ~150 lines in `src/orchestrator.ts` + `src/git.ts`. Add a `git.ciFeedback` config flag and a poll interval. Cap retries with `maxAttempts`.
2. **Optional browser-QA validator prompt for UI tasks.** Same validator role, second prompt file (`prompts/validator-ui.md`) instructing the validator to start the app (use `git.setupCommand` / a new `validation.serveCommand`) and exercise the flow with Claude Code browser tools. Select per task via a `validate_mode` field (planner can set it; editable in dashboard).
3. **Keep the orchestrator deterministic.** Do not drift toward "the orchestrator is an agent." Deterministic scheduling plus the decisions log is the differentiator.
4. **Do not chase harness count.** `agent.command` is already a string; per-role override (e.g. Codex for validation) is enough if ever wanted.
5. **Hardening targets:** `tasks.md` parser edge cases (nested lists, non-`T###` keys, mixed checkbox styles), worktree cleanup after daemon crash (`recover()` path), serialized merges when parallel tasks touch the same files, SSE reconnection in the dashboard.
6. **Nice-to-have later:** mid-run re-plan ("re-plan from task N onward"), per-role reasoning-effort settings, Linear/GitHub Issues import as an alternative to `tasks.md`.

## 4. Sources consulted for the comparison
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
