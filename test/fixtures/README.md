# Fixtures: the executable spec for orch's risky logic

These tables define correct behaviour for the parts of orch that are easy to get subtly wrong: the `tasks.md` parser, JSON extraction from agent output, task readiness, the task state machine, the PR-poll decision, file ownership and phase validation ([decision 0020](../../docs/decisions/0020-pure-core-and-fixtures.md), [architecture §21.2](../../docs/architecture.md#212-testing-architecture)).

They were written spec-first (TASK-01), before the pure functions in `src/core/` existed. **Changing an expected output is a behaviour change and needs the owner's review in the PR.** Adding cases is fine.

## Conventions for every file

- **`pending`**: a case with `"pending": "TASK-NN"` describes behaviour that task builds. Runners **skip** it (report it as skipped, not passed). The task that builds the behaviour removes the field in its PR. Cases without `pending` must pass.
- **`name`**: unique within the file. It is used as the test name.
- Timestamps are ISO-8601 UTC. Pure functions receive `now` as input and never read the clock.
- Order matters wherever the result is a list (`start`, `effect`, `itemBodies`, `failedChecks`), except `depends_on`, which is compared sorted.

## Files

### `tasks-md/<case>.md` + `<case>.expected.json`
Runner: `parseTasksMd(fs.readFileSync("<case>.md", "utf8"))` (`src/speckit.ts`), map each task to `{ key, phase, parallel, done, depends_on: [...depends_on].sort() }`, `deepStrictEqual` with the expected array (task order = file order). Title and description are not part of the fixture.

`crlf-line-endings.md` must keep its CRLF line endings. `test/fixtures/.gitattributes` marks it `-text` so git never converts it.

| Case | Covers |
| :--- | :--- |
| `basic-phases` | `##` phases; earlier-phase deps; previous-task dep for non-`[P]` |
| `parallel-siblings` | `[P]` siblings; REQ-INTAKE-01/02 acceptance example; ticked task in a later phase |
| `parallel-after-sequential` | `[P]` task after a non-`[P]` task does not depend on it; the next non-`[P]` task depends only on the `[P]` one before it |
| `explicit-depends-on` | `depends on T001, T002`; case-insensitive (`Depends On`) |
| `after-and` | `after T003 and T004`; `after T001, T002 and T005` |
| `requires` | `Requires T001`; `requires T001 and T002` |
| `ticked` | `[x]` and `[X]` are done; done tasks still count as dependencies |
| `bullets-indentation` | `*` bullets, spaces/tab indentation, `-[ ]` without a space; `[]`, `+` and numbered items are not tasks |
| `key-widths` | 2- and 4-digit keys; 1- and 5-digit keys, lower-case `t` and missing keys are not tasks |
| `unknown-dependency` | an unknown key (`T999`) is dropped |
| `self-dependency` | a self-reference is dropped |
| `forward-reference` | a reference to a later task is kept (cycles are refused later by plan approval, `core/graph.ts`, since TASK-13) |
| `before-heading` | tasks before any `##` heading have phase `null` and form the first phase; `#` (h1) is not a phase |
| `h3-headings` | `###` and `####` headings are phases; headings without tasks create no phase; phase names are trimmed |
| `crlf-line-endings` | CRLF input |

### `extract-json.json`
`[{ name, input, expected }]`. Runner: `deepStrictEqual(extractJson(input), expected)` (`src/adapters/runner.ts`). `expected: null` when nothing parses.

Covers: single fence; last fenced block wins; invalid last block falls back to an earlier one; fence without the `json` tag; a fence in another language (` ```ts `) before the JSON fence; trailing object without a fence; nested braces; braces in prose before an unfenced object and before a fenced one; braces inside string values; no JSON; object-like but invalid text; empty input; CRLF inside the fence; an indented fence.

### `readiness.json`
`[{ name, pending?, input: ReadinessInput, expected: ReadinessResult }]` exactly as in [architecture §7.1](../../docs/architecture.md#71-readiness). Runner: `deepStrictEqual(selectReady(input), expected)`. The order of `start` is significant. `heldForOverlap` is always present (empty when nothing is held).

Covers: dependencies done / skipped / unmet (running, failed, needs_input, pr_open, pr_checks, missing key, other run); open task question; open plan question (built by TASK-13; passes); `maxParallel` with `orderIdx` ordering; active tasks counting against `maxParallel`; tasks waiting on the owner not using a slot; global `maxAgents` across two projects (REQ-PROJ-08); `busyAgents`; free slots never negative; fairness by `lastStartAt`, null first, ties by id, round-robin (REQ-PROJ-09); a paused run starts nothing but its agents still count; runs that are not `running`; tasks of another run; only `pending` tasks are candidates; resume flag combinations (§7.1 step 5); empty `filesOwned` never blocks; disjoint ownership; overlap with an active or already-chosen task gives `heldForOverlap` (built by TASK-14; passes); no overlap check across projects; the phase gate (built by TASK-15): later-phase tasks wait while an earlier phase is validating, needs the owner or is pending, a fix-up of the open phase still starts, tasks of the first unpassed phase are not held, no `phases` = no gate, a `null` phase matches the row named `""` and a phase without a row is not gated. The project's optional `phases` and the task's optional `phase` are the gate's inputs.

### `ownership.json`
`{ overlap: [{ name, a, b, expected }], outOfScope: [{ name, files, owned, expected }] }` ([architecture §7.2](../../docs/architecture.md#72-ownership-overlap), §10.2, [decision 0017](../../docs/decisions/0017-file-ownership.md)). Runner: `ownedOverlap(a, b) === expected` and, because overlap is symmetric, `ownedOverlap(b, a) === expected`; `deepStrictEqual(outOfScope(files, owned), expected)` (order of `files` kept). Added in TASK-14.

Covers `overlap`: equal paths; different files in one dir; dir glob vs a file inside it (both orders); sibling dirs; a segment prefix that is not a string prefix (`src/auth` vs `src/authz`); `**` and `*.md` at the root (empty prefix); empty lists (one or both); a wildcard in a middle segment; brace and bracket wildcards; `./` and backslash normalization; any matching pair in multi-entry lists; disjoint multi-entry lists; a plain directory vs a file below it. Covers `outOfScope`: the brief's `src/**` + `README.md` example; empty ownership reports nothing; exact file match; a plain directory owns its contents; `*` does not cross directories; several patterns.

### `phases.json`
`{ toValidate: [{ name, tasks, phases, expected }], fixup: [{ name, phase, round, verdict, laterTasks, expected }] }` ([architecture §10.3](../../docs/architecture.md#103-phase-validation), [decision 0015](../../docs/decisions/0015-phase-validation-fixups.md)). Added in TASK-15. Runners: `deepStrictEqual(phasesToValidate(tasks, phases), expected)` and `deepStrictEqual(planFixup(phase, round, verdict, laterTasks), expected)` (`src/core/phases.ts`).

Shapes: `tasks`: `[{ key, phase, status, orderIdx }]` (`phase: null` = before any heading, the phase row named `""`); `phases`: `[{ id, name, idx, status, fixup_rounds }]`; `expected` (toValidate): `[{ phaseId, name, action: "validate" | "pass", reason }]` in walk order. `phase` (fixup): `{ name, idx, lastOrderIdx }`; `verdict`: `{ verdict, failure, reasons, unmet, suggestions }`; `laterTasks`: `[{ key, orderIdx, status, dependsOn }]`; `expected`: `{ task: { key, title, description, acceptance, phase, orderIdx, dependsOn, mergePolicy, synthetic }, edges: [{ taskKey, dependsOn }], reorder: [{ taskKey, orderIdx }] }`.

Covers `toValidate`: all done → validate; a running task → nothing; done + skipped → validate; all skipped → pass and continue; a passed phase skipped over; an earlier pending phase blocks a later finished one; `validating` and `needs_human` stop the walk; a pending fix-up keeps the phase open; fix-up done → due again; the unnamed phase; a row without tasks passes; walk by `idx`, not input order; all passed. Covers `fixup`: round 1 with edges and reorder; round 2 of phase 2 (no edges for done/skipped tasks, which still move); the last phase (no edges); the unnamed phase (`phase: null`) and an edge that already exists.

### `transitions.json`
`[{ name, row, pending?, task, event, config, expected }]`. Runner: `nextTaskState(task, event, config)` (`src/core/transitions.ts`), then:

| `expected` field | Check |
| :--- | :--- |
| `status` | always compared |
| `patch` | `deepStrictEqual(result.patch ?? {}, expected.patch ?? {})`: an absent `patch` means no field changes |
| `decisionPrefix` | `result.decision.text` starts with it; absent means **no** decision |
| `notify` | `!!result.notify === !!expected.notify` |
| `effect` | `deepStrictEqual(result.effect ?? [], expected.effect ?? [])`: an ordered list of side effects the shell performs (`merge_local`, `push_and_pr`, `merge_pr`, `kill_agent`, `remove_worktree`) |
| `rejected` | `true` means the event is not allowed from this state: the result says so and `status` is unchanged |

Shapes:
- `task`: `{ key, status, attempt, max_attempts, fix_rounds, merge_policy, branch, worktree, pr_url, pr_head, last_feedback, synthetic? }`.
- `config`: `{ pr: boolean, feedback: { enabled, waitForChecks, maxRounds } }`.
- `event.type`: `start`, `worker_blocked`, `attempt_failed{feedback}`, `worker_done`, `validated{branchSha}`, `merge_failed{error}`, `answered{openQuestions, runStatus}`, `human_retry`, `human_skip`, `human_stop`, `run_stop`, `daemon_restart`, `human_merge`, `human_mark_merged`, `human_request_changes{feedback}`, `pr_action{action, kind?, feedback?}` (actions from `pr-poll.json`), `validator_blocked{reason}`.

Patch rules the cases pin down: the patch holds only what the transition decides. Values that come from performing an effect (`pr_url`, `pr_head`, `pr_pushed_at`, `pr_feedback_at`, a new `branch`/`worktree` on start) are written by the shell after the effect succeeds. `push_and_pr` always comes with `ci_status: null`; `remove_worktree` always comes with `worktree: null`, and is omitted when `worktree` is already null. Entering `done` also means the shell ticks `tasks.md` (§11), which is not listed as an effect. If an effect fails (a merge), the shell sends `merge_failed` instead of applying the transition (T9).

Row mapping (architecture §8):

| Row | Cases | Pending |
| :--- | :--- | :--- |
| T1 | start; retry start; start rejected when not pending | |
| T2 | worker blocked | |
| T3 | worker failure retry; validator FAIL retry; synthetic fix-up task retry (built by TASK-15; passes) | |
| T4 | last attempt fails; `max_attempts` 1 | |
| T5 | worker done | |
| T6 | local auto merge; local mode ignores no-new-commits; synthetic fix-up merge (built by TASK-15; passes) | |
| T7 | local manual; PR manual | |
| T8 | wait for checks; no wait; feedback disabled; fix round with new commits | |
| T8a | no new commits; wins over manual policy | |
| T9 | merge failure from validating; from pr_checks | |
| T10 | answered and resumed; another question still open | |
| T11 | answered while paused | |
| T12 | retry from failed; from pr_open; rejected while active | |
| T13 | skip with worktree; without worktree; rejected while active | |
| T14 | human stop; run stop; daemon restart; stop rejected when not active | |
| T15 | PR merge; local merge; merge from pr_checks; rejected from pending | |
| T16 | mark merged from pr_open; from failed without worktree | |
| T17 | request changes; ignores the round cap; local mode; rejected when not awaiting review | |
| T18 | mark_done; mark_failed; fix_round ci; fix_round review; fix_round over the cap → inbox; inbox; repeated inbox is a no-op; wait; merge | |
| T19 | UI validator blocked | TASK-16 |

### `pr-poll.json`
`[{ name, step, pending?, task, pr, localSha, now, config, expected }]`. Runner: `decidePrAction({ task, pr, localSha, now, config })` (`src/core/prpoll.ts`), then:

| `expected` field | Check |
| :--- | :--- |
| `action` | `mark_done`, `mark_failed`, `fix_round`, `inbox`, `wait` or `merge` |
| `kind` | `ci` or `review` for `fix_round`; absent otherwise |
| `reasonContains` | substring of `result.reason` (used for the decision, inbox text or notification) |
| `patch` | `deepStrictEqual(result.patch ?? {}, expected.patch ?? {})`: `pr_feedback_at` (watermark, step 3), `ci_status` (only when it differs from the task's, step 4), `ci_head` (step 6) |
| `itemBodies` | bodies of the feedback items carried by a review fix round, oldest first |
| `failedChecks` | names of the failed checks carried by a CI fix round |

Shapes:
- `task`: `{ key, status (pr_checks|pr_open), fix_rounds, pr_url, branch, pr_feedback_at, pr_pushed_at, updated_at, ci_head, ci_status }`.
- `pr`: a normalized `PrStatus` (`src/prfeedback.ts`): `{ number, url, state, headSha, reviewDecision, checks: Check[], feedback: FeedbackItem[] }`.
- `localSha`: the local branch head, or `null` when unknown (then the PR head is trusted).
- `config`: `{ trigger, ignoreAuthors, maxRounds, noChecksGraceSeconds, checksTimeoutMinutes }`.

Step mapping (architecture §12.2):

| Step | Cases |
| :--- | :--- |
| 1 merged | merged even with failing checks and a fresh trigger; manual task merged on GitHub (REQ-PRFB-04) |
| 2 closed | closed without merging |
| 3 review feedback | changes requested; REQ-PRFB-03 acceptance (bot excluded, inline kept); watermark covers non-trigger comments; bot trigger ignored; `isBot` inline ignored; ignored author case-insensitive; ts equal to the watermark is not fresh; older than the watermark; no trigger at a line start (`please /orch`, `/orchestrate`); trigger on a later line; empty changes-requested review triggers, empty plain review dropped; empty trigger setting; review wins over failing checks; rounds exhausted still `fix_round` (cap in T18) |
| 4 checks summary | head mismatch means pending (pr_open, pr_checks); unknown local sha; `none` within the grace period means pending; `none` after the grace period; unchanged `ci_status` gives no patch |
| 5 pending | within the timeout; past `checksTimeoutMinutes` → inbox; timeout from `updated_at` when never pushed; manual task never times out |
| 6 fail | new head → CI fix round; failure wins over pending; `ci_head` already acted on in pr_checks → inbox; in pr_open → wait (REQ-PRFB-02); rounds exhausted → inbox (REQ-PRFB-05) |
| 7 pass/none | auto task merges (REQ-PRFB-01); changes requested still open → inbox; manual task waits; `none` on a manual task waits |

## Behaviour changes

Cases whose expected output differs from what the code did when the fixtures were written. TASK-03 (or the task named) makes the code match. TASK-03 is done: the `extract-json`, T14 and readiness `maxAgents`/`busyAgents` rows below now pass; the `pending` rows wait for their tasks.

| File | Case | Reason |
| :--- | :--- | :--- |
| `extract-json.json` | fence of another language is not JSON; the json fence after it wins | Today a ` ```ts ` block before the JSON makes the fence regex pair the wrong backticks, so the worker's result is lost (`null`). Agents often show code before their final JSON. |
| `extract-json.json` | indented fence | Today the closing fence must start at column 0, so a JSON block indented inside a list item is lost (`null`). |
| `transitions.json` | T14: stop is rejected for a task that is not active | Today `stopTask` resets any task to `pending`, so "stop" on a `pr_open` task silently drops it out of the inbox. §8 only allows stopping active tasks. |
| `readiness.json` | global `maxAgents` and `busyAgents` cases | New inputs. Since TASK-09 the orchestrator passes `server.json` `scheduler.maxAgents` and the running planners as `busyAgents`. |
| `readiness.json` | fairness cases (built by TASK-09; pass), plan question (built by TASK-13; passes), ownership overlap (`pending: TASK-14`) | New behaviour built by those tasks. |
| `transitions.json` | T17 (built by TASK-06; passes), T19 (`pending: TASK-16`), fix-up tasks (built by TASK-15; pass) | New behaviour built by those tasks. |
| `readiness.json` | phase gate cases (added and built by TASK-15; pass) | New optional inputs `phases` (project) and `phase` (task); existing cases leave them out and are unchanged. |

Everything else (all 15 `tasks-md` cases, the other 13 `extract-json` cases, all 36 `pr-poll` cases and the non-pending transitions) matches the code's behaviour when the fixtures were written. The `tasks-md`, `extract-json` and `pr-poll` cases were checked mechanically against `parseTasksMd`, `extractJson` and a transcription of `pollPr` on the real `prfeedback.ts` helpers.
