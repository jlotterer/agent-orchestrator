# orch: handoff (superseded)

This file used to be the all-in-one engineering briefing for orch. On 2026-11-07 its content was split into dedicated documents ([decision 0021](decisions/0021-docs-split-and-dogfooding.md)). Start with [CLAUDE.md](../CLAUDE.md).

| Former section | Now lives in |
| :--- | :--- |
| 1. Purpose and objectives, non-goals | [requirements.md §1–4](requirements.md#1-objective) |
| 2. Design principles P1–P13 | [architecture.md §1](architecture.md#1-design-principles) and [decisions 0001–0009](decisions/README.md) |
| 3. Architecture, file table | [architecture.md §2–3](architecture.md#2-components--data-flow) |
| 4. State machines (run, task, merge, PR feedback loop) | [architecture.md §7.4](architecture.md#74-run-control), [§8](architecture.md#8-task-state-machine), [§11](architecture.md#11-git--merge), [§12](architecture.md#12-pr-feedback-loop) |
| 5. Agent contracts, environment, normalized events | [architecture.md §13](architecture.md#13-agent-adapters--contracts) |
| 6. Data model | [architecture.md §20](architecture.md#20-data-model--persistence) |
| 7. Config | [architecture.md §19](architecture.md#19-settings--environment) |
| 8. What has been verified | [requirements.md](requirements.md) Status column (`built`) and [architecture.md §21.2](architecture.md#212-testing-architecture) |
| 9. Known gaps | Turned into requirements and tasks: [tasks/README.md](tasks/README.md); remaining open items in [requirements.md §7](requirements.md#7-assumptions--open-questions) |
| 10. Roadmap R1–R13 | R1 built ([decision 0010](decisions/0010-pr-feedback-loop.md)); R2, R3, R4, R13 and multi-project planned in [tasks/README.md](tasks/README.md); the rest are non-goals for this round ([requirements.md §4](requirements.md#4-non-goals)) |
| 11. Working agreements | [CLAUDE.md](../CLAUDE.md) Conventions, Banned, Definition of done |
| 12. Quick orientation commands | [CLAUDE.md](../CLAUDE.md) Commands |

The full previous text is in git history (`git log -p -- docs/AGENT_HANDOFF.md`).
