# 0005: Decisions and questions are first-class records; one inbox

- **Status:** Accepted, 2026-11-07
- **Requirements affected:** REQ-HITL-01 … REQ-HITL-07

## Context
The owner's explicit requirement: be told when a decision needs them, and see the decisions the system made. Competitors have no decisions log.

## Decision
Decisions (actor, time, task, rationale) and questions are DB rows, created by agents via `orch decide`/`orch ask` or their JSON block, and by orch for every autonomous choice. Everything needing the owner is an inbox item derived from state, plus a push notification. A question pauses only its task.

## Alternatives rejected
- **Escalation through chat.** Not auditable, easy to miss.
- **Pause the whole run on a question.** Wastes independent work.

## Consequences
- Any new autonomous behaviour MUST record a decision; any new human-needed situation MUST appear in the inbox and notify.
