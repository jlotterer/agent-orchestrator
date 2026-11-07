# 0002: All state lives in SQLite owned by the daemon

- **Status:** Accepted, 2026-11-07
- **Requirements affected:** REQ-SCHED-05, REQ-NFR-01, REQ-OPS-05

## Context
The owner's first requirement is to prevent loss of context. Agent sessions are disposable and may crash, time out or be rate-limited. The daemon may restart.

## Decision
Runs, tasks, events, decisions, questions, projects and phases live in one SQLite database (better-sqlite3, WAL) owned by the daemon. Agents write only through orch's API.

## Alternatives rejected
- **State in agent memory / long chat.** Lost on crash, unbounded context.
- **Files in the repo as the database.** Conflicts across parallel branches; see roadmap R6 for an export, not a replacement.
- **A server database (Postgres).** An extra service to run for a one-owner tool.

## Consequences
- Recovery is a DB read. Schema changes need versioned migrations (architecture §20).
- Agents MUST NOT keep orch state in task branches or memory files.
