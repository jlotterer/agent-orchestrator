# 0022: Raise the Node floor to 22

- **Status:** Accepted, 2026-11-07
- **Supersedes:** [0009](0009-locked-stack.md) (Node version only; the rest of 0009 stands)
- **Requirements affected:** REQ-NFR-02, REQ-NFR-03

## Context
0009 set Node ≥ 20. The locked runtime dependency, `better-sqlite3@13`, declares `engines.node >=22` and its native binding segfaults on Node 20 (found by TASK-02 when running `npm test` in a `node:20` container). Node 20 reached end-of-life in April 2026. The Docker image already uses `node:22`.

## Decision
The stack is unchanged from 0009 except that the floor is **Node ≥ 22**: TypeScript strict ESM compiled by `tsc`, `better-sqlite3` as the only runtime dependency, `node:http`, `node:test`, and a single no-build `dashboard/index.html`. `package.json` `engines` says `>=22`; CI runs on Node 22 and 24.

## Alternatives rejected
- **Pin `better-sqlite3` to 12.x to keep Node 20.** Holds back the only dependency to support an end-of-life runtime.
- **Keep claiming Node ≥ 20.** It is already false; installs on Node 20 crash at the first DB open.

## Consequences
- Node 22 APIs (e.g. `path.matchesGlob`, glob patterns in `node --test`) can be used without fallbacks, which settles assumption DA1 in architecture §22.
- Adding a runtime dependency or a UI build step still requires a new decision record.
