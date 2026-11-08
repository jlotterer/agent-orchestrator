# TASK-19: The orch-spec skill
**Status:** todo · **Wave:** 14 · **Depends on:** TASK-18 · **Parallel:** Yes

## Goal
Ship the skill that writes what orch reads: `skills/orch-spec/`, forked from the owner's requirements-architect skill, with project, feature, fold-back and adopt modes, and a check script that verifies a feature folder against the brief contract.

## Covers
REQ-SPEC-01, REQ-SPEC-02, REQ-SPEC-03 (check script half), REQ-SPEC-04

## Read first
- [CLAUDE.md](../../CLAUDE.md)
- [requirements.md §5.12](../requirements.md#512-spec-skill-spec)
- [architecture.md §6](../architecture.md#6-spec-intake--planner): the brief contract (added by TASK-18)
- [proposals/spec-workflow.md, Part 1](../proposals/spec-workflow.md#part-1-the-owners-workflow): the owner's workflow the skill must support, including the rules it applies without being asked
- `~/.claude/skills/requirements-architect/` (SKILL.md, templates/, reference/platforms.md): the source to fork. Keep its interview method (ground yourself, scaffold, expand, interview in batches of four, push back, draft file, readiness check).
- `test/fixtures/spec-dir/full/` and `bad/` with their expected outputs (TASK-18)

## Scope
- `skills/orch-spec/SKILL.md`: one skill, four modes chosen from the first message or asked:
  - **project**: the requirements-architect interview, Full output only, writing `AGENTS.md` (rules), `CLAUDE.md` (doc map + "follow AGENTS.md", merged if present), `docs/requirements.md`, `docs/architecture.md`, `docs/decisions/`, `docs/roadmap.md` (features F01…, REQ IDs each covers, dependencies, fixtures-first flag; F01 is the walking skeleton). No per-task briefs in this mode.
  - **feature**: reads the project record, interviews only about the feature, writes `specs/NNN-name/` per the contract (spec.md, tasks.md, tasks/T00N.md with `orch: 1` frontmatter). Applies the rules of REQ-SPEC-02 and says so in its summary.
  - **fold-back**: takes the pasted "Update project docs" inbox item (REQs, decisions, plan edits, contracts); sets REQ statuses, writes or supersedes decision records, carries plan edits into the briefs, updates architecture and `AGENTS.md`.
  - **adopt**: given a Spec Kit folder, writes a brief per existing task key, keeping keys and ticks.
- `skills/orch-spec/templates/`: the forked templates plus `spec.template.md`, `brief.template.md`, `roadmap.template.md`, `agents.template.md`.
- `skills/orch-spec/scripts/check-feature.mjs` (Node, no dependencies): checks a feature folder for frontmatter fields and version, relative links, brief size, markers (in `spec.md`, briefs and `contracts/*.md`, per architecture §6.4), REQ coverage against the requirements file, parallel target-file overlap, test-only tasks (paths under `fixtures/` are not test paths). It also warns when a brief plus the contracts it names exceed 20,000 characters in total, since orch budgets each contract on its own and has no total cap. Exit 0 with no output on success; one line per problem (`file:line: message`) otherwise. Replaces `check_docs.py` for feature folders; keep a Node port of its link check for project mode.
- Feature mode writes each brief's `depends_on` as the full effective list (earlier-phase tasks included, as §6.4 derives it), so a brief reads true on its own, and it never gives a task an acceptance criterion that needs a file owned by another task of the same wave (the `full` fixture's T003/T004 split is the model).
- `test/unit/check-feature.test.mjs`: runs the script against `test/fixtures/spec-dir/full` (passes) and `bad` (reports exactly the four expected problems, matched against the fixture's expected JSON).
- `skills/README.md`: how to install the skill (`~/.claude/skills/orch-spec`), one paragraph per mode.

## Out of scope
orch's own parser and context assembly (TASK-20, TASK-21). Packaging for non-Claude agent CLIs (settled question 1 in the proposal).

## Target files
- `skills/orch-spec/**`
- `skills/README.md`
- `test/unit/check-feature.test.mjs`

## Done when
- Unit: `check-feature.mjs` passes on `full` and reports the four `bad` problems with matching files and lines.
- Manual (prompts are product): the PR description records one real run of **project** mode on a scratch repo and one of **feature** mode producing a folder that the check script passes. Attach the generated `tasks/T001.md`.
- `npm run check` still passes (the skill adds no runtime dependency; no vendor names outside `src/adapters/`).
- `npm run typecheck && npm test` pass; README gains a "Writing specs" pointer to `skills/README.md`; this brief's status line and the task index are updated in the same PR.
