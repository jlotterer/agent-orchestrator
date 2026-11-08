# orch: Requirements

> **Scope of this document:** *what* orch must do and how we'll know it does it. *How* it is built lives in [architecture.md](architecture.md). *Why* key choices were made lives in [decisions/](decisions/). Requirement IDs are stable: never renumber; retire an ID instead of reusing it.
>
> **Status column:** `built` = exists today and is covered by tests; agents MUST NOT regress it. `new` = to be built by the tasks in [tasks/](tasks/README.md).

## 1. Objective
One developer builds software with AI coding agents from Spec Kit specs (`spec.md`, `plan.md`, `tasks.md`). Today they act as the orchestrator by hand: one chat per task, one PR per task, merge, repeat. orch replaces that manual loop. It turns a task list into reviewed, merged changes across several projects. The owner only approves plans, answers questions the agents can't resolve, and reviews the merges the plan marks as risky.

Success looks like this:
- a feature's task list runs to merged PRs with the owner touching only inbox items;
- no decision the system made is invisible;
- nothing is lost when an agent session, the daemon, or the server restarts.

## 2. Users & Context
- **One owner** (the only user). They author specs with Spec Kit, run orch on an always-on Linux server (or WSL2/Docker), and use it from a browser on a laptop or phone over a private network.
- **AI agents** (Claude Code primarily; Gemini CLI as an alternative, typically for validation). They are not users, but they call orch's agent-facing commands from inside a task.
- The owner accepts subscription usage limits rather than API billing. They accept that agents run with full permissions inside their isolated working copy. They want no vendor lock-in: open code they own, any agent CLI.

## 3. Core Workflow
1. Owner registers one or more projects (git repos) with orch.
2. Owner writes a feature spec with Spec Kit, producing a `tasks.md`.
3. Owner asks orch to plan the feature. orch imports the tasks; a planner agent adds acceptance criteria, dependencies, merge policy, validation mode and owned files, and logs its decisions.
4. Owner reviews and edits the plan, then approves and starts the run.
5. For each ready task (dependencies done, capacity free):
   1. a worker agent implements it in an isolated working copy with a hand-off brief;
   2. a deterministic test gate runs;
   3. an independent validator agent checks it;
   4. the change is merged, automatically or after owner review.
6. While a PR is open, CI failures and review comments go back to the worker for fix rounds.
7. When a phase completes, orch validates the phase as a whole and creates fix-up tasks if needed.
8. Throughout, anything that needs the owner appears in one inbox, with a push notification. Everything the system decided appears in the decisions log.

## 4. Non-Goals
- **Replacing Spec Kit's planning stage.** orch consumes `tasks.md`; it does not write specs from free text.
- **Running agents in a vendor's cloud.** The owner's server is the persistent machine.
- **Multi-user or multi-tenant use.** One owner, no roles. Auth exists to keep strangers out, not to separate users.
- **An LLM orchestrator.** Scheduling, retries, git and merges stay deterministic code ([0001](decisions/0001-deterministic-orchestrator.md)).
- **More agent CLIs this round** (Codex, OpenCode, Aider): the adapter layer allows them later.
- **Out of this round:** issue trackers as the task source, repo-durable state export, learned conventions, multi-validator consensus, scheduled codebase sweeps, spec PRs before implementation.
- **Spend caps.** Cost is shown, not enforced.
- **Native Windows hosting.** WSL2 or Docker on Windows is supported.

## 5. Functional Requirements
Keywords MUST / SHOULD / MAY follow RFC 2119.

### 5.1 Projects (PROJ)
**User intent:** As the owner, I want one orch to manage all my repos so that I can see and switch between them in one place, without running a server per repo.

| ID | Requirement | Status |
| :--- | :--- | :--- |
| REQ-PROJ-01 | The owner MUST be able to register a project by giving the path of a git repository on the server, from both the CLI and the dashboard. A path that is not a git repository MUST be rejected with a message saying so. | new |
| REQ-PROJ-02 | When a registered project has no project settings file, orch MUST create a starter settings file in the repo and say where it is. | new |
| REQ-PROJ-03 | The owner MUST be able to see every registered project with its name, current run status, and number of open inbox items, and switch the dashboard between projects. | new |
| REQ-PROJ-04 | The owner MUST be able to remove (archive) a project. Archiving MUST NOT delete the repository. The project's history MUST remain stored, and it MUST be possible to re-register the project later. Archiving a project with an active run MUST be refused. | new |
| REQ-PROJ-05 | Per-project settings MUST be read from a file inside the project's repository. Server-wide settings MUST be kept separately and MUST NOT be overridable from a project file in ways that change how agent CLIs are launched or which credentials they get. | built (loaders, TASK-05) / new (daemon uses them, TASK-09) |
| REQ-PROJ-06 | Changes to a project's settings file MUST take effect no later than the next run start for that project, without restarting orch. | new (loader re-reads the file on every call, TASK-05; run-start wiring TASK-09) |
| REQ-PROJ-07 | Each project MUST have at most one unfinished run (planning, awaiting approval, ready, running, or paused). Creating or starting another run in that project while one is unfinished MUST be refused with a message naming the unfinished run. | new |
| REQ-PROJ-08 | Several projects MAY run at the same time. The total number of agent sessions running across all projects MUST NOT exceed a configurable global limit. | new |
| REQ-PROJ-09 | When capacity is scarce, a project with ready tasks MUST NOT wait indefinitely while other projects keep starting tasks. | new |
| REQ-PROJ-10 | An existing single-repo installation MUST be upgraded on first start: its repo becomes a registered project and its existing runs, tasks, decisions and questions remain visible. `[ASSUMED]` | new |

**Edge cases:**
- Registering the same repo twice → refused; the existing project is named.
- A project's repo is moved or deleted on disk → the project shows an error state; its history stays viewable; starting a run is refused.
- The global limit is 1 and two projects have ready tasks → tasks start one at a time, alternating fairly between the projects.
- An invalid project settings file → the error is shown for that project; other projects are unaffected.

**Acceptance criteria:**
- `REQ-PROJ-01`: Given a directory that is a git repo, When the owner runs the add-project command with its path, Then the project appears in the project list. Given a directory that is not a git repo, Then the command fails with a message that it is not a git repository.
- `REQ-PROJ-02`: Given a repo without a settings file, When it is registered, Then a starter settings file exists in the repo and the command output names its path.
- `REQ-PROJ-03`: Given two registered projects, one with an open question, When the owner opens the dashboard, Then both are listed with their run status, the one with the question shows an inbox count of 1, and selecting a project shows its board.
- `REQ-PROJ-04`: Given an archived project, Then it is absent from the default project list, its repo directory still exists, and re-registering the same path restores its run history. Given a project with a running run, When the owner archives it, Then the action is refused.
- `REQ-PROJ-05`: Given a project settings file that tries to set an agent CLI command, When orch loads it, Then that key is rejected with an error naming the key.
- `REQ-PROJ-06`: Given a running orch, When the owner changes the test command in a project's settings file and starts a new run, Then the new run uses the new command.
- `REQ-PROJ-07`: Given a project with a paused run, When the owner creates a new plan in that project, Then it is refused, naming the paused run.
- `REQ-PROJ-08`: Given a global limit of 2 and three projects each with ready tasks, Then at no point are more than 2 agent sessions running.
- `REQ-PROJ-09`: Given a global limit of 1, project A with 5 ready tasks and project B with 1 ready task, Then B's task starts before A's third task.
- `REQ-PROJ-10`: Given an installation created before multi-project support, with one completed run, When orch starts after the upgrade, Then the repo is listed as a project and the completed run is visible with its decisions.

### 5.2 Spec Intake & Planning (INTAKE)
**User intent:** As the owner, I want to hand orch my Spec Kit task list and get a reviewed, enriched plan so that every task has clear acceptance criteria and a correct order before any agent starts.

| ID | Requirement | Status |
| :--- | :--- | :--- |
| REQ-INTAKE-01 | orch MUST import tasks from a feature directory's `tasks.md`. Each line of the form `- [ ] T001 …` becomes a task. A `[P]` marker means "may run in parallel with siblings". `##` headings define phases. `- [x]` tasks are imported as already done. | built |
| REQ-INTAKE-02 | orch MUST derive dependencies as follows: a task depends on every task in earlier phases; a task without `[P]` also depends on the previous task in its phase; text such as "depends on T003", "after T003" or "requires T003" adds an explicit dependency. | built |
| REQ-INTAKE-03 | A feature directory without `tasks.md`, or whose `tasks.md` contains no tasks, MUST be rejected with a message saying which. | built |
| REQ-INTAKE-04 | When planning is requested with the planner, a planner agent MUST propose, per task: acceptance criteria, dependencies, a merge policy (automatic or owner review), an optional task-specific test command, a validation mode (standard or UI), and the files or globs the task owns. Proposals referring to unknown tasks MUST be ignored. | built (criteria, deps, policy, command) / new (mode, files) |
| REQ-INTAKE-05 | The planner's decisions MUST be recorded in the decisions log with their rationale. | built |
| REQ-INTAKE-06 | If the planner fails or returns nothing usable, the plan MUST fall back to the imported tasks unchanged, and that fallback MUST be recorded as a decision. | built |
| REQ-INTAKE-07 | Questions the planner raises about the spec as a whole MUST appear in the inbox as plan questions, not attached to any single task. While a plan question is open, no task of that run may start. | new |
| REQ-INTAKE-08 | A plan MUST wait for the owner's approval before any task runs. | built |
| REQ-INTAKE-09 | Before approval, and afterwards for tasks that have not started, the owner MUST be able to edit a task's acceptance criteria, dependencies, merge policy, test command, validation mode, owned files and attempt limit. Each edit MUST be recorded as a human decision. | built (except mode, files) |
| REQ-INTAKE-10 | The owner SHOULD be able to preview the imported tasks, phases and dependencies of a feature directory without creating a run or calling an agent. | new |

**Edge cases:**
- `tasks.md` uses `*` bullets, indentation, or 2–4 digit IDs → still imported.
- A dependency names a task that doesn't exist → that dependency is dropped.
- A task depends on itself → that dependency is dropped.
- A dependency cycle (introduced by the planner or an edit) → `[ASSUMED]` the plan cannot be approved, and the cycle is named.
- Every task is already ticked → the run is created with all tasks done and finishes immediately when started.

**Acceptance criteria:**
- `REQ-INTAKE-01`: Given a `tasks.md` with phases "Setup" (T001) and "Core" (T002 [P], T003 [P], T004) and T005 ticked, When imported, Then five tasks exist, with T002/T003 parallel, T004 not parallel, T005 done, and each task's phase set.
- `REQ-INTAKE-02`: Given the same file and "T002 … (depends on T001)", Then T002, T003 and T004 depend on T001, T004 also depends on T003, and T002 does not depend on T003.
- `REQ-INTAKE-03`: Given a directory without `tasks.md`, When planning, Then the error names the missing `tasks.md`.
- `REQ-INTAKE-04`: Given a planner that returns criteria, merge policy "manual" and owned files for T004, Then T004 shows those criteria, manual policy and owned files in the plan view. Given a planner entry for an unknown task T999, Then no task is created or changed for it.
- `REQ-INTAKE-05`: Given a planner decision "Marked T004 manual" with a rationale, Then the decisions log shows it with actor "planner" and the rationale.
- `REQ-INTAKE-06`: Given a planner that exits with an error, Then the run is awaiting approval with the imported tasks, and the log has an orchestrator decision about the fallback.
- `REQ-INTAKE-07`: Given a planner question about the spec, Then the inbox shows a plan question not labelled with a task. When the run is started before it is answered, Then no task starts until it is answered.
- `REQ-INTAKE-08`: Given a plan awaiting approval, When the owner tries to start it, Then it is refused until approved.
- `REQ-INTAKE-09`: Given a plan awaiting approval, When the owner changes T002's acceptance criteria, Then the plan shows the new criteria and the decisions log has a human decision naming T002.
- `REQ-INTAKE-10`: Given a feature directory, When the owner requests a preview, Then the tasks, phases and dependencies are printed and no run exists afterwards.

### 5.3 Scheduling & Run Control (SCHED)
**User intent:** As the owner, I want tasks to run in a safe order and as parallel as is safe, and I want to pause or stop at any time so that I stay in control without babysitting.

| ID | Requirement | Status |
| :--- | :--- | :--- |
| REQ-SCHED-01 | A task MUST start only when all of these hold: its dependencies are done or skipped; it has no open questions; no plan question is open; its project's parallel limit has room; the global agent limit has room. | built (except plan questions, global limit) |
| REQ-SCHED-02 | Two tasks whose owned files overlap MUST NOT run at the same time, even if both are ready. When orch holds one back for this reason, it MUST record a decision naming both tasks and show the implicit ordering in the plan view. | new |
| REQ-SCHED-03 | Pausing a run MUST let running agent sessions finish and start nothing new until resumed. | built |
| REQ-SCHED-04 | Stopping a run MUST end its running agent sessions and return their tasks to pending, keeping their working copies and commits. | built |
| REQ-SCHED-05 | When orch restarts, tasks that were mid-attempt MUST return to pending with their working copies kept, and runs that were planning MUST become awaiting approval. No completed work may be lost. | built |
| REQ-SCHED-06 | A run MUST become done when every task is done or skipped, and the owner MUST be notified. | built |
| REQ-SCHED-07 | When nothing in a run can progress without the owner, orch MUST say so once in the activity stream, naming the blocked tasks and why. | built |
| REQ-SCHED-08 | Answers given while a run is paused MUST take effect when the run resumes. | built |

**Edge cases:**
- A dependency is skipped → its dependants may start.
- A task is stopped by the owner mid-validation → it returns to pending, and the next attempt re-validates the existing commits.
- Overlap is declared in globs → orch errs on the side of not running the tasks together.

**Acceptance criteria:**
- `REQ-SCHED-01`: Given T002 depending on T001 (running) and a parallel limit of 2, Then T002 does not start until T001 is done.
- `REQ-SCHED-02`: Given ready tasks T002 owning `src/auth/**` and T003 owning `src/auth/login.ts`, with a parallel limit of 2, Then they run one after the other, and the decisions log has an orchestrator decision naming T002 and T003.
- `REQ-SCHED-03`: Given a running task, When the run is paused, Then the task finishes its attempt and no new task starts.
- `REQ-SCHED-04`: Given a running worker, When the run is stopped, Then the agent process ends within a few seconds, the task is pending, and its branch keeps its commits.
- `REQ-SCHED-05`: Given a task running when orch is killed, When orch starts again, Then the task is pending, its working copy exists, and the activity stream says why.
- `REQ-SCHED-06`: Given the last task merges, Then the run status is done and a "run complete" notification is sent.
- `REQ-SCHED-07`: Given every unfinished task is waiting on a question or a failed task, Then exactly one "waiting on you" entry lists them.
- `REQ-SCHED-08`: Given a question answered while the run is paused, When the run resumes, Then the task continues with the answer.

### 5.4 Worker Execution & Context (WORK)
**User intent:** As the owner, I want each task done by a fresh agent that still knows what earlier tasks did so that context is never lost but never bloated.

| ID | Requirement | Status |
| :--- | :--- | :--- |
| REQ-WORK-01 | Each task MUST be worked on in its own isolated working copy and branch, created from the project's base branch. | built |
| REQ-WORK-02 | Each worker attempt MUST receive a brief containing: the task and its criteria; an excerpt of the feature's spec and plan; summaries of completed tasks (direct dependencies in full, others shortened); the decisions log so far; the owner's answers so far; and feedback from the previous attempt. The brief MUST stay within configured size limits. | built |
| REQ-WORK-03 | When an attempt is retried, and resuming is enabled and supported by the agent CLI, the worker MUST continue its previous session rather than start fresh. | built |
| REQ-WORK-04 | A failed attempt (worker reports failure, test gate fails, validator rejects, timeout, crash) MUST be retried with the failure as feedback, up to the task's attempt limit. After that, the task MUST become failed and appear in the inbox. | built |
| REQ-WORK-05 | Uncommitted changes left by a worker MUST be committed before validation. An attempt that produced no commits MUST count as failed. | built |
| REQ-WORK-06 | The worker's final summary, touched files and decisions MUST be recorded, so later tasks' briefs can use them. If the worker gives no summary, the task still proceeds and later briefs say no summary was given. | built |
| REQ-WORK-07 | An agent session that exceeds the configured time limit MUST be ended and counted as a failed attempt. | built |
| REQ-WORK-08 | The project's configured files (e.g. `.env`) MUST be copied into each new working copy, and its setup command run there. A failing setup command MUST fail the attempt with its output as feedback. | built |

**Edge cases:**
- The agent CLI can't be found → the attempt fails with "failed to start '<command>'".
- The agent is rate-limited by its vendor → a failed attempt, retried; then the inbox.
- The brief exceeds limits → it is truncated with a visible "truncated" marker, not dropped.

**Acceptance criteria:**
- `REQ-WORK-01`: Given two tasks running in parallel, Then each has its own directory and branch, and neither sees the other's uncommitted changes.
- `REQ-WORK-02`: Given T003 depends on T001 (done, with a summary) and T002 (done), Then T003's brief contains T001's full summary, a shortened T002 summary, the decisions log and the owner's answers.
- `REQ-WORK-03`: Given a validator rejection on attempt 1 and resume enabled, Then attempt 2 resumes the same agent session and its prompt contains the rejection reasons.
- `REQ-WORK-04`: Given an attempt limit of 2 and two test-gate failures, Then the task is failed and the inbox shows it with the last failure output.
- `REQ-WORK-05`: Given a worker that edits files without committing, Then a commit exists on the task branch before validation. Given a worker that changes nothing, Then the attempt fails with "no commits".
- `REQ-WORK-06`: Given a worker summary for T001, Then the task view shows it and T002's brief includes it.
- `REQ-WORK-07`: Given a 1-minute limit and an agent that runs for 2 minutes, Then it is ended and the attempt is failed with a timeout message.
- `REQ-WORK-08`: Given a setup command that exits 1, Then the attempt fails and the feedback contains the command's output.

### 5.5 Validation (VAL)
**User intent:** As the owner, I want every change checked by something other than the agent that wrote it so that "done" means verified, not claimed.

| ID | Requirement | Status |
| :--- | :--- | :--- |
| REQ-VAL-01 | Before any validator agent runs, the task's test command (task-specific, else the project's) MUST run in the task's working copy. A non-zero exit MUST fail the attempt, with the command's output as feedback. | built |
| REQ-VAL-02 | When the validator agent is enabled, a validator agent MUST run in a fresh session. It receives the task, its criteria, the worker's summary (as claims to check), the diff, and the test-gate output. It MUST NOT receive the worker's reasoning or conversation. | built (gate output new) |
| REQ-VAL-03 | The validator's verdict MUST be PASS or FAIL, with evidence for each acceptance criterion. Anything other than PASS MUST fail the attempt, with the reasons and unmet criteria as feedback. | built |
| REQ-VAL-04 | The validator MUST be able to run on a different agent CLI and model from the worker. | built |
| REQ-VAL-05 | The validator MUST report edits outside the task's owned files as a finding in its verdict. Such edits MUST NOT by themselves cause a FAIL. | new |
| REQ-VAL-06 | When every task in a phase is done or skipped, orch MUST validate the phase as a whole on the base branch: the project's phase test command, then a phase validator agent given the phase's tasks and the spec. The result MUST be recorded as a decision. | new |
| REQ-VAL-07 | When phase validation fails, orch MUST create a fix-up task describing the failure. Tasks of later phases MUST wait for it, and its creation MUST be recorded as a decision. After a configured number of failed fix-up rounds for a phase, the phase MUST go to the inbox instead. | new |
| REQ-VAL-08 | A task in UI validation mode MUST be validated against the running application: orch starts the app from the task's working copy using the project's start command; waits until it responds or a time limit passes; gives the validator the app's address; and stops the app afterwards, including when the task is stopped or orch shuts down. | new |
| REQ-VAL-09 | If the app in UI mode does not become ready in time, the attempt MUST fail with the app's output as feedback. If the validator reports it cannot drive a browser, the task MUST go to the inbox as failed without further retries. | new |

**Edge cases:**
- No test command is configured → the gate is skipped; the validator still runs.
- The validator agent is disabled → the gate alone decides.
- The validator returns no verdict → treated as FAIL, with its text as feedback.
- Phase validation is disabled in project settings → phases complete without it.
- The start command's port is already in use → orch picks a free port and passes it to the app.

**Acceptance criteria:**
- `REQ-VAL-01`: Given a test command `sh check.sh` that exits 1, Then the attempt fails and the feedback contains the script's output.
- `REQ-VAL-02`: Given a gate that passes with output "12 tests passed", Then the validator's prompt contains that output, the diff and the worker's summary, and contains none of the worker's assistant messages.
- `REQ-VAL-03`: Given a validator verdict FAIL with one unmet criterion, Then the next attempt's feedback lists that criterion as UNMET.
- `REQ-VAL-04`: Given the worker on Claude and the validator on Gemini, Then the activity stream shows the validator started on the Gemini adapter.
- `REQ-VAL-05`: Given T002 owns `src/auth/**` and its diff also edits `README.md`, Then the verdict lists `README.md` as out of scope, and a PASS stays PASS.
- `REQ-VAL-06`: Given phase "Core" with tasks all done, Then a phase validation runs once on the base branch, and its result appears as a decision.
- `REQ-VAL-07`: Given phase validation of "Core" fails, Then a fix-up task appears in the plan with the failure as its description, and tasks of the next phase do not start until it is done.
- `REQ-VAL-08`: Given a UI-mode task and a start command, Then while the validator runs the app answers at the address given to the validator, and after the verdict no app process remains.
- `REQ-VAL-09`: Given a start command that never answers, Then after the readiness time limit the attempt fails with the app's output in the feedback.

### 5.6 Human-in-the-Loop (HITL)
**User intent:** As the owner, I want to be told exactly when I'm needed, and to see every decision the system made, so that I can walk away and still stay in control.

| ID | Requirement | Status |
| :--- | :--- | :--- |
| REQ-HITL-01 | One inbox MUST list everything that needs the owner across all projects, each item labelled with its project: plan approvals, open questions (task and plan), failed tasks, tasks awaiting review or merge (including merge failures and PR problems), and phases needing the owner. Each item MUST offer its relevant actions. | built (single project) / new (all projects, labels, phase items) |
| REQ-HITL-02 | Every new inbox item and every run completion MUST trigger a push notification (when configured) whose text names the project and the task. | built (project name new) |
| REQ-HITL-03 | A worker MUST be able to ask the owner a question, optionally with answer options. Only that task pauses, the owner is notified, and after the answer the worker continues in its own session. Answering MUST NOT consume an attempt. | built |
| REQ-HITL-04 | Agents MUST be able to record a decision with a rationale without pausing. | built |
| REQ-HITL-05 | The decisions log MUST show every decision by planner, worker, validator, orchestrator and owner, in order, with actor, time, task (if any) and rationale. | built |
| REQ-HITL-06 | Every choice orch makes on its own MUST be recorded as an orchestrator decision. That includes retrying, holding back a task for file overlap, starting a PR fix round, merging, creating a fix-up task, and falling back from the planner. | built (overlap, fix-up new) |
| REQ-HITL-07 | The owner MUST be able to do the following to a task: retry from scratch, skip, stop, merge now, mark as merged elsewhere, and send it back with written feedback. Each action MUST be recorded as a human decision. | built (send back new) |

**Edge cases:**
- Notifications are not configured → the inbox still works; nothing else changes.
- The notification service is unreachable → logged; orch continues.
- A question is answered twice → the second answer is refused.

**Acceptance criteria:**
- `REQ-HITL-01`: Given project A with a failed task and project B with an open question, When the owner opens the inbox, Then both items appear, labelled A and B, with Retry/Skip and answer actions respectively.
- `REQ-HITL-02`: Given notifications configured, When a task in project "shop" fails, Then a notification is sent whose title or body contains "shop" and the task key.
- `REQ-HITL-03`: Given a worker asks "English or French?" with two options, Then only that task is paused, the inbox shows both options, and after "French" is chosen the same session continues and its attempt count is unchanged.
- `REQ-HITL-04`: Given a worker records a decision with a rationale, Then the decisions log shows it with actor "worker" and the task, and the task continues.
- `REQ-HITL-05`: Given a completed run, Then the decisions log lists entries from planner, worker, validator, orchestrator and human in chronological order.
- `REQ-HITL-06`: Given a retry after a validator rejection, Then an orchestrator decision "Retrying <task> (attempt 2/2)" exists.
- `REQ-HITL-07`: Given a task awaiting review, When the owner sends it back with "rename the flag to --force", Then the worker resumes with that text as feedback, and a human decision records it.

### 5.7 Git & Merge (GIT)
**User intent:** As the owner, I want one branch and one PR per task, merged the way I would merge them, so that history stays clean and parallel work doesn't collide.

| ID | Requirement | Status |
| :--- | :--- | :--- |
| REQ-GIT-01 | Working copies MUST live outside the project repository. A retried task MUST reuse its working copy and branch. A done or skipped task's working copy MUST be removed. | built |
| REQ-GIT-02 | In local-merge mode, a validated task MUST be merged into the base branch of the project's main checkout (squash or fast-forward per settings). If the main checkout is not on the base branch, or has uncommitted tracked changes, the task MUST go to the inbox with that reason. | built |
| REQ-GIT-03 | In PR mode, a validated task MUST be pushed and get a PR (reusing an open PR for its branch). Tasks with automatic policy are merged by orch; tasks with review policy wait for the owner. | built |
| REQ-GIT-04 | A failure in the merge step (conflict, rejected push, missing permission) MUST put the task in the inbox with the error, without consuming worker attempts. | built |
| REQ-GIT-05 | After a task merges, orch MUST tick it in the feature's `tasks.md` on the base branch, never on task branches. In local-merge mode the tick is committed; in PR mode it is left as an uncommitted change. | built |
| REQ-GIT-06 | Merges into the same project's main checkout MUST NOT interleave. | built |

**Edge cases:**
- A task branch already exists after a crash → it is reused.
- `tasks.md` lives outside the repo → no tick, no error.
- The PR for a branch was closed earlier → a new PR is opened.

**Acceptance criteria:**
- `REQ-GIT-01`: Given a task done in local mode, Then its working copy directory no longer exists and its branch is deleted.
- `REQ-GIT-02`: Given local mode with an uncommitted change to a tracked file in the main checkout, Then the validated task goes to the inbox with a message about the unclean working tree.
- `REQ-GIT-03`: Given PR mode and review policy, Then a PR exists and the inbox shows the task with the PR link.
- `REQ-GIT-04`: Given a merge conflict, Then the task is in the inbox with the conflict message and its attempt count is unchanged.
- `REQ-GIT-05`: Given T001 merged in local mode, Then `tasks.md` on the base branch has `- [x] T001` in a commit, and no task branch modifies `tasks.md`.
- `REQ-GIT-06`: Given two tasks finishing validation at the same moment, Then both merge, one after the other, with no corrupted index.

### 5.8 PR Feedback Loop (PRFB)
**User intent:** As the owner, I want CI failures and my PR comments to go straight back to the agent so that I review results, not chase red builds.

| ID | Requirement | Status |
| :--- | :--- | :--- |
| REQ-PRFB-01 | In PR mode, with waiting for checks enabled, an automatic-policy task MUST NOT be merged until its PR's checks pass for the commit orch pushed (or the PR has no checks after a grace period). | built |
| REQ-PRFB-02 | When checks fail on a commit orch pushed, orch MUST send the failed check names and an excerpt of their logs to the worker as a fix round, at most once per commit. | built |
| REQ-PRFB-03 | A "changes requested" review, or a comment with a line starting with the configured trigger (default `/orch`), MUST start a fix round. The fix round carries every new comment by a human since the last round, including inline comments with their file and line. Comments by bots and ignored authors MUST NOT start a round. | built |
| REQ-PRFB-04 | A PR merged outside orch MUST mark the task done. A PR closed without merging MUST mark the task failed. | built |
| REQ-PRFB-05 | Fix rounds MUST have their own limit, separate from attempts. When it is reached, further feedback MUST go to the inbox. | built |
| REQ-PRFB-06 | Instead of merging or starting a round, orch MUST put the task in the inbox when: a fix round produced no new commits; checks stay pending past a time limit; a "changes requested" review is still open after a fix; or the PR branch has commits that conflict with orch's branch. | built |
| REQ-PRFB-07 | Commits pushed to the PR branch by someone else that only add to orch's branch MUST be included before the next fix round. | built |

**Edge cases:**
- Checks that are still running when another check fails → the round starts on the first failure.
- GitHub hasn't registered the new push yet → treated as pending, never as a pass.
- `gh` is temporarily failing → logged once per distinct error; retried next poll.

**Acceptance criteria:**
- `REQ-PRFB-01`: Given an automatic task whose PR check is pending, Then the task waits in "Waiting on CI" and is merged only after the check passes.
- `REQ-PRFB-02`: Given a failing check with a log, Then the worker's next prompt contains the check name and the log tail, and a second poll of the same commit does not start another round.
- `REQ-PRFB-03`: Given comments "/orch mention the reviewer" (human), "/orch ignore me" (bot) and an inline comment on `impl/x.txt:1`, Then a round starts, and its feedback contains the human comment and `impl/x.txt:1` but not "ignore me".
- `REQ-PRFB-04`: Given a review-policy PR merged on GitHub by the owner, Then within one poll the task is done.
- `REQ-PRFB-05`: Given a limit of 2 rounds used up, When CI fails again, Then the task is in the inbox and no round starts.
- `REQ-PRFB-06`: Given a fix round with no new commits, Then the task is in the inbox with "no new commits".
- `REQ-PRFB-07`: Given a reviewer pushed a commit on top of orch's branch, Then the next round's working copy contains that commit.

### 5.9 Agent Adapters (ADAPT)
**User intent:** As the owner, I want to choose which agent CLI and model does each job so that I'm not locked to a vendor and can mix them.

| ID | Requirement | Status |
| :--- | :--- | :--- |
| REQ-ADAPT-01 | The planner, worker and validator roles (and the phase validator) MUST each be assignable to an agent CLI and model independently, at server level, with per-project overrides choosing among the server's configured CLIs. | built (server level) / new (project overrides, phase validator) |
| REQ-ADAPT-02 | orch MUST run Claude Code and Gemini CLI headlessly in a working copy, with the prompt, an optional model, and session resume. | built |
| REQ-ADAPT-03 | Agent output MUST be shown live in the task view as one uniform stream: agent text, tool calls, tool results, errors, and session info including reported cost. | built |
| REQ-ADAPT-04 | Agents MUST be able to use orch's agent-facing commands (decide, ask) from inside a task without any installation step, and those commands MUST act on the right task. | built |

**Edge cases:**
- An agent ends without the expected structured block → its text is still recorded; the step is treated as failed (validator) or summary-less (worker).
- The CLI emits a malformed line → shown as raw text; the run continues.

**Acceptance criteria:**
- `REQ-ADAPT-01`: Given the server sets the validator to Gemini and project X overrides the validator to Claude, Then X's validators run on Claude and other projects' on Gemini.
- `REQ-ADAPT-02`: Given each adapter, Then an end-to-end run with the matching fake CLI completes planning, work, validation and resume.
- `REQ-ADAPT-03`: Given a running worker, Then its tool calls appear in the task view while it runs, without reloading.
- `REQ-ADAPT-04`: Given a worker runs `orch ask "…"`, Then the question is attached to that worker's task.

### 5.10 Interfaces (UI)
**User intent:** As the owner, I want a dashboard and a CLI that show the plan, progress, decisions and code changes, and let me act, so that I can run everything from a browser or a terminal.

| ID | Requirement | Status |
| :--- | :--- | :--- |
| REQ-UI-01 | The dashboard MUST show, for the selected project and run: a board of tasks by status, the plan (editable where allowed), the decisions log, the activity stream, and a task view with the live agent log. All of it updates live without reloading. | built |
| REQ-UI-02 | After a lost connection, the dashboard MUST reconnect live updates automatically and refresh its state. | new |
| REQ-UI-03 | The task view MUST show the task's code changes against its base: the list of changed files with added/removed line counts, and each file's diff, collapsible. | new |
| REQ-UI-04 | For a task awaiting review, the owner MUST be able to send it back to the worker with written feedback from the task view (see REQ-HITL-07). | new |
| REQ-UI-05 | The owner MUST be able to view past runs of a project. | built |
| REQ-UI-06 | The dashboard MUST show cost and agent time per task, per run and per project where the agent CLI reports them, and "n/a" where it doesn't. | new |
| REQ-UI-07 | The CLI MUST offer the owner's main actions: register, list and archive projects; plan (and preview); approve; run, pause, stop; status; answer; retry, skip, merge. Commands MUST act on the project given explicitly, else the project whose repo contains the current directory, else the only project. Otherwise they fail, listing the projects. | built (actions) / new (projects, scoping) |
| REQ-UI-08 | CLI commands MUST exit 0 on success, 1 on failure (with the error on stderr), and 2 on usage errors. `[ASSUMED]` | new |

**Edge cases:**
- Very large diffs → truncated with a visible notice and the total size.
- Binary files in a diff → listed without content.
- A project's repo is missing → its views show the error; other projects work.

**Acceptance criteria:**
- `REQ-UI-01`: Given a task changes status, Then its card moves lanes in an open dashboard within a few seconds without reloading.
- `REQ-UI-02`: Given the daemon restarts while the dashboard is open, Then within 30 seconds after it is back the dashboard shows live updates again without a manual reload.
- `REQ-UI-03`: Given a task that changed two files, Then the task view lists both with +/− counts, and expanding one shows its diff with added and removed lines distinguished.
- `REQ-UI-04`: Given a task awaiting review, When the owner submits feedback in the task view, Then the task leaves the inbox and its next worker prompt contains the feedback.
- `REQ-UI-05`: Given a project with two finished runs, Then the owner can select either and see its board and decisions.
- `REQ-UI-06`: Given a run whose agents reported $0.10 and $0.05, Then the run shows $0.15. Given a validator CLI that reports no cost, Then its cost shows "n/a".
- `REQ-UI-07`: Given two projects and a terminal inside project B's repo, When `orch status` runs without a project flag, Then it shows B. Given a terminal outside both, Then it fails listing both projects.
- `REQ-UI-08`: Given `orch answer` without arguments, Then the exit code is 2.

### 5.11 Operations & Security (OPS)
**User intent:** As the owner, I want orch to be safe to leave running on a server, and to stay healthy for months, so that I can rely on it without maintaining it.

| ID | Requirement | Status |
| :--- | :--- | :--- |
| REQ-OPS-01 | When an access token is configured, every API request, live-update stream and dashboard action MUST require it. The CLI and agents MUST send it automatically, and the dashboard MUST ask for it once per browser. | new |
| REQ-OPS-02 | orch MUST refuse to start listening on a non-local network address without an access token, unless the owner explicitly opts out in server settings. `[ASSUMED]` | new |
| REQ-OPS-03 | A health check MUST be available without the token, reporting that orch is up and its version. `[ASSUMED]` | new |
| REQ-OPS-04 | Agent event logs of runs that finished more than a configured number of days ago MUST be archived to compressed files on the server, then removed from the live store. Decisions, questions, task summaries and verdicts MUST be kept. | new |
| REQ-OPS-05 | Stored data from earlier versions MUST be upgraded automatically on start, without data loss. | built (columns) |
| REQ-OPS-06 | orch MUST run as a systemd service and in Docker, keeping all of its state in one data directory. | built (per repo; ORCH_HOME layout in src/paths.ts, TASK-05) / new (daemon keeps all state there, TASK-09) |
| REQ-OPS-07 | The access token and notification credentials MUST NOT be written to the store, the event log, or agent prompts. | new |

**Edge cases:**
- The token is wrong → 401, with no detail about why.
- The archive directory is not writable → events are not deleted; an error is logged.
- A run is unfinished → its events are never archived, regardless of age.

**Acceptance criteria:**
- `REQ-OPS-01`: Given a token is configured, When a request without it hits a run-control endpoint, Then it is refused with 401. When the CLI runs with the token in its environment, Then it succeeds.
- `REQ-OPS-02`: Given host `0.0.0.0` and no token, When orch starts, Then it exits with an error explaining the options.
- `REQ-OPS-03`: Given a token is configured, When the health check is requested without it, Then it answers successfully with the version.
- `REQ-OPS-04`: Given a run finished 40 days ago and a 30-day retention, When archiving runs, Then its events are in a compressed file under the data directory and gone from the store, and its decisions are still shown.
- `REQ-OPS-05`: Given a database from the previous version, When orch starts, Then it starts, and all previous runs are readable.
- `REQ-OPS-06`: Given the Docker setup, When the container is rebuilt, Then all projects, runs and logins survive.
- `REQ-OPS-07`: Given a configured token and ntfy token, Then neither string appears in the database file or any agent prompt.

## 6. Non-Functional Requirements
| ID | Category | Requirement | How Verified |
| :--- | :--- | :--- | :--- |
| REQ-NFR-01 | Reliability | A daemon crash or restart MUST lose no recorded state; at most the in-flight agent attempt is redone. | e2e: kill daemon mid-task, restart, run completes |
| REQ-NFR-02 | Maintainability | orch MUST keep exactly one runtime dependency (SQLite binding) unless a decision record approves another; the dashboard MUST need no build step. | `npm run check` (scripts/check-invariants.mjs) in CI on every PR |
| REQ-NFR-03 | Portability | orch MUST run on Linux and in Docker; development and tests MUST also work on macOS and WSL2. | CI on Linux (`.github/workflows/ci.yml`, Node 22 and 24); e2e in `node:22` container |
| REQ-NFR-04 | Vendor independence | Agent-vendor-specific code MUST live only in the adapter layer. | `npm run check`: vendor names outside `src/adapters/` fail CI (allowlisted defaults in `src/config.ts`) |
| REQ-NFR-05 | Determinism | Scheduling, state transitions and PR-loop decisions MUST be decided by pure functions with fixture-driven tests. | `test/unit/core.test.mjs` runs every fixture table; `npm run check` keeps `src/core/` free of fs, child processes, DB and clock reads |
| REQ-NFR-06 | Performance | The dashboard state for a run of 200 tasks MUST load in under 1 second on the server, regardless of the size of the event log. | unit/perf test with seeded DB |
| REQ-NFR-07 | Observability | Every task state change MUST appear in the activity stream with a reason. | e2e assertions on events |
| REQ-NFR-08 | Safety | orch MUST refuse to run as root where the agent CLI requires a non-root user, and MUST document that agents have full permissions in their working copy. | Docker image runs as uid 1000; README |

## 7. Assumptions & Open Questions
| ID | Type | Statement | Impact if Wrong |
| :--- | :--- | :--- | :--- |
| A1 | Product | One owner, many projects; no multi-user. | Auth model and inbox ownership change. |
| A2 | Product | Deployed on an always-on Linux server reached over a private network. | Auth hardening (TLS, rate limiting) becomes required. |
| A3 | Product | Claude Code is the primary worker; Gemini mainly validates. | Adapter test priority. |
| A5 | Product `[ASSUMED]` | Single-repo installs upgrade automatically (REQ-PROJ-10). | Manual migration steps needed. |
| A6 | Product `[ASSUMED]` | Non-local bind requires a token unless overridden (REQ-OPS-02). | First-run friction, or exposure. |
| A7 | Product `[ASSUMED]` | Cost is display-only. | Spend caps need requirements. |
| A8 | Product `[ASSUMED]` | CLI exit codes 0/1/2 (REQ-UI-08). | Scripts relying on other codes. |
| A9 | Product `[ASSUMED]` | Health check is unauthenticated (REQ-OPS-03). | Leaks version string. |
| A10 | Product `[ASSUMED]` | A plan with a dependency cycle cannot be approved. | Runs that deadlock instead. |
| Q1 | Open | The Gemini adapter has not run against a live Gemini account. | Validator prompt tuning; not blocking. |

Design-level assumptions are tracked in [architecture.md](architecture.md#22-design-assumptions).

## 8. Glossary
| Term | Meaning |
| :--- | :--- |
| Project | A registered git repository that orch manages, with its own settings file. |
| Run | One execution of one feature's plan in one project. |
| Task | One `tasks.md` item, or a fix-up task orch created. One branch, one working copy, one PR. |
| Attempt | One worker session plus its validation for a task. Limited by the attempt limit. |
| Fix round | A worker attempt triggered by PR feedback (CI, review, owner) after validation passed. Limited separately. |
| Test gate | The deterministic test command run before the validator agent. |
| Validator | An independent agent session that checks a task's diff against its criteria. |
| Phase validation | A check of a whole phase on the base branch after all its tasks finish. |
| Fix-up task | A task orch creates when phase validation fails. |
| Owned files | Files or globs a task declares it will change; used to prevent overlapping parallel work. |
| Inbox | The list of everything that needs the owner, across projects. |
| Decision | A recorded choice with actor, time, task and rationale. |
| Brief / hand-off | The context assembled for a worker: task, spec excerpt, prior summaries, decisions, answers, feedback. |
| Merge policy | `auto` (orch merges when validated and green) or `manual` (owner reviews). |
| Global agent limit | The maximum number of concurrent agent sessions across all projects (`maxAgents`). |
