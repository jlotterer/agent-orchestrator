# 0023: orch owns its spec skill; Spec Kit remains a compatible import

- **Status:** Accepted, 2026-11-08; implemented in TASK-18..26 (TASK-25 and TASK-26 are follow-ups from the TASK-19 review). Owner's guide: [Write specs with the orch-spec skill](../user-guide/how-to/write-specs-with-orch-spec.md)
- **Requirements affected:** REQ-INTAKE-11..15, REQ-WORK-09..11, REQ-VAL-10, REQ-VAL-11, REQ-HITL-08, REQ-SPEC-01..04 (drafts in [docs/proposals/spec-workflow.md](../proposals/spec-workflow.md))

## Context
orch's output is bounded by the per-task brief: a worker starts with a fresh context and gets one brief, and the validator gets less. Today the brief is a one-line task plus a spec excerpt that is cut at a shared size limit with `plan.md` first, so the requirements are often the part that is lost; the task validator gets no spec at all; design files (`contracts/`) and project rules never reach agents. A two-tool workflow (requirements-architect for the project record, Spec Kit for features) was drafted and rejected: every problem it had to patch (two interviews, two ID systems, two rule files, two decision stores, Spec Kit's test-first tasks that cannot pass orch's gate, a branch mismatch) came from the seam between the tools.

## Decision
orch ships one skill, `skills/orch-spec/` (forked from the owner's requirements-architect), that writes exactly what orch reads: the project record once (requirements with REQ IDs, architecture, decisions, `AGENTS.md` rules, roadmap), and per feature a folder with `spec.md`, `tasks.md` and one self-contained brief per task. Each brief carries YAML frontmatter with a format version (`orch: 1`) and the task's plan fields. orch reads briefs deterministically, builds the plan without an agent when every task has one (the planner runs only for brief-less tasks, or for the whole plan on `--review`), and gives workers and validators the brief, the cited REQ rows, the named contracts and the project rules. Plan edits made in the dashboard stay in the database during the run; when the run completes, orch raises an inbox item listing covered REQs, decisions, plan edits and changed contracts, which drives the skill's fold-back mode. The feature folder is a superset of the Spec Kit layout, so a plain Spec Kit folder still imports (with less context), and an adopt mode enriches one into briefs.

## Alternatives rejected
- **Spec Kit as the only front door.** Familiar, but its tasks are one line, its specs get truncated, its test-first tasks cannot merge under orch's gate, and it has no project-wide record, so decisions get undone and features drift after a few runs.
- **requirements-architect then Spec Kit.** Recovers the project record but doubles the interviews and the sources of truth; coherence then depends on prompt discipline rather than design.
- **Keep the planner as the author of criteria from a richer spec.** Still an LLM reconstructing what the author already knew, and the validator still checks criteria the owner never wrote.

## Consequences
- The skill is product, like `prompts/*.md`: changes need one real run per affected mode.
- The brief header and `tasks/` layout become part of the input contract; parse rules get fixtures under `test/fixtures/spec-dir/` and may not change without owner review ([0020](0020-pure-core-and-fixtures.md)).
- [0008](0008-speckit-input-contract.md) stands: `tasks.md` lines remain the minimum input.
- [0004](0004-independent-validation.md) stands: validators get the brief and rules, never the worker's transcript.
- Project rules are read from a vendor-neutral file (`handoff.projectFiles`, default `AGENTS.md`), so the invariants check still holds.
