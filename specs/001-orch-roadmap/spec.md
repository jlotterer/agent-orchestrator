# Feature Specification: orch roadmap (multi-project, safety, validation)

This feature directory lets orch run its own roadmap. The full specification is in the repository docs:

- Requirements (what): `docs/requirements.md`
- Architecture (how): `docs/architecture.md`
- Decisions (why): `docs/decisions/`

**Workers:** every task line in `tasks.md` names a brief in `docs/tasks/TASK-NN.md`. Read `CLAUDE.md` first, then that brief, then only the sections it links to. The brief's Scope, Out of scope, Target files and Done when are authoritative.

**Validators:** the acceptance criteria for a task are the brief's "Done when" list and the requirement IDs under "Covers" (see the acceptance criteria in `docs/requirements.md`).
