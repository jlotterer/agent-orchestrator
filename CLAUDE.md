# orch: Agent Guide

orch is a self-hosted orchestrator for AI coding agents, used by one owner across several projects. It imports a Spec Kit `tasks.md`, has a planner add acceptance criteria, then runs each task as worker → deterministic test gate → independent validator → PR/merge. It shows everything in a dashboard with one inbox for decisions that need the owner. The orchestrator itself is deterministic code; agents are disposable; SQLite is the source of truth.

## Where things are
| Doc | Use it for |
| :--- | :--- |
| [docs/requirements.md](docs/requirements.md) | **What** orch must do: REQ IDs (`built` / `new`), acceptance criteria, non-goals. It changes rarely. |
| [docs/architecture.md](docs/architecture.md) | **How** it is built: components, state machine, contracts, settings, data model, testing. |
| [docs/decisions/](docs/decisions/) | **Why** key choices were made. Read these before proposing to change the stack or the approach. |
| [docs/tasks/](docs/tasks/) | One brief per task, plus [the index](docs/tasks/README.md). Same tasks for orch itself: `specs/001-orch-roadmap/`. |
| `test/fixtures/` | Executable spec for the risky logic (parser, readiness, transitions, PR poll). Created by TASK-01. |
| [README.md](README.md), [docs/docker.md](docs/docker.md) | User manual and container guide. |

**Code is the source of truth for contracts:** `src/types.ts`, `src/db.ts` (schema), `src/config.ts` (settings), `src/server.ts` (HTTP API), `prompts/*.md` (agent JSON contracts), `src/core/*` (decision logic). If code and architecture.md disagree, follow the code and fix the doc in the same PR.

## Stack (locked; see [0009](docs/decisions/0009-locked-stack.md))
- TypeScript (strict, NodeNext ESM), compiled with `tsc` to `dist/`; Node ≥ 20
- Runtime dependency: `better-sqlite3` only. HTTP via `node:http`, no framework
- Dashboard: single `dashboard/index.html`, vanilla JS, no build step
- Tests: `node:test` (unit, against `dist/`), `scripts/e2e*.mjs` (end-to-end with fake agents and a fake `gh`)

## Commands
- Install: `npm ci`
- Build: `npm run build` · Typecheck: `npm run typecheck`
- Run: `node dist/cli.js serve` (dashboard on :4800)
- Unit tests: `npm run test:unit` (needs a build first)
- E2E: `npm run test:e2e`. It needs Linux/macOS. On Windows, run it in Docker (`node:22`); see README "Testing".
- Before finishing any change: `npm run typecheck && npm run build && npm run test:unit && npm run test:e2e` (TASK-02 folds this into `npm test`).

## Conventions
- `src/core/` is pure: no `node:fs`, `node:child_process`, DB access, or clock reads. Time and facts are passed in. `orchestrator.ts` gathers facts, calls core, performs side effects.
- Vendor-specific code only in `src/adapters/`. `orchestrator.ts` never special-cases a vendor.
- Every autonomous choice orch makes is recorded with `decide()`. Every situation needing the owner appears in the inbox **and** sends a notification.
- Never write ticks or orch state into task branches; base branch or DB only.
- Secrets (tokens, adapter env) never go into the DB, the event log, or prompts.
- Prompts are product: changes to `prompts/*.md` need one real run, not only the fake agent.
- Keep e2e green; add a `fake-agent.mjs` marker or a `fake-gh.mjs` case for every new lifecycle path.
- Scripts keep LF line endings (`.gitattributes`). Executables need the git exec bit (`git update-index --chmod=+x`).

## Banned
- New runtime dependencies, web frameworks, ORMs, bundlers, or a UI build step: [0009](docs/decisions/0009-locked-stack.md) (a new record is required to change this)
- LLM calls in scheduling, retries, merges or the PR loop: [0001](docs/decisions/0001-deterministic-orchestrator.md)
- Giving validators the worker's transcript: [0004](docs/decisions/0004-independent-validation.md)
- Changing a fixture's expected output without owner review: [0020](docs/decisions/0020-pure-core-and-fixtures.md)

## Working on a task
1. Read your brief in `docs/tasks/TASK-NN.md`, then only the sections it links to.
2. Stay inside the brief's scope and target files. If you need to change something outside them, raise it in the PR instead of doing it.
3. Write tests for every acceptance criterion the task lists.
4. Don't reverse a decision record silently. Propose a new record instead.

## Definition of done
- Typecheck, unit and e2e tests pass.
- Every acceptance criterion cited by the task has an automated test, or a documented manual step if the brief marks it as manual.
- No banned dependency or pattern is introduced.
- **Docs are updated in the same PR** if behaviour, contracts or defaults changed (requirements status column, architecture section, README), along with the brief's status line.
