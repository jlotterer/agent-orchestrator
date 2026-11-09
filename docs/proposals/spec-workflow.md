# Proposal: one spec process for orch

**Status:** implemented in TASK-18..26 (decision [0023](../decisions/0023-orch-owns-spec-skill.md)); closed. Design agreed by the owner on 2026-11-08; it superseded an earlier two-tool draft. Parts 1 to 4 now point to where each part lives; Part 5 stays as the record of how the design questions were settled.

## Summary

One skill, owned by orch, writes exactly what orch reads. The owner runs one interview per project and one per feature. orch reads the result without an LLM step in between, gives every agent a complete brief, and tells the owner what to fold back when a run finishes.

```
orch-spec (project mode)   →  project record: requirements, architecture, decisions, rules
orch-spec (feature mode)   →  specs/NNN-name/: spec.md, tasks.md, tasks/T00N.md briefs
orch plan → approve → run  →  one PR per task; validator checks brief + rules
orch (end of run)          →  inbox item: "Update project docs"
orch-spec (fold-back mode) →  REQ statuses, new/superseded decisions, architecture
```

Why one tool: every problem in the earlier draft (two interviews, two ID systems, two rule files, two decision stores, a branch mismatch, test-first tasks that can never pass orch's gate, specs cut off mid-requirement) came from the seam between two tools. GitHub Spec Kit folders still import (decision [0008](../decisions/0008-speckit-input-contract.md) stands); they get less context, and the skill's adopt mode can enrich one into briefs.

---

# Part 1: The owner's workflow

Now the user-guide page [Write specs with the orch-spec skill](../user-guide/how-to/write-specs-with-orch-spec.md), rewritten against what shipped, with [Import a Spec Kit folder](../user-guide/how-to/import-a-spec-kit-folder.md) for the Spec Kit path and adopt mode. The skill's install and modes summary is [skills/README.md](../../skills/README.md).

# Part 2: The feature folder contract

Lives in [architecture.md §6.4 "Feature folder and brief contract"](../architecture.md#64-feature-folder-and-brief-contract), with its executable form in `test/fixtures/spec-dir/`. A complete, reviewed example brief is `test/fixtures/spec-dir/full/tasks/T003.md`.

# Part 3: Requirements

REQ-INTAKE-11..15, REQ-WORK-09..11, REQ-VAL-10..11, REQ-HITL-08 and REQ-SPEC-01..04, with their edge cases and acceptance criteria, are in [docs/requirements.md](../requirements.md) (§5.2, §5.4, §5.5, §5.6 and §5.12), all `built`.

# Part 4: Task plan

The briefs are [TASK-18](../tasks/TASK-18.md) to [TASK-26](../tasks/TASK-26.md), indexed in [docs/tasks/README.md](../tasks/README.md) (waves 13 to 17). TASK-25 and TASK-26 were follow-ups from the TASK-19 review. From TASK-27 on, orch's own briefs are written with the skill into `specs/NNN-*/tasks/`.

---

# Part 5: Design questions and how they were settled

Agreed with the owner on 2026-11-08.

| # | Question | Settled as | Why |
| :--- | :--- | :--- | :--- |
| 1 | Skill packaging | Claude Code skill in `skills/` only, for now | The skill's output is plain markdown any agent can read; only the author needs the skill. Revisit when a non-Claude author asks. |
| 2 | Project rules file | `handoff.projectFiles` default `["AGENTS.md"]`; the orch repo sets `["CLAUDE.md"]` for itself | Vendor-neutral and widely recognised; keeps the invariants check (vendor names only in adapters) intact. |
| 3 | Unresolved markers | Refuse the import; `--allow-open` overrides with a decision recorded | The interview exists so nothing reaches a worker unresolved. |
| 4 | REQ ID pattern | Fixed `REQ-<DOMAIN>-NN` | The skill writes it; nothing to configure until a non-skill user needs another style. |
| 5 | Planner default | Deterministic when every task has a brief; planner for brief-less tasks; `--review` to run it on the whole plan | The brief already carries everything the planner would write. Matches decision 0001. The check script and the owner's approval remain the review. |
| 6 | Dashboard plan edits vs brief files | The database stays the source of truth during the run; the end-of-run inbox item lists plan edits and fold-back carries them into the briefs | orch never mutates authored files; the fold-back step is where the record is reconciled anyway. |
| 7 | Skill/parser version drift | `orch: 1` in the brief frontmatter; unsupported version is a clear import error | Silent ignoring of unknown fields would be the worst failure mode. |
| 8 | Location of the requirements file | `handoff.requirementsFile`, default `docs/requirements.md` | Projects that keep it elsewhere still get REQ rows in briefs. |
| 9 | Brief header format | YAML frontmatter (scalars and flow lists only) instead of a bold header line; `tasks.md` stays exactly the Spec Kit format | Standard, unambiguous, trivially parsed without a dependency; the key already names the brief file. |
