# Skills

Skills that ship with orch. Today there is one: `orch-spec`, the author's side of the spec workflow in [decision 0023](../docs/decisions/0023-orch-owns-spec-skill.md). It writes exactly what `orch plan` reads: the project record once, and per feature a folder with one self-contained brief per task (the contract is [architecture §6.4](../docs/architecture.md#64-feature-folder-and-brief-contract)). The owner's end-to-end workflow is in [proposals/spec-workflow.md, Part 1](../docs/proposals/spec-workflow.md#part-1-the-owners-workflow).

## Install

The skill is a Claude Code skill: a folder with `SKILL.md`, templates, a platform reference and three Node scripts (no dependencies; Node 22 or later, which orch needs anyway). Copy or link it into your skills directory:

```sh
# link (follows updates when you pull orch)
ln -s "$(pwd)/skills/orch-spec" ~/.claude/skills/orch-spec
# or copy
cp -r skills/orch-spec ~/.claude/skills/orch-spec
```

On Windows, from PowerShell: `New-Item -ItemType Junction -Path "$HOME\.claude\skills\orch-spec" -Target "$PWD\skills\orch-spec"`, or copy the folder.

Then, in the repository you are specifying, start Claude Code and type `/orch-spec` followed by what you want. The skill picks the mode from your first message and asks when it is unclear. Other agent CLIs can read the files it writes (plain markdown), but only Claude Code runs the skill itself (settled question 1 in the proposal).

## Modes

**Project** (`/orch-spec New project. <idea in two or three sentences>. Users: … Core job: … Not in scope: … Stack: …, test command: … Riskiest part: …`). The requirements-architect interview, in rounds of up to four questions: non-goals, data and state, boundaries, platform constraints, agent guardrails, edge cases and the riskiest logic. It keeps `REQUIREMENTS.draft.md` as its memory between rounds; edit it directly when something is wrong. Output, on the base branch: `AGENTS.md` (vendor-neutral rules orch hands to every agent and validators enforce), `CLAUDE.md` (doc map plus "follow AGENTS.md", merged into an existing file, never overwritten), `docs/requirements.md` (REQ tables with a status column and Given/When/Then criteria), `docs/architecture.md`, `docs/decisions/` and `docs/roadmap.md` (features F01, F02, …, the REQ IDs each covers, dependencies, and whether it needs a fixtures-first task; F01 is always the walking skeleton). No task briefs yet; those come per feature. Self-check: `scripts/check-project.mjs`.

**Feature** (`/orch-spec Feature F02 from docs/roadmap.md.`). Reads the record and asks only about the feature: the exact behaviour behind each REQ it covers, the interfaces more than one task shares, edge cases, what stays out. Writes `specs/NNN-<name>/` with `spec.md` (Goal, Covers, Out of scope, Contracts, Risky logic), `tasks.md` (the Spec Kit task list orch has always read) and `tasks/T00N.md`, one brief per task with `orch: 1` frontmatter. It applies orch's rules without being asked and says which ones shaped the result: tests ship with their code and no task ends with failing tests, fixtures-first tasks ship skipped tests, `[P]` only when target files are disjoint, criteria live in the task that owns the files they need, the full effective `depends_on`, every MUST requirement cited by a brief, briefs under 8,000 characters and nothing left as TBD. Then it runs `scripts/check-feature.mjs` and fixes what it prints. Commit the folder and run `orch plan specs/NNN-<name> --dry-run`.

**Fold-back** (`/orch-spec Fold back feature F02. <paste the inbox item>`). After a run completes, orch's inbox shows **Update project docs** with the REQ IDs the merged tasks covered, the decisions recorded during the run, the plan edits you made in the dashboard and the contracts that changed. The skill sets those REQs to `built`, writes decision records for the project-level decisions (marking superseded ones), carries dashboard plan edits into the briefs so the folder matches what ran, updates `docs/architecture.md` where a contract changed, updates `AGENTS.md` if a rule changed, and moves the roadmap row to `built`. Skip this step and the record goes stale; after a few features new specs contradict old ones and nothing notices.

**Adopt** (`/orch-spec adopt specs/003-name`). For a folder written with GitHub Spec Kit. `scripts/scaffold-briefs.mjs` writes a skeleton brief per existing task key with the effective dependencies and parallel flag; `tasks.md` keys, order, `[P]` marks and ticks are never changed. The skill then fills each brief from `spec.md`, `plan.md`, `data-model.md` and `contracts/`, adds `## Covers` and `## Contracts` to `spec.md`, asks you to resolve every `[NEEDS CLARIFICATION]`, and runs the check. A plain Spec Kit folder still imports without this; adopting gives workers a full brief instead of excerpts.

## Scripts

All three are plain Node, exit 0 with no output when clean, and print one `file:line: message` per problem otherwise.

| Script | Checks |
| :--- | :--- |
| `check-feature.mjs <folder> [--requirements <file> \| --no-requirements] [--brief-chars N] [--contract-chars N] [--total-chars N] [--json]` | The brief contract: `orch:` version, frontmatter fields and values, H1, acceptance and target-file sections, contract resolution, markers (`[NEEDS CLARIFICATION`, `TBD`, `TODO`) in `spec.md`, briefs and `contracts/*.md`, brief and contract sizes and the 20,000-character total, parallel target-file overlap, test-only tasks (`fixtures/` is not a test path), every task has a brief and vice versa, REQ coverage against `docs/requirements.md` (found above the folder, or `--requirements`), relative links and anchors. It accepts `test/fixtures/spec-dir/full` and reports the four problems of `bad`; `orch plan --dry-run` reports the same four (REQ-SPEC-03). |
| `check-project.mjs <root>` | The project record: links and anchors across `*.md`, `docs/**` and `specs/*/spec.md`; duplicate REQ IDs; every MUST REQ covered by a roadmap feature and no REQ listed by two features; `AGENTS.md` present. |
| `scaffold-briefs.mjs <folder> [--dry-run]` | Writes a skeleton brief for every task without one; never touches `tasks.md`. |

Unit tests: `test/unit/check-feature.test.mjs`.
