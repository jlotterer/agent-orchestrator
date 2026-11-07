# Implementation Plan: orch roadmap

See `docs/architecture.md` (module layout §3, state machine §8, testing §21.2) and `docs/tasks/README.md` (waves, dependencies, coverage).

Stack is locked (`docs/decisions/0009-locked-stack.md`): TypeScript strict ESM, Node ≥ 20, `better-sqlite3` only, `node:test`, single-file dashboard without a build step.

Test command for every task: `npm run typecheck && npm test` (e2e needs Linux/macOS; on Windows use a `node:22` container).
