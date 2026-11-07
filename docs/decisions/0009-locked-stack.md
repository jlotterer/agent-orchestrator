# 0009: Locked stack: TypeScript, Node ≥ 20, one runtime dependency, no-build dashboard

- **Status:** Superseded by [0022](0022-node-22-floor.md) for the Node version (≥ 22); otherwise Accepted, 2026-11-07
- **Requirements affected:** REQ-NFR-02, REQ-NFR-03

## Context
The owner wants a small codebase they own and can read; deployment is a single server.

## Decision
TypeScript strict ESM compiled by `tsc`, Node ≥ 20, `better-sqlite3` as the only runtime dependency, `node:http` (no framework), `node:test` for unit tests, and a single `dashboard/index.html` with vanilla JS and no build step.

## Alternatives rejected
- **Web framework (Express/Fastify).** Unneeded for a dozen routes.
- **React/Vite dashboard.** Build step and dependency tree.
- **ORM.** Hides SQL for a small schema.
- **Jest/Vitest.** Node:test suffices.

## Consequences
- Adding a runtime dependency or a UI build step requires a new decision record.
