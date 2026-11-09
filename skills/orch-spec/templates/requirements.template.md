<!--
Template notes (do not copy into the output):
- WHAT, not HOW. Test each statement: "Could this change without the user noticing or caring?" If yes, it belongs in architecture.md.
- No library names, thresholds, algorithms, file formats or internal paths in MUST statements, unless the user
  mandates them (a required file format, a fixed path, "uses the Claude API"): then they are requirements and belong here.
- IDs: REQ-<DOMAIN>-<NN>, REQ-NFR-<NN>. Stable: never renumber, retire instead.
- Status column: `new` until a feature that covers the ID has run and been folded back, then `built (FNN)`.
  Fold-back mode changes it; nothing else does. orch quotes the whole row to workers, so keep rows self-contained.
- Acceptance criteria are observable Given/When/Then. Exact test numbers that depend on design defaults go in task briefs.
-->

# <Project Name>: Requirements

> **Scope of this document:** *what* the app must do and how we'll know it does it. *How* it is built lives in [architecture.md](architecture.md). *Why* key choices were made lives in [decisions/](decisions/). Requirement IDs are stable: never renumber; retire an ID instead of reusing it.

## 1. Objective
<Who, the problem, and what success looks like, measurable if possible.>

## 2. Users & Context
- <user(s), environment, what they control, what they accept (e.g. data leaving the device)>

## 3. Core Workflow
1. <step>

## 4. Non-Goals
- <thing not built, and why>

## 5. Functional Requirements
Keywords MUST / SHOULD / MAY follow RFC 2119.

### 5.<n> <Domain> (<DOM>)
**User intent:** As <user>, I want <capability> so that <outcome>.

| ID | Requirement | Status |
| :--- | :--- | :--- |
| REQ-<DOM>-01 | <observable behavior> | new |

**Edge cases:**
- <condition> → <user-visible result>

**Acceptance criteria:**
- `REQ-<DOM>-01`: Given <context>, When <action>, Then <observable outcome>.

## 6. Non-Functional Requirements
| ID | Category | Requirement | How Verified |
| :--- | :--- | :--- | :--- |
| REQ-NFR-01 | <Performance / Privacy / Reliability / Accessibility / Compatibility / Accuracy> | <…> | <…> |

## 7. Assumptions & Open Questions
| ID | Type | Statement | Impact if Wrong |
| :--- | :--- | :--- | :--- |

Design-level assumptions are tracked in [architecture.md](architecture.md) (Design Assumptions section).

## 8. Glossary
| Term | Meaning |
| :--- | :--- |
