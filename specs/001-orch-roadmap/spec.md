# Feature Specification: orch roadmap (multi-project, safety, validation)

This feature directory lets orch run its own roadmap. The full specification is in the repository docs:

- Requirements (what): `docs/requirements.md`
- Architecture (how): `docs/architecture.md`
- Decisions (why): `docs/decisions/`

**Workers:** task lines T001–T026 in `tasks.md` name a brief in `docs/tasks/TASK-NN.md`; from T027 on the brief is `tasks/<key>.md` in this folder (architecture §6.4) and orch hands it to you directly. Read `CLAUDE.md` first, then that brief, then only the sections it links to. The brief's Scope, Out of scope, Target files and Done when are authoritative.

**Validators:** the acceptance criteria for a task are the brief's "Done when" list and the requirement IDs under "Covers" (see the acceptance criteria in `docs/requirements.md`).

## Covers

Requirements cited by the briefs in `tasks/` (T001–T026 cite theirs in `docs/tasks/`):

- REQ-ADAPT-01, REQ-ADAPT-02, REQ-ADAPT-03 (T027)
- REQ-NFR-04 (T027)
- REQ-UI-09, REQ-OPS-08 (T028)
- REQ-UI-10, REQ-UI-11 (T029)
