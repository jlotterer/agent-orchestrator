# Task Index

Each task is a self-contained brief for one agent session and one PR. Start with [CLAUDE.md](../../CLAUDE.md), then read the brief, then only the sections it links to.

**Parallel = Yes** means the task shares no target files with the other Yes tasks in the same wave, so it can run in its own worktree at the same time.

**Status values:** `todo` · `in-progress` · `done`. Update the status line in the brief in your PR.

**Running these with orch itself:** [specs/001-orch-roadmap/tasks.md](../../specs/001-orch-roadmap/tasks.md) lists the same tasks in Spec Kit format (one phase per wave), so `orch plan specs/001-orch-roadmap` imports them. TASK-01 needs the owner's review: give it merge policy `manual`.

**Hot files:** `src/orchestrator.ts`, `dashboard/index.html`, `src/server.ts` and `src/cli.ts` are touched by most feature tasks, which is why waves 5–12 are sequential. **Shared doc files** (`README.md`, `docs/architecture.md`, `docs/requirements.md`, `docs/user-guide/feature-status.md`) are touched by nearly every task: in wave 14 three parallel tasks conflicted there. Parallel tasks should add their doc lines in task-specific places (their own §, row or page) and the last one to merge resolves the shared paragraphs.

| Task | Wave | Area | Summary | Depends on | Parallel |
| :--- | :--- | :--- | :--- | :--- | :--- |
| [TASK-01](TASK-01.md) | 1 | Fixtures | Fixture tables (no code) for parser, extractJson, readiness, transitions, PR poll; owner reviews | — | Yes |
| [TASK-02](TASK-02.md) | 1 | Tooling | test/unit layout, shared e2e helpers, `npm test`, invariants script, GitHub Actions CI | — | Yes |
| [TASK-03](TASK-03.md) | 2 | Core | src/core readiness/transitions/prpoll; orchestrator calls them; fixtures drive unit tests | 01, 02 | Yes |
| [TASK-04](TASK-04.md) | 2 | Regression | e2e-lifecycle scenarios: stop, crash recovery, timeout, setup/no-commit failures, pause, conflicts | 02 | Yes |
| [TASK-05](TASK-05.md) | 3 | Config | ServerConfig + ProjectConfig loaders, forbidden keys, ORCH_HOME paths, legacy adapter | 03 | Yes |
| [TASK-06](TASK-06.md) | 3 | Review | GET diff, request-changes fix round (kind human), dashboard diff viewer + Send back | 03 | Yes |
| [TASK-07](TASK-07.md) | 4 | Data | user_version migrations, projects/phases tables, new columns, registry module | 05 | Yes |
| [TASK-08](TASK-08.md) | 4 | Security | auth.ts gate, /api/health, /api/login cookie, CLI/agent token, dashboard login, bind guard | 05 | Yes |
| [TASK-09](TASK-09.md) | 5 | Projects | Daemon manages projects: per-project config/git, one run per project, maxAgents, fairness, legacy upgrade | 03, 07, 08 | No |
| [TASK-10](TASK-10.md) | 6 | API/CLI | /api/projects*, /api/inbox, project state; CLI project commands, --project, exit codes; perf | 09 | No |
| [TASK-11](TASK-11.md) | 7 | Dashboard | Project switcher, add/archive, global inbox with tags, run history, SSE backoff reconnect | 10 | Yes |
| [TASK-12](TASK-12.md) | 7 | Ops | archive.ts: gzip JSONL export of old runs' events, then delete; CLI + daily timer | 07, 09 | Yes |
| [TASK-13](TASK-13.md) | 8 | Planning | Plan-level questions (task_id NULL) block task starts; `--dry-run`; approval refuses cycles | 11, 12 | No |
| [TASK-14](TASK-14.md) | 9 | Scheduling | Planner files_owned, ownedOverlap, scheduler serialization + decision, validator scope findings | 13 | No |
| [TASK-15](TASK-15.md) | 10 | Validation | phases.ts, phase validator prompt/role, detached base worktree, synthetic FIX tasks, inbox item | 14 | No |
| [TASK-16](TASK-16.md) | 11 | Validation | appserver.ts lifecycle, validator-ui prompt, validate_mode, BLOCKED verdict, gate output to validator | 15 | No |
| [TASK-17](TASK-17.md) | 12 | Ops | Persist cost/agent_ms per task and run; rollups per run/project; dashboard tiles | 16 | No |
| [TASK-18](TASK-18.md) | 13 | Fixtures | Feature-folder fixtures (briefs, warnings, context order) and the brief contract in architecture §6; owner reviews | — | Yes |
| [TASK-19](TASK-19.md) | 14 | Skill | `skills/orch-spec/`: project, feature, fold-back and adopt modes; `check-feature.mjs` | 18 | Yes |
| [TASK-20](TASK-20.md) | 14 | Core | `src/core/brief.ts`: frontmatter and brief parsing, folder checks; `--dry-run` shows briefs and warnings | 18 | Yes |
| [TASK-21](TASK-21.md) | 14 | Core | `src/core/context.ts`: spec context with per-part budgets, REQ-row extraction; new `handoff` settings | 18 | Yes |
| [TASK-25](TASK-25.md) | 15 | Regression | Make `e2e-phase` scenario (d) deterministic: CI on `main` is intermittently red since before wave 14 | — | No |
| [TASK-26](TASK-26.md) | 15 | Skill | orch-spec follow-ups: overlap rule equal to `brief.ts`, cross-check test over every fixture, adopt-mode real run | 19, 20 | Yes |
| [TASK-22](TASK-22.md) | 15 | Planning | (done) Plan from briefs without an agent; `--review`; rules and contracts in worker, validator and phase prompts | 20, 21 | No |
| [TASK-23](TASK-23.md) | 16 | HITL | (done) End-of-run "Update project docs" inbox item, notification, ack, CLI | 22 | No |
| [TASK-24](TASK-24.md) | 17 | Docs | User-guide pages for the spec workflow; README; status columns; close out the proposal | 23 | Yes |

## Waves at a glance
```
W1  01 02
W2  03 04
W3  05 06
W4  07 08
W5  09
W6  10
W7  11 12
W8  13
W9  14
W10 15
W11 16
W12 17
W13 18
W14 19 20 21
W15 25 22 26
W16 23
W17 24
```

Waves 13–17 implement [decision 0023](../decisions/0023-orch-owns-spec-skill.md) (authored briefs and the `orch-spec` skill); the design is in [proposals/spec-workflow.md](../proposals/spec-workflow.md). TASK-18 needs the owner's review: give it merge policy `manual`. TASK-25 and TASK-26 are follow-ups found in the TASK-19 review (a pre-existing flaky e2e scenario that keeps CI red, and drift between the skill's checker and orch's).

## Requirement Coverage
| Requirement | Covered by |
| :--- | :--- |
| REQ-PROJ-01 | TASK-07, TASK-10 |
| REQ-PROJ-02 | TASK-07 |
| REQ-PROJ-03 | TASK-10, TASK-11 |
| REQ-PROJ-04 | TASK-07, TASK-10 |
| REQ-PROJ-05 | TASK-05 |
| REQ-PROJ-06 | TASK-05, TASK-09 |
| REQ-PROJ-07 | TASK-09 |
| REQ-PROJ-08 | TASK-01, TASK-09 |
| REQ-PROJ-09 | TASK-01, TASK-09 |
| REQ-PROJ-10 | TASK-09 |
| REQ-INTAKE-01 | TASK-01, TASK-03 |
| REQ-INTAKE-02 | TASK-01, TASK-03 |
| REQ-INTAKE-03 | TASK-04 |
| REQ-INTAKE-04 | TASK-14, TASK-16 |
| REQ-INTAKE-05 | TASK-04 |
| REQ-INTAKE-06 | TASK-04 |
| REQ-INTAKE-07 | TASK-13 |
| REQ-INTAKE-08 | TASK-04 |
| REQ-INTAKE-09 | TASK-04, TASK-14, TASK-16 |
| REQ-INTAKE-10 | TASK-13 |
| REQ-INTAKE-11 | TASK-18, TASK-20, TASK-22 |
| REQ-INTAKE-12 | TASK-22 |
| REQ-INTAKE-13 | TASK-18, TASK-20 |
| REQ-INTAKE-14 | TASK-18, TASK-20, TASK-22 |
| REQ-INTAKE-15 | TASK-20 |
| REQ-SCHED-01 | TASK-01, TASK-03, TASK-09, TASK-13 |
| REQ-SCHED-02 | TASK-14 |
| REQ-SCHED-03 | TASK-04 |
| REQ-SCHED-04 | TASK-04 |
| REQ-SCHED-05 | TASK-04 |
| REQ-SCHED-06 | TASK-04 |
| REQ-SCHED-07 | TASK-04 |
| REQ-SCHED-08 | TASK-04 |
| REQ-WORK-01 | TASK-04 |
| REQ-WORK-02 | TASK-04 |
| REQ-WORK-03 | TASK-03, TASK-04 |
| REQ-WORK-04 | TASK-04 |
| REQ-WORK-05 | TASK-04 |
| REQ-WORK-06 | TASK-04 |
| REQ-WORK-07 | TASK-04 |
| REQ-WORK-08 | TASK-04 |
| REQ-WORK-09 | TASK-18, TASK-21, TASK-22 |
| REQ-WORK-10 | TASK-18, TASK-21, TASK-22 |
| REQ-WORK-11 | TASK-22 |
| REQ-VAL-01 | TASK-04 |
| REQ-VAL-02 | TASK-16 |
| REQ-VAL-03 | TASK-04 |
| REQ-VAL-04 | TASK-04 |
| REQ-VAL-05 | TASK-14 |
| REQ-VAL-06 | TASK-15 |
| REQ-VAL-07 | TASK-15 |
| REQ-VAL-08 | TASK-16 |
| REQ-VAL-09 | TASK-16 |
| REQ-VAL-10 | TASK-22 |
| REQ-VAL-11 | TASK-22 |
| REQ-HITL-01 | TASK-10, TASK-11, TASK-15 |
| REQ-HITL-02 | TASK-09 |
| REQ-HITL-03 | TASK-04 |
| REQ-HITL-04 | TASK-04 |
| REQ-HITL-05 | TASK-04 |
| REQ-HITL-06 | TASK-04, TASK-14, TASK-15 |
| REQ-HITL-07 | TASK-06 |
| REQ-HITL-08 | TASK-23 |
| REQ-GIT-01 | TASK-04 |
| REQ-GIT-02 | TASK-04 |
| REQ-GIT-03 | TASK-06 |
| REQ-GIT-04 | TASK-04 |
| REQ-GIT-05 | TASK-04 |
| REQ-GIT-06 | TASK-04 |
| REQ-PRFB-01 | TASK-01, TASK-03 |
| REQ-PRFB-02 | TASK-01, TASK-03 |
| REQ-PRFB-03 | TASK-01, TASK-03 |
| REQ-PRFB-04 | TASK-01, TASK-03 |
| REQ-PRFB-05 | TASK-01, TASK-03 |
| REQ-PRFB-06 | TASK-01, TASK-03 |
| REQ-PRFB-07 | TASK-01, TASK-03 |
| REQ-ADAPT-01 | TASK-09, TASK-15 |
| REQ-ADAPT-02 | TASK-04 |
| REQ-ADAPT-03 | TASK-04 |
| REQ-ADAPT-04 | TASK-04 |
| REQ-UI-01 | TASK-11 |
| REQ-UI-02 | TASK-11 |
| REQ-UI-03 | TASK-06 |
| REQ-UI-04 | TASK-06 |
| REQ-UI-05 | TASK-11 |
| REQ-UI-06 | TASK-17 |
| REQ-UI-07 | TASK-10 |
| REQ-UI-08 | TASK-10 |
| REQ-OPS-01 | TASK-08 |
| REQ-OPS-02 | TASK-08 |
| REQ-OPS-03 | TASK-08 |
| REQ-OPS-04 | TASK-12 |
| REQ-OPS-05 | TASK-07 |
| REQ-OPS-06 | TASK-05, TASK-09 |
| REQ-OPS-07 | TASK-08 |
| REQ-NFR-01 | TASK-04, TASK-25 |
| REQ-NFR-02 | TASK-02 |
| REQ-NFR-03 | TASK-02 |
| REQ-NFR-04 | TASK-02 |
| REQ-NFR-05 | TASK-01, TASK-03 |
| REQ-SPEC-01 | TASK-19, TASK-23 (fold-back real run), TASK-26 (adopt real run) |
| REQ-SPEC-02 | TASK-19 |
| REQ-SPEC-03 | TASK-18, TASK-19, TASK-20, TASK-26 |
| REQ-SPEC-04 | TASK-19, TASK-26 |
| REQ-NFR-06 | TASK-10 |
| REQ-NFR-07 | TASK-04, TASK-25 |
| REQ-NFR-08 | TASK-08 |
