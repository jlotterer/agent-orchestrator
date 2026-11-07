# 0004: A deterministic gate, then an independent validator

- **Status:** Accepted, 2026-11-07
- **Requirements affected:** REQ-VAL-01, REQ-VAL-02, REQ-VAL-03, REQ-VAL-04

## Context
The owner wants validation separate from implementation (maker/checker). Agents overclaim. Tests are cheap and non-negotiable; judgement about acceptance criteria is not.

## Decision
The project's test command runs first. Then a validator agent in a fresh session sees the task, criteria, the worker's summary as claims, the diff and the gate output, never the worker's reasoning. It must cite evidence per criterion and does not fix code. It may run on a different vendor or model.

## Alternatives rejected
- **Validator only.** Spends tokens on what a test run catches.
- **Worker self-check.** No independence.
- **CI only (Agent Orchestrator).** No criterion-level judgement.

## Consequences
- Validator prompts MUST NOT receive worker transcripts.
- A non-PASS verdict always fails the attempt.
