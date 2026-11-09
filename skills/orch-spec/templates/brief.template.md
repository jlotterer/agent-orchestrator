<!--
Template notes (do not copy into the output):
- tasks/<key>.md: the one document a worker gets for its task (orch architecture §6.4). The validator gets the
  same brief and never the worker's transcript, so the acceptance criteria are what gets checked. Self-contained:
  a worker with this file, the REQ rows it cites, the contracts it names and AGENTS.md must be able to finish.
- Frontmatter is the YAML subset orch parses: scalars and flow lists [a, b] only; `#` comments allowed. Keys:
    orch: 1                 format version; required, must be 1
    covers: [REQ-…]         REQ IDs this task satisfies; orch pulls their rows and criteria into the context
    depends_on: [T…]        the FULL effective list: every task in earlier phases plus within-phase dependencies,
                            so the brief reads true on its own (orch adds earlier phases anyway; it never removes)
    parallel: true|false    wins over [P] in tasks.md; false when this task shares a file with a sibling
    merge_policy: auto|manual   manual when a person must review (fixture tables, security, schema changes)
    validate: standard|ui   ui when the validator must drive a browser against the running app
    validate_command: <cmd> optional; a narrower test command than the project default
- Keep the whole file under handoff.briefChars (8,000 characters) and brief + named contracts under 20,000.
- Sections orch parses: "## Acceptance criteria" (one criterion per bullet), "## Target files" (one path per
  bullet), "## Contracts" (one per bullet: "<Name> (spec.md §Contracts)" or "contracts/<file>.md"; or "None.").
  Goal, Out of scope and Notes for the worker are read as prose. The H1 is "# <key>: <title>".
- Every acceptance criterion must be testable inside THIS task's target files. If a criterion needs a file owned
  by a sibling of the same wave, move the criterion to that sibling (for example, a refresh task exposes
  refreshIfDue and tests it; the middleware task owns the request path and tests the /api/me body).
- Tests ship here, in the same task as the code they test; no task may end with failing tests. A fixtures-first
  task ships its tests skipped and names the task that un-skips them; its tests import modules that do not exist
  yet with a dynamic import() inside the test body, because a top-level import of a missing module fails the file.
- No TBD, TODO or [NEEDS CLARIFICATION]: ask in the interview instead.
-->
---
orch: 1
covers: [REQ-<DOM>-NN]
depends_on: [T00N]
parallel: false
merge_policy: auto
validate: standard
---
# T00N: <Title as written in tasks.md>

## Goal
When this task is done, <what exists, named precisely: files, exported functions, routes, pages>, and <why it matters to the feature>. <What a neighbouring task does with it.>

## Acceptance criteria
- Given <state>, When <action with exact inputs>, Then <observable outcome with exact values>.
- Given <…>, When <…>, Then <…>.

## Target files
- <path/one.ts>
- <test/path/one.test.ts>

## Contracts
- <ContractName> (spec.md §Contracts)
- contracts/<file>.md

## Out of scope
- <What a neighbouring task owns, with its key, so the worker does not build it.>
- <A rejected alternative and the decision that rejected it.>

## Notes for the worker
<Names to use, boundaries not to cross (files of parallel siblings), the order to work in, and anything the worker would otherwise guess. Two to six sentences.>
