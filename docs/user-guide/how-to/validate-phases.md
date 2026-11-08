# Validate whole phases

> [!NOTE]
> **Planned.** Phase validation isn't in the current release. This page describes how it will work.

Each task is validated on its own, but tasks that each pass can still fail together. Phase validation checks a whole phase on the base branch after all of its tasks merge. If the check fails, orch creates a fix-up task automatically, and later phases wait for it.

## How phase validation works

When every task in a phase is done or skipped, and at least one is done, orch:

1. Creates a temporary working copy of the base branch, and runs the project's `git.setupCommand` in it.
2. Runs the phase test command: `validation.phase.command`, or the project's `validation.command` if that's empty.
3. Runs a *phase validator* agent. It gets the phase's tasks, their worker summaries, an excerpt of the spec, and the test output. It returns PASS or FAIL with reasons.
4. Records the result as a decision, and removes the temporary working copy.

A phase validation counts as one agent toward the global agent limit. While a phase hasn't passed, tasks in later phases wait.

## What happens when a phase fails

If the phase fails and fix-up rounds remain (`validation.phase.maxFixups`, 2 by default), orch:

1. Creates a *fix-up task* named `FIX-<phase-number>.<round>`, for example `FIX-1.1`. Its description holds the failure and the reasons. Its acceptance criteria are the unmet criteria plus "phase validation passes". Its merge policy is `auto`.
2. Makes every task in later phases depend on it.
3. Records the creation as a decision.

The fix-up task runs like any other task. When it's done, orch validates the phase again. Fix-up tasks show a fix-up badge in the **Plan** tab, and orch never writes them into `tasks.md`.

If the phase still fails after the last fix-up round, the phase goes to your **Inbox**, and orch sends a notification. Choose one action:

- Re-run phase validation, for example after you fixed something by hand.
- Accept the phase as it is. Later phases then continue.

The **Plan** tab shows each phase's status: pending, validating, passed, failed or needs you.

## Configure phase validation

Phase validation is on by default. Set these keys in the project's `orch.config.json`:

```json
"validation": {
  "phase": {
    "enabled": true,
    "command": "npm run test:integration",
    "maxFixups": 2
  }
}
```

| Key | Default | Effect |
| :--- | :--- | :--- |
| `validation.phase.enabled` | `true` | Set to `false` to skip phase validation. Phases then complete as soon as their tasks finish. |
| `validation.phase.command` | `""` | The test command for the whole phase. Empty uses `validation.command`. |
| `validation.phase.maxFixups` | `2` | How many fix-up tasks orch creates for one phase before it asks you. Set to `0` to go to the inbox on the first failure. |

The phase validator uses the validator's agent and model unless you set the `phaseValidator` role. See [Choose agents and models](configure-agents.md).
