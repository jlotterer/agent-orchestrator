# 0011: One daemon manages many projects

- **Status:** Accepted, 2026-11-07
- **Requirements affected:** REQ-PROJ-01 … REQ-PROJ-04, REQ-HITL-01, REQ-UI-07

## Context
The owner wants Vibe-Kanban-style management of several projects with one view and the ability to switch, instead of one daemon and port per repo.

## Decision
A single daemon keeps a registry of projects (repo paths) in its database. The dashboard has a project switcher and a global inbox labelled by project. Projects are added via CLI and dashboard, validated as git repos, archived rather than deleted.

## Alternatives rejected
- **One daemon per repo.** No shared view, many ports, no global capacity control.
- **Server config list of projects.** Restart to add.
- **Auto-discovery.** Surprises.

## Consequences
- All run-scoped code paths take a project context; ids for runs/tasks/questions stay globally unique so agent commands need no project.
- CLI commands resolve a project per architecture §5.4.
