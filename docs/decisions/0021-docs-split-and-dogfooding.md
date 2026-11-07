# 0021: Split the handoff doc; orch builds its own roadmap

- **Status:** Accepted, 2026-11-07
- **Requirements affected:** —

## Context
`docs/AGENT_HANDOFF.md` mixed requirements, design and rationale. The roadmap is a good real-world test of orch itself.

## Decision
Requirements, architecture and decision records replace the handoff doc, which becomes a short pointer. The task briefs are also listed in `specs/001-orch-roadmap/tasks.md` so orch can import and run them.

## Alternatives rejected
- **Keep the handoff doc as architecture.** WHAT/HOW/WHY mixed.
- **Briefs only.** Misses the cheapest real-world test.

## Consequences
- Briefs must be self-contained enough for orch's hand-off limits; `tasks.md` lines link to the brief files.
