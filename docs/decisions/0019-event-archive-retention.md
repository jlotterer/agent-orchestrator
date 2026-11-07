# 0019: Archive event logs to compressed files, then delete

- **Status:** Accepted, 2026-11-07
- **Requirements affected:** REQ-OPS-04, REQ-NFR-06

## Context
Agent event logs (every tool call) grow without bound; decisions and summaries are small and valuable.

## Decision
Events of runs finished more than N days ago (default 30) are exported to gzip JSONL under `ORCH_HOME/archive`, then deleted in one transaction. Decisions, questions, task rows and costs are kept. Costs are stored on rows so totals don't depend on events.

## Alternatives rejected
- **Keep everything, manual prune.** Unbounded growth.
- **Plain delete.** Loses forensic detail.

## Consequences
- Never delete before the archive file is durably written.
