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
  orchestrator.ts   side-effecting coordinator: project contexts, tick, runTask, validate, finalize, PR poll, human actions
  core/             PURE (no fs, no child_process, no Date.now: time is passed in)
    readiness.ts    selectReady(): which tasks start now                      (built: TASK-03)
    transitions.ts  nextTaskState(): task status after an event               (built: TASK-03)
    prpoll.ts       decidePrAction(): what to do with a PR observation        (built: TASK-03)
    ownership.ts    ownedOverlap() static-prefix overlap; outOfScope() via path.matchesGlob (TASK-14)
    phases.ts       phasesToValidate(), planFixup(), phaseList()              (built: TASK-15)
    graph.ts        cycle detection over depends_on (findCycle)               [built: TASK-13]
  prfeedback.ts     PURE: gh JSON → checks/feedback; worker feedback text (built, R1)
  speckit.ts        tasks.md parser (pure) + spec dir reader + tick writer
  config.ts         server + project config loaders, forbidden keys, effective Config (built: TASK-05; daemon uses them since TASK-09)
  paths.ts          ORCH_HOME layout                                                  (built: TASK-05)
  projects.ts       project registry (add/archive/resolve by cwd)                      (built: TASK-07; daemon uses it since TASK-09)
  db.ts             better-sqlite3 store, schema + `user_version` migrations           (built: TASK-07)
  git.ts            Git class: worktrees, commits, diffs, merge, gh pr/run/api helpers
  auth.ts           token check, login cookie, bind guard                             (built: TASK-08)
  appserver.ts      UI-mode app lifecycle: port, start, readiness, stop, pidfiles     [planned: TASK-16]
  archive.ts        event retention: export JSONL.gz, delete                          [built: TASK-12]
  costs.ts          cost/time rollups                                                 [planned: TASK-17]
  notify.ts         ntfy POST
  prompts.ts        prompt loading (repo override) + {{var}} rendering + clip
  types.ts          shared types
  adapters/         types.ts, runner.ts (spawn, stream, extractJson), claude.ts, gemini.ts, index.ts
prompts/            planner.md, worker.md, validator.md, validator-ui.md [TASK-16], phase-validator.md (built: TASK-15)
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
**[built: TASK-05 (loaders, paths), TASK-07 (registry), TASK-09 (daemon)]** One daemon serves every registered project. `orch serve` reads `$ORCH_HOME/server.json` (`loadServerConfig`), opens `$ORCH_HOME/orch.db`, and builds the `Orchestrator` from `ServerConfig` + `Store`.

**Project context** (`src/orchestrator.ts`, `ProjectContext`): per project id, `{project, cfg, git, warnings}`, where `cfg` = `toLegacyConfig(server, loadProjectConfig(repo, server).config, repo, {projectId, home})` (the effective settings as a `Config`: worktrees under `worktreesDir(project)`, roles resolved per project) and `git` = `new Git(repo, baseBranch, ghCommand)`. Rebuilt by `plan()` and `start()` (REQ-PROJ-06), built lazily on first use otherwise (e.g. a run that was running at daemon restart), never rebuilt mid-run. Each project has its own merge lock. A context fails to build when the repo directory is missing or the settings are invalid; the error names the project, `plan`/`start` refuse with it, the tick skips that project (stderr once per distinct error), and the snapshot's `config.error` shows it. Settings warnings are logged as `info` events on the run when the context is rebuilt. All run-scoped code takes the context from `run.project_id`.

**Legacy routes** (kept beside the project API of §15.1 for older clients and scripts; the dashboard uses the project API since TASK-11): they act on the **default project** = the first non-archived project by name, then id. `POST /api/plan` picks `body.project`, else the project whose repo contains `specDir` (deepest match), else the default project. The CLI uses only project-scoped routes (§15.2).

**Project API** (`src/orchestrator.ts`, built: TASK-10): `snapshot(projectId?, runId?)` (a `runId` of another project → 404; no project → the run's project, else the default project), `listProjectSummaries({archived?})`, `globalInbox()`, `addProject(path, {name?})` (wraps `registerProject`), `archiveProject(id)` (wraps the registry's, 404 for an unknown id). All four read tasks, questions and decisions per run, never the events table (REQ-NFR-06). The **shown run** of a project, used by its snapshot, its `inboxCount` and the global inbox, is its current run, else its newest. `plan()` refuses an archived project. Every SSE `change` payload carries `projectId` (null only when the change concerns no run of a project).

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

**Precedence:** project file > `server.json` project defaults (`defaults.*`, same shape) > built-in defaults. Roles start from `server.json` `agents.roles`; `roles.phaseValidator`, if set nowhere, copies the effective `validator`. The effective config is rebuilt when a run is created or started (REQ-PROJ-06), never mid-run.

**Loader contract** (`src/config.ts`): `loadServerConfig(home)` reads `<home>/server.json` over the §19 server defaults (missing file = defaults); it throws if `agents.roles.*` names an undefined adapter or `defaults` holds a rejected key (named `defaults.<key>`). `loadProjectConfig(repoPath, server)` returns `{config, warnings, path}`: it re-reads the file on every call, throws on rejected keys (all named in one message) and on unknown role adapters, and drops unknown or non-object keys with a warning (unknown keys under `server.json` `defaults` are reported the same way). `validation.ui.env` is a free-form map. `writeStarterProjectConfig(repoPath, {baseBranch})` writes `{baseBranch, validation: {command: ""}}` only if no file exists. Examples: [orch.config.example.json](../orch.config.example.json) (project keys) and [examples/server.example.json](../examples/server.example.json).

### 5.3 Registry
`projects` table (§20). `id` = slug of the repo directory name, `-2`, `-3`… on collision. `repo_path` unique (realpath). Adding: realpath → must contain `.git` (`git rev-parse --show-toplevel` equals path) → if archived row with same path exists, un-archive it → else insert → write starter `orch.config.json` if missing (keys: `baseBranch` detected from `git symbolic-ref refs/remotes/origin/HEAD` else current branch, `validation.command: ""`). Archive refuses if the project has an unfinished run.

**Contract** (`src/projects.ts`, built TASK-07): `registerProject(store, path, {name?})` → `{project, configCreated?: <settings file path>, unarchived?: true}`; errors: missing path, "<path> is not a git repository", "<path> is not a git repository root (the repository root is …)", "<path> is already registered as project '<id>'". `name` defaults to the directory name. `archiveProject(store, id)` refuses while a run is `planning|plan_pending|ready|running|paused`, naming the run; it never touches the repo or the rows. `resolveProjectForCwd(projects, cwd)` = step 3 of §5.4 (deepest non-archived `repo_path` containing `cwd`). Store: `addProject`, `getProject`, `getProjectByPath`, `listProjects({archived?})` (archived excluded unless `archived: true`), `setProjectArchived`, `touchProjectStart`, `listRuns(projectId?)`.

Missing repo on disk → project `error` field set at load; views show it; plan/start refused.

### 5.4 CLI project resolution
`--project <id>` > `ORCH_PROJECT` env > the registered project whose `repo_path` contains `cwd` (deepest match) > the only non-archived project > error exit 2 listing projects.
_(→ code: `resolveProject` in `src/cli.ts`; built: TASK-10)_ The CLI reads the list from `GET /api/projects?archived=1` and applies `resolveProjectForCwd` locally. An explicit id (flag or env) may name an archived project (so its history can be read) but must exist, else exit 2 listing the projects. `orch plan <specDir>` tries the spec dir before the cwd. No registered project → exit 2. `answer`, `decide` and `ask` need no project.

### 5.5 Legacy upgrade
`[ASSUMED]` Applies to single-repo installs.
_(→ code: `upgradeLegacyInstall` in `src/cli.ts`; built: TASK-09)_
On `orch serve`, before the bind guard, if `$ORCH_HOME/server.json` does not exist and a legacy config is found (`--config`, `ORCH_CONFIG`, or upward search from cwd for an `orch.config.json` containing `repo`, `agents` or the pre-0.2 `agent`):
1. Read it with `loadConfig()` (validation, relative paths, the `agent` block mapping). Server-level keys present in the file (`host`, `port`, `publicUrl`, `notify`, `auth`, `agents`, `scheduler.tickSeconds`, `git.ghCommand`) go into the new server settings, with `scheduler.maxAgents` = its effective `maxParallel`. `auth` is copied as written in the file; an `ORCH_TOKEN` from the environment is never written.
2. Back up the legacy file to `orch.config.json.bak` and rewrite it with every other key (project-level). If the legacy file is not `<repo>/orch.config.json` and the repo has none, the project keys are written there too.
3. If the legacy `dbPath` exists and `$ORCH_HOME/orch.db` does not, copy it (and its `-wal`) there. Open the Store (migrations), register the repo as a project unless its path is already registered, and set `project_id` on all runs where it is NULL.
4. Write `server.json` last: it marks the upgrade as done. If step 3 fails, the legacy file is restored from `.bak` and the next start tries again.
5. Record an orchestrator decision "Upgraded single-repo install to project <id>" (rationale: what moved where) on the project's newest run, if it has one, and print it.

## 6. Spec Intake & Planner
### 6.1 Tasks file parser
_(→ code: `src/speckit.ts`)_
- Phase header: `^##+\s+(.+)$` (any `##`/`###` heading starts a new phase).
- Task line: `^\s*[-*]\s*\[([ xX])\]\s*(T\d{2,4})\b\s*(\[P\])?\s*(.*)$`. Title = text clipped to 110 chars; description = full text.
- Dependencies: union of (all tasks in earlier phases) + (previous task in phase if not `[P]`) + explicit `(depends on|after|requires) T001[, T002| and T003]` (case-insensitive). Unknown keys and self-edges dropped. No transitive reduction.
- Fixture coverage: §21.2 `tasks-md/`.

### 6.2 Planner
Prompt `prompts/planner.md` receives title, spec files (except tasks.md, clipped to 2×`handoff.specChars`), and the parsed tasks as JSON. Contract (§13.2). Applied fields: `acceptance`, `depends_on` (filtered to known keys, no self), `merge_policy`, `validate_cmd`, `validate_mode` [TASK-16], `files_owned` [TASK-14]. Planner decisions → decisions (actor planner). Plan questions → `questions` with `task_id NULL` (built: TASK-13), logged as a run-level `question` event (`plan: true`); while one is open no task of the run starts (§7.1) and the tick logs one "waiting on you" event; answering the last one triggers a tick. Planner failure → fallback decision, tasks as imported.

### 6.3 Approval gates
`approvePlan` requires `plan_pending` and **no dependency cycle** over every task of the run (`core/graph.ts` `findCycle(tasks) → string[] | null`, e.g. `["T1","T2","T1"]`; unknown keys ignored) [built: TASK-13]. A cycle is refused (400) with `dependency cycle: T001 → T004 → T001; edit the dependencies of T001, T004 and approve again`; the run stays `plan_pending`. Open plan questions do not block approval, only task starts.

Dry run (`previewPlan(specDir)`, REQ-INTAKE-10) [built: TASK-13]: read the spec dir, parse `tasks.md` and derive dependencies exactly as `plan` does; returns `{dir, title, tasks: ImportedTask[], cycle}` (`cycle` = `findCycle` result, else null). No run, no agent, nothing written; the same errors as `plan` for a missing dir, `tasks.md` or tasks.

## 7. Scheduler
### 7.1 Readiness
`selectReady(input) → ReadinessResult`
_(→ code: `src/core/readiness.ts`; built in TASK-03 including fairness and plan questions; inputs filled by the orchestrator since TASK-09/13; overlap since TASK-14; phase gate since TASK-15)_

The orchestrator (built: TASK-09) passes `maxAgents` = `server.json` `scheduler.maxAgents`, `busyAgents` = planners and phase validations currently running (phase validations: built TASK-15), one entry per non-archived project whose current run is `running` or `paused` (`maxParallel`/`resumeOnRetry` from its context, `lastStartAt` = `projects.last_start_at`; `runStatus: null` when its context fails to build), and the tasks of those runs. `planQuestionsOpen` = unanswered questions of the run with `task_id NULL` (built: TASK-13); `filesOwned` = `tasks.files_owned` (built: TASK-14); each `heldForOverlap` pair becomes one orchestrator decision per run ("Holding <task> until <other> finishes: their owned files overlap", deduplicated against the stored decisions). Every start sets `projects.last_start_at` to the tick's time. `phases` = the run's phase rows when `validation.phase.enabled`, else omitted (no gate); `phase` = `tasks.phase` (built: TASK-15).
Input:
```ts
interface ReadinessInput {
  maxAgents: number;                 // global cap (server)
  busyAgents: number;                // agents not tied to a task row: planners, phase validators
  projects: { id: string; runId: string | null; runStatus: string | null; maxParallel: number;
              lastStartAt: string | null; planQuestionsOpen: number; resumeOnRetry: boolean;
              phases?: { name: string; idx: number; status: string }[] }[];   // §10.3 phase gate
  tasks: { id: string; projectId: string; runId: string; key: string; orderIdx: number; status: TaskStatus;
           dependsOn: string[]; filesOwned: string[]; openQuestions: number;
           attempt: number; fixRounds: number; hasSession: boolean; adapterSupportsResume: boolean;
           phase?: string | null }[];
}
interface ReadinessResult {
  start: { taskId: string; resume: boolean }[];
  heldForOverlap: { taskId: string; blockedByTaskId: string }[];   // for decisions (logged once per pair per run)
}
```
Algorithm:
1. `active` = tasks with status `running|validating`. `free = maxAgents − active − busyAgents`.
2. Candidates per project (only projects with `runStatus === "running"` and `planQuestionsOpen === 0`): `pending`, every `dependsOn` key is `done|skipped` in the same run, `openQuestions === 0`, and the **phase gate** is open: with `gate` = the lowest `idx` among the project's `phases` whose status is not `passed`, a task whose phase row (`phase ?? ""`) has `idx > gate` waits (a task whose phase has no row is not gated); sorted by `orderIdx`.
3. Projects ordered by `lastStartAt` ascending (null first), then `id` — fairness (REQ-PROJ-09).
4. Round-robin: repeatedly walk the ordered projects; for each, take its first candidate if project active+chosen < `maxParallel`, `free > 0`, and its `filesOwned` does not overlap (§7.2) any active or already-chosen task **of the same project** — else record `heldForOverlap` against the first overlapping task and try the project's next candidate. Stop when a full pass chooses nothing.
5. `resume = resumeOnRetry && hasSession && adapterSupportsResume && (attempt > 0 || fixRounds > 0)`.

### 7.2 Ownership overlap
_(→ code: `src/core/ownership.ts`; built in TASK-14; fixtures `test/fixtures/ownership.json`)_
`ownedOverlap(a, b)`: false if either list is empty (unknown ownership = unconstrained, preserves today's behaviour). Otherwise, for each pattern compute its **static prefix**: path segments (split on `/`, normalized, no leading `./`) up to but excluding the first segment containing any of `* ? [ {`; a pattern without wildcards is its own prefix. Two patterns overlap if one prefix's segments are a prefix of the other's (equal included; empty prefix overlaps everything). Conservative by design: may serialize tasks that would not actually collide, never runs colliding ones together ([0017](decisions/0017-file-ownership.md)). Patterns are normalized (backslashes become `/`; leading `./` and empty segments are dropped). A task in `needs_input` whose answers arrive is not resumed while an active task of its run has overlapping ownership; the next tick retries (the same decision is recorded). The dashboard Plan tab repeats this rule to show each task's "not with" keys.

### 7.3 Tick
One timer (`server.json` `scheduler.tickSeconds`), one tick across all projects, never two ticks at once. Per tick, for each project's current run that is `running`: (1) resume `needs_input` tasks with no open questions (T10; a resume continues a session that already held a slot and is not held back by `maxAgents`, so after answers the cap can be exceeded briefly); (2) PR polls (§12, per project settings); (3) phase checks (§10.3: pass or start validations; built TASK-15); then (4) one `selectReady` over every project (§7.1) → start tasks (not awaited), set `last_start_at`, log held-for-overlap decisions; (5) per running run: if no task is active and all tasks `done|skipped` (and phases validated or phase validation disabled) → run `done` + notify; else if nothing can progress without the owner → one "waiting on you" activity event (deduped by last event).

### 7.4 Run control
- One unfinished run per project: `plan(projectId, specDir, opts)` and `start(runId)` refuse when another run of the project is in `planning|plan_pending|ready|running|paused`, with `project '<id>' already has an unfinished run <runId> (<status>, "<title>"); finish or stop it first` (built: TASK-09). A project's **current run** is its newest run not `done|stopped|failed`; legacy routes without a run id act on the default project's current run.
- `pause`: status `paused`; tick skips the run's starts; running agents finish.
- `stop`: SIGTERM agent children of that run (including a running phase validator, whose phase goes back to `pending`), active tasks → `pending`, run `stopped`. A stopped run may be started again if no other unfinished run exists.
- `recover()` on daemon start: active tasks → `pending` (worktree kept, activity event), `planning` runs → `plan_pending`, `validating` phases → `pending` (validated again; built TASK-15), kill leftover UI-mode apps from `run/*.pid` [TASK-16].

## 8. Task State Machine
_(→ code: `src/core/transitions.ts`; built in TASK-03, T17 in TASK-06; T19 [TASK-16] not yet)_
States: `pending, running, validating, needs_input, pr_checks, pr_open, failed, done, skipped`. Active = `running|validating`. Watched (PR polled) = `pr_checks|pr_open`.

`nextTaskState(task, event, cfg) → { status, patch, decision?, notify?, effect?, rejected? }` where `effect` is the ordered list of side effects the shell must perform (`merge_local | push_and_pr | merge_pr | kill_agent | remove_worktree`; empty = none) and `rejected` marks an event not allowed from the current state (status unchanged). The patch holds only what the transition decides; values produced by an effect (`pr_url`, `pr_head`, `pr_pushed_at`, new branch/worktree) are written by the shell after the effect succeeds. If an effect fails (merge), the shell sends `merge_failed` (T9) instead, except for T15 (`human_merge`), where the error goes back to the owner and the task stays. The shell (`Orchestrator.fire`/`applyTransition`) runs merge effects (`merge_local`, `push_and_pr`, `merge_pr`) before the state change and the others (`kill_agent`, `remove_worktree`) after it, so a transition without merge effects is applied synchronously. Owner actions on a state that does not allow them are rejected with an error (e.g. stopping a task that is not active). Fixture semantics: [test/fixtures/README.md](../test/fixtures/README.md).

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
| T17 | pr_open/pr_checks | `human_request_changes{feedback}` | — | pending | fix round kind `human` (§12.3); allowed even if `fix_rounds >= maxRounds`; human decision "Sending owner feedback on <key>['s PR] back to the worker (round n)"; rejected with empty feedback |
| T18 | pr_checks/pr_open | PR action (§12.2) | — | per action | — |
| T19 | validating | `validator_blocked` (UI mode, no browser) | — | failed | no retry; notify [TASK-16] |

Fix-up tasks (`synthetic`, built: TASK-15) use the same machine; the shell never ticks them in `tasks.md`.

## 9. Worker & Hand-off Brief
- Worktree: `git worktree add -b orch/<key>-<slug> <dir> <baseRef>`; `baseRef` = `origin/<base>` after `fetch --prune` when a remote exists, else `<base>`. Reuse existing branch. Copy `git.copyFiles`, run `git.setupCommand` (15 min timeout). A failing setup removes the new worktree (branch kept) and fails the attempt with the command's exit code and output, so the next attempt recreates the worktree and reruns setup.
- Prompt `prompts/worker.md` vars: task key/title/description, acceptance bullets, spec excerpt (`handoff.contextFiles`, clipped to `handoff.specChars`), hand-off, branch/base, validate hint, feedback section. `files_owned`: the owned list, or "(none declared…)" (built: TASK-14).
- Hand-off (clipped to `handoff.historyChars`): completed tasks with lower `order_idx` (direct deps: full summary; others: 200 chars; up to 8 files), last 25 decisions, all answered Q/A.
- Resume prompt: answers (if any) + `last_feedback` + "continue, commit, same JSON block".
- Agent env: `ORCH_URL`, `ORCH_TASK_ID`, `ORCH_RUN_ID`, `ORCH_ACTOR`, `ORCH_TOKEN` (when a token is set; built: TASK-08), `PATH` prefixed with `<pkg>/bin`.

## 10. Validation
### 10.1 Gate
`validate_cmd || validation.command` via `sh -c` in the worktree, 20 min timeout; output clipped 3000 to the log, 4000 to feedback. Precondition: `commitsAhead > 0`. Gate output (clipped 4000) is passed to the validator as `{{gate_output}}` [planned: TASK-16].

### 10.2 Validator
Fresh session, prompt `prompts/validator.md`: task, criteria, worker summary (claims), `diffFromBase` (stat + diff, 60k chars), gate hint/output. Verdict contract §13.2. Non-PASS → T3/T4 with reasons + UNMET criteria. Out-of-scope edits (files in diff not matched by `files_owned` via `path.matchesGlob`) are listed by orch in the prompt (`files_owned`, `out_of_scope`; file names from `git diff --name-status`, so the list is complete even when the diff text is clipped; a pattern without wildcards also owns everything below it) and reported in `findings`, never a FAIL by themselves. The verdict event stores `findings` (validator) and `out_of_scope` (orch); the task panel shows the latest under "Validator findings" (built: TASK-14).

### 10.3 Phase validation
_(→ code: decisions in `src/core/phases.ts` (built: TASK-15, fixtures `test/fixtures/phases.json`); flow in `src/orchestrator.ts` checkPhases/validatePhase/applyPhaseVerdict; `Git.addDetachedWorktree`)_
- `phases` table row per (run, phase name): `pending → validating → passed | needs_human`, `fixup_rounds` (`failed` is reserved; the owner actions accept it like `needs_human`). Rows are created `pending` by the phase check from the run's tasks (`phaseList`: plan order of each phase's first task, `idx` from 1; tasks before any heading form the phase named `""`, shown as "(no phase)").
- `phasesToValidate(tasks, phases) → {phaseId, name, action: validate|pass, reason}[]`: walk the rows by `idx`; skip `passed`; stop at the first row that is not `pending`. A `pending` phase is due (`validate`) when it has ≥1 task, all its tasks (incl. fix-ups) are `done|skipped` and at least one is `done`, which ends the walk; with no tasks or only skipped tasks it is `pass` (decision "Phase "<name>" passed without validation: <reason>") and the walk continues; otherwise the walk stops. So phases are validated one at a time, in order. Disabled (`validation.phase.enabled` false): every `pending` row goes straight to `passed` and readiness gets no rows.
- Run: one validation per run at a time; it starts only when a global slot is free (`maxAgents − active tasks − busyAgents > 0`) and counts as one busy agent until it ends. Row → `validating`. Detached worktree at `baseRef` (`<worktreeDir>/<run>-phase-<idx>`, `git worktree add --detach`), `git.copyFiles`, `git.setupCommand`, then `validation.phase.command || validation.command` (20 min; a failing setup or command is a FAIL without the agent), then, if `validation.agent`, the phase validator (role `phaseValidator`, default = the project's validator role; env `ORCH_RUN_ID`, `ORCH_ACTOR=phase_validator`, no task id) with prompt `prompts/phase-validator.md` (phase label/idx/count, each task with criteria and summary, spec excerpt, command output clipped 4000, earlier fix-up rounds). Verdict event `verdict` with `role: phase_validator`. The worktree is always removed. An error of orch itself (worktree, git) → `needs_human` directly.
- PASS → `passed`, decision "Phase "<name>" passed validation" (actor `phase_validator`, or `orchestrator` without the agent). FAIL → decision "Phase "<name>" failed validation" (rationale = failure + reasons + UNMET lines, clipped 1500). Then, with `fixup_rounds < validation.phase.maxFixups`: `planFixup(phase, round, verdict, laterTasks)` → task key `FIX-<idx>.<round>` (`synthetic`, phase = same, policy auto, `order_idx` = the phase's last + 1 with later tasks moved down one, description = failure + reasons + suggestions, acceptance = unmet + "Phase validation of "<name>" passes") and one edge per **unfinished** later-phase task (its `depends_on` gains the key); row → `pending` with `fixup_rounds+1`; orchestrator decision "Created fix-up task FIX-… for phase "<name>" (round n/max); later phases wait for it". Otherwise → `needs_human`, orchestrator decision "Phase "<name>" needs the owner: …" (rationale = the failure summary, used as the inbox item's `detail`) and a notification. Synthetic tasks are never ticked in `tasks.md`.
- Owner actions (only on `needs_human|failed`, else 400): `revalidatePhase` → `pending` (fix-up rounds kept, so another FAIL returns to the inbox), human decision "Re-running validation of phase …"; `acceptPhase` → `passed`, human decision "Accepted phase … without passing validation".
- Later phases' tasks wait while an earlier phase is not `passed` (readiness phase gate, §7.1). A run is `done` only when every phase row is `passed` (with validation enabled); a `needs_human` phase gives one "waiting on you" activity event.

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
- **Diff for review:** `diffFiles(worktree)` → `git diff --no-renames -z --numstat` + `--name-status` + per-file `git diff <base>...HEAD -- <file>` (`<base>` = `baseRef()`, so only the task's own commits); patch text starts at the first hunk; binary files (`-\t-` in numstat) have `patch: null`; total patch text capped at 200k chars (`truncated: true`; files past the cap keep their counts, `patch: null`). When the worktree is gone (done tasks, not started), `GET /api/tasks/:id/diff` answers 404 with the reason.

## 12. PR Feedback Loop
_(→ code: decision in `src/core/prpoll.ts` (`decidePrAction`), applied as transition T18 in `src/core/transitions.ts`; I/O in `src/orchestrator.ts` pollPr/startFixRound and `src/git.ts`; helpers in `src/prfeedback.ts`)_
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
`launch(config, {prompt, model, resumeSessionId}) → {command, args, stdin}`; `parseLine(json, state) → NormalizedEvent[]`; `finish(state, exitCode)`; `supportsResume`. Normalized kinds: `text | tool | agent | error | info`. Orchestrator-added kinds: `state | git | decision | question | verdict`. Claude: `claude -p --output-format stream-json --verbose [--model] [--resume]`, prompt on stdin, default `--permission-mode bypassPermissions`. Gemini: `gemini -p <trailer> --output-format stream-json --yolo --skip-trust [-m] [--resume]`, prompt on stdin. Runner: timeout → error event (`<adapter> timed out after <n> min|s; killing`), SIGTERM, then SIGKILL after 5 s; non-zero exit → error event. A failed worker run without a `reason` uses those error messages as its attempt feedback.

### 13.2 JSON contracts
_(→ code: `prompts/*.md`)_
All roles end with one fenced ```json block; `extractJson` takes the last parseable fenced block tagged `json` or untagged (blocks in other languages are skipped; fences may be indented), else the last parseable trailing `{…}`.
- Planner: `{tasks:[{key, acceptance[], depends_on[], merge_policy, validate_cmd, validate_mode?, files_owned?}], decisions:[{text, rationale}], questions:[{text, options[]}]}`
- Worker: `{status: done|blocked|failed, summary, files[], decisions[], follow_ups[], reason?}`
- Validator: `{verdict: PASS|FAIL|BLOCKED, criteria:[{criterion, met, evidence}], reasons[], suggestions[], findings?[]}` (`BLOCKED` only in UI mode)
- Phase validator (built: TASK-15): `{verdict: PASS|FAIL, reasons[], unmet[], suggestions[]}`; anything but PASS (including no block) is a FAIL

### 13.3 Agent-facing CLI
`orch decide "<text>" --why "<r>"` → `POST /api/decide`; `orch ask "<q>" --options "A,B"` → `POST /api/ask` (requires `ORCH_TASK_ID`), prints "STOP working now…".

## 14. Inbox, Decisions & Notifications
- Inbox is **derived** on read, never stored: per project/run: `approve_plan` (run `plan_pending`), `question` (unanswered; `task_id` null = plan question: no `task_key`, `plan: true`; built: TASK-13), `failed` tasks, `merge` (`pr_open` tasks, with `pr_url`, `feedback`, `ci_status`, `fix_rounds`), `phase` (`needs_human`/`failed` phase rows, with `phase_id`, `phase_name`, `fixup_rounds`, `detail` = latest failure; built: TASK-15). Items of a run carry `run_id`. Global inbox = union over non-archived projects' shown runs (current, else newest), each item with `project_id`, `project_name` [built: TASK-10].
- Decisions: append-only rows (actor ∈ planner|worker|validator|phase_validator|orchestrator|human).
- Notifications (`src/notify.ts`): ntfy POST with Title, Priority, Click (task PR url or `publicUrl`), Tags. Title prefix `[<project name>] ` (registry name; built: TASK-09). Failures logged to stderr, never thrown.

## 15. Interface Contracts
_(→ code: `src/server.ts`, `src/cli.ts`)_
### 15.1 HTTP API
All JSON. Errors: `{error: string}` with 400 (bad request / invalid state), 401 (auth), 404 (not found). Auth per §16.

| Method & path | Body / query | Returns | Status |
| :--- | :--- | :--- | :--- |
| GET `/api/health` | — | `{ok, version, uptimeSec}` (no auth) | built: TASK-08 |
| POST `/api/login` | `{token}` | right token: sets cookie, `{ok, auth:true}`; wrong: 401; auth off: `{ok, auth:false}` (no auth) | built: TASK-08 |
| GET `/api/projects` | `?archived=1` (include archived) | `[{id, name, repo, archived, error, run:{id,status,title}\|null, inboxCount}]`; `run` = shown run (§5), `error` = missing repo or invalid settings, else null; `inboxCount` 0 when archived | built: TASK-10 |
| POST `/api/projects` | `{path, name?}` | project row `{id, name, repo_path, archived, …}` + `configCreated` (starter settings path, when written) + `unarchived: true` (when an archived project was restored); 400 with the registry's message (§5.3) | built: TASK-10 |
| DELETE `/api/projects/:id` | — | `{ok}` (archive); 400 naming the unfinished run; 404 unknown id | built: TASK-10 |
| GET `/api/projects/:id/state` | `?run=<id>` | snapshot `{project:{id,name,repo,archived}, run, tasks, decisions, questions, phases, inbox, inboxCount, runs, config}` (`phases`: TASK-15; `config.phaseValidation` = `{enabled, command, maxFixups}`) of that run (404 if not in the project), else of the shown run; `costs` added by TASK-17 | built: TASK-10 |
| GET `/api/inbox` | — | global inbox items (§14), each with `project_id`, `project_name`, `run_id` | built: TASK-10 |
| POST `/api/projects/:id/plan` | `{specDir, llm, dryRun?}` | run; 400 for an archived project or an unfinished run; `dryRun: true` → `{dir, title, tasks, cycle}` (§6.3), no run created; 404 unknown project | built: TASK-10 (dry run: TASK-13) |
| GET `/api/state`, GET `/api/runs/:id` | `/api/state?project=<id>` | legacy snapshot, same shape as the project state: the run by id (404 if unknown), else the project's shown run; `runs` and `config` are that project's; no project → default project | built (`project`, `?project=`: TASK-09) |
| POST `/api/plan`, POST `/api/{start,pause,stop}` | plan: `{specDir, llm, project?}` | legacy: plan resolves the project per §5; start/pause/stop act on the default project's current run | built |
| POST `/api/runs/:id/{approve,start,pause,stop}` | — | `{ok}`; approve: 400 naming the keys of a dependency cycle (§6.3) | built (cycle check: TASK-13) |
| POST `/api/tasks/:id/{retry,skip,stop,merge,mark-merged,edit}` | edit: patch | `{ok}` | built |
| POST `/api/tasks/:id/request-changes` | `{feedback}` (non-empty) | `{ok}`; 400 unless `pr_open\|pr_checks` | built (TASK-06) |
| GET `/api/tasks/:id/diff` | — | `{base, head, files:[{path, status, additions, deletions, binary, patch}], truncated}`; 404 with reason when no worktree | built (TASK-06) |
| GET `/api/tasks/:id/events`, `/api/runs/:id/events` | `?after&limit` | events; for an archived run, one synthetic `info` event "Log archived to <path>" (§17) | built (archive: TASK-12) |
| POST `/api/questions/:id/answer` | `{answer}` | `{ok}` | built |
| POST `/api/ask`, `/api/decide` | agent payloads | question / decision | built |
| POST `/api/phases/:id/{revalidate,accept}` | — | `{ok}`; 400 unless the phase is `needs_human\|failed`; 404 unknown id | built: TASK-15 |
| GET `/api/events/stream` | — | SSE: `event` (event rows), `change` (`{what, projectId, runId?, …}`; `what` ∈ run, tasks, questions, decision, projects, phases); `: ping` every 25 s | built |

### 15.2 CLI
`orch serve | project add <path> [--name n] | project list [--archived] | project remove <id> | plan <specDir> [--no-llm] [--dry-run] | approve [runId] | run | pause | stop | status | answer <qid> <text> | retry|skip|merge|stop-task <key> | archive-events | decide | ask`. Global `--project <id>` (§5.4). Exit codes: 0 ok, 1 error (`error: <msg>` on stderr, including API errors and an unreachable daemon), 2 usage (`UsageError`: missing arguments, unknown command or subcommand, flag without a value, project not determinable; the message is on stderr after `error:`). `orch`, `orch help` and `--help` print the help and exit 0. Project commands use the project routes: `status`, `approve`, `run|pause|stop` and the task actions read `GET /api/projects/:id/state` and act on its run or tasks by id; `plan` posts `/api/projects/:id/plan`. Token from `ORCH_TOKEN` or `$ORCH_HOME/server.json` when readable. Base URL from `ORCH_URL`, else `http://127.0.0.1:<port>` from the server settings. `plan --dry-run` posts `dryRun: true` and prints the phases, each task with `[x]`/`[ ]`, `[P]`, key, title and `depends on:`, and a warning when the preview has a cycle; exit 0, nothing created. [built: TASK-10 (`archive-events`: TASK-12, `--dry-run`: TASK-13)]

### 15.3 Dashboard
Single `dashboard/index.html`. A full refresh reads `GET /api/projects`, `GET /api/inbox` and `GET /api/projects/:id/state[?run=]` of the selected project; Board, Plan, Decisions, Activity, the task drawer and the run selector show only that project [built: TASK-11]. Regions: top bar (project switcher `#projectSwitcher`: the selected project's name, a status dot for its shown run (running, awaiting approval, done, idle; red = project error) and its inbox count; its menu `#projectMenu` lists every non-archived project in `#projectList` with dot, run title and status (or the error) and inbox count, plus **Add project…** `#btnAddProject` (dialog `#addProjectDlg`: path, optional name; an API error is shown inline in `#addProjectErr`, the starter settings path or a restore in a toast) and **Archive this project…** `#btnArchiveProject` (confirm, then `DELETE`; a refusal naming the unfinished run is shown as a toast) [built: TASK-11]; run selector `#runSel` (the project's runs, past ones included; picking one pins it until the project changes), run controls, cost tile [TASK-17]), Inbox `#globalInbox` (global: items of every non-archived project, each with a project tag; a plan question carries a **Plan** pill instead of a task key [built: TASK-13]; clicking an item switches to its project and opens its task; the item's own buttons act without switching, except Inspect and Send back… which switch first) [built: TASK-11], Board (lanes: Pending, Running, Validating, Needs input, Waiting on CI, Review / merge, Failed, Done; replaced by the panel `#projectError` when the project's repo is missing or its settings are invalid, or when no project exists (with Add project) [built: TASK-11]), Plan (phases, criteria, deps incl. implicit overlap edges, policy, mode, owned files; edit dialog; a note while plan questions are open; a refused approval, e.g. a dependency cycle, is toasted and kept as `#approveError` above the plan until the next attempt [built: TASK-13]), Decisions, Activity, Task drawer (meta, criteria, summary, feedback, actions; Send back textarea for `pr_open|pr_checks`; Diff section loaded on expand: file list with status and +/− counts, collapsible unified diff per file with added/removed lines coloured, binary note, truncation notice; live log). The drawer keeps stable regions so a refresh does not clear a draft or collapse open files. The inbox merge card has **Send back…** (dialog) [built: TASK-06]. The selected project is kept in `localStorage` key `orch.project` (every access in try/catch; missing or no longer listed → the first project); switching resets the run to the project's shown run and closes the drawer [built: TASK-11]. SSE reconnect: on error close the stream and retry with backoff 1 s doubling to 30 s; before each retry a `GET /api/projects` probe (401 → token prompt, which reconnects; unreachable → next backoff); on reopen reset the backoff, do a full refresh and reload Activity. The live dot `#live` is green when connected, amber while retrying (its title says when). A full refresh also runs every 30 s [built: TASK-11]. On any 401 show a token prompt that POSTs `/api/login`, then refresh and reconnect SSE [built: TASK-08].

## 16. Authentication
_(→ code: `src/auth.ts`, gate in `src/server.ts`, guard in `src/cli.ts` `serve`; built: TASK-08)_
- Token: `ORCH_TOKEN` env > `server.json` `auth.token` (via `resolveToken()`). Empty = auth off. The human CLI reads port and token from `$ORCH_HOME/server.json` when it exists, else from a legacy `orch.config.json`.
- Refused requests get 401 `{error:"unauthorized"}` with no reason. The CLI sends `Authorization: Bearer` from `ORCH_TOKEN` or the settings file; the daemon puts `ORCH_TOKEN` in every agent env (planner, worker, validator).
- Accepted credentials: `Authorization: Bearer <token>` or cookie `orch_token=<token>` (set by `/api/login`: `HttpOnly; SameSite=Strict; Path=/; Max-Age` one year). Compare SHA-256 digests with `crypto.timingSafeEqual`.
- Unauthenticated routes: `GET /` (dashboard shell), `GET /api/health`, `POST /api/login`. Everything else, including SSE, needs auth when a token is set.
- Bind guard at startup: host not in `127.0.0.1 | ::1 | localhost` and no token and not `auth.allowInsecure` → exit 1 with a message naming both options.
- Secret hygiene: the token, ntfy token and adapter env values are never logged, stored in events, or rendered into prompts; `publicConfig()` exposes only booleans for them (`auth`, `ntfy`, `ntfyToken`). `scripts/e2e-auth.mjs` checks the DB file, every event and every prompt.
- Docker: the image runs as uid 1000 (`orch`), the healthcheck uses `/api/health`, and compose passes `ORCH_TOKEN` (required, because the container binds `0.0.0.0`).

## 17. Retention & Archive
_(→ code: `src/archive.ts`, built: TASK-12)_
- On `orch serve` startup and every 24 h after (timer in `src/cli.ts`), and on `orch archive-events`: runs with status `done|stopped|failed`, `archived_at IS NULL`, `updated_at` older than `retention.eventDays` (0 = never), that still have events. Runs with no events are skipped (no empty files).
- Per run: stream events `ORDER BY id` as JSON lines through `zlib.createGzip()` to `archive/<project>/<runId>-events.jsonl.gz.tmp` (`_unassigned` for a run with no project), fsync, rename to final name, then in one transaction delete the run's events and set `runs.archived_at`, then record an orchestrator decision "Archived N event(s) to <path>". Any failure before the rename → `.tmp` removed, nothing deleted, `error` event logged on the run, the error returned; other runs carry on.
- Task and run log endpoints for archived runs return one synthetic `info` event "Log archived to <path>" (id `Number.MAX_SAFE_INTEGER`, so a client polling with `?after` sees it once). Decisions, questions, task rows (summaries, feedback, costs) are untouched.
- `orch archive-events` opens `$ORCH_HOME/orch.db` directly (works with or without a running daemon; WAL), prints the archived run ids and exits 1 if any run failed.

**Contract:** `archiveEligibleRuns(store, {now, eventDays, archiveRoot}) → {archived: runId[], errors: string[]}`; `archiveFilePath(archiveRoot, run)`; `archivedLogEvent(archiveRoot, run, taskId)`. Store: `listArchivableRuns(beforeIso)`, `iterateRunEvents(runId)` (pages of 500 by id, so the connection is free between pages while the stream awaits), `deleteRunEventsAndMarkArchived(runId, ts)`.

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
| `roles.<role>` | project | `{adapter, model}` | server roles (`phaseValidator`: effective `validator`) | §5.2 |

## 20. Data Model & Persistence
_(→ code: `src/db.ts`)_
### Entities
| Entity | Field | Type | Constraints / Notes |
| :--- | :--- | :--- | :--- |
| projects [TASK-07] | id, name, repo_path, archived, last_start_at, created_at, updated_at | TEXT/INT | `repo_path` UNIQUE |
| runs | id, project_id [TASK-07], spec_dir, title, status, base_branch, cost_usd [TASK-17], agent_ms [TASK-17], archived_at [TASK-12], created_at, updated_at, notes | | status ∈ §7.4 run states |
| tasks | id, run_id, key, title, description, acceptance JSON, depends_on JSON, parallel, phase, order_idx, status, attempt, max_attempts, merge_policy, validate_cmd, validate_mode [TASK-16], files_owned JSON [TASK-14], synthetic [TASK-15, built], worktree, branch, pr_url, session_id, summary, files JSON, last_feedback, fix_rounds, pr_head, pr_pushed_at, pr_feedback_at, ci_head, ci_status, cost_usd, agent_ms [TASK-17], created_at, updated_at | | UNIQUE(run_id, key) |
| events | id, run_id, task_id, ts, kind, data JSON | | append-only; deleted only by archive |
| decisions | id, run_id, task_id, ts, actor, text, rationale | | append-only |
| questions | id, run_id, task_id NULL-able [TASK-07], ts, text, options JSON, answer, answered_at | | NULL task = plan question |
| phases [TASK-07 schema, used since TASK-15] | id, run_id, name, idx, status, fixup_rounds, updated_at | | UNIQUE(run_id, name) |

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
`PRAGMA user_version` holds the schema version (built: TASK-07, current version 2). The `Store` constructor calls `migrate(db)`, which runs migrations `user_version+1..N` in order, one transaction each (the version bump is in the same transaction), and refuses a DB whose version is newer than the build. Each migration tolerates a DB that already has part of it (columns are added only if missing). Version 1 = the 0.1 schema plus any missing R1 task columns. Version 2 = `projects` and `phases` tables, the `[TASK-07]`…`[TASK-17]` run/task columns above, indexes `runs_project(project_id, created_at)` and `questions_run(run_id, id)`, and a rebuild of `questions` (create new, copy with ids, drop, rename) to make `task_id` nullable. JSON columns (`acceptance`, `depends_on`, `files`, `files_owned`) map to arrays and `archived`/`synthetic` to booleans in `src/types.ts`. Never edit a released migration; add a new one.

## 21. Errors, Logging & Testing
### 21.1 Errors & logging
- Every caught error in task flow → `error` event on the task + the transition's feedback. Daemon-level errors → stderr (journald/docker logs).
- PR poll errors logged once per distinct message per task.
- Tool inputs clipped to 400 chars per string field; tool outputs to 1500; never log secrets (§16).

### 21.2 Testing architecture
- **One command:** `npm test` = build → `test:unit` → `check` → `test:e2e`. CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run typecheck`, `npm test` on ubuntu-latest with Node 22 and 24 ([0022](decisions/0022-node-22-floor.md)).
- **Unit** (`test/unit/*.test.mjs`, `node --test`, against `dist/`): pure modules, driven by fixtures. `config.test.mjs` [TASK-05] covers the server/project loaders against temp dirs: precedence, every rejected key, unknown-key warnings, unknown role adapters, `ORCH_HOME` override, `toLegacyConfig`, and that both example files load without warnings.
- **Fixtures** (`test/fixtures/`, spec-first, owner-reviewed, [TASK-01]):
  - `tasks-md/<case>.md` + `<case>.expected.json`: `[{key, phase, parallel, done, depends_on}]` (depends_on sorted).
  - `extract-json.json`: `[{name, input, expected}]` (`expected: null` when nothing parses).
  - `readiness.json`: `[{name, input: ReadinessInput, expected: ReadinessResult}]` (order of `start` significant).
  - `transitions.json`: `[{name, row, task: {status, attempt, max_attempts, fix_rounds, merge_policy, …}, event, config, expected: {status, patch?, decisionPrefix?, notify?: bool, effect?: string[], rejected?: bool}}]`, at least one case per row of §8.
  - `pr-poll.json`: `[{name, step, task, pr, localSha, now, config, expected: {action, kind?, reasonContains?, patch?, itemBodies?, failedChecks?}}]`, at least one case per step of §12.2.
  - Any case may carry `"pending": "TASK-NN"`: runners skip it until that task removes the marker. Field semantics, row/step mapping and the Behaviour changes list: `test/fixtures/README.md`.
  - `ownership.json` [TASK-14]; `phases.json` [TASK-15]: `{toValidate: [{name, tasks, phases, expected}], fixup: [{name, phase, round, verdict, laterTasks, expected}]}`.
- **E2E** (`scripts/e2e*.mjs`, Linux/macOS or `node:22` container): throwaway repos, real git, the daemon via `dist/cli.js serve`, fakes: `fake-agent.mjs` (Claude and Gemini dialects, scripted by task key/prompt markers), `fake-gh.mjs` (PR state files + local bare `origin`), `fake-app.mjs` [TASK-16] (HTTP server on `PORT`). Notifications captured with a local HTTP sink when asserted.
  - `e2e.mjs`: full happy-path loop (Claude worker, Gemini validator); since TASK-13 it also runs `orch plan --dry-run` first (exit 0, every key printed, no run), checks the planner's plan question has no task, has approval refuse a T001↔T004 cycle with 400, and checks no task starts until the plan question is answered. `e2e-pr.mjs`: PR mode and feedback loop. `e2e-lifecycle.mjs` [TASK-04]: 13 independent regression scenarios (a)–(m), each its own repo, daemon and port (`node scripts/e2e-lifecycle.mjs b h` runs a subset): stop, `kill -9` + restart, timeout, setup failure, no commits, missing `tasks.md`, planner failure, answer while paused, dirty main checkout, merge conflict, skipped dependency, double answer, criteria edit. Scenario (h2) is `todo`: answering while paused still costs an attempt (T11, owner decision pending). `e2e-phase.mjs` [TASK-15]: (a) phase 1 FAIL → `FIX-1.1` with the failure, phase 2 waits → fix-up done → PASS → phase 2 → run done, decisions for both results and the fix-up, `tasks.md` without `FIX-`; (b) `maxFixups: 0` → phase inbox item, Re-run fails again, Accept lets phase 2 run.
  - `e2e-multi.mjs` [TASK-09]: (multi) one daemon, two projects registered through `dist/projects.js` before start, `server.json` with `maxAgents: 1` and ntfy pointed at a local HTTP sink: never more than one active task (polled), the second project's task starts before the first's third (worker-start event ids), refused plan/start naming the unfinished run, worktrees under `ORCH_HOME/worktrees/<id>/`, titles prefixed with the project name; (legacy) a legacy `orch.config.json` plus a 0.1-schema DB with a done run → project registered, old run + decisions visible, files split, a new run completes. Every e2e daemon gets `ORCH_HOME=<tmp>/home` (`makeRepo()` returns it); scripts that write a legacy config exercise the upgrade on each start.
  - `fake-agent.mjs` markers (anywhere in the prompt): `PLANNER_FAIL` (planner exits 1), `PLAN_QUESTION` (planner also returns one plan question) [TASK-13], `SLEEP_LONG` (worker commits `impl/<KEY>.wip`, writes its pid to `$FAKE_STATE_DIR`, sleeps; exits if orphaned), `NO_COMMIT` (done without changes), `CONFLICT_FILE` (also writes `shared.txt`), `PHASE_TRAP` (phase validator FAILs phase 1 until `impl/FIX-1.<round>.txt` is on the base branch) [TASK-15]; task key T002 asks a question, T003/T004 fail once at the gate/validator, `CI_TRAP` fails CI once.
- **E2E helpers** (`scripts/lib/e2e.mjs`): `makeRepo({files, origin?, prefix?})` (throwaway repo on `main` with a local git identity, optional bare `origin`), `writeConfig(repo, cfg)`, `startDaemon({cwd, env, port})` (prefixed logs, resolves when `/api/state` answers), `api(port)` → `(method, path, body)`, `waitFor(fn, {timeoutMs, intervalMs})`, `cleanup({ok})` (kills daemons; keeps temp repos on failure). New scenarios should be a config, a loop and assertions.
- **Invariants** (`scripts/check-invariants.mjs`, `npm run check`): `dependencies` is exactly `better-sqlite3` (REQ-NFR-02); `/claude|gemini|anthropic/i` in `src/**/*.ts` outside `src/adapters/` fails unless the line matches the allowlist in the script (built-in adapter defaults and legacy migration in `src/config.ts`) (REQ-NFR-04); files in `src/core/` must not import `node:fs`, `node:child_process` or `../db`, nor call `Date.now()` / `new Date()` without arguments (REQ-NFR-05, [0020](decisions/0020-pure-core-and-fixtures.md)).
- **Fixture runner** (`test/unit/core.test.mjs`): loads every file in `test/fixtures/`, runs `parseTasksMd`, `extractJson`, `selectReady`, `nextTaskState`, `decidePrAction`, `ownedOverlap`/`outOfScope` and `phasesToValidate`/`planFixup`, and reports cases with `pending` as skipped.
- **Manual**: first live Gemini run; first real GitHub repo with Actions; visual dashboard review (dark + light, phone width).

## 22. Design Assumptions
| ID | Statement | Impact if wrong | Resolved by (task) |
| :--- | :--- | :--- | :--- |
| DA1 | `path.matchesGlob` (Node ≥ 22.5) is available for out-of-scope detection. Node floor is 22 ([0022](decisions/0022-node-22-floor.md)). Confirmed in TASK-14; on Node 22 it prints an `ExperimentalWarning` once per process. | Need a tiny glob matcher. | TASK-14 |
| DA2 | Static-prefix overlap is precise enough; over-serialization is acceptable. | Lost parallelism; refine to glob intersection. | TASK-14 |
| DA3 | One detached worktree per phase validation is cheap enough (setup command reruns). | Slow phase checks; reuse a cached base worktree. | TASK-15 |
| DA4 | Validator CLIs can drive a browser when configured (e.g. Playwright MCP for Claude Code). | UI mode returns BLOCKED; owner configures tooling. | TASK-16 |
| DA5 | Copying the legacy DB and rewriting the legacy config file is acceptable during upgrade (with `.bak`). | Manual migration doc instead. | TASK-09 |
| DA6 | Phase validation on by default. | Extra token spend; flip default. | TASK-15 |
| DA7 | `scheduler.maxAgents` default 2. | Subscription limits hit; owner lowers it. | TASK-09 |
