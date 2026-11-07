# 0001: The orchestrator is deterministic code, not an LLM

- **Status:** Accepted, 2026-11-07
- **Requirements affected:** REQ-SCHED-01, REQ-HITL-06, REQ-NFR-05

## Context
Competing tools (Factory Missions, Agent Orchestrator) make the orchestrator itself an agent. Factory's own numbers put orchestration at ~2% of a 16-hour mission: it does not need to be clever, it needs to be reliable. The owner must be able to predict and debug what the system does.

## Decision
Scheduling, retries, git, merges, PR polling and phase handling are plain TypeScript. A model is called only for the planner, worker, validator and phase-validator roles.

## Alternatives rejected
- **Orchestrator as an LLM agent.** Less predictable, harder to debug, costs tokens on every step, and its choices are hard to audit.

## Consequences
- Behaviour is reproducible from DB state and fixtures.
- Agents MUST NOT add LLM calls to scheduling, retry, merge or PR-loop logic. New judgement needs go to a role prompt or to the owner (inbox).
