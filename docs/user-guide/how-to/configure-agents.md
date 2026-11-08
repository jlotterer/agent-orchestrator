# Choose agents and models

orch launches an agent program for each role: planner, worker, validator, and phase validator. You choose which program and model each role uses. Two agent programs are supported: Claude Code and Gemini CLI.

## Supported agent programs

orch calls each supported program through an *adapter*, a name you use in the settings.

| Adapter | Program | Default extra arguments |
| :--- | :--- | :--- |
| `claude` | Claude Code (`claude`) | `--permission-mode bypassPermissions` |
| `gemini` | Gemini CLI (`gemini`) | `--yolo --skip-trust` |

Both run without prompts inside the task's working copy, and both can resume an earlier session, so retries keep what the agent learned.

> [!NOTE]
> The Claude Code adapter is tested end to end against the real program. The Gemini CLI adapter is tested against a simulated program but hasn't been run against a live Gemini account yet. Expect to adjust the validator prompt slightly the first few times you use it.

## Set the agent for each role on the server

Server-wide defaults live in `~/.orch/server.json`, under `agents.roles`. They apply to every project.

1. In `~/.orch/server.json`, set the adapter and model for each role:

   ```json
   "agents": {
     "roles": {
       "planner":   { "adapter": "claude", "model": "" },
       "worker":    { "adapter": "claude", "model": "" },
       "validator": { "adapter": "gemini", "model": "pro" }
     }
   }
   ```

   An empty `model` uses the program's default model.

2. Restart orch.

The validator is the natural place for a second vendor. It only reads the diff and runs tests, and a model from a different vendor shares fewer blind spots with the worker. Keep workers on Claude Code if your skills, hooks and `CLAUDE.md` files are written for it.

## Override a role for one project

A project can choose a different adapter or model for a role, from the adapters the server defines.

1. In the project's `orch.config.json`, add `roles`:

   ```json
   "roles": {
     "validator": { "adapter": "claude", "model": "opus" }
   }
   ```

2. Save the file. The change applies from the next run you plan or start.

If the adapter name isn't defined in `server.json`, orch refuses to plan or start the project and names the problem.

For phase validation, set the `phaseValidator` role. If you don't, it uses the validator's settings.

## Sign in to the agent programs

orch launches the programs as the user that runs orch, so they use that user's sign-in.

- **Claude Code:** sign in once with `claude` as that user. A subscription sign-in works. An orchestrated run starts several fresh sessions per task, so it reaches subscription usage limits faster than interactive use.
- **Gemini CLI:** run `gemini` once as that user to sign in. Or set `GEMINI_API_KEY` in the adapter's `env`:

  ```json
  "agents": { "adapters": { "gemini": { "env": { "GEMINI_API_KEY": "<key>" } } } }
  ```

orch never writes adapter `env` values to its database, its logs or agent prompts.

## Change the program path, arguments or time limit

Each adapter in `agents.adapters` has these keys:

| Key | Effect |
| :--- | :--- |
| `type` | Which adapter it is: `claude` or `gemini`. |
| `command` | The program to run, for example `claude` or a full path. |
| `extraArgs` | Arguments added to every launch. |
| `env` | Extra environment variables for the program. |

To limit what Claude Code workers can do, replace the default arguments with an allowlist of tools:

```json
"agents": {
  "adapters": {
    "claude": {
      "type": "claude",
      "command": "claude",
      "extraArgs": ["--allowedTools", "Bash,Edit,Read,Write"]
    }
  }
}
```

`agents.timeoutMinutes` (90 by default) is how long any agent session may run. orch ends a session that runs longer, and counts it as a failed attempt.

A project's `orch.config.json` can't change `agents` at all. That stops a cloned repo from changing which programs run on your server or which credentials they get.

## Customize a prompt

Each role's instructions come from a prompt file in the orch source: `prompts/planner.md`, `prompts/worker.md` and `prompts/validator.md`. To change them for one project:

1. Copy the prompt into the project's repo at `.orch/prompts/<role>.md`, for example `.orch/prompts/validator.md`.
2. Edit the copy.

orch uses the project's copy from then on. Keep the final JSON block that the original prompt asks for, because orch reads the agent's result from it. See [What agents see and do](../reference/agents.md).

## Retry with a fresh session

By default, a retried worker resumes its earlier session, so it keeps what it learned. To start each attempt in a clean session instead, set this in the project's `orch.config.json`:

```json
"scheduler": { "resumeOnRetry": false }
```

**Re-run from scratch** in the dashboard always starts a fresh session.

## Turn off the validator agent

To let the test gate alone decide whether a task passes, set `"validation": { "agent": false }` in the project's `orch.config.json`. If no test command is set either, every task that makes commits passes.
