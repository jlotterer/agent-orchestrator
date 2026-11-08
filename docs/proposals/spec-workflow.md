# Proposal: one spec process for orch

**Status:** design agreed by the owner, 2026-11-08; nothing in Parts 3–4 is built yet. Supersedes the earlier two-tool draft. Decision: [0023](../decisions/0023-orch-owns-spec-skill.md). Part 5 records the design questions and how they were settled.

## Summary

One skill, owned by orch, writes exactly what orch reads. The owner runs one interview per project and one per feature. orch reads the result without an LLM step in between, gives every agent a complete brief, and tells the owner what to fold back when a run finishes.

```
orch-spec (project mode)   →  project record: requirements, architecture, decisions, rules
orch-spec (feature mode)   →  specs/NNN-name/: spec.md, tasks.md, tasks/T00N.md briefs
orch plan → approve → run  →  one PR per task; validator checks brief + rules
orch (end of run)          →  inbox item: "Update project docs"
orch-spec (fold-back mode) →  REQ statuses, new/superseded decisions, architecture
```

Why one tool: every problem in the earlier draft (two interviews, two ID systems, two rule files, two decision stores, a branch mismatch, test-first tasks that can never pass orch's gate, specs cut off mid-requirement) came from the seam between two tools. Removing the seam removes the problems. GitHub Spec Kit folders still import (decision [0008](../decisions/0008-speckit-input-contract.md) stands); they get less context, and the skill can enrich one into briefs.

The key observation: a worker starts with a fresh context and gets one brief, and the validator gets even less. So orch's output is bounded by the per-task brief. requirements-architect's self-contained task brief is the strongest thing it produces, and today orch throws it away and asks the planner to reconstruct it from a one-line task.

---

# Part 1: The owner's workflow

This part is written so it can become a user-guide page when Part 4's wave 1–3 tasks ship.

## Step 0: Set up (once per machine)

- Install orch and an agent CLI it supports. See [Install orch](../user-guide/install.md).
- Install the skill. It ships in this repo under `skills/orch-spec/`; copy or link it into `~/.claude/skills/orch-spec/`. (Packaging for other agent CLIs: open question 1.)

## Step 1: Create the project record (once per project)

In the repo (`git init` first if needed), start the agent and invoke the skill:

```text
/orch-spec
New project. <Idea in two or three sentences.> Users: <who>. Core job: <one sentence>.
Not in scope: <list>. Stack: <stack and versions>, test command: <cmd>.
Riskiest part: <logic>.
```

The skill reads the repo first, then interviews you in rounds of up to four questions. Tips:

- **Non-goals are the most valuable answers you give.** Agents add scope you didn't ask for. Every non-goal becomes a rule validators enforce.
- **Answer the "why" questions properly.** Each decision record is quoted to agents later as the reason not to change something.
- **Say "help me decide"** when you don't know. The skill recommends, and records the alternatives it rejected.
- **Read `REQUIREMENTS.draft.md` between rounds** and edit it directly when something is wrong.

**Creates** (all on the base branch; commit before continuing):

| File | Contents |
| :--- | :--- |
| `AGENTS.md` | Project rules every agent must follow: stack, banned dependencies and patterns, conventions, test command, definition of done. Vendor-neutral, so orch can hand it to any agent and to validators. |
| `CLAUDE.md` | Doc map plus "follow AGENTS.md". Merged into an existing file, never overwritten. |
| `docs/requirements.md` | Objective, users, non-goals, `REQ-<DOMAIN>-NN` tables with a status column, Given/When/Then acceptance criteria, edge cases, glossary. |
| `docs/architecture.md` | Components, data model, contracts, settings, errors, testing approach. |
| `docs/decisions/NNNN-*.md` + index | One record per significant decision: context, decision, rejected alternatives, consequences. |
| `docs/roadmap.md` | Ordered features F01, F02, …: REQ IDs each covers, dependencies, and whether it needs a fixtures-first task. F01 is always the walking skeleton (layout, test command, CI). |

## Step 2: Specify a feature (once per feature)

```text
/orch-spec
Feature F02 from docs/roadmap.md.
```

The skill reads the project record and asks only about the feature: the detail behind each REQ it covers, interfaces that more than one task will share, and edge cases. It then writes the feature folder and runs its own checks (links, sizes, markers, coverage, parallel-file overlap).

**Creates** `specs/002-<name>/` on the base branch:

| File | Contents |
| :--- | :--- |
| `spec.md` | Goal; **Covers** (REQ IDs); **Out of scope** (including later roadmap features); **Contracts**: every interface shared by two or more tasks (signatures, routes, schemas, file formats); **Risky logic** and its fixtures task. |
| `tasks.md` | One line per task in orch's existing import format: `- [ ] T003 [P] Session refresh`. `##` headings are phases. Nothing is added to the format; the task key names its brief. |
| `tasks/T00N.md` | One self-contained brief per task, with YAML frontmatter orch parses. See the contract in Part 2. |

Rules the skill applies without being asked, because it knows how orch runs tasks:

- Tests ship in the same task as the code they test. **No task ends with failing tests**, because orch merges only after the test gate passes. A fixtures-first task adds fixtures and expected outputs with tests marked skipped, and the implementing tasks un-skip them.
- `[P]` only when tasks share no target files. The scaffold task creates shared files up front so later tasks only add files.
- Tasks are small: one reviewable PR each, about 300 changed lines or fewer.
- Every brief cites its REQ IDs; every MUST REQ the feature covers appears in at least one brief.
- Briefs stay inside orch's size limits, so nothing is cut when orch builds the worker's context.
- Nothing is left as `TBD` or `[NEEDS CLARIFICATION]`. Open questions are asked in the interview, not deferred to workers.

Commit the folder to the base branch.

## Step 3: Run the feature with orch

1. Once per project: `orch project add <repo>`, and set `validation.command` in `orch.config.json`.
2. Preview: `orch plan specs/002-<name> --dry-run`. It shows each task, whether it has a brief, its dependencies and parallel marks, and any warnings (file overlap, oversized brief, test-only task).
3. Plan: `orch plan specs/002-<name>`. When every task has a brief, the plan is built from the briefs with no LLM call: instant, free and reproducible. The planner runs only for tasks that lack a brief. Pass `--review` to have the planner review the whole plan anyway; it may add a criterion or fix a dependency, and each change is recorded as a decision with its reason.
4. In the **Plan** tab, check the plan (and anything a `--review` planner changed). You can still edit a task's criteria, dependencies or policy here; such edits live in orch's database, not in the brief, and the end-of-run inbox item lists them so fold-back carries them into the brief. Approve. Start.
5. Answer **Inbox** items as they arrive.

Each worker gets its brief, the REQ rows it cites, the contracts it names, `AGENTS.md`, and the usual hand-off (dependency summaries, decisions, answers, feedback). The validator gets the same brief, rows, contracts and rules, and rejects a change that breaks a rule, quoting it.

## Step 4: Fold the results back (after each run)

When the run completes, the inbox shows **Update project docs** with the REQ IDs the merged tasks covered, the decisions recorded during the run, the plan edits you made in the dashboard, and the contracts that changed. Then:

```text
/orch-spec
Fold back feature F02. <paste the inbox item>
```

The skill sets those REQs to `built`, writes decision records for run decisions that are project-level (and marks superseded ones), carries dashboard plan edits into the briefs, updates `docs/architecture.md` where contracts changed, and updates `AGENTS.md` if a rule changed. Commit, acknowledge the inbox item, and go to Step 2 for the next feature.

**Skip this step and the project record goes stale.** After a few features, new specs contradict old ones and nothing notices. This is the step that keeps a long-lived project coherent.

## Arriving with a Spec Kit folder

`orch plan specs/NNN-name` still works on a plain Spec Kit folder. Workers then get `spec.md`, `data-model.md` and `plan.md` excerpts (in that order, each with its own size budget) instead of briefs, and the planner writes the acceptance criteria as it does today. To get full fidelity, run `/orch-spec adopt specs/NNN-name`: the skill reads the folder and writes a brief per existing task key without changing `tasks.md` keys or ticks.

---

# Part 2: The feature folder contract

The contract lives in [architecture.md §6.4 "Feature folder and brief contract"](../architecture.md#64-feature-folder-and-brief-contract) (moved there by TASK-18), with its executable form in `test/fixtures/spec-dir/`. That section is the single home for the folder layout, the brief frontmatter and sections, the folder checks (errors, warnings, conflicts) and the order and budgets of the context each agent receives. This part is kept as a pointer so links into the proposal keep working.

A complete, reviewed example of a brief is `test/fixtures/spec-dir/full/tasks/T003.md`; the same folder's `spec.md` shows the `## Contracts` section with named contracts, and `test/fixtures/spec-dir/bad/` shows each problem the checks report.

---

# Part 3: Requirements (status `new`)

These rows are now in [docs/requirements.md](../requirements.md) (§5.2, §5.4, §5.5, §5.6 and the new §5.12), with their edge cases and acceptance criteria. The requirements file is the source of truth; this part is kept as the design rationale and may lag it.

## 5.2 Spec Intake & Planning (INTAKE)

| ID | Requirement | Status |
| :--- | :--- | :--- |
| REQ-INTAKE-11 | When a feature directory has `tasks/<key>.md` for a task, orch MUST read it as the task's brief: its frontmatter sets the task's dependencies, parallel flag, merge policy, validation mode and validation command; its target-files section sets owned files; its acceptance-criteria section sets the criteria. Frontmatter takes precedence over `tasks.md` marks, and a conflict is recorded as a decision. A brief whose `orch` format version is missing or unsupported MUST be an import error naming the file. | new |
| REQ-INTAKE-12 | When every task has a brief with acceptance criteria, `orch plan` MUST build the plan from the briefs without calling an agent. When some tasks lack a brief, the planner MUST run for those tasks only. With `--review`, the planner MUST review the whole plan: it MAY add criteria, correct dependencies and raise questions, each recorded as a decision with a reason, and MUST NOT remove or rewrite criteria from a brief. | new |
| REQ-INTAKE-13 | Import MUST refuse a feature directory whose `spec.md` or briefs contain an unresolved marker (`[NEEDS CLARIFICATION`, `TBD`, `TODO`), naming the file and line, unless the owner passes an override flag. | new |
| REQ-INTAKE-14 | Import MUST warn when two parallel tasks name the same target file, when a brief exceeds the configured size, and when a task appears to add only tests. Warnings appear in the preview and are recorded as decisions at plan time. | new |
| REQ-INTAKE-15 | The import preview (REQ-INTAKE-10) MUST show, per task, whether a brief was found and which fields came from it, plus the warnings of REQ-INTAKE-14. | new |

**Behavioral edge cases**
- A brief exists but has no acceptance-criteria section → the planner writes criteria for that task only; a decision records it.
- A brief names a contract that doesn't resolve → import warning naming the brief and the contract.
- `tasks.md` says `[P]` but the brief says `Parallel: no` → the brief wins; decision recorded.
- The feature directory is a plain Spec Kit folder (no `tasks/`) → behaviour as before this change, plus REQ-WORK-10 ordering.

**Acceptance criteria**
- `REQ-INTAKE-11`: Given a folder with T001 (brief: depends on nothing, auto, standard, files `src/a.ts`) and T002 (brief: depends on T001, manual, ui), When planned, Then the plan has exactly those values, T002's criteria equal the brief's list, and no agent was called. Given a brief with `orch: 2`, Then planning fails naming the file.
- `REQ-INTAKE-12`: Given the same folder plus T003 without a brief, When planned, Then the planner is called once and only T003's criteria come from it. Given `--review` and a fake planner that returns rewritten criteria for T001, Then T001 keeps the brief's criteria plus any additions, and a decision records the additions.
- `REQ-INTAKE-13`: Given a brief containing `TBD`, When planning, Then the command fails naming `tasks/T001.md` and the line; with `--allow-open` it proceeds with a decision recorded.
- `REQ-INTAKE-14`: Given T001 `[P]` and T002 `[P]` both listing `src/a.ts`, When previewed, Then the preview warns naming both tasks and the file.

## 5.4 Worker Execution & Context (WORK)

| ID | Requirement | Status |
| :--- | :--- | :--- |
| REQ-WORK-09 | When a task has a brief, the worker's context MUST contain, in this order and each within its own size budget: the brief in full; the requirement rows and acceptance criteria for every REQ ID the brief cites, taken from the project's requirements file (`handoff.requirementsFile`, default `docs/requirements.md`); the contracts the brief names; the project rules files; then the hand-off of REQ-WORK-02. Any cut MUST be marked in the context and recorded as a decision. A cited REQ ID that is not found MUST be noted in the context, not treated as an error. | new |
| REQ-WORK-10 | Without a brief, the spec excerpt of REQ-WORK-02 MUST include `spec.md` before `plan.md`, then other design files (`data-model.md`, `contracts/*`), each file within its own size budget rather than one shared budget. | new |
| REQ-WORK-11 | The project rules files (`handoff.projectFiles`, default `AGENTS.md`) MUST be passed to the planner, workers, task validators and phase validators when present. Their absence is not an error. | new |

**Acceptance criteria**
- `REQ-WORK-09`: Given a brief citing REQ-AUTH-03 and naming contract `SessionStore`, When T003 starts, Then its prompt contains the brief, the REQ-AUTH-03 row and criteria from `docs/requirements.md`, the `SessionStore` section, `AGENTS.md`, and the hand-off, in that order.
- `REQ-WORK-09` (budget): Given a 20,000-character brief and `briefChars: 8000`, Then the prompt contains a truncation marker and a decision names the task and the cut size.
- `REQ-WORK-10`: Given a 15,000-character `plan.md` and a 3,000-character `spec.md` with `specChars: 12000`, Then the worker's prompt contains all of `spec.md`.

## 5.5 Validation (VAL)

| ID | Requirement | Status |
| :--- | :--- | :--- |
| REQ-VAL-10 | The task validator MUST receive the same brief, requirement rows, contracts and project rules as the worker, and never the worker's transcript. | new |
| REQ-VAL-11 | The validator MUST reject a change that breaks a project rule or a named contract, quoting the rule or contract in its verdict; that verdict MUST be recorded as the attempt's feedback. | new |

**Acceptance criteria**
- `REQ-VAL-10`: Given T003 under validation, Then the validator prompt contains the brief, the REQ rows, the contract and `AGENTS.md`, and does not contain the worker's log.
- `REQ-VAL-11` (e2e, fake validator): Given a rule "no new dependencies" and a diff adding one, Then the verdict is a rejection quoting the rule and the attempt's feedback contains it.

## 5.6 Human-in-the-Loop (HITL)

| ID | Requirement | Status |
| :--- | :--- | :--- |
| REQ-HITL-08 | When a run completes, orch MUST create an inbox item "Update project docs" listing the REQ IDs cited by merged tasks, the decisions recorded during the run, the plan edits the owner made in the dashboard (REQ-INTAKE-09), and the contracts named by merged tasks, and MUST send a notification. The item closes when the owner acknowledges it. | new |

**Acceptance criteria**
- `REQ-HITL-08`: Given a run whose merged tasks cite REQ-A-01 and REQ-B-02, recorded two worker decisions, and had T002's merge policy edited to `manual` in the dashboard, When the run completes, Then the inbox has one item listing both IDs, both decisions and the T002 edit, and a notification was sent.

## 5.12 Spec Skill (SPEC) — new domain

**User intent:** As the owner, I want one guided process that writes specs orch can run at full fidelity, so that I never hand-tune files to fit orch.

| ID | Requirement | Status |
| :--- | :--- | :--- |
| REQ-SPEC-01 | The repository MUST ship a skill (`skills/orch-spec/`) with three modes: project (writes the project record of Part 1 Step 1), feature (writes a feature folder conforming to Part 2, with the current `orch` brief version), and fold-back (updates the project record and briefs from a completed run's inbox item). | new |
| REQ-SPEC-02 | In feature mode the skill MUST apply orch's execution rules: tests in the same task as their code and no task that ends with failing tests; fixtures-first tasks ship skipped tests; parallel tasks share no target files; briefs within `handoff.briefChars`; every MUST REQ the feature covers appears in a brief; no unresolved markers. | new |
| REQ-SPEC-03 | The skill MUST include a check script that verifies a feature folder against Part 2 (header fields, links, sizes, markers, coverage, parallel overlap), and `orch plan --dry-run` MUST accept any folder the check script passes without warnings. | new |
| REQ-SPEC-04 | An adopt mode MUST turn an existing Spec Kit feature folder into briefs without changing `tasks.md` task keys or tick state. | new |

**Acceptance criteria**
- `REQ-SPEC-03`: Given the fixture folder `test/fixtures/spec-dir/full/` (written by the skill and reviewed by the owner), Then the check script passes and `orch plan --dry-run` shows no warnings. Given `test/fixtures/spec-dir/bad/`, Then both report the same four problems.
- `REQ-SPEC-04`: Given a Spec Kit folder with T001–T004 and T001 ticked, When adopted, Then `tasks.md` has the same four keys, T001 still ticked, and `tasks/T00N.md` exists for each.
- `REQ-SPEC-01`, `-02`: manual. One real run per mode, recorded in the task brief (prompts are product).

---

# Part 4: Task plan

The briefs are written: [TASK-18](../tasks/TASK-18.md) to [TASK-24](../tasks/TASK-24.md), indexed in [docs/tasks/README.md](../tasks/README.md) and importable from [specs/001-orch-roadmap/tasks.md](../../specs/001-orch-roadmap/tasks.md) (phases 13–17). TASK-18 needs owner review (fixtures) and gets merge policy `manual`.

| Task | Wave | Summary | Covers | Depends on | Parallel |
| :--- | :--- | :--- | :--- | :--- | :--- |
| TASK-18 | 13 | Feature-folder fixtures (`full`, `bad`, `speckit`, `version`) with expected parse output, warnings and context order; Part 2 becomes architecture §6 | INTAKE-11, -13, -14, WORK-09, -10, SPEC-03 (fixtures) | — | Yes |
| TASK-19 | 14 | `skills/orch-spec/`: fork of requirements-architect with project, feature, fold-back and adopt modes; `check-feature.mjs` verified against the fixtures | SPEC-01..04 | 18 | Yes |
| TASK-20 | 14 | `src/core/brief.ts` + `speckit.ts`: frontmatter and brief parsing, version check, folder checks; `--dry-run` output and `--allow-open` | INTAKE-11, -13, -14, -15, SPEC-03 | 18 | Yes |
| TASK-21 | 14 | `src/core/context.ts`: spec context with per-part budgets and REQ-row extraction; new `handoff` settings | WORK-09, -10 | 18 | Yes |
| TASK-22 | 15 | `orchestrator.ts`: plan from briefs without an agent, planner for brief-less tasks, `--review`, rules and contracts in every prompt; one real run | INTAKE-11, -12, -14, WORK-09..11, VAL-10, -11 | 20, 21 | No |
| TASK-23 | 16 | End-of-run "Update project docs" inbox item, notification, ack, CLI | HITL-08 | 22 | No |
| TASK-24 | 17 | User-guide pages, README, status columns, proposal close-out | — | 23 | Yes |

Dogfooding: TASK-19 ships before the orch side is complete, so the skill's first real feature-mode run is on a scratch repo (recorded in its PR). From TASK-25 on, orch's own briefs are written with the skill into `specs/NNN-*/tasks/`.

---

# Part 5: Design questions and how they were settled

Agreed with the owner on 2026-11-08.

| # | Question | Settled as | Why |
| :--- | :--- | :--- | :--- |
| 1 | Skill packaging | Claude Code skill in `skills/` only, for now | The skill's output is plain markdown any agent can read; only the author needs the skill. Revisit when a non-Claude author asks. |
| 2 | Project rules file | `handoff.projectFiles` default `["AGENTS.md"]`; the orch repo sets `["CLAUDE.md"]` for itself | Vendor-neutral and widely recognised; keeps the invariants check (vendor names only in adapters) intact. |
| 3 | Unresolved markers | Refuse the import; `--allow-open` overrides with a decision recorded | The interview exists so nothing reaches a worker unresolved. |
| 4 | REQ ID pattern | Fixed `REQ-<DOMAIN>-NN` | The skill writes it; nothing to configure until a non-skill user needs another style. |
| 5 | Planner default | Deterministic when every task has a brief; planner for brief-less tasks; `--review` to run it on the whole plan | The brief already carries everything the planner would write. Matches decision 0001. The check script and the owner's approval remain the review. |
| 6 | Dashboard plan edits vs brief files | The database stays the source of truth during the run; the end-of-run inbox item lists plan edits and fold-back carries them into the briefs | orch never mutates authored files; the fold-back step is where the record is reconciled anyway. |
| 7 | Skill/parser version drift | `orch: 1` in the brief frontmatter; unsupported version is a clear import error | Silent ignoring of unknown fields would be the worst failure mode. |
| 8 | Location of the requirements file | `handoff.requirementsFile`, default `docs/requirements.md` | Projects that keep it elsewhere still get REQ rows in briefs. |
| 9 | Brief header format | YAML frontmatter (scalars and flow lists only) instead of a bold header line; `tasks.md` stays exactly the Spec Kit format | Standard, unambiguous, trivially parsed without a dependency; the key already names the brief file. |
