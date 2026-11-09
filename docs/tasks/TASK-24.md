# TASK-24: Document the spec workflow
**Status:** todo · **Wave:** 17 · **Depends on:** TASK-23 · **Parallel:** Yes

## Goal
Owners can follow the whole process from the user guide: write the project record, write a feature, run it, fold the results back. Everything the guide says is shipped; the proposal is closed out as implemented.

## Covers
— (documentation for REQ-INTAKE-11..15, REQ-WORK-09..11, REQ-VAL-10..11, REQ-HITL-08, REQ-SPEC-01..04)

## Read first
- [CLAUDE.md](../../CLAUDE.md)
- [proposals/spec-workflow.md, Part 1](../proposals/spec-workflow.md#part-1-the-owners-workflow): the draft of the page
- `docs/user-guide/` (index, how-to layout, settings and CLI references) and the `user-docs` skill conventions already used there
- `skills/README.md` (TASK-19), the shipped CLI flags (TASK-20, TASK-22, TASK-23) and settings (TASK-21): the page must match the code, not the proposal

## Scope
- `docs/user-guide/how-to/write-specs-with-orch-spec.md`: Part 1 rewritten against what shipped, with real command output. Add it to `docs/user-guide/index.md` and the quickstart's "In real use…" note.
- `docs/user-guide/how-to/import-a-spec-kit-folder.md`: the lower-fidelity path and `adopt` mode.
- `docs/user-guide/reference/`: new settings and flags (`--review`, `--allow-open`, `orch docs-update`) if the earlier tasks left gaps.
- `docs/user-guide/feature-status.md`: the new features. Remove the "Coming later" section entirely (since TASK-19 and TASK-22 it mixes shipped and planned rows) and the "Not planned" bullet about spec writing that now names the skill; everything on the page is shipped.
- `README.md`: revise the "Writing specs" section TASK-19 added (do not add a second one) so it points to the skill and the new guide page and says nothing about the planner writing criteria.
- `docs/requirements.md`: status column of the REQs above → `built (TASK-NN)`; §5.2 user intent updated (briefs, not only Spec Kit).
- `docs/proposals/spec-workflow.md`: status line → implemented; Parts 1–4 reduced to pointers to the guide, architecture §6 and the briefs; keep Part 5 (settled questions) as the record.
- `docs/decisions/0023`: status line → note "implemented in TASK-18..26" (TASK-25 and TASK-26 are follow-ups from the TASK-19 review).
- `skills/README.md`: check it against the guide page; the guide is the manual, the skills README stays the install and modes summary.
- `docs/tasks/README.md`: note that from TASK-27 on, orch's own briefs live in `specs/NNN-*/tasks/` written with the skill (TASK-25 and TASK-26 were written before the skill was dogfooded), and keep the "Hot files" note about parallel waves and the shared doc files.

## Out of scope
Code. Converting the existing TASK-01..24 briefs to the new folder format.

## Target files
- `docs/user-guide/**`
- `README.md`
- `docs/requirements.md` (status column and §5.2 intent only)
- `docs/proposals/spec-workflow.md`
- `docs/decisions/0023-orch-owns-spec-skill.md` (status line)
- `docs/tasks/README.md`

## Done when
- Every command and setting named in the new pages exists in `dist/cli.js --help` output or `src/config.ts`.
- All relative links in the touched docs resolve: `node skills/orch-spec/scripts/check-project.mjs .` reports no broken links or anchors (its roadmap and AGENTS.md checks do not apply to the orch repo itself; ignore those two lines).
- `npm run typecheck && npm test` pass; this brief's status line and the task index are updated in the same PR.
