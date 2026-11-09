<!--
Template notes (do not copy into the output):
- CLAUDE.md is loaded by the author's own Claude Code sessions. orch does not hand it to agents; it hands
  AGENTS.md (vendor-neutral). So this file is a doc map plus "follow AGENTS.md", nothing more. Keep it short.
- If a CLAUDE.md already exists, MERGE: add the "Where things are" table and the AGENTS.md line, keep every
  existing section, never overwrite the user's content.
-->
# <Project Name>: Agent Guide

<One paragraph: what it is, who it is for, the core workflow.>

**Follow [AGENTS.md](AGENTS.md).** It holds the stack, commands, rules, banned list and definition of done for every change; orch hands it to every agent and validators enforce it.

## Where things are
| Doc | Use it for |
| :--- | :--- |
| [docs/requirements.md](docs/requirements.md) | **What** it must do: REQ IDs with a status column, acceptance criteria, non-goals. Changes rarely. |
| [docs/architecture.md](docs/architecture.md) | **How** it is built: components, data model, contracts, settings, testing. |
| [docs/decisions/](docs/decisions/) | **Why** key choices were made. Read the record before proposing to change the stack or the approach. |
| [docs/roadmap.md](docs/roadmap.md) | The ordered features, the REQ IDs each covers, and their status. |
| `specs/NNN-<name>/` | One folder per feature: `spec.md`, `tasks.md`, one brief per task under `tasks/`. Written with `/orch-spec`; run with `orch plan`. |
| <fixtures path, if any> | Executable spec for <risky logic>. |

Once code exists, **code is the source of truth for contracts** (<list the key contract files>). If code and architecture.md disagree, follow the code and fix the doc in the same change.

## Working on a task
1. Read your brief (`specs/NNN-<name>/tasks/T00N.md`), the requirement rows it cites and the contracts it names, then only what they link to.
2. Stay inside the brief's target files. Raise anything outside them in the PR instead of changing it.
3. Write a test for every acceptance criterion in the brief.
4. Never reverse a decision record silently. Propose a new record.
