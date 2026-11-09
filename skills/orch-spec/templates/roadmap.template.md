<!--
Template notes (do not copy into the output):
- docs/roadmap.md is the plan at feature level. Project mode writes features, not tasks; feature mode later turns
  one feature into specs/NNN-name/ with its briefs.
- F01 is always the walking skeleton: repo layout, the test command running one real test, CI, the shared
  files later features add to. It is small and unblocks everything.
- Every MUST REQ ID appears in the Covers column of exactly one feature (check-project.mjs reports an uncovered
  MUST and an ID listed by two features). A REQ that two features touch belongs to the first; the second extends it
  with a new REQ ID or a decision. Shorthand the checker expands: `REQ-X-01, -02, -05` and ranges `REQ-X-01..04`.
- Fixtures-first = Yes when the feature has risky logic (parser, arithmetic, merge rule, state machine): its first
  task then ships fixture tables and skipped tests, with merge policy manual.
- Status: planned → specified (folder written) → running → built (fold-back done). Fold-back mode moves it.
-->
# <Project Name>: Roadmap

Ordered features. Each becomes one feature folder (`specs/NNN-<name>/`) written with `/orch-spec` feature mode and run with `orch plan specs/NNN-<name>`. Requirement IDs live in [requirements.md](requirements.md); the reasons in [decisions/](decisions/).

| Feature | Name | Covers | Depends on | Fixtures-first | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| F01 | Walking skeleton: layout, test command, CI | REQ-NFR-01 | — | No | planned |
| F02 | <Feature> | REQ-<DOM>-01, -02 | F01 | Yes: <the risky logic> | planned |

## F01: Walking skeleton
<Three to five sentences: what exists after it (directories, the one real test, CI green), and which shared files it creates so later features only add files.>

## F02: <Feature>
<What the user can do when it ships; the contracts it will expose to later features; the risky logic and how fixtures pin it.>

## Later, not scheduled
- <Capability that is out of scope for now, with the REQ IDs or non-goal it relates to.>
