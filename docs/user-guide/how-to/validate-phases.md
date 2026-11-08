# Validate whole phases

Each task is validated on its own, but tasks that each pass can still fail together. Phase validation checks a whole phase on the base branch after all of its tasks merge. If the check fails, orch creates a fix-up task automatically, and later phases wait for it.

## How phase validation works

When every task in a phase is done or skipped, and at least one is done, orch:

1. Creates a temporary working copy of the base branch (`origin/<base>` in pull request mode), and runs the project's `git.setupCommand` in it.
2. Runs the phase test command: `validation.phase.command`, or the project's `validation.command` if that's empty. If the command fails, the phase fails without asking the agent.
3. Runs a *phase validator* agent, unless `validation.agent` is `false`. It gets the phase's tasks, their acceptance criteria and worker summaries, an excerpt of the spec, and the test output. It returns PASS or FAIL with reasons and unmet criteria.
4. Records the result as a decision, and removes the temporary working copy.

Phases are validated one at a time, in order. A phase validation counts as one agent toward the global agent limit, so it waits when no agent slot is free. While a phase hasn't passed, tasks in later phases wait, even tasks that don't depend on anything. The run is done only when every phase has passed.

If every task in a phase was skipped, there's nothing to validate: the phase passes, and orch records that as a decision.

A phase that was already finished when the run started also passes without a check, for example when all of its tasks were ticked `- [x]` in `tasks.md`, or when a run that was in progress before you upgraded orch had already finished it. orch records that as a decision too. A phase that was only partly finished is validated as usual once its remaining tasks are done.

## What happens when a phase fails

If the phase fails and fix-up rounds remain (`validation.phase.maxFixups`, 2 by default), orch:

1. Creates a *fix-up task* named `FIX-<phase-number>.<round>`, for example `FIX-1.1`, at the end of the phase. Its description holds the failure and the reasons. Its acceptance criteria are the unmet criteria plus "phase validation passes". Its merge policy is `auto`.
2. Makes every unfinished task in later phases depend on it.
3. Records the creation as an orchestrator decision.

The fix-up task runs like any other task: worker, test gate, validator, merge, and retries. When it's done, orch validates the phase again. Fix-up tasks show a **fix-up** badge on the board and in the **Plan** tab, and orch never writes them into `tasks.md`.

If the phase still fails after the last fix-up round, the phase goes to your **Inbox**, and orch sends a notification. The same happens when the validation can't run at all, for example when the temporary working copy can't be created. Choose one action:

- **Re-run validation**, for example after you fixed something by hand on the base branch. The fix-up round count is kept, so another failure comes straight back to the inbox.
- **Accept phase** to take the phase as it is. Later phases then continue.

The **Plan** tab shows each phase's status next to its name: **validation pending**, **validating**, **passed** or **needs you**, and how many fix-up rounds it used.

If you stop the run or the server restarts during a phase validation, the phase goes back to pending and is validated again.

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
| `validation.phase.enabled` | `true` | Set to `false` to skip phase validation. Later phases then don't wait for earlier ones beyond their task dependencies. |
| `validation.phase.command` | `""` | The test command for the whole phase. Empty uses `validation.command`. |
| `validation.phase.maxFixups` | `2` | How many fix-up tasks orch creates for one phase before it asks you. Set to `0` to go to the inbox on the first failure. |

The phase validator uses the validator's agent and model unless you set the `phaseValidator` role. See [Choose agents and models](configure-agents.md).
