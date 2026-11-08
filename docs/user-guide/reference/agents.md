# What agents see and do

This page describes what each agent role receives, what it can do while it works, and what it must return. It helps when you write specs, customize prompts, or read an agent's log.

## What each role receives

| Role | Receives | Doesn't receive |
| :--- | :--- | :--- |
| Planner | The feature title, every file in the feature folder except `tasks.md` (up to twice `handoff.specChars`), and the imported task list. | Not applicable |
| Worker | The task's key, title, description and acceptance criteria; an excerpt of `plan.md` and `spec.md` (up to `handoff.specChars`); a hand-off brief; its branch and base branch; the test command; and feedback from a failed attempt, fix round or **Send back**. The files it owns. | Other tasks' sessions |
| Validator | The task, its acceptance criteria, the worker's summary as claims to check, and the diff against the base branch. The test gate's output (**Planned**). The list of changes outside the task's owned files. The app's address in UI mode (**Planned**). | The worker's reasoning or conversation |
| Phase validator (**Planned**) | The phase's tasks and their summaries, an excerpt of the spec, and the phase test output. | Not applicable |

### The hand-off brief

Each worker starts with a fresh session, so orch gives it a hand-off brief of earlier work, up to `handoff.historyChars` characters:

- Summaries of completed tasks that come earlier in the plan. Direct dependencies get their full summary. Others get a shortened summary. Each lists up to eight touched files.
- The last 25 decisions of the run.
- Every question you answered so far, with your answer.

If a worker gave no summary, later briefs say so.

## What agents can do while they work

Agents work in their task's own working copy, on branch `orch/<task-key>-<title>`. They commit there, but don't push, open pull requests, or switch branches. orch does all of that.

They can call two `orch` commands. orch puts `orch` on their `PATH` and sets everything those commands need, including the access token.

- `orch decide "<decision>" --why "<reason>"` records a judgment call, such as choosing a library or changing an interface. It appears in the **Decisions** tab with the agent's role as the actor. The agent keeps working.
- `orch ask "<question>" --options "A,B"` asks you a question and tells the agent to stop. The question appears in the **Inbox**, and only that task pauses. When you answer, the same session continues with your answer, and no attempt is used.

Workers are told to ask only when something is ambiguous and a wrong guess would be expensive to undo. Otherwise, they decide and record the decision.

## What agents return

Each role ends its final message with one JSON block. orch reads the last JSON block in the message, or, if there isn't one, the last JSON object at the end.

### Planner

```json
{
  "tasks": [
    { "key": "T001", "acceptance": ["..."], "depends_on": [], "merge_policy": "auto", "validate_cmd": null }
  ],
  "decisions": [{ "text": "...", "rationale": "..." }],
  "questions": [{ "text": "...", "options": ["...", "..."] }]
}
```

orch ignores entries for task keys that don't exist. Each task can also have `files_owned`, a list of files or glob patterns. **Planned:** `validate_mode` (`standard` or `ui`).

### Worker

```json
{
  "status": "done",
  "summary": "What was built, where, and what the next worker must know.",
  "files": ["src/one.ts"],
  "decisions": [{ "text": "...", "rationale": "..." }],
  "follow_ups": ["Work noticed but not done"]
}
```

`status` is `done`, `blocked` (after `orch ask`), or `failed` with a `reason`. A missing block doesn't fail the task: it continues to validation without a summary.

### Validator

```json
{
  "verdict": "PASS",
  "criteria": [{ "criterion": "...", "met": true, "evidence": "..." }],
  "reasons": ["Why it fails, if it fails"],
  "suggestions": ["Optional improvements"]
}
```

Anything other than `PASS`, including a missing block, fails the attempt. The worker's next attempt gets the reasons and the unmet criteria.

The verdict can include `findings`, such as changes outside the task's owned files. Findings don't fail the task by themselves. **Planned:** a `BLOCKED` verdict in UI mode when the validator can't use a browser, which fails the task without retries.

### Phase validator

**Planned.**

```json
{ "verdict": "PASS", "reasons": [], "unmet": [], "suggestions": [] }
```

## Customize the prompts

To change a role's instructions for one project, copy its prompt from the orch source's `prompts/` folder to `<repo>/.orch/prompts/<role>.md` and edit the copy. Keep the JSON block format above. Test a changed prompt with one real run before you rely on it. See [Choose agents and models](../how-to/configure-agents.md#customize-a-prompt).
