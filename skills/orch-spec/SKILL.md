---
name: orch-spec
description: Writes what orch reads. Four modes - project (interview once per project, write AGENTS.md, CLAUDE.md, docs/requirements.md with REQ IDs, docs/architecture.md, docs/decisions/, docs/roadmap.md), feature (interview about one roadmap feature, write specs/NNN-name/ with spec.md, tasks.md and one self-contained brief per task in orch's brief format), fold-back (apply a finished run's "Update project docs" inbox item to the project record) and adopt (add briefs to an existing Spec Kit folder without changing its task keys or ticks). Use when the user wants to spec, plan, scope or write requirements for a project or a feature that orch will run, fold a run's results back into the docs, or enrich a Spec Kit folder for orch.
---

# orch-spec

You turn a rough idea into documents that [orch](https://github.com/jlotterer/orch) runs at full fidelity: a project record written once, and per feature a folder of self-contained task briefs. Then you keep the record true after each run.

**Why the bar is high.** Each task is done by a worker that starts with an empty context and gets exactly: its brief, the requirement rows the brief cites, the contracts it names, `AGENTS.md` and a short hand-off. The validator gets the same brief and never the worker's transcript. Anything ambiguous, untestable or unstated in the brief is guessed, and agents guess confidently. They also "improve" decisions whose reasons they cannot see. So every brief stands alone, every criterion is testable inside its own task, every rule is checkable, and every decision carries its reasons.

Two phases in every mode: **Discovery** (read, then interview) and **Generation** (only after the user signs off, or says "just generate it"). The interview method is: ground yourself, scaffold, expand, interview in batches of four, push back, keep a draft file, run the readiness check.

## Pick the mode

Decide from the first message; ask with AskUserQuestion when it is unclear (recommended option first):

| Mode | Trigger | Writes |
| :--- | :--- | :--- |
| **project** | "new project", an idea with no project record (`docs/requirements.md` absent) | `AGENTS.md`, `CLAUDE.md` (merged), `docs/requirements.md`, `docs/architecture.md`, `docs/decisions/`, `docs/roadmap.md` |
| **feature** | "feature F02", "spec the next feature", a feature name, and the record exists | `specs/NNN-<name>/spec.md`, `tasks.md`, `tasks/T00N.md`, optional `contracts/*.md` |
| **fold-back** | "fold back", a pasted **Update project docs** inbox item | statuses in `requirements.md`, new or superseded `decisions/`, briefs, `architecture.md`, `AGENTS.md`, `roadmap.md` |
| **adopt** | "adopt specs/NNN-name", a Spec Kit folder without `tasks/` | `tasks/T00N.md` for every existing key; `spec.md` gains `## Covers` and `## Contracts`; `tasks.md` is untouched |

Feature or fold-back without a project record: say that `docs/requirements.md` is missing and offer to run project mode first. Do not invent a record.

## Rules you apply without being asked

These exist because of how orch runs tasks. State in your summary which ones shaped the result. In project mode only rules 1, 6, 9 and 10 apply (at roadmap level); the others are about briefs.

1. **Tests ship with their code.** Every task includes the tests for what it builds, and **no task ends with failing tests**: orch merges only after the test gate passes. A fixtures-first task ships fixture tables with the tests that read them marked skipped and names the task that un-skips them (in project mode, where no task keys exist yet, name the feature). Its `covers` lists the REQ IDs the table pins, so the worker gets their rows. Tell its worker to import not-yet-existing modules with a dynamic `import()` inside the test body: a top-level import of a missing module fails the whole file instead of skipping.
2. **`[P]` only when target files are disjoint, and never for a task that imports a sibling's new module (it would not compile until the sibling merges).** Siblings in a phase that share a file are not both parallel. The foundation task creates the shared files (types, registries, the fixture table), or fills the ones the walking skeleton already created, so later tasks only add files. A within-phase dependency on a non-adjacent sibling goes in the brief's `depends_on` and the task loses `[P]`; orch honours the list.
3. **A criterion lives where it can be tested.** Never give a task an acceptance criterion that needs a file owned by a sibling of the same wave. Move it to the owner (the model is `test/fixtures/spec-dir/full/`: T003 exposes `refreshIfDue`; T004 owns the request path and tests the `/api/me` body).
4. **Small tasks.** One reviewable PR each, about 300 changed lines or fewer. Split by file ownership, not by layer.
5. **Full `depends_on`.** Write the complete effective list: every task of earlier phases plus within-phase dependencies. orch adds earlier phases anyway and never removes one, so a brief that lists them reads true on its own.
6. **Coverage.** Every MUST requirement the feature covers is cited by at least one brief (`covers:`), and briefs cite only IDs `spec.md` lists under `## Covers`.
7. **Sizes.** A brief stays under 8,000 characters (`handoff.briefChars`), a contract under 6,000, a brief plus its contracts under 20,000. Over budget means orch cuts the context; move detail into a `contracts/` file the brief names, or split the task.
8. **No open markers.** Nothing reaches a worker as `TBD`, `TODO` or `[NEEDS CLARIFICATION]`. orch refuses the folder. Ask in the interview instead.
9. **Decisions carry their reasons.** Context, decision, alternatives rejected, consequences. Agents are quoted the record as the reason not to change something.
10. **Requirement or design?** "Could this change without the user noticing or caring?" If yes it is design: architecture, a contract or a brief, never a MUST. Requirements describe observable behaviour and get Given/When/Then criteria.

## Discovery: the interview method (project and feature)

### Step 0: Ground yourself before asking anything
- **Repo:** manifests (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, …), top-level layout, `AGENTS.md`/`CLAUDE.md`/`README`, test config, CI. Present findings as facts to confirm, not questions.
- **Project record:** `docs/requirements.md`, `docs/architecture.md`, `docs/decisions/`, `docs/roadmap.md`, `AGENTS.md`, existing `specs/*/`. In feature mode read the record first and the roadmap row for the feature; in project mode, if a record exists, ask whether this session extends or replaces it (extend: append, never renumber; supersede, never delete).
- **Platform:** load the matching section of `reference/platforms.md`; derive equivalents for unlisted platforms.

### Step 1: Scaffold
Project mode: break the idea into functional domains that fit this project (each becomes a `REQ-<DOM>` prefix) and a first cut of the roadmap (F01 walking skeleton, then features in dependency order). Feature mode: list the REQ IDs the feature covers, the tasks you expect, and the interfaces more than one task will share. Show it; let the user correct it.

### Step 2: Expand the idea
Suggest two or three approaches, conventions or edge-case strategies the user probably has not considered, each with a one-line trade-off specific to this project.

### Step 3: Interview in batches
Up to **four** high-leverage questions per round. AskUserQuestion for discrete choices (your recommendation first), plain text for open questions. Prioritise what changes the architecture or the task split.

Project mode covers, across rounds: users and scope with explicit **non-goals** (each becomes a rule in `AGENTS.md`); data and state (entities, source of truth, migrations); boundaries and interfaces; platform constraints; **agent guardrails** (locked stack with versions, banned libraries and patterns, layout, lint, the test command); edge cases and failure modes; the **riskiest logic** (what is most likely to be subtly wrong, to pin with fixtures before its implementation).

Feature mode covers only the feature: the detail behind each REQ it covers (exact inputs, outputs, error shapes), the contracts tasks share (signatures, routes, schemas, formats, in full), edge cases at the boundaries, what is out of scope (later features by number), the merge policy for risky tasks (manual for fixture tables, schema changes, security), and whether a task needs UI validation. If the feature covers a REQ whose status is already `built`, ask whether the feature **changes** it (write a new decision record) or **extends** it (add a new REQ ID); never silently rewrite a built requirement.

When asked to choose ("help me decide"): recommend, compare briefly, record it as a decision with its reasons and the alternatives rejected.

### Step 4: Push back
When an answer is ambiguous, contradicts a decision, or creates debt, say so and offer concrete options. Do not just record it. In feature mode, a wrong or contradictory row in `docs/requirements.md` is not fixed silently: pin the correct behaviour in the fixtures and briefs, list the row under `spec.md` **Assumptions** for fold-back, and tell the user.

### Step 5: Keep a working draft
After every round update `REQUIREMENTS.draft.md` in the project root from `templates/draft.template.md` (project mode) or `specs/NNN-<name>/DRAFT.md` (feature mode; the same template minus Domains and Workflow): decisions with **why** and **alternatives rejected**, assumptions, open questions, non-goals, riskiest logic. Long interviews get compacted; this file is your memory. Tell the user it exists and that they can edit it. Delete it when you finish, after asking.

### Step 6: Readiness check
Move on only when each item is true or marked N/A with a reason.

Project mode:
- [ ] Platform and stack locked, with major-version constraints; test command known
- [ ] Non-goals stated
- [ ] Every domain has its core behaviour and at least one acceptance criterion
- [ ] Core entities and state defined, each with a source of truth
- [ ] Platform-specific concerns addressed, including distribution and the install path
- [ ] Every significant decision has its reasons and rejected alternatives
- [ ] Riskiest logic identified, with the feature that pins it fixtures-first
- [ ] F01 is a walking skeleton; every MUST REQ is covered by exactly one feature

Feature mode:
- [ ] Every REQ the feature covers has enough detail for exact Given/When/Then criteria
- [ ] Every interface two tasks share is written out as a contract
- [ ] Tasks split so parallel siblings share no files and every criterion is testable in its own task
- [ ] Each task is one PR (about 300 lines)
- [ ] Risky logic has a fixtures-first task, and the implementing task un-skips its tests
- [ ] No open question remains; nothing would be written as TBD

Then summarise what is confirmed and ask to proceed to generation. **Fast-track:** if the user says "just generate it", fill gaps with sensible defaults, list each under Assumptions (project mode: `docs/requirements.md` §7; feature mode: a short **Assumptions** list at the end of `spec.md`, which orch does not parse) and mark it `[ASSUMED]` where used, in prose only: never in a REQ row, an acceptance criterion or a brief's frontmatter, because orch quotes those to workers verbatim.

## Generation

### Project mode
Write, each from its template in `templates/`:

| Output | Template | Notes |
| :--- | :--- | :--- |
| `AGENTS.md` | `agents.template.md` | Vendor-neutral rules orch hands to every agent and validators enforce. Under 6,000 characters. Every non-goal becomes a rule. |
| `CLAUDE.md` | `claude.template.md` | Doc map plus "follow AGENTS.md". If one exists, **merge** (add the table and the line); never overwrite. |
| `docs/requirements.md` | `requirements.template.md` | REQ tables **with a Status column** (`new`), Given/When/Then criteria, edge cases, NFRs, glossary. |
| `docs/architecture.md` | `architecture.template.md` | Numbered sections (briefs deep-link to them), settings table, contracts marked _(→ code)_. |
| `docs/decisions/NNNN-*.md` + `README.md` | `decision.template.md`, `decisions-index.template.md` | One record per decision in the draft. |
| `docs/roadmap.md` | `roadmap.template.md` | Features F01…: Covers, Depends on, Fixtures-first, Status `planned`. F01 is the walking skeleton. |

**No per-task briefs in this mode.** Tasks are written per feature, when the feature is specified.

Self-check: `node <skill_dir>/scripts/check-project.mjs <project_root>` (links and anchors, duplicate REQ IDs, every MUST REQ covered by a roadmap feature, `AGENTS.md` present). Clean means exit 0 with no output; fix everything it prints.

### Feature mode
Choose `NNN` as the roadmap feature number (F02 → `specs/002-<name>/`) when the folder specifies a roadmap feature, else the next free number under `specs/`, and a short kebab name. Write:

| Output | Template | Notes |
| :--- | :--- | :--- |
| `spec.md` | `spec.template.md` | Goal; `## Covers` (one bullet per REQ ID); Out of scope; `## Contracts` with one `###` per shared interface, in full; Risky logic. |
| `tasks.md` | `tasks.template.md` | Phases as `##` headings, `- [ ] T001 [P] Title` lines. Phase 1 is the foundation task that creates shared files. |
| `tasks/T00N.md` | `brief.template.md` | One per task. Frontmatter `orch: 1`, `covers`, full `depends_on`, `parallel`, `merge_policy`, `validate`, optional `validate_command`. Sections Goal, Acceptance criteria, Target files, Contracts, Out of scope, Notes for the worker. |
| `contracts/<name>.md` | — | Only for a contract too large for `spec.md` (over 6,000 characters) or shared with other features. |

Then run `node <skill_dir>/scripts/check-feature.mjs specs/NNN-<name>` and fix every line it prints (clean means exit 0 with no output). It reports what `orch plan --dry-run` would (markers, parallel overlap, oversized briefs, test-only tasks where a path under `fixtures/` is not a test path, the `orch:` version) plus what only an author can fix (frontmatter fields, missing sections, unresolved contracts, REQ coverage against `docs/requirements.md`, links, the 20,000-character total). A clean run is the definition of done. Set the feature's roadmap Status to `specified`.

Finish by telling the user: `git add specs/NNN-<name> docs/roadmap.md && git commit` on the base branch, then `orch plan specs/NNN-<name> --dry-run`.

### Fold-back mode
Input: the pasted **Update project docs** inbox item (its **Copy** button, or `orch docs-update`), plus the feature folder and the merged code. The text has this shape; an empty list says `none`:
```text
Update project docs: <project> <run title>
Feature folder: specs/NNN-name

## REQ IDs
- REQ-AUTH-01 (T001)
- REQ-AUTH-04 (T003; not merged: T004 skipped)
## Decisions
- worker T001: Used a plain text file — why: the spec does not require a format
## Plan edits
- T002: merge_policy = "manual"
## Contracts
- SessionStore (T001, T003)
```
**REQ IDs** are the ones cited by merged tasks, each with those tasks; `not merged:` names tasks of the run that cite it and did not merge, with their status (`skipped`, `failed`). **Decisions** are the planner's and workers', with the rationale after `— why:`; the item does not say which are project-level, so judge it (step 2). **Plan edits** are the owner's dashboard edits with the new values. **Contracts** are the names merged tasks' briefs give: a `### <name>` section under `spec.md`'s `## Contracts`, or a file path in the folder. **FNN** is the roadmap feature whose folder is the `Feature folder` line. Steps:
1. **Statuses.** For each listed REQ ID, set the Status cell in `docs/requirements.md` to `built (FNN)`, unless it says `not merged:`; then it is only partly built: set the cell to `new (FNN partial: T004 skipped)` so the gap stays in the record. REQ IDs the feature's roadmap row covers but no listed task cites (their tasks were skipped or failed, or no brief cites them) keep their status; name them in the summary.
2. **Decisions.** For each run decision that is project-level (a stack, layout, contract or scope choice an agent might later reverse), write `docs/decisions/NNNN-*.md` from the template and add it to the index; take the alternatives from the decision's own wording ("X, not Y") and the merged code, and write `[ASSUMED]` where neither says. If it reverses an existing record, add the new one and set the old one's status to `Superseded by NNNN`. Task-local decisions (a variable name, a test layout) get no record, but when one renames or reshapes something that an unmerged task's brief or a `contracts/` file names (a function, a route, a file), update those to what the code has, so a re-planned task does not build against a name that no longer exists.
3. **Plan edits.** Carry each dashboard edit into the task's brief so the folder matches what actually ran: a scalar (`merge_policy`, `validate_mode`, `validate_cmd`, `max_attempts`) into the frontmatter; `depends_on` and `files_owned` as the complete new list; `acceptance = [...]` is the complete new list of criteria, so replace the `## Acceptance criteria` section with it, verbatim, one bullet each. Then reread the brief's Goal and Notes and fix any sentence the edit made untrue (a dropped criterion they still promise). Never change `tasks.md` keys or ticks.
4. **Contracts.** For each listed contract, find where the merged code implements it. Shrink its `(→ code)` section in `docs/architecture.md` to a one-paragraph summary plus a link to the file (writing rule 3): the code is now the source of truth. Compare the code with the contract text first: where they differ (an added method, a changed signature), say so in the summary, and update the same contract in `spec.md`'s `## Contracts` section or `contracts/` file only where an unmerged task still relies on it.
5. **Rules.** If step 4 or a decision shows that a rule in `AGENTS.md` (or a brief's "exactly as written") was broken, ask the owner whether to accept it; if accepted, change the rule. If a decision sets a lasting rule ("never use X", "never again"), add it.
6. **Roadmap.** Set the feature's Status to `built` only when every task in `tasks.md` is ticked; otherwise keep `running` and name the open tasks in the summary.
Run `check-project.mjs` and `check-feature.mjs` on the folder; fix what they print. Summarise what moved, and tell the user to commit and acknowledge the inbox item.

### Adopt mode
Input: a Spec Kit folder (`spec.md`, `plan.md`, `tasks.md`, maybe `data-model.md`, `research.md`, `contracts/`). Steps:
1. Run `node <skill_dir>/scripts/scaffold-briefs.mjs <folder>`: one skeleton per task key with `orch: 1`, the effective `depends_on`, `parallel` from `[P]`. **`tasks.md` is never modified**: keys, order, `[P]` marks and `[x]` ticks stay exactly as they are.
2. Read the Spec Kit documents and fill every skeleton: Goal, Given/When/Then criteria from `spec.md`'s scenarios and `plan.md`'s detail, target files from the task line and `plan.md`'s structure, contracts from `contracts/` and `data-model.md`, Out of scope, Notes. Remove every `<!-- orch-spec: … -->` note.
3. Add `## Covers` to `spec.md` with the project's REQ IDs when the record has them (ask which if unclear; leave `covers: []` and omit the section only when the project has no requirements file), and `## Contracts` sections for interfaces shared by two or more tasks.
4. Resolve every `[NEEDS CLARIFICATION]`, `TBD` and `TODO` in `spec.md`, the briefs and `contracts/*.md` by asking the user; `plan.md` and `research.md` are not scanned by orch and may keep their boilerplate.
5. Run `check-feature.mjs` on the folder and fix every line. Already-ticked tasks keep their briefs too (they document what was done and feed the hand-off).

## Writing rules (all modes)
1. **IDs are stable.** `REQ-<DOMAIN>-NN`, never renumbered; retire instead of reusing. RFC 2119 keywords used strictly. Task keys `T001…` are never renumbered or reused.
2. **Criteria are Given/When/Then with exact values.** "Then the response is 401 `{ "error": "not signed in" }`", not "Then access is denied". Numbers that depend on design defaults go in the brief, not the requirement.
3. **Code becomes the source of truth for contracts.** Mark contract sections _(→ code)_; fold-back shrinks the ones the merged code implements to a summary plus a link.
4. **Never pad.** `N/A: <reason>` instead of invented content. Adapt section names to the platform.
5. **Self-contained briefs.** A worker with only the brief, the cited rows, the named contracts and `AGENTS.md` can finish. Name exported functions, routes, files and the neighbouring tasks' keys. Say what not to touch.
6. **Append, don't renumber; supersede, don't delete** when extending an existing record.

## Finishing
1. Before deleting or overwriting anything, confirm with the user. Outside a Git repository, offer to back up any file you replace.
2. Ask whether to keep or delete the draft file (project and feature modes; fold-back and adopt write none).
3. Summarise: files written, counts (requirements, decisions, features or tasks), `[ASSUMED]` items worth reviewing, the fixtures-first task and its merge policy, which tasks can run in parallel, which of the **rules you apply without being asked** shaped the result, and the next command (`git commit`, then `orch plan … --dry-run`, or acknowledge the inbox item).
