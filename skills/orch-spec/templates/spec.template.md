<!--
Template notes (do not copy into the output):
- spec.md of a feature folder specs/NNN-name/ (orch architecture §6.4). Workers and validators never read this
  file whole: orch hands them their brief, the REQ rows it cites, the contracts it names and AGENTS.md. So the
  Goal is for the owner and the phase validator; the Contracts are for every task that shares them.
- ## Covers: one bullet per REQ ID the feature satisfies, in the exact form "- REQ-DOM-NN: <short gloss>".
  check-feature.mjs requires every MUST ID here to be cited by a brief, and every brief to cite only IDs here.
- ## Contracts: one "### <Name>" per interface two or more tasks share (types, routes, schemas, file formats,
  CLI flags). A brief names it as "- <Name> (spec.md §Contracts)". Keep each under handoff.contractChars (6,000).
  Larger ones go to contracts/<file>.md and are named by path.
- ## Risky logic: the part most likely to be subtly wrong and the fixtures-first task that pins it.
- An optional "## Assumptions" at the end lists fast-track defaults and any requirement row the interview found
  wrong or contradictory, for fold-back to fix. orch does not parse it; workers do not see it.
- No TBD, TODO or [NEEDS CLARIFICATION] anywhere in this file: orch refuses the folder.
-->

# Feature NNN: <Title>

## Goal
<Two to four sentences: what the user can do when the feature ships, how it builds on earlier features (F0N), and what it enables later. Written for the owner and the phase validator.>

## Covers
- REQ-<DOM>-NN: <short gloss of the requirement>

## Out of scope
- <Later roadmap features by number, with the REQ IDs they own.>
- <Alternatives rejected, with the decision record that rejected them.>
- <Neighbouring behaviour that stays as it is.>

## Contracts

### <ContractName>
<Who implements it (one task) and who consumes it (the others). State the rule: consumers must not add to it.>

```<lang>
<the exact signatures, types, routes or schema>
```

<Rules the code must follow that the signature does not express: null versus throw, who passes the clock, ordering.>

## Risky logic
<The arithmetic, parser, merge rule or state machine most likely to be wrong at the boundaries. Which task ships the fixture table and the tests that read it (skipped where the implementation comes later), and which task un-skips them. Or "None: <reason>".>
