# Troubleshooting

Find your symptom or error message, then follow the fix. Error messages from the `orch` command start with `error:`. Errors during a task appear in the task's **Log**, in **Last feedback**, and in the **Activity** tab. Server errors go to the terminal or system journal where orch runs. For a systemd service, run `journalctl -u orch -f`. For Docker, run `docker compose logs -f orch`.

## Starting orch

### "refusing to listen on `<host>` without an access token"

**Cause:** `host` in `server.json` is a network address, and no access token is set.

**Fix:** Set `ORCH_TOKEN` or `auth.token`. Or set `host` back to `127.0.0.1`. See [Secure remote access](how-to/secure-access.md).

### "no projects registered in `<path>`"

**Cause:** orch started, but no project is registered yet. This is a warning, and orch keeps running.

**Fix:** Register a project. See [Add and manage projects](how-to/manage-projects.md).

### "agents.roles.`<role>`.adapter '`<name>`' is not defined in agents.adapters"

**Cause:** A role in `server.json` names an adapter that isn't defined.

**Fix:** Use `claude` or `gemini`, or define the adapter under `agents.adapters`.

### The dashboard doesn't load from another machine

**Cause:** orch listens on `127.0.0.1` by default, or a firewall blocks the port.

**Fix:** Set `host` to `0.0.0.0` and set an access token. In Docker, check the published port in `docker-compose.yml`.

### The dashboard keeps asking for the token

**Cause:** The token you enter doesn't match the server's, or the browser blocks cookies for the site.

**Fix:** Check `ORCH_TOKEN` on the server first, because it overrides `auth.token`. Allow cookies for orch's address.

## Commands

### The command can't reach orch

**Cause:** orch isn't running, or it runs on another port or machine.

**Fix:** Start `orch serve`. If orch runs elsewhere, set `ORCH_URL`, for example `export ORCH_URL=http://my-server:4800`.

### "unauthorized"

**Cause:** An access token is set on the server, and the command can't find it.

**Fix:** Set `ORCH_TOKEN` in your terminal. The command also reads `auth.token` from `$ORCH_HOME/server.json`, if it can read that file.

### "which project? Run inside a project's repo or pass --project <id> (or set ORCH_PROJECT)"

**Planned.** **Cause:** Several projects are registered, and the command can't tell which one you mean.

**Fix:** Run it inside the project's repo, add `--project <project-id>`, or set `ORCH_PROJECT`.

### "task `<key>` not found"

**Cause:** The key isn't in the project's current run, or the command picked another project.

**Fix:** Run `orch status` to see the run and its keys. Add `--project <project-id>` if needed.

### "already answered"

**Cause:** Someone already answered the question, for example from the dashboard.

**Fix:** None needed. The first answer counts.

## Registering projects

### "`<path>` is not a git repository"

**Fix:** Check the path, or run `git init` in the folder first.

### "`<path>` is not a git repository root (the repository root is `<root>`)"

**Fix:** Register the path it suggests.

### "`<path>` is already registered as project '`<id>`'"

**Fix:** None needed. Use the existing project. To see it, run `orch project list`.

### A project shows "repository `<path>` does not exist"

**Cause:** The repo folder was moved or deleted.

**Fix:** Restore the folder at that path. Or archive the project and register the new path.

## Settings

### "`<key>` is a server setting and is not allowed in project settings"

**Cause:** A project's `orch.config.json` contains a server key, such as `agents`, `host`, `auth` or `notify`. orch refuses to plan or start that project.

**Fix:** Remove the key from the project file. Set it in `server.json` instead, if you need it. See [Project settings](reference/project-settings.md#keys-a-project-file-cant-set).

### "unknown key '`<key>`' ignored"

**Cause:** A settings file has a key orch doesn't know, often a typo. The warning appears in the run's **Activity** tab.

**Fix:** Correct or remove the key.

### A settings change has no effect

**Cause:** Project settings apply from the next run you plan or start, not to a run that's already going. Server settings apply after a restart.

**Fix:** Start a new run, or restart orch for server settings.

## Planning

### "no tasks.md in `<path>`. Run /speckit.tasks first."

**Fix:** Create `tasks.md` in the feature folder.

### "no tasks found in `<path>`"

**Cause:** No line matches the task format.

**Fix:** Use lines like `- [ ] T001 Do something`. See [Task file format](reference/tasks-file.md).

### "project '`<id>`' already has an unfinished run `<run-id>` (`<status>`, "`<title>`"); finish or stop it first"

**Cause:** Each project can have only one unfinished run.

**Fix:** Finish that run, or stop it with `orch stop` or **Stop**, and then plan again.

### "planner failed or returned no plan; using imported tasks as-is"

**Cause:** The planner agent exited with an error or didn't return a usable result. The plan still waits for your approval, with the tasks as written.

**Fix:** Read the planner's output in the **Activity** tab. Add acceptance criteria yourself, or plan again after fixing the cause, such as a usage limit.

### "plan not approved yet"

**Fix:** Approve the plan before you start the run.

## Tasks

### "failed to start '`<command>`'"

**Cause:** orch couldn't launch the agent program. It isn't installed, or it isn't on the `PATH` of the user that runs orch.

**Fix:** Install the program for that user, or set its full path in `agents.adapters.<name>.command`.

### "`<adapter>` timed out after `<time>`; killing"

**Cause:** An agent session ran longer than `agents.timeoutMinutes`.

**Fix:** Split the task into smaller ones, or raise the limit.

### "setup command failed (exit `<code>`)"

**Cause:** `git.setupCommand` failed in the new working copy. Its output is in the feedback.

**Fix:** Run the command yourself in a fresh clone to find the problem. In Docker, make sure the image has the tools it needs.

### The attempt fails with "no commits"

**Cause:** The worker finished without changing anything.

**Fix:** Read the worker's summary and log. The task might already be done, or its description might be unclear. Edit the task, or skip it.

### Tasks fail because the agent hit a usage limit

**Cause:** Subscription usage limits. An orchestrated run starts several fresh sessions per task.

**Fix:** Pause the run. When the limit resets, retry the failed tasks and start the run again. Lower `scheduler.maxAgents` to use fewer sessions at once.

### A task stays in Pending

**Cause:** One of its dependencies isn't done, a question is open, or no slot is free under `scheduler.maxParallel` or `scheduler.maxAgents`.

**Fix:** Check the task's **Depends on** list and the **Inbox**. If the run waits on you, the **Activity** tab says which tasks are blocked and why.

## Merging

### "local merge needs '`<base>`' checked out in `<repo>` (currently '`<branch>`')"

**Fix:** In the repo's main checkout, check out the base branch, and then select **Merge now**.

### "local merge needs a clean working tree in `<repo>`"

**Fix:** Commit or discard the uncommitted changes to tracked files in the main checkout, and then select **Merge now**.

### "rebase onto `<base>` failed"

**Cause:** The task's changes conflict with the base branch, usually because two tasks changed the same file.

**Fix:** Select **Re-run** to start the task again on the current base branch. To prevent it, add a dependency between the two tasks. See [Run tasks in parallel](how-to/run-in-parallel.md#keep-parallel-tasks-apart).

### "gh pr create failed" or "gh pr merge failed"

**Cause:** The GitHub CLI isn't signed in, lacks permission, or GitHub refused the merge, for example because of required checks or a conflict.

**Fix:** Run `gh auth status` as the user that runs orch. Fix the problem on GitHub, and then select **Merged elsewhere** or **Re-run**.

### "Fix round `<n>` produced no new commits"

**Cause:** The worker didn't change anything in response to the feedback.

**Fix:** Read the feedback and the worker's log. Send it back with clearer instructions, merge it as it is, or fix it yourself and select **Merged elsewhere**.

### The tasks.md tick isn't committed

**Cause:** In pull request mode, orch leaves the tick as an uncommitted change on your base branch, so it doesn't push for you.

**Fix:** Commit it with your next push.

## Docker

### Claude Code refuses to run

**Cause:** The container runs as root, or it started from inside a Claude Code session.

**Fix:** Don't override `user:` in the compose file. Start the container from a plain shell.

### Permission errors on `work/`

**Cause:** The folder isn't owned by user ID 1000.

**Fix:** Run `sudo chown -R 1000:1000 work`.
