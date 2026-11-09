<!--
Template notes (do not copy into the output):
- HOW. Everything an implementing agent needs that isn't user-visible behavior: mechanisms, algorithms, defaults, formats, contracts.
- Mark contract sections "(→ code)". Once implemented, the code is authoritative and the section shrinks to a summary and a link.
- Number the sections and keep the numbers stable. Task briefs deep-link to them. Anchors follow GitHub slug rules:
  lower-case, punctuation dropped, spaces to hyphens, so "## 7. Storage Format _(→ code)_" is `#7-storage-format--code`
  (note the double hyphen). check-project.mjs reports a wrong anchor.
- Put every tunable number in the Settings table, with its default and the section that uses it.
- Adapt or drop sections to fit the platform. Write "N/A: <reason>" instead of inventing content.
-->

# <Project Name>: Architecture & Design

> **Scope of this document:** *how* the requirements in [requirements.md](requirements.md) are met. Reasons for the big choices are in [decisions/](decisions/).
>
> **Once code exists, the code is authoritative for contracts** (sections marked _(→ code)_). Any PR that changes a contract or default updates this file.

## 1. Design Principles
1. <e.g. pure core, thin framework shell>
2. <e.g. derived state is never persisted>
3. <e.g. every external dependency can be replaced by a fake>
4. <e.g. never guess silently: surface uncertainty>

## 2. Components & Data Flow
```
<text diagram: processes/threads/contexts, boundaries, external integrations, where state lives>
```

## 3. Module Layout
```
<directory tree with a one-line purpose per file, marking pure / framework-dependent>
```

## 4. Concurrency / Runtime Model
| Thread / process / context | Owns | Communicates via |
| :--- | :--- | :--- |

## 5–N. <One section per domain mechanism>
<Algorithms, state machines (as transition tables), formats, error-mapping tables, with tunables referenced by setting name.>

## <n>. Settings & Environment
| Key / Env Var | Type | Default | Used by (section) |
| :--- | :--- | :--- | :--- |

## <n>. Data Model & Persistence _(→ code)_
### Entities
| Entity | Field | Type | Constraints / Notes |
| :--- | :--- | :--- | :--- |
### State ownership
| State | Where | Source of truth | Survives restart/update |
| :--- | :--- | :--- | :--- |
### Migrations & versioning
<…>

## <n>. Interface Contracts _(→ code)_
<Internal component contracts (signals/events/messages), external APIs (request shape + error mapping), CLI, UI screens and states, permissions.>

## <n>. Errors & Logging
<What is logged where, redaction, crash handling.>

## <n>. Testing Architecture
<Unit / integration / E2E layout, the fakes, the fixture format for risky logic, manual checks.>

## <n>. Design Assumptions
| ID | Statement | Impact if wrong | Resolved by (task) |
| :--- | :--- | :--- | :--- |
