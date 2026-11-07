# orch: Architecture & Design

> **Scope of this document:** *how* the requirements in [requirements.md](requirements.md) are met. Reasons for the big choices are in [decisions/](decisions/).
>
> **Once code exists, the code is authoritative for contracts** (sections marked _(→ code)_). Any PR that changes a contract or default updates this file.
>
> **Built vs planned:** sections describe the target design. Parts not built yet are marked **[planned: TASK-NN]**. Everything else matches the code at the time of writing.

## 1. Design Principles
1. **The orchestrator is deterministic code.** An LLM is called only for the planner, worker, validator and phase-validator roles, never for scheduling, retries, git or merges ([0001](decisions/0001-deterministic-orchestrator.md)).
2. **SQLite owned by the daemon is the single source of truth** for runs, tasks, events, decisions, questions, projects and phases. Agents are disposable; nothing important lives only in an agent's context ([0002](decisions/0002-sqlite-single-source-of-truth.md)).
3. **Fresh context per role invocation, with a bounded hand-off brief** instead of shared memory ([0003](decisions/0003-fresh-context-and-handoff-brief.md)).
4. **Maker/checker:** a deterministic gate, then an independent validator that sees claims and diff, never reasoning ([0004](decisions/0004-independent-validation.md)).
5. **Every autonomous choice is a decision record; everything needing a human is an inbox item plus a push notification** ([0005](decisions/0005-decisions-and-inbox.md)).
6. **Decide in pure functions, act in the shell.** Readiness, task transitions, PR-poll actions, ownership overlap and phase completion are pure functions in `src/core/`, tested by fixture tables. `orchestrator.ts` gathers facts, calls them, and performs side effects ([0020](decisions/0020-pure-core-and-fixtures.md)).
7. **Vendor code lives only in adapters** ([0007](decisions/0007-agent-adapters.md)).
8. **Near-zero dependencies, no build step for the UI** ([0009](decisions/0009-locked-stack.md)).
9. **Never write state into task branches.** Ticks and orch state go to the base branch or the DB only.

## 2. Components & Data Flow
```
 Browser (dashboard/index.html, vanilla JS)          Terminal (orch CLI)          Agent inside a task (orch decide/ask)
        │  REST + SSE  (cookie or Bearer token)              │ REST (Bearer)                 │ REST (Bearer via ORCH_TOKEN)
        └────────────────────────────┬──────────────────────┴───────────────────────────────┘
                                     ▼
                       src/server.ts  (router, auth gate, SSE fan-out)
                                     │
                       src/orchestrator.ts  (one daemon, many projects)
         ┌───────────────┬───────────┼────────────────┬───────────────────┬────────────────┐
         ▼               ▼           ▼                ▼                   ▼                ▼
   src/core/*       src/projects  src/config      src/adapters/*      src/git.ts       src/notify.ts
   (pure decisions) (registry)    (server+project) (agent CLIs)        (git, gh)        (ntfy)
                                     │                │                   │
                                     ▼                ▼                   ▼
                              SQLite (ORCH_HOME/orch.db)   child processes: claude/gemini, sh (gate, setup, app), git, gh
                                                                          │
                                                       per task: <ORCH_HOME>/worktrees/<project>/<run>-<task>  (branch orch/<key>-<slug>)
```
State lives in SQLite (all projects), project repos (code, `tasks.md` ticks, project settings file), worktrees (in-flight work), and `ORCH_HOME/archive` (archived event logs).

## 3. Module Layout
```
src/
  cli.ts            orch entry: owner commands + agent-facing decide/ask; talks HTTP to the daemon
  server.ts         node:http router, auth gate, SSE, serves dashboard/index.html
  orchestrator.ts   side-effecting coordinator: tick, runTask, validate, finalize, PR poll, human actions
  core/             PURE (no fs, no child_process, no Date.now: time is passed in)
    readiness.ts    selectReady(): which tasks start now                      [planned: TASK-03]
    transitions.ts  nextTaskState(): task status after an event               [planned: TASK-03]
    prpoll.ts       decidePrAction(): what to do with a PR observation        [planned: TASK-03]
    ownership.ts    ownedOverlap(): do two owned-file lists overlap           [planned: TASK-14]
    phases.ts       phasesToValidate(), fixup planning                        [planned: TASK-15]
    graph.ts        cycle detection over depends_on                           [planned: TASK-13]
  prfeedback.ts     PURE: gh JSON → checks/feedback; worker feedback text (built, R1)
  speckit.ts        tasks.md parser (pure) + spec dir reader + tick writer
  config.ts         server config + project config loading/validation/merging      [split: TASK-05]
  paths.ts          ORCH_HOME layout                                                  [planned: TASK-05]
  projects.ts       project registry (add/list/archive/resolve by cwd)                [planned: TASK-07]
  db.ts             better-sqlite3 store, schema + versioned migrations
  git.ts            Git class: worktrees, commits, diffs, merge, gh pr/run/api helpers
  auth.ts           token check, login cookie, bind guard                             [planned: TASK-08]
  appserver.ts      UI-mode app lifecycle: port, start, readiness, stop, pidfiles     [planned: TASK-16]
  archive.ts        event retention: export JSONL.gz, delete                          [planned: TASK-12]
  costs.ts          cost/time rollups                                                 [planned: TASK-17]
  notify.ts         ntfy POST
  prompts.ts        prompt loading (repo override) + {{var}} rendering + clip
  types.ts          shared types
  adapters/         types.ts, runner.ts (spawn, stream, extractJson), claude.ts, gemini.ts, index.ts
prompts/            planner.md, worker.md, validator.md, validator-ui.md [TASK-16], phase-validator.md [TASK-15]
dashboard/          index.html (single file, no build)
test/
  unit/             node:test files, run against dist/                                [TASK-02]
  fixtures/         spec-first fixture tables (see §21.2)                             [TASK-01]
scripts/            e2e*.mjs scenarios, fake-agent.mjs, fake-gh.mjs, fake-app.mjs [TASK-16], lib/ helpers [TASK-02]
```

## 4. Concurrency / Runtime Model
| Thread / process / context | Owns | Communicates via |
| :--- | :--- | :--- |
| Daemon (one Node process) | DB handle, scheduler timer, in-memory proc map, poll bookkeeping, per-project merge locks | HTTP/SSE to clients; child processes |
| Scheduler tick (every `scheduler.tickSeconds`, plus nudges after state changes; re-entrancy guarded by a `ticking` flag) | Starting tasks, resuming answered tasks, PR polls, phase checks, run completion | Calls `core/*`, then `runTask()` etc. (not awaited) |
| Agent child process (claude/gemini) | One role invocation in one worktree | stdin prompt, stdout stream-json lines, exit code; `orch decide/ask` via HTTP |
| Shell children (gate, setup, git, gh, app under test) | Short-lived commands in a worktree or repo | exit code + captured output |
| Per-project merge lock (promise chain) | Serializes operations on that project's main checkout (local merges, ticks) | — |
| PR poll (per task, at most one in flight, at most every `pollSeconds`) | One `gh` observation + resulting action | — |

Single-threaded JS: DB writes are synchronous (better-sqlite3), so no row-level races. Re-read the task after every `await` before acting (status may have changed).

## 5. Projects & Configuration
**[planned: TASK-05, TASK-07, TASK-09]** Today one daemon serves one repo configured by `orch.config.json`.

### 5.1 ORCH_HOME layout
```
$ORCH_HOME (default ~/.orch)
  server.json                 server settings (§19)
  orch.db                     SQLite, all projects
  worktrees/<project-id>/     task worktrees: <runId>-<taskkey>, phase worktrees: <runId>-phase-<n>
  archive/<project-id>/       <runId>-events.jsonl.gz
  run/                        pidfiles for UI-mode apps: app-<taskId>.pid
```

### 5.2 Project settings file
`<repo>/orch.config.json`. Allowed keys (all optional; defaults in §19): `name`, `baseBranch`, `scheduler.{maxParallel,maxAttempts,resumeOnRetry}`, `validation.{command,agent,phase.{enabled,command,maxFixups},ui.{startCommand,url,readyTimeoutSeconds,env}}`, `git.{pr,mergePolicy,squash,copyFiles,setupCommand,tickTasksMd,feedback.*}`, `handoff.*`, `roles.{planner,worker,validator,phaseValidator}.{adapter,model}`.

**Rejected keys (error naming the key, project unusable until fixed):** `agents` (adapters/commands/env), `host`, `port`, `publicUrl`, `auth`, `notify`, `dbPath`, `worktreeDir`, `git.ghCommand`, `repo`. Reason: a repo must not change how agent CLIs launch or which credentials they get ([0013](decisions/0013-project-config-in-repo.md)). `roles.*.adapter` must name an adapter defined in `server.json`. Unknown keys → warning in the activity stream, ignored.

**Precedence:** project file > `server.json` project defaults (`defaults.*`, same shape) > built-in defaults. The effective config is rebuilt when a run is created or started (REQ-PROJ-06), never mid-run.

### 5.3 Registry
`projects` table (§20). `id` = slug of the repo directory name, `-2`, `-3`… on collision. `repo_path` unique (realpath). Adding: realpath → must contain `.git` (`git rev-parse --show-toplevel` equals path) → if archived row with same path exists, un-archive it → else insert → write starter `orch.config.json` if missing (keys: `baseBranch` detected from `git symbolic-ref refs/remotes/origin/HEAD` else current branch, `validation.command: ""`). Archive refuses if the project has an unfinished run. Missing repo on disk → project `error` field set at load; views show it; plan/start refused.

### 5.4 CLI project resolution
`--project <id>` > `ORCH_PROJECT` env > the registered project whose `repo_path` contains `cwd` (deepest match) > the only non-archived project > error exit 2 listing projects.

### 5.5 Legacy upgrade
`[ASSUMED]` Applies to single-repo installs.
On `orch serve`, if `$ORCH_HOME/server.json` does not exist and a legacy config is found (`ORCH_CONFIG`, or upward search from cwd for an `orch.config.json` containing `repo` or `agents`):
1. Write `server.json` from its server-level keys (host, port, publicUrl, notify, agents, `scheduler.tickSeconds`, `git.ghCommand`), with `scheduler.maxAgents` = its `maxParallel`.
2. Back up the legacy file to `orch.config.json.bak`, rewrite it with only project-level keys.
3. If the legacy `dbPath` exists and `$ORCH_HOME/orch.db` does not, copy it there, run migrations, register the repo as a project, and set `project_id` on all runs.
4. Record an orchestrator decision "Upgraded single-repo install to project <id>".

## 6. Spec Intake & Planner
### 6.1 Tasks file parser
_(→ code: `src/speckit.ts`)_
- Phase header: `^##+\s+(.+)$` (any `##`/`###` heading starts a new phase).
- Task line: `^\s*[-*]\s*\[([ xX])\]\s*(T\d{2,4})\b\s*(\[P\])?\s*(.*)$`. Title = text clipped to 110 chars; description = full text.
- Dependencies: union of (all tasks in earlier phases) + (previous task in phase if not `[P]`) + explicit `(depends on|after|requires) T001[, T002| and T003]` (case-insensitive). Unknown keys and self-edges dropped. No transitive reduction.
- Fixture coverage: §21.2 `tasks-md/`.

### 6.2 Planner
Prompt `prompts/planner.md` receives title, spec files (except tasks.md, clipped to 2×`handoff.specChars`), and the parsed tasks as JSON. Contract (§13.2). Applied fields: `acceptance`, `depends_on` (filtered to known keys, no self), `merge_policy`, `validate_cmd`, `validate_mode` [TASK-16], `files_owned` [TASK-14]. Planner decisions → decisions (actor planner). Plan questions → `questions` with `task_id NULL` [TASK-13] (today: attached to first pending task, prefixed `[plan]`). Planner failure → fallback decision, tasks as imported.

### 6.3 Approval gates
`approvePlan` requires `plan_pending` and **no dependency cycle** (`core/graph.ts`, [planned: TASK-13]); a cycle is reported naming its keys. Dry run [TASK-13]: parse + derive deps, return tasks, write nothing.

## 7. Scheduler
### 7.1 Readiness
`selectReady(input) → ReadinessResult`
_(→ code: `src/core/readiness.ts`, [planned: TASK-03, extended TASK-09/12/13])_
Input:
```ts
interface ReadinessInput {
  maxAgents: number;                 // global cap (server)
  busyAgents: number;                // agents not tied to a task row: planners, phase validators
  projects: { id: string; runId: string | null; runStatus: string | null; maxParallel: number;
              lastStartAt: string | null; planQuestionsOpen: number; resumeOnRetry: boolean }[];
  tasks: { id: string; projectId: string; runId: string; key: string; orderIdx: number; status: TaskStatus;
           dependsOn: string[]; filesOwned: string[]; openQuestions: number;
           attempt: number; fixRounds: number; hasSession: boolean; adapterSupportsResume: boolean }[];
}
interface ReadinessResult {
  start: { taskId: string; resume: boolean }[];
  heldForOverlap: { taskId: string; blockedByTaskId: string }[];   // for decisions (logged once per pair per run)
}
```
Algorithm:
1. `active` = tasks with status `running|validating`. `free = maxAgents − active − busyAgents`.
2. Candidates per project (only projects with `runStatus === "running"` and `planQuestionsOpen === 0`): `pending`, every `dependsOn` key is `done|skipped` in the same run, `openQuestions === 0`; sorted by `orderIdx`.
3. Projects ordered by `lastStartAt` ascending (null first), then `id` — fairness (REQ-PROJ-09).
4. Round-robin: repeatedly walk the ordered projects; for each, take its first candidate if project active+chosen < `maxParallel`, `free > 0`, and its `filesOwned` does not overlap (§7.2) any active or already-chosen task **of the same project** — else record `heldForOverlap` against the first overlapping task and try the project's next candidate. Stop when a full pass chooses nothing.
5. `resume = resumeOnRetry && hasSession && adapterSupportsResume && (attempt > 0 || fixRounds > 0)`.

### 7.2 Ownership overlap
_(→ code: `src/core/ownership.ts`, [planned: TASK-14])_
`ownedOverlap(a, b)`: false if either list is empty (unknown ownership = unconstrained, preserves today's behaviour). Otherwise, for each pattern compute its **static prefix**: path segments (split on `/`, normalized, no leading `./`) up to but excluding the first segment containing any of `* ? [ {`; a pattern without wildcards is its own prefix. Two patterns overlap if one prefix's segments are a prefix of the other's (equal included; empty prefix overlaps everything). Conservative by design: may serialize tasks that would not actually collide, never runs colliding ones together ([0017](decisions/0017-file-ownership.md)).

### 7.3 Tick
Per tick: (1) resume `needs_input` tasks with no open questions; (2) PR polls (§12); (3) phase checks (§10.3); (4) `selectReady` → start tasks (not awaited), log held-for-overlap decisions; (5) per running run: if all tasks `done|skipped` (and phases validated or phase validation disabled) → run `done` + notify; else if nothing can progress without the owner → one "waiting on you" activity event (deduped by last event).

### 7.4 Run control
- One unfinished run per project: `plan()` and `start()` refuse when another run of the project is in `planning|plan_pending|ready|running|paused` [planned: TASK-09].
- `pause`: status `paused`; tick skips the run's starts; running agents finish.
- `stop`: SIGTERM agent children of that run, active tasks → `pending`, run `stopped`. A stopped run may be started again if no other unfinished run exists.
- `recover()` on daemon start: active tasks → `pending` (worktree kept, activity event), `planning` runs → `plan_pending`, kill leftover UI-mode apps from `run/*.pid` [TASK-16].

## 8. Task State Machine
_(→ code: `src/core/transitions.ts`, [planned: TASK-03])_
States: `pending, running, validating, needs_input, pr_checks, pr_open, failed, done, skipped`. Active = `running|validating`. Watched (PR polled) = `pr_checks|pr_open`.

`nextTaskState(task, event, cfg) → { status, patch, decision?, notify?, effect? }` where `effect` names the side effect the shell must perform (`merge_local | push_and_pr | merge_pr | kill_agent | remove_worktree | none`).

| # | From | Event | Guard | To | Patch / decision / notify |
| :--- | :--- | :--- | :--- | :--- | :--- |
| T1 | pending | `start` | selected by §7.1 | running | `attempt+1`; branch/worktree assigned if null |
| T2 | running | `worker_blocked` (open question or status `blocked`) | — | needs_input | notify "needs your input" |
| T3 | running/validating | `attempt_failed{feedback}` (worker failed, crash, timeout, setup fail, no commits, gate fail, validator FAIL) | `attempt < max_attempts` | pending | `last_feedback`; decision "Retrying <key> (attempt n+1/max)" |
| T4 | running/validating | `attempt_failed{feedback}` | `attempt >= max_attempts` | failed | `last_feedback`; notify "<key> failed" |
| T5 | running | `worker_done` | — | validating | (auto-commit leftovers first) |
| T6 | validating | `validated` | local mode, policy auto | done | effect `merge_local` then `remove_worktree` (merge error → T9) |
| T7 | validating | `validated` | policy manual (any mode) | pr_open | PR mode: effect `push_and_pr` first; notify "ready for review" |
| T8 | validating | `validated` | PR mode, policy auto | pr_checks (if `feedback.enabled && waitForChecks`) else done | effect `push_and_pr` (+ `merge_pr` when not waiting) |
| T8a | validating | `validated` | PR mode, `fix_rounds > 0`, pushed sha == `pr_head` | pr_open | feedback "Fix round n produced no new commits"; notify |
| T9 | validating/pr_checks | `merge_failed{error}` | — | pr_open | `last_feedback: "Merge step failed: …"`; attempt unchanged; notify |
| T10 | needs_input | `answered` | no open questions, run running | running | `attempt` unchanged net (decrement then T1 increments); resume session |
| T11 | needs_input | `answered` | run not running | pending | — |
| T12 | any non-active | `human_retry` | — | pending | `attempt 0, fix_rounds 0, ci_head null, ci_status null`; decision (human) |
| T13 | any non-active | `human_skip` | — | skipped | effect `remove_worktree`; decision (human) |
| T14 | active | `human_stop` / `run_stop` / `daemon_restart` | — | pending | effect `kill_agent` (not on restart) |
| T15 | pr_open/pr_checks | `human_merge` | — | done | effect `merge_pr`/`merge_local`; on error stay, surface error |
| T16 | any | `human_mark_merged` | — | done | effect `remove_worktree` |
| T17 | pr_open/pr_checks | `human_request_changes{feedback}` | — | pending | fix round kind `human` (§12.3); allowed even if `fix_rounds >= maxRounds` [TASK-06] |
| T18 | pr_checks/pr_open | PR action (§12.2) | — | per action | — |
| T19 | validating | `validator_blocked` (UI mode, no browser) | — | failed | no retry; notify [TASK-16] |

Fix-up tasks [TASK-15] use the same machine.

## 9. Worker & Hand-off Brief
- Worktree: `git worktree add -b orch/<key>-<slug> <dir> <baseRef>`; `baseRef` = `origin/<base>` after `fetch --prune` when a remote exists, else `<base>`. Reuse existing branch. Copy `git.copyFiles`, run `git.setupCommand` (15 min timeout).
- Prompt `prompts/worker.md` vars: task key/title/description, acceptance bullets, spec excerpt (`handoff.contextFiles`, clipped to `handoff.specChars`), hand-off, branch/base, validate hint, feedback section. Owned files listed when present [TASK-14].
- Hand-off (clipped to `handoff.historyChars`): completed tasks with lower `order_idx` (direct deps: full summary; others: 200 chars; up to 8 files), last 25 decisions, all answered Q/A.
- Resume prompt: answers (if any) + `last_feedback` + "continue, commit, same JSON block".
- Agent env: `ORCH_URL`, `ORCH_TASK_ID`, `ORCH_RUN_ID`, `ORCH_ACTOR`, `ORCH_TOKEN` [TASK-08], `PATH` prefixed with `<pkg>/bin`.

## 10. Validation
### 10.1 Gate
`validate_cmd || validation.command` via `sh -c` in the worktree, 20 min timeout; output clipped 3000 to the log, 4000 to feedback. Precondition: `commitsAhead > 0`. Gate output (clipped 4000) is passed to the validator as `{{gate_output}}` [planned: TASK-16].

### 10.2 Validator
Fresh session, prompt `prompts/validator.md`: task, criteria, worker summary (claims), `diffFromBase` (stat + diff, 60k chars), gate hint/output. Verdict contract §13.2. Non-PASS → T3/T4 with reasons + UNMET criteria. Out-of-scope edits (files in diff not matched by `files_owned` via `path.matchesGlob`) are listed by orch in the prompt and reported in `findings`, never a FAIL by themselves [TASK-14].

### 10.3 Phase validation
_(→ code: `src/core/phases.ts`, [planned: TASK-15])_
- `phases` table row per (run, phase name): `pending → validating → passed | failed | needs_human`, `fixup_rounds`.
- `phasesToValidate(tasks, phases)`: a phase is due when it has ≥1 task, all its tasks (incl. fix-ups) are `done|skipped`, at least one is `done`, and its row is `pending`. Disabled when `validation.phase.enabled` is false (phase rows go straight to `passed`).
- Run: counts as one busy agent. Create detached worktree at `baseRef` (`<run>-phase-<n>`), run setup, then `validation.phase.command || validation.command`, then phase validator (role `phaseValidator`, default = validator role) with prompt `prompts/phase-validator.md` (phase tasks + summaries + spec excerpt + gate output). Remove worktree after.
- PASS → `passed`, decision. FAIL with `fixup_rounds < validation.phase.maxFixups` → create task key `FIX-<phaseIdx>.<round>` (`synthetic=1`, phase = same, policy auto, description = failure + reasons, acceptance = unmet criteria + "phase validation passes"), add its key to `depends_on` of every task in later phases, phase row → `pending` with `fixup_rounds+1`, decision. Otherwise → `needs_human` inbox item (actions: re-run phase validation, accept phase). Synthetic tasks are never ticked in `tasks.md`.
- Later phases' tasks also wait while their earlier phase is `validating|needs_human` (readiness treats a phase not `passed` as an unmet dependency for later phases).

### 10.4 UI validation mode
_(→ code: `src/appserver.ts`, [planned: TASK-16])_
- `tasks.validate_mode`: `standard | ui` (planner proposes; owner edits).
- After the gate: pick a free port (listen on 0, close), spawn `sh -c <validation.ui.startCommand>` **detached** in the worktree with `PORT=<port>` + `validation.ui.env`; write `run/app-<taskId>.pid`. URL = `validation.ui.url` with `{port}` substituted (default `http://127.0.0.1:{port}/`). Poll every 1 s with `fetch` until a response with status < 500 or `readyTimeoutSeconds` → failure = T3/T4 with the app's last 3000 chars of output.
- Validator prompt `prompts/validator-ui.md` adds `{{app_url}}` and instructions to exercise the criteria in a browser with whatever browser tool the CLI provides. Verdict `BLOCKED` (no browser tool) → T19.
- Stop: SIGTERM the process group (`process.kill(-pid)`), SIGKILL after 5 s; delete pidfile. Always in `finally`, on `stopTask`/`stop`, and in `recover()` for leftover pidfiles.

## 11. Git & Merge
_(→ code: `src/git.ts`)_
- **Local mode:** under the project merge lock: main checkout must be on `baseBranch` and clean (`status --porcelain --untracked-files=no`); `rebase <base>` in the worktree (abort on failure); `merge --squash` + commit (or `--ff-only`). Done → remove worktree + delete branch.
- **PR mode:** `push -u --force-with-lease origin <branch>`; reuse an **open** PR for the branch (`gh pr view <branch> --json url,state`), else `gh pr create`; merge with `gh pr merge <branch> --squash|--merge --delete-branch`. Done → remove worktree, keep local branch deletion to gh.
- **Tick:** after merge, under the merge lock, flip `- [ ] KEY` → `- [x] KEY` in `<spec_dir>/tasks.md` if inside the repo; commit it on base in local mode; leave uncommitted in PR mode.
- **Diff for review** [planned: TASK-06]: `diffFiles(worktree)` → `git diff --numstat` + `--name-status` + per-file `git diff <base>...HEAD -- <file>`; binary files (`-\t-` in numstat) have no patch; total patch text capped at 200k chars (`truncated: true`). When the worktree is gone (done tasks), the diff is unavailable (404 with reason).

## 12. PR Feedback Loop
_(→ code: `src/orchestrator.ts` pollPr/startFixRound/toInbox, `src/prfeedback.ts`; decision logic moves to `src/core/prpoll.ts` in TASK-03)_
### 12.1 Observation
`Git.prStatus(cwd, prUrl)`: `gh pr view <url> --json number,url,state,headRefOid,reviewDecision,reviews,comments,statusCheckRollup` + `gh api repos/{owner}/{repo}/pulls/<n>/comments?per_page=100` (best effort). Normalized to `PrStatus` (checks pass/fail/pending; feedback items review/comment/inline with author, body, ts, state, path, line, isBot).

### 12.2 PR action decision
`decidePrAction` (order matters):
1. `state MERGED` → `mark_done` (decision "PR was merged on GitHub").
2. `state CLOSED` → `mark_failed` ("PR was closed without merging", notify).
3. Fresh feedback = items with `ts > pr_feedback_at`, not bot/ignored, with body or CHANGES_REQUESTED. If any is a trigger (CHANGES_REQUESTED review, or a line `^\s*<trigger>(\s|$)`) → `fix_round{kind: review, items: all fresh, watermark: max ts}`.
4. Checks summary only if `pr.headSha == local branch sha` (else `pending`); `none` within `noChecksGraceSeconds` of `pr_pushed_at` → `pending`. Patch `ci_status`.
5. `pending` → `wait`; if status `pr_checks` and pending for longer than `checksTimeoutMinutes` since push → `inbox`.
6. `fail`: if `ci_head == headSha` → (`pr_checks` → `inbox` "still failing") else `wait`; else patch `ci_head = headSha` and → `fix_round{kind: ci, failed checks}` if `fix_rounds < maxRounds`, else `inbox`.
7. `pass|none`: status `pr_open` → `wait`. Status `pr_checks`: `reviewDecision == CHANGES_REQUESTED` → `inbox`; else → `merge` (decision "Merging <key>: PR checks passed").

### 12.3 Fix round
`startFixRound(kind)`: round = `fix_rounds + 1`; over `maxRounds` (kinds ci/review) → inbox. Sync worktree from `origin/<branch>`: same/ahead → continue; remote ahead → `merge --ff-only`; diverged → inbox. Decision "Sending <CI failure|review feedback|owner feedback> on <key>'s PR back to the worker (round n/max)". Patch: `pending, attempt 0, fix_rounds = round, last_feedback = formatted feedback, ci_status null`. Then the normal path (resume, gate, validator, finalize). Kind `human` (T17) uses the owner's text formatted as "## Feedback from the owner" and ignores the round cap. In local mode (no PR) the sync step is skipped.

### 12.4 Feedback text
CI: failed check names + conclusions + URLs + log tails (GitHub Actions jobs via `gh run view --job <id> --log-failed`, first 3 jobs, total `logChars`, tail kept). Review: one bullet per item with author, verb, `path:line` for inline, body indented. Both end with "do not push; orch updates the PR".

## 13. Agent Adapters & Contracts
### 13.1 Adapter interface
_(→ code: `src/adapters/types.ts`)_
`launch(config, {prompt, model, resumeSessionId}) → {command, args, stdin}`; `parseLine(json, state) → NormalizedEvent[]`; `finish(state, exitCode)`; `supportsResume`. Normalized kinds: `text | tool | agent | error | info`. Orchestrator-added kinds: `state | git | decision | question | verdict`. Claude: `claude -p --output-format stream-json --verbose [--model] [--resume]`, prompt on stdin, default `--permission-mode bypassPermissions`. Gemini: `gemini -p <trailer> --output-format stream-json --yolo --skip-trust [-m] [--resume]`, prompt on stdin. Runner: timeout → SIGTERM then SIGKILL after 5 s; non-zero exit → error event.

### 13.2 JSON contracts
_(→ code: `prompts/*.md`)_
All roles end with one fenced ```json block; `extractJson` takes the last parseable fenced block, else the last parseable trailing `{…}`.
- Planner: `{tasks:[{key, acceptance[], depends_on[], merge_policy, validate_cmd, validate_mode?, files_owned?}], decisions:[{text, rationale}], questions:[{text, options[]}]}`
- Worker: `{status: done|blocked|failed, summary, files[], decisions[], follow_ups[], reason?}`
- Validator: `{verdict: PASS|FAIL|BLOCKED, criteria:[{criterion, met, evidence}], reasons[], suggestions[], findings?[]}` (`BLOCKED` only in UI mode)
- Phase validator [TASK-15]: `{verdict: PASS|FAIL, reasons[], unmet[], suggestions[]}`

### 13.3 Agent-facing CLI
`orch decide "<text>" --why "<r>"` → `POST /api/decide`; `orch ask "<q>" --options "A,B"` → `POST /api/ask` (requires `ORCH_TASK_ID`), prints "STOP working now…".

## 14. Inbox, Decisions & Notifications
- Inbox is **derived** on read, never stored: per project/run: `approve_plan` (run `plan_pending`), `question` (unanswered; `task_id` null = plan question), `failed` tasks, `merge` (`pr_open` tasks, with `pr_url`, `feedback`, `ci_status`, `fix_rounds`), `phase` (`needs_human` phase rows) [TASK-15]. Global inbox = union over non-archived projects' current runs, each item with `project_id`, `project_name` [TASK-10].
- Decisions: append-only rows (actor ∈ planner|worker|validator|phase_validator|orchestrator|human).
- Notifications (`src/notify.ts`): ntfy POST with Title, Priority, Click (task PR url or `publicUrl`), Tags. Title prefix `[<project name>] ` [TASK-09]. Failures logged to stderr, never thrown.

## 15. Interface Contracts
_(→ code: `src/server.ts`, `src/cli.ts`)_
### 15.1 HTTP API
All JSON. Errors: `{error: string}` with 400 (bad request / invalid state), 401 (auth), 404 (not found). Auth per §16.

| Method & path | Body / query | Returns | Status |
| :--- | :--- | :--- | :--- |
| GET `/api/health` | — | `{ok, version, uptimeSec}` (no auth) | TASK-08 |
| POST `/api/login` | `{token}` | sets cookie, `{ok}` (no auth) | TASK-08 |
| GET `/api/projects` | `?archived=1` | `[{id, name, repo, archived, error, run:{id,status}\|null, inboxCount}]` | TASK-10 |
| POST `/api/projects` | `{path, name?}` | project (+ `configCreated` path) | TASK-10 |
| DELETE `/api/projects/:id` | — | `{ok}` (archive) | TASK-10 |
| GET `/api/projects/:id/state` | `?run=<id>` | snapshot `{project, run, tasks, decisions, questions, inbox, runs, config, costs}` | TASK-10 |
| GET `/api/inbox` | — | global inbox items | TASK-10 |
| POST `/api/projects/:id/plan` | `{specDir, llm, dryRun?}` | run, or `{tasks}` for dry run | TASK-10/12 |
| GET `/api/state`, GET `/api/runs/:id` | `?project=` | legacy snapshot (default project) | built |
| POST `/api/runs/:id/{approve,start,pause,stop}` | — | `{ok}` | built |
| POST `/api/tasks/:id/{retry,skip,stop,merge,mark-merged,edit}` | edit: patch | `{ok}` | built |
| POST `/api/tasks/:id/request-changes` | `{feedback}` | `{ok}` | TASK-06 |
| GET `/api/tasks/:id/diff` | — | `{base, head, files:[{path, status, additions, deletions, binary, patch}], truncated}` | TASK-06 |
| GET `/api/tasks/:id/events`, `/api/runs/:id/events` | `?after&limit` | events | built |
| POST `/api/questions/:id/answer` | `{answer}` | `{ok}` | built |
| POST `/api/ask`, `/api/decide` | agent payloads | question / decision | built |
| POST `/api/phases/:id/{revalidate,accept}` | — | `{ok}` | TASK-15 |
| GET `/api/events/stream` | — | SSE: `event` (event rows), `change` (`{what, projectId?, runId?, …}`); `: ping` every 25 s | built |

### 15.2 CLI
`orch serve | project add <path> [--name n] | project list | project remove <id> | plan <specDir> [--no-llm] [--dry-run] | approve [runId] | run | pause | stop | status | answer <qid> <text> | retry|skip|merge|stop-task <key> | archive-events | decide | ask`. Global `--project <id>` (§5.4). Exit codes: 0 ok, 1 error (`error: <msg>` on stderr), 2 usage. Token from `ORCH_TOKEN` or `$ORCH_HOME/server.json` when readable. Base URL from `ORCH_URL` or server config host/port.

### 15.3 Dashboard
Single `dashboard/index.html`. Regions: top bar (project switcher with status dot + inbox count, Add project, run selector, run controls, cost tile), Inbox (global, project tag), Board (lanes: Pending, Running, Validating, Needs input, Waiting on CI, Review / merge, Failed, Done), Plan (phases, criteria, deps incl. implicit overlap edges, policy, mode, owned files; edit dialog), Decisions, Activity, Task drawer (meta, criteria, summary, feedback, actions incl. Send back, Diff section lazy-loaded, live log). SSE reconnect: on error close, retry with backoff 1 s doubling to 30 s, on open do a full refresh [TASK-11]. On any 401 show a token prompt that POSTs `/api/login` [TASK-08].

## 16. Authentication
_(→ code: `src/auth.ts`, [planned: TASK-08])_
- Token: `ORCH_TOKEN` env > `server.json` `auth.token`. Empty = auth off.
- Accepted credentials: `Authorization: Bearer <token>` or cookie `orch_token=<token>` (set by `/api/login`: `HttpOnly; SameSite=Strict; Path=/`). Compare SHA-256 digests with `crypto.timingSafeEqual`.
- Unauthenticated routes: `GET /` (dashboard shell), `GET /api/health`, `POST /api/login`. Everything else, including SSE, needs auth when a token is set.
- Bind guard at startup: host not in `127.0.0.1 | ::1 | localhost` and no token and not `auth.allowInsecure` → exit 1 with a message naming both options.
- Secret hygiene: the token, ntfy token and adapter env values are never logged, stored in events, or rendered into prompts; `publicConfig()` exposes only booleans for them.

## 17. Retention & Archive
_(→ code: `src/archive.ts`, [planned: TASK-12])_
- On startup and every 24 h (and `orch archive-events`): runs with status `done|stopped|failed`, `archived_at IS NULL`, `updated_at` older than `retention.eventDays` (0 = never).
- Per run: stream events `ORDER BY id` as JSON lines through `zlib.createGzip()` to `archive/<project>/<runId>-events.jsonl.gz.tmp`, fsync, rename to final name, then in one transaction delete the run's events and set `runs.archived_at`. Any failure before the rename → nothing deleted, error event logged.
- Task log views for archived runs show "Log archived to <path>". Decisions, questions, task rows (summaries, feedback, costs) are untouched.

## 18. Cost & Time Rollup
_(→ code: `src/costs.ts`, [planned: TASK-17])_
- When `runAgent` resolves, add `res.costUsd` (if not null) to the owning row's `cost_usd` (NULL + x = x) and `res.durationMs` to `agent_ms`: tasks for worker/validator/UI validator; runs for planner and phase validator.
- Rollups: run = run row + Σ its tasks; project = Σ runs. Cost NULL everywhere → "n/a". Persisted on rows so archiving events never changes totals.

## 19. Settings & Environment
| Key / Env Var | Where | Type | Default | Used by (section) |
| :--- | :--- | :--- | :--- | :--- |
| `ORCH_HOME` | env | path | `~/.orch` | §5.1 |
| `ORCH_TOKEN` | env | string | — | §16, §15.2 |
| `ORCH_URL` | env (CLI, agents) | url | from server.json | §15.2 |
| `ORCH_PROJECT` | env (CLI) | id | — | §5.4 |
| `ORCH_TASK_ID`, `ORCH_RUN_ID`, `ORCH_ACTOR` | env (agents) | string | set by orch | §9, §13.3 |
| `ORCH_CONFIG` | env | path | — | legacy only §5.5 |
| `host` / `port` / `publicUrl` | server | string/int/url | `127.0.0.1` / `4800` / `http://localhost:4800` | §16, §14 |
| `auth.token` / `auth.allowInsecure` | server | string / bool | `""` / `false` | §16 |
| `notify.ntfyUrl` / `notify.ntfyToken` | server | url / string | `""` | §14 |
| `agents.timeoutMinutes` | server | int | 90 | §13.1 |
| `agents.adapters.<name>` | server | `{type, command, extraArgs, env}` | claude, gemini | §13.1 |
| `agents.roles.<role>` | server (defaults) | `{adapter, model}` | all `claude` | §6.2, §9, §10 |
| `scheduler.maxAgents` | server | int | 2 | §7.1 |
| `scheduler.tickSeconds` | server | int | 5 | §7.3 |
| `retention.eventDays` | server | int | 30 | §17 |
| `git.ghCommand` | server | string | `gh` | §11, §12 |
| `defaults.*` | server | project-key shape | — | §5.2 |
| `name` | project | string | repo dir name | §5.3 |
| `baseBranch` | project | string | `main` | §9, §11 |
| `scheduler.maxParallel` | project | int | 1 | §7.1 |
| `scheduler.maxAttempts` | project | int | 2 | §8 |
| `scheduler.resumeOnRetry` | project | bool | true | §7.1 |
| `validation.command` | project | string | `""` | §10.1 |
| `validation.agent` | project | bool | true | §10.2 |
| `validation.phase.enabled` / `.command` / `.maxFixups` | project | bool / string / int | true / `""` / 2 | §10.3 `[ASSUMED]` enabled by default |
| `validation.ui.startCommand` / `.url` / `.readyTimeoutSeconds` / `.env` | project | string / string / int / map | `""` / `http://127.0.0.1:{port}/` / 120 / {} | §10.4 |
| `git.pr` / `git.mergePolicy` / `git.squash` | project | bool / enum / bool | true / auto / true | §11 |
| `git.copyFiles` / `git.setupCommand` / `git.tickTasksMd` | project | list / string / bool | [] / `""` / true | §9, §11 |
| `git.feedback.enabled` / `waitForChecks` / `pollSeconds` / `maxRounds` / `checksTimeoutMinutes` / `noChecksGraceSeconds` / `trigger` / `ignoreAuthors` / `logChars` | project | — | true / true / 60 / 3 / 60 / 90 / `/orch` / [] / 6000 | §12 |
| `handoff.specChars` / `historyChars` / `contextFiles` | project | int / int / list | 12000 / 6000 / `[plan.md, spec.md]` | §9 |
| `roles.<role>` | project | `{adapter, model}` | server roles | §5.2 |

## 20. Data Model & Persistence
_(→ code: `src/db.ts`)_
### Entities
| Entity | Field | Type | Constraints / Notes |
| :--- | :--- | :--- | :--- |
| projects [TASK-07] | id, name, repo_path, archived, last_start_at, created_at, updated_at | TEXT/INT | `repo_path` UNIQUE |
| runs | id, project_id [TASK-07], spec_dir, title, status, base_branch, cost_usd [TASK-17], agent_ms [TASK-17], archived_at [TASK-12], created_at, updated_at, notes | | status ∈ §7.4 run states |
| tasks | id, run_id, key, title, description, acceptance JSON, depends_on JSON, parallel, phase, order_idx, status, attempt, max_attempts, merge_policy, validate_cmd, validate_mode [TASK-16], files_owned JSON [TASK-14], synthetic [TASK-15], worktree, branch, pr_url, session_id, summary, files JSON, last_feedback, fix_rounds, pr_head, pr_pushed_at, pr_feedback_at, ci_head, ci_status, cost_usd, agent_ms [TASK-17], created_at, updated_at | | UNIQUE(run_id, key) |
| events | id, run_id, task_id, ts, kind, data JSON | | append-only; deleted only by archive |
| decisions | id, run_id, task_id, ts, actor, text, rationale | | append-only |
| questions | id, run_id, task_id NULL-able [TASK-07], ts, text, options JSON, answer, answered_at | | NULL task = plan question |
| phases [TASK-07 schema, TASK-15 use] | id, run_id, name, idx, status, fixup_rounds, updated_at | | UNIQUE(run_id, name) |

### State ownership
| State | Where | Source of truth | Survives restart/update |
| :--- | :--- | :--- | :--- |
| Runs, tasks, decisions, questions, phases, projects | SQLite | DB | yes |
| Event logs | SQLite, then archive files | DB until archived, then file | yes |
| Project settings | `<repo>/orch.config.json` | file | yes (versioned) |
| Server settings | `$ORCH_HOME/server.json` | file | yes |
| In-flight work | worktrees | git | yes (kept on stop/crash) |
| Running agent processes, poll timers, merge locks | memory | daemon | no (recovered per §7.4) |
| UI-mode app processes | process + pidfile | pidfile | killed on recover |

### Migrations & versioning
`PRAGMA user_version` holds the schema version [TASK-07]. `Store` constructor runs ordered migrations `1..N` in a transaction each. Version 1 = today's schema plus the R1 columns (applied by the existing `TASK_MIGRATIONS` column check). Making `questions.task_id` nullable needs a table rebuild (create new, copy, drop, rename). Never edit a released migration; add a new one.

## 21. Errors, Logging & Testing
### 21.1 Errors & logging
- Every caught error in task flow → `error` event on the task + the transition's feedback. Daemon-level errors → stderr (journald/docker logs).
- PR poll errors logged once per distinct message per task.
- Tool inputs clipped to 400 chars per string field; tool outputs to 1500; never log secrets (§16).

### 21.2 Testing architecture
- **Unit** (`test/unit/*.test.mjs`, `node --test`, against `dist/`): pure modules, driven by fixtures.
- **Fixtures** (`test/fixtures/`, spec-first, owner-reviewed, [TASK-01]):
  - `tasks-md/<case>.md` + `<case>.expected.json`: `[{key, phase, parallel, done, depends_on}]` (depends_on sorted).
  - `extract-json.json`: `[{name, input, expected}]` (`expected: null` when nothing parses).
  - `readiness.json`: `[{name, input: ReadinessInput, expected: ReadinessResult}]` (order of `start` significant).
  - `transitions.json`: `[{name, task: {status, attempt, max_attempts, fix_rounds, merge_policy, …}, event, config, expected: {status, patch?, decisionPrefix?, notify?: bool, effect?}}]`, at least one case per row of §8.
  - `pr-poll.json`: `[{name, task, pr, localSha, now, config, expected: {action, kind?, reasonContains?, patch?}}]`, at least one case per step of §12.2.
  - `ownership.json` [TASK-14 extends], `phases.json` [TASK-15 extends].
- **E2E** (`scripts/e2e*.mjs`, Linux/macOS or `node:22` container): throwaway repos, real git, the daemon via `dist/cli.js serve`, fakes: `fake-agent.mjs` (Claude and Gemini dialects, scripted by task key/prompt markers), `fake-gh.mjs` (PR state files + local bare `origin`), `fake-app.mjs` [TASK-16] (HTTP server on `PORT`). Notifications captured with a local HTTP sink when asserted.
- **Manual**: first live Gemini run; first real GitHub repo with Actions; visual dashboard review (dark + light, phone width).

## 22. Design Assumptions
| ID | Statement | Impact if wrong | Resolved by (task) |
| :--- | :--- | :--- | :--- |
| DA1 | `path.matchesGlob` (Node ≥ 20.17/22.5) is available for out-of-scope detection. | Need a tiny glob matcher. | TASK-14 |
| DA2 | Static-prefix overlap is precise enough; over-serialization is acceptable. | Lost parallelism; refine to glob intersection. | TASK-14 |
| DA3 | One detached worktree per phase validation is cheap enough (setup command reruns). | Slow phase checks; reuse a cached base worktree. | TASK-15 |
| DA4 | Validator CLIs can drive a browser when configured (e.g. Playwright MCP for Claude Code). | UI mode returns BLOCKED; owner configures tooling. | TASK-16 |
| DA5 | Copying the legacy DB and rewriting the legacy config file is acceptable during upgrade (with `.bak`). | Manual migration doc instead. | TASK-09 |
| DA6 | Phase validation on by default. | Extra token spend; flip default. | TASK-15 |
| DA7 | `scheduler.maxAgents` default 2. | Subscription limits hit; owner lowers it. | TASK-09 |
