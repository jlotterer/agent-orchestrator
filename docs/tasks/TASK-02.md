# TASK-02: Test harness, invariants check and CI
**Status:** todo · **Wave:** 1 · **Depends on:** — · **Parallel:** Yes (with TASK-01)

## Goal
Give every later task one way to run all tests (`npm test`), shared helpers so new end-to-end scenarios are short, an automated check of the stack invariants (one runtime dependency, vendor names only in adapters), and CI on Linux.

## Covers
REQ-NFR-02, REQ-NFR-03, REQ-NFR-04

## Read first
- [CLAUDE.md](../../CLAUDE.md)
- [requirements.md §6](../requirements.md#6-non-functional-requirements)
- [architecture.md §21.2](../architecture.md#212-testing-architecture)
- [decision 0009](../decisions/0009-locked-stack.md)
- [decision 0007](../decisions/0007-agent-adapters.md)
- Existing: `scripts/e2e.mjs`, `scripts/e2e-pr.mjs`, `scripts/unit.mjs`, `package.json`

## Scope
- Move `scripts/unit.mjs` to `test/unit/prfeedback.test.mjs`, importing from `../../dist/`.
- `package.json` scripts: `test:unit` = `node --test test/unit/`; `check` = `node scripts/check-invariants.mjs`; `test` = `npm run build && npm run test:unit && npm run check && npm run test:e2e`.
- `scripts/lib/e2e.mjs`: `makeRepo({files, origin?})`, `startDaemon({cwd, env, port})` with prefixed logs, `api(port)` returning `(method, path, body)`, `waitFor(fn, {timeoutMs})`, `cleanup()`. Refactor `scripts/e2e.mjs` and `scripts/e2e-pr.mjs` to use it, keeping their assertions unchanged.
- `scripts/check-invariants.mjs`: fail if `package.json` `dependencies` is anything other than exactly `better-sqlite3`. Fail if `/claude|gemini|anthropic/i` appears in `src/**/*.ts` outside `src/adapters/` and the allowlisted defaults in `src/config.ts` (allowlist kept in the script with a comment).
- `.github/workflows/ci.yml`: ubuntu-latest, Node 20 and 22; `npm ci`, `npm run typecheck`, `npm test`.
- Update the Testing section of `README.md` and the Commands section of `CLAUDE.md`.

## Out of scope
New e2e scenarios (TASK-04), fixture runners (TASK-03).

## Target files
- `package.json`
- `test/unit/prfeedback.test.mjs`
- `scripts/unit.mjs (delete)`
- `scripts/lib/e2e.mjs`
- `scripts/e2e.mjs`
- `scripts/e2e-pr.mjs`
- `scripts/check-invariants.mjs`
- `.github/workflows/ci.yml`
- `README.md`
- `CLAUDE.md`

## Done when
- `npm test` passes in a `node:22` container.
- Adding a fake dependency to `package.json` makes `npm run check` exit non-zero (verified locally, described in the PR).
- Adding the string `claude` to `src/orchestrator.ts` makes `npm run check` exit non-zero.
- The CI workflow runs green on the PR.
- Both e2e scenarios keep their existing assertions.
- `npm run typecheck` passes and docs touched by this change (README, architecture, decisions) are updated in the same PR, including this brief's status line.
