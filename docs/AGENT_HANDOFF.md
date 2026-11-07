# orch — handoff for the coding agent

This document is the complete briefing for an AI coding agent (or a human) continuing development
of **orch**. It records what the tool is for, how it was designed, every decision that shaped it
and why, the current state of the code, known gaps, and a prioritized roadmap that folds in the
best ideas from the other orchestrators we evaluated. Read it fully before changing anything.

The project lives in this repository. `README.md` is the user-facing manual, `docs/docker.md` is
the container guide. This file is the *engineering* context.

---

## 1. Purpose and objectives

### The problem
The owner builds software with Claude Code. Their existing workflow: a Claude Code skill produces
`requirements.md`, `architecture.md` and a series of task `.md` files; then, for each task, they
open a fresh chat, instruct the agent, create a PR, merge, delete the branch. It works, but the
human is the orchestrator, and that does not scale.

### What they want (verbatim priorities, in their own words, lightly condensed)
1. An orchestrator that coordinates hand-offs between tasks, **prevents loss of context**, and
   keeps **validation separate from implementation** (the orchestrator / worker / validator
   pattern from Factory's Missions).
2. **Not tied into a vendor ecosystem.** Open code they own; any agent CLI.
3. A **nice UI dashboard** to control and monitor: what the plan is, what is done and not done,
   what is running, and **if there are decisions to be made that they need to make, they must be
   made aware**. Decisions the **system** makes must be visible too.
4. **Easy to use**: easy to instruct, easy to control.
5. Runs on a **Linux server** (always on) and is driven from a **Windows laptop** (browser);
   WSL2 also works. Docker deployment supported.
6. **Claude Code** is the primary agent; they also want to mix in **Gemini** (e.g. Claude for
   coding, Gemini for verification). They accept subscription usage limits over API billing.
7. Spec authoring moves to **GitHub Spec Kit** (`spec.md`, `plan.md`, `tasks.md`).
8. Sequential by default; parallel when safe.
9. Notifications via **ntfy** push.

### Non-goals (for now)
- Replacing Spec Kit's planning stage. orch consumes its output.
- Running agents in the cloud on our behalf (Warp Oz, Factory Droid Computers). The server *is*
  the persistent machine.
- Multi-user / multi-tenant. One owner, one dashboard, no auth (see Security).

---

## 2. Design principles (decided, do not relitigate without reason)

| # | Principle | Why |
|---|---|---|
| P1 | **All state lives in SQLite owned by the orchestrator daemon.** Nothing important lives only in an agent's context window. | This is what "prevents loss of context". Workers are disposable; the DB is not. |
| P2 | **The orchestrator is deterministic code, not an LLM.** It calls a model only for planning (once per spec). | Factory's own numbers: orchestration was 2.3% of a 16-hour Mission. Reliability matters more than cleverness here. Also cheaper and debuggable. |
| P3 | **Fresh context per role invocation.** Planner once; one worker per task attempt; one validator per task. | Attention degrades over long trajectories; fresh, narrow contexts are the Missions insight and the Ralph-loop insight. |
| P4 | **Hand-off brief, not shared memory.** Each worker receives: task + acceptance criteria, spec excerpt, summaries of completed tasks (direct dependencies in full, others clipped), the decisions log, human answers. | Replaces "one long chat" with a bounded, curated context. Caps are configurable (`handoff.*`). |
| P5 | **Validator is independent.** It gets the task, criteria, the worker's *claims* (summary) and the diff. Never the worker's reasoning. It runs tests itself and must cite evidence per criterion. It does not fix code. | Maker/checker split. Optionally a different model or vendor (`agents.roles.validator`). |
| P6 | **Two validation layers.** A deterministic command gate (`validation.command`, e.g. `npm test`) runs *before* the validator agent. | Cheap, non-negotiable, catches the obvious without spending tokens. |
| P7 | **Decisions and questions are first-class DB records**, created by agents via a CLI (`orch decide`, `orch ask`) or via the final JSON block. | The owner's explicit requirement: see what the system decided and be told when it needs them. |
| P8 | **Blocking questions pause only that task.** The orchestrator keeps running independent tasks. On answer, the worker is resumed in its *own session* (`--resume`) so it keeps context. | Avoids stalling the run and avoids redoing work. |
| P9 | **Git isolation: one worktree per task, one branch, one PR.** Worktrees live outside the repo (`worktreeDir`). | Parallel-safe; mirrors the owner's existing PR-per-task habit. |
| P10 | **Adapters, not a single agent.** Each role picks an adapter (`claude`, `gemini`) and model. Adapters normalize CLI streams into five event kinds. | Vendor independence; mixed validation. |
| P11 | **Everything a human needs is in one Inbox.** Plan approval, questions, failures past retry, manual merges, merge errors. Each with its actions. Push notification for each. | "Easy to control." |
| P12 | **Risky work waits for a human.** `merge_policy: manual` per task; the planner assigns it for auth, migrations, billing, irreversible changes. Merge-step failures (conflicts, CI) go to the inbox rather than burning worker retries. | Safety without babysitting. |
| P13 | **Spec Kit is the input contract, not a dependency.** Any markdown with `- [ ] T001 …` lines works. Ticks are written back to `tasks.md` after merge. | Keeps the owner's authoring flow and tooling choice flexible. |

---

## 3. Architecture

```
                 ┌──────────────── dashboard (dashboard/index.html, vanilla JS, SSE) ──────────────┐
                 │  Inbox · Board · Plan · Decisions · Activity · Task drawer with live log        │
                 └───────────────────────────────▲──────────────────────────────────────────────────┘
                                                 │ REST + SSE (src/server.ts)
┌───────────── orch daemon (src/orchestrator.ts) ─┴────────────────────────────────────────────────┐
│ scheduler tick ─► pick ready tasks (deps done, no open questions, slots free)                     │
│ runTask ──► git worktree add ─► worker (adapter) ─► commit ─► validate()                          │
│ validate ─► validation.command gate ─► validator (adapter) ─► PASS? finalize : failOrRetry        │
│ finalize ─► push + gh pr create ─► merge (auto) | inbox (manual) ─► tick tasks.md ─► done         │
│ questions / decisions / answers / retry / skip / merge / stop ◄─ CLI + dashboard                  │
│ SQLite (src/db.ts): runs, tasks, events, decisions, questions                                     │
└───────────────┬───────────────────────────────┬──────────────────────────────┬───────────────────┘
                │ src/adapters/runner.ts        │ src/git.ts                    │ src/notify.ts
         claude -p stream-json           git worktree / gh pr                   ntfy push
         gemini -p stream-json
```

### Files
| path | role |
|---|---|
| `src/cli.ts` | `orch` entry: `init serve plan approve run pause stop status answer retry skip merge`; agent-facing `decide`, `ask`. Talks to the daemon over HTTP (`ORCH_URL`). |
| `src/config.ts` | `orch.config.json` schema, defaults, legacy `agent`→`agents` migration, validation. |
| `src/orchestrator.ts` | The state machine. Everything in §4 and §5. |
| `src/db.ts` | better-sqlite3 store. WAL mode. Schema in §6. |
| `src/speckit.ts` | `tasks.md` parser (phases, `[P]`, explicit "depends on"), spec dir reader, tick-writer. |
| `src/adapters/types.ts` | `AgentAdapter` interface, `AdapterConfig`, `StreamState`, normalized event kinds. |
| `src/adapters/runner.ts` | Spawn, stdin, timeout/kill, line loop, `extractJson()` (last fenced ```json block, else last `{…}`). |
| `src/adapters/claude.ts` | `claude -p --output-format stream-json --verbose [--model] [--resume]`, prompt on stdin. |
| `src/adapters/gemini.ts` | `gemini -p <trailer> --output-format stream-json --yolo --skip-trust [-m] [--resume]`, prompt on stdin; reassembles deltas, segments by tool call. |
| `src/adapters/index.ts` | Registry (`ADAPTERS`), `getAdapter()`. |
| `src/git.ts` | `sh()`/`shell()`, `Git` class: baseRef (origin/base after fetch, else local), worktree add/remove, commitAll, commitPaths, diffFromBase, commitsAhead, push, createPr, mergePr, mergeLocal (rebase + squash/ff). |
| `src/server.ts` | Node `http` server, tiny router, SSE at `/api/events/stream`, serves dashboard. |
| `src/notify.ts` | ntfy POST with title/priority/click/tags. |
| `src/prompts.ts` | Loads `prompts/<name>.md` with `<repo>/.orch/prompts/<name>.md` override; `{{var}}` rendering; `clip()`. |
| `prompts/planner.md` `worker.md` `validator.md` | The three role prompts and their JSON contracts (§7). |
| `dashboard/index.html` | Single file, no build. |
| `scripts/fake-agent.mjs` | Scripted stand-in for both CLIs (`FAKE_FLAVOR=gemini`). |
| `scripts/e2e.mjs` | Full-loop test in a temp repo (`npm run test:e2e`). |
| `Dockerfile`, `docker-compose.yml`, `docs/docker.md`, `orch.service` | Deployment. |

Stack: TypeScript (strict, NodeNext ESM, `tsc` → `dist/`), Node ≥ 20, dependency: `better-sqlite3` only. No framework, no bundler.

---

## 4. State machines

### Run
`planning` → `plan_pending` → (approve) `ready` → (start) `running` ⇄ `paused` → `done` | `stopped` | `failed`

- `activeRun()` = most recent run not in `done|stopped|failed`. **Single active run is assumed** by the scheduler (see Gaps).
- `plan(specDir, {llm})`: creates run + tasks from `tasks.md`; if `llm`, runs the planner and applies its enrichment (acceptance, depends_on, merge_policy, validate_cmd), logs its decisions, attaches plan-level questions to the first pending task. Then `plan_pending` + ntfy.
- `recover()` on daemon start: active tasks → `pending` (worktree kept), `planning` runs → `plan_pending`.

### Task
```
pending ──(deps done, slot)──► running ──► validating ──► done
   ▲                              │             │
   │   needs_input ◄──(orch ask)──┘             ├──(gate/validator FAIL, attempt<max)──► pending (retry, resumes session)
   │        │ (answered) ─────────► running     ├──(attempts exhausted)──► failed  → inbox
   │                                            └──(PASS, manual policy | merge error)──► pr_open → inbox → done
   └──(human: retry) failed/pr_open/done            skipped (human)
```
- `attempt` increments on each worker start; answering a question does not consume an attempt
  (`resumeAfterAnswer` decrements first). `retryTask` resets to 0 and starts fresh.
- `resume` (= `--resume <session_id>`) is used when `scheduler.resumeOnRetry` and the adapter
  `supportsResume`. Resume prompt = answered Q/A + last feedback + "continue".
- `stop()` kills all agent processes (SIGTERM) and resets active tasks to `pending`.
- `pause()` lets active tasks finish; scheduler starts nothing new. Answers received while paused
  are applied when the run resumes (tick resumes `needs_input` tasks with no open questions).
- Scheduler tick every `tickSeconds`; also nudged after state changes.

### Merge
- `git.pr: true`: `push --force-with-lease` → `gh pr create` (reuses existing PR for the branch) →
  `auto`: `gh pr merge --squash --delete-branch`; `manual`: `pr_open`. Worktree removed on done.
- `git.pr: false`: `mergeLocal` = rebase task branch onto base, then squash-merge or ff into base
  **in the main repo checkout**; requires base checked out and clean (untracked files ignored).
  Serialized with `withMergeLock()`.
- After merge: `tickTasksMd` flips `- [ ] T001` → `- [x] T001` on the **base branch** (never on task
  branches — parallel branches would conflict on adjacent lines). Committed in local mode; left as
  a working-tree change in PR mode.

---

## 5. Agent contracts

All three roles end their final message with ONE fenced ```json block. `extractJson()` is
forgiving (last fenced block, else last top-level object).

**Planner → orchestrator**
```json
{ "tasks": [{ "key": "T001", "acceptance": ["…"], "depends_on": [], "merge_policy": "auto|manual", "validate_cmd": null }],
  "decisions": [{ "text": "…", "rationale": "…" }],
  "questions": [{ "text": "…", "options": ["…"] }] }
```

**Worker → orchestrator**
```json
{ "status": "done|blocked|failed", "summary": "2-5 sentences for the next worker", "files": ["…"],
  "decisions": [{ "text": "…", "rationale": "…" }], "follow_ups": ["…"], "reason": "(if failed)" }
```
Rules the prompt enforces: implement only this task; write/run tests; commit on the branch; never
push/PR/switch branches; never edit `tasks.md`/`spec.md`/`plan.md`; `orch decide` for judgement
calls; `orch ask` + stop for expensive ambiguity.

**Validator → orchestrator**
```json
{ "verdict": "PASS|FAIL", "criteria": [{ "criterion": "…", "met": true, "evidence": "…" }],
  "reasons": ["…"], "suggestions": ["…"] }
```

**Agent environment** (set by the orchestrator for every worker/validator): `ORCH_URL`,
`ORCH_TASK_ID`, `ORCH_RUN_ID`, `ORCH_ACTOR` (`worker|validator`), and `PATH` prefixed with
`<pkg>/bin` so `orch` resolves without a global install. Planner gets `ORCH_RUN_ID`, `ORCH_ACTOR=planner`.

**Normalized events** (what adapters emit, what the DB stores in `events.kind`, what the dashboard renders):
`text` (assistant prose), `tool` (tool call: name, clipped input, id), `agent` (tool result: output clipped to 1500, is_error), `error`, `info` (init / final stats incl. `cost_usd` when the CLI reports it). The orchestrator adds `state`, `git`, `decision`, `question`, `verdict`.

---

## 6. Data model (SQLite)

- `runs(id, spec_dir, title, status, base_branch, created_at, updated_at, notes)`
- `tasks(id, run_id, key, title, description, acceptance JSON, depends_on JSON, parallel, phase, order_idx, status, attempt, max_attempts, merge_policy, validate_cmd, worktree, branch, pr_url, session_id, summary, files JSON, last_feedback, created_at, updated_at)` — `UNIQUE(run_id, key)`
- `events(id, run_id, task_id, ts, kind, data JSON)` — append-only; indexed by task and run
- `decisions(id, run_id, task_id, ts, actor, text, rationale)` — actor ∈ planner|worker|validator|orchestrator|human
- `questions(id, run_id, task_id, ts, text, options JSON, answer, answered_at)`

`snapshot()` derives the inbox from this: `approve_plan`, open `question`s, `failed` tasks, `pr_open` tasks (with `pr_url`/`feedback`).

---

## 7. Config (orch.config.json)

See `src/config.ts` for the authoritative schema and defaults. Key points:
- Paths resolve relative to the config file. `ORCH_CONFIG` env or upward search from cwd.
- `agents.adapters.<name> = { type, command, extraArgs, env }`; `agents.roles.{planner,worker,validator} = { adapter, model }`; `agents.timeoutMinutes`.
- Defaults: Claude `--permission-mode bypassPermissions`; Gemini `--yolo --skip-trust` (both required headless; without `--yolo` Gemini silently denies tools and exits 0; without `--skip-trust` a fresh worktree is untrusted and it exits 55).
- Legacy pre-0.2 `agent` block is migrated by `migrateLegacyAgentBlock()`.
- `handoff.contextFiles` (default `plan.md`, `spec.md`), `handoff.specChars` (12k), `handoff.historyChars` (6k).

---

## 8. What has been verified

- `npm run test:e2e` passes: planning with LLM enrichment, approval, `maxParallel: 2`, a question
  asked mid-task via `orch ask`, answered through the API, worker resumed with `--resume`; gate
  failure → retry; validator FAIL → retry; manual-merge approval; local merge; `tasks.md` ticked;
  decisions from every actor present. Workers on the Claude adapter, validator on the Gemini
  adapter (fake dialects).
- A **real** one-task run with Claude Code 2.1.x (planner + worker + validator, local merge):
  planner produced 5 criteria + 3 decisions with rationale; validator ran its own checks and
  returned PASS with per-criterion evidence; ~$0.20 total. Real stream-json shapes match the parser.
- Gemini CLI 0.67: argument set accepted (fails only at auth here); stream schema taken from the
  CLI's `StreamJsonFormatter` source; `--resume <uuid>` confirmed in source. **Not yet run live.**
- Dashboard screenshots reviewed (dark + light, board, task drawer, plan, decisions).
- Docker: Dockerfile/compose written and reviewed; **not built here** (no daemon in the sandbox).

---

## 9. Known gaps and rough edges (fix list)

Ordered roughly by how likely they are to bite.

1. **Gemini adapter untested live.** First live run will probably need prompt tuning in
   `prompts/validator.md` for Gemini's style. Verify the stdin + `-p` trailer behaves as the
   help text says ("Appended to input on stdin").
2. **Dashboard has no authentication.** Bind to localhost / Tailscale / reverse proxy. Do not expose.
3. **Parallel tasks have no file-ownership check.** Two `[P]` tasks touching the same file will
   produce a merge conflict that lands in the inbox. (Roadmap R2.)
4. **Local-merge mode requires `baseBranch` checked out and clean** in the main repo. Any human
   edit there blocks merges until committed/stashed. PR mode avoids this.
5. **PR mode leaves `tasks.md` tick as an uncommitted working-tree change** in the main repo.
   Option: commit+push to base after merge when branch protection allows; make it configurable.
6. **Single active run.** `activeRun()` picks the newest unfinished run; two concurrent runs would
   share `maxParallel` incorrectly. Either enforce one run at a time or scope the scheduler per run.
7. **Plan-level questions are attached to the first pending task** (hack so they show in the
   inbox). A `questions.task_id` nullable + inbox support would be cleaner.
8. **No per-run cost/duration rollup.** `info` events carry `cost_usd`/`duration_ms`; nothing sums them.
9. **Events table is unbounded.** Add pruning or per-run archive.
10. **Worker JSON block missing → weak hand-off.** If a worker ends without the block, `summary`
    is null and the next worker gets "(no summary)". Could fall back to a cheap summarizer call.
11. **Validator cannot see the gate's output** (only whether it passed). Passing it along would help.
12. **No unit tests** (only e2e). The `tasks.md` parser and `extractJson` deserve unit tests.
13. **`Stop` while a validator is running** resets the task to `pending`; the worker's commits are
    kept, so the retry re-validates rather than re-implements — fine, but note `attempt` increments again.
14. **Recovery after daemon crash** keeps worktrees but loses in-flight agent output; the task
    simply re-runs (with `--resume` if a session id was captured).
15. **`sh -c` for validation commands** — no shell escaping concerns since the command comes from config, but it runs with the agent's permissions.
16. **ntfy only.** Slack/Discord/email webhooks would be ~20 lines each in `notify.ts`.

---

## 10. Roadmap: features worth borrowing from the other tools

These are the capabilities we identified in the comparison that orch lacks today, ranked by
value-for-effort for this owner. Each has a source (which tool does it well), a sketch, and
touchpoints in the code.

### R1. CI-failure and review-comment feedback loops (from Composio Agent Orchestrator, Symphony)
Today, after `gh pr create`, orch either merges or waits. If GitHub CI fails on the PR, or a
reviewer requests changes, nothing happens until a human re-runs.
- Poll `gh pr checks` / `gh pr view --json reviews,comments` for `pr_open` tasks (and briefly for
  `auto` tasks before merging, if `git.waitForChecks: true`).
- On failing checks: resume the worker with the CI log excerpt as feedback (same path as
  `failOrRetry`, without consuming the attempt budget, or with a separate `ciAttempts` budget).
- On review comments: resume the worker with the comments; mark the task `pr_open` again when it
  pushes. Record both as `decision`s so the trail is visible.
- Touchpoints: `finalize()`, a new `pollPullRequests()` in the tick, `git.ts` helpers.

### R2. File-ownership declarations for safe parallelism (from Shard, Agent Teams file locking)
- Planner emits `files_owned: ["src/auth/**"]` per task; the scheduler refuses to run two tasks
  with overlapping globs concurrently (edge added automatically, logged as an orchestrator decision).
- Worker prompt states the ownership; validator flags out-of-scope edits (it already reviews scope).
- Touchpoints: planner prompt + JSON, `tasks.files_owned`, `tick()` readiness check, Plan tab.

### R3. Milestone / phase-level validation (from Factory Missions)
Per-task validation checks pieces; nothing checks that a phase works as a whole.
- After all tasks in a phase are `done`, run a **phase validator** on the base branch: full test
  suite, plus a validator agent with the phase's tasks and spec section. Failures open a
  synthetic "fix-up" task (or go to the inbox).
- Later: integration validator with browser automation (Missions' "validation workers launch the
  app and click through"). Claude Code has computer use; Gemini CLI has browser tools via MCP.
- Touchpoints: `tick()` phase-completion detection, new prompt `prompts/phase-validator.md`, synthetic tasks.

### R4. Diff review in the dashboard (from Conductor, Nimbalyst, Vibe Kanban)
The owner reviews `pr_open` tasks on GitHub today. Local-merge mode has no review surface at all.
- `GET /api/tasks/:id/diff` → `git.diffFromBase`; render with a small diff viewer (diff2html or
  hand-rolled) in the task drawer, with "Merge now" / "Request changes" (which resumes the worker
  with the human's comment as feedback).
- Touchpoints: `server.ts`, `dashboard/index.html`, `git.ts`.

### R5. Issue tracker as control plane (from Symphony, Code Conductor, openspec-flow)
Let GitHub Issues (or Linear) be an alternative queue to `tasks.md`.
- `orch plan --from-issues --label orch` imports labelled issues as tasks; status mirrored back
  via labels/comments; PR body gets `Closes #N`.
- Keeps the DB as the source of truth; the tracker is a view + input.
- Touchpoints: a second importer beside `speckit.ts`, `finalize()` PR body, a status mirror in state changes.

### R6. Durable state in the repo (from Beads / Gas Town)
SQLite is local to the server. Beads keeps work state as JSON in `.beads/` so it travels with the
repo and survives machines.
- Export a run's tasks/decisions/questions as JSON (`.orch/runs/<id>.json`) on every change; allow
  `orch import` to rebuild the DB from it. Optionally commit to a side branch.
- Touchpoints: `db.ts` export/import, `orchestrator.changed()` hook.

### R7. Convention capture / learned skills (from Factory Missions "orchestrator captures patterns
as reusable skills", Trellis session journals)
- After each validated task, append notable conventions from the worker's summary and the
  validator's suggestions to `.orch/conventions.md`; include it in every hand-off brief (capped).
  Over a run, workers stop re-learning the same project quirks.
- Touchpoints: `handoff()`, `markDone()`, a small "distill" LLM call or plain append.

### R8. Multi-validator consensus (from Chorus multi-LLM review)
For `manual`-policy or high-risk tasks, run two validators (e.g. Claude + Gemini) and require both
to PASS; disagreements go to the inbox with both verdicts side by side.
- Touchpoints: `validate()`, config `validation.consensus: ["claude","gemini"]`, verdict rendering.

### R9. Periodic sweeps (from Gas Town "sweeps", Claude Code `/loop`, Warp Oz schedules)
A scheduled run that reviews the codebase against `architecture.md`/`spec.md` for drift and files
fix-up tasks into `tasks.md` (as a new phase) for the next run. Cron inside the daemon; results go
to the inbox for approval before execution.
- Touchpoints: new `sweep` role prompt, scheduler, `speckit.ts` writer.

### R10. Spec-PR before implementation (from openspec-flow, GitHub Agentic Workflows)
Optional two-stage gate: the planner's enriched plan is opened as a PR against `specs/…` for
review, and only merging it approves the run. Useful when multiple people review plans.
- Touchpoints: `plan()`, `approvePlan()` triggered by PR merge webhook/poll.

### R11. Claude Code native integrations
- `WorktreeCreate` hooks and `.worktreeinclude` could replace `git.copyFiles`/`setupCommand` when
  the worker is Claude Code; keep orch's own mechanism for other adapters.
- Pass `--allowedTools` profiles per role (validator read-mostly; worker full).
- Consider `--append-system-prompt` for role prompts instead of inlining, to keep the user prompt
  short (Claude adapter only).

### R12. More adapters
Codex (`codex exec --json`), OpenCode, Aider. One file each in `src/adapters/`, register in
`index.ts`, add a `FAKE_FLAVOR` to `scripts/fake-agent.mjs`, extend the e2e assertion.

### R13. Operational polish
Per-run cost/time rollup (tile in the dashboard header); run history view; event pruning;
Slack/Discord/email notifiers; auth on the dashboard (basic auth or a bearer token checked in
`server.ts`); unit tests for `speckit.ts` and `extractJson`; a `--dry-run` for `orch plan` that
prints the dependency graph.

### Suggested order
R1 (CI/review loops) → R4 (diff review) → R2 (file ownership) → R13 (auth + costs + tests) →
R3 (phase validation) → R7 (conventions) → R8 → R5/R6 → R9/R10 → R12.

---

## 11. Working agreements for whoever continues this

- Keep the dependency count near zero; the dashboard stays a single HTML file with no build step.
- Any new agent-facing behaviour goes through the adapter interface and the JSON contracts; do not
  special-case a vendor in `orchestrator.ts`.
- Every autonomous decision the orchestrator makes (reordering, retry, policy change) must be
  recorded with `decide()` so it shows in the Decisions tab. Every situation needing a human must
  appear in the inbox *and* ping ntfy.
- Keep `scripts/e2e.mjs` green and extend it when adding a lifecycle path; add a `FAKE_FLAVOR`
  branch to `scripts/fake-agent.mjs` for any new adapter.
- Prompts are product. Changes to `prompts/*.md` should be tested on a real run, not only the fake.
- Never write ticks or state into task branches (parallel-merge conflicts); base branch only.
- Secrets never go into the DB or the events log (tool inputs are clipped, but be deliberate).

---

## 12. Quick orientation commands

```bash
npm install && npm run build      # dist/
npm run typecheck
npm run test:e2e                  # full loop with fake agents, ~10s
node dist/cli.js init             # writes orch.config.json
node dist/cli.js serve            # daemon + dashboard on :4800
```
Entry points to read first, in order: `src/orchestrator.ts` (runTask → validate → finalize),
`src/adapters/runner.ts`, `prompts/worker.md`, `dashboard/index.html` (render + SSE handlers).
