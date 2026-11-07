# 0003: Fresh context per role invocation, with a bounded hand-off brief

- **Status:** Accepted, 2026-11-07
- **Requirements affected:** REQ-WORK-02, REQ-WORK-03, REQ-WORK-06

## Context
Attention degrades over long trajectories; fresh, narrow contexts are the core insight of Missions and Ralph-style loops. But each worker must still know what earlier tasks did.

## Decision
Every planner, worker attempt, validator and phase validator starts a fresh session. Workers receive a hand-off brief (task, criteria, spec excerpt, prior summaries, decisions, answers, feedback) capped by configurable sizes. Retries and answered questions resume the worker's own session.

## Alternatives rejected
- **One long session per run.** Context bloat and drift.
- **Shared memory store queried by agents.** More moving parts, unbounded, hard to audit.

## Consequences
- Worker summaries matter: the JSON contract requires one.
- Agents MUST keep brief assembly bounded; new context goes in with a cap.
