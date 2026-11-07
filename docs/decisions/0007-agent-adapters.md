# 0007: Adapters per agent CLI; vendor code only in adapters

- **Status:** Accepted, 2026-11-07
- **Requirements affected:** REQ-ADAPT-01 … REQ-ADAPT-04, REQ-NFR-04

## Context
The owner refuses vendor lock-in and wants to mix vendors (Claude for coding, Gemini for verification).

## Decision
Each agent CLI has an adapter that launches it headlessly and normalizes its stream into five event kinds. Roles pick an adapter and model. Everything downstream is shared.

## Alternatives rejected
- **Single hard-coded agent.** Lock-in.
- **Chasing many harnesses now.** Breadth over depth; adapters make it a later one-file change.

## Consequences
- New vendor behaviour MUST go through the adapter interface and JSON contracts; `orchestrator.ts` MUST NOT special-case a vendor.
