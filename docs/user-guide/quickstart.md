# Quickstart: your first run

In this quickstart, you register a repo with orch, give it a two-task feature, and watch orch implement, check and merge both tasks. To keep it short, you use local merge mode, so you don't need GitHub. It takes about 15 minutes, most of it agent time.

## Before you begin

- Install orch and confirm `orch serve` starts. See [Install orch](install.md).
- Have a git repo on the server with a working test command, such as `npm test` or `pytest`. This quickstart uses `~/projects/myapp`.
- Check out the repo's base branch (usually `main`) and make sure it has no uncommitted changes. Local merge mode merges into this checkout.

## Register the project

How you register a repo depends on your orch release.

### With project commands

**Planned.** This applies when your release includes `orch project add`. To check, run `orch help`.

1. Start orch, if it isn't running:

   ```bash
   orch serve
   ```

2. In another terminal, register the repo:

   ```bash
   orch project add ~/projects/myapp
   ```

   orch registers the project and, because the repo has no settings file, creates one:

   ```text
   registered project myapp "myapp" at /home/you/projects/myapp
   created starter settings file /home/you/projects/myapp/orch.config.json; set validation.command there
   ```

### Without project commands

In the current release, you register your first project by starting orch from inside the repo.

1. Stop orch if it's running.
2. Go to the repo and create a settings file:

   ```bash
   cd ~/projects/myapp
   orch init
   ```

3. Start orch from the same folder:

   ```bash
   orch serve
   ```

   On this first start, orch moves the server settings from the file into `~/.orch/server.json` and registers the repo as a project. This works only while `~/.orch/server.json` doesn't exist yet.

## Configure the project

1. Open `~/projects/myapp/orch.config.json` in an editor.
2. Set your test command and turn off pull requests for this first run:

   ```json
   {
     "baseBranch": "main",
     "validation": { "command": "npm test" },
     "git": { "pr": false }
   }
   ```

   Replace `npm test` with your project's test command. Keep any other keys that are already in the file.

3. Save the file. orch reads it again when you plan or start a run, so you don't need to restart orch.

## Write a small feature

1. Create a feature folder:

   ```bash
   mkdir -p ~/projects/myapp/specs/001-hello
   ```

2. Create `~/projects/myapp/specs/001-hello/spec.md` with a short description of what you want:

   ```markdown
   # Hello command
   Add a `hello` function that returns "Hello, <name>!" and a unit test for it.
   ```

3. Create `~/projects/myapp/specs/001-hello/tasks.md` with two tasks:

   ```markdown
   ## Phase 1: Core
   - [ ] T001 Add a hello(name) function in src/hello.js
   - [ ] T002 Add unit tests for hello(name)
   ```

   T002 depends on T001, because it has no `[P]` marker.

In real use, Spec Kit's `/speckit.specify`, `/speckit.plan` and `/speckit.tasks` commands write these files for you.

## Plan the feature

1. Run the planner:

   ```bash
   cd ~/projects/myapp
   orch plan specs/001-hello
   ```

   The planner takes a minute or so. Then orch prints the new run and its status:

   ```text
   run 3f9c2a1b "Hello command" → plan_pending. Review the plan in the dashboard, then: orch approve
   ```

   The run ID is random. The title comes from the first heading of `spec.md`.

2. In a browser, go to `http://127.0.0.1:4800`.
3. Go to the **Plan** tab. Read the acceptance criteria the planner wrote for each task.
4. Optional: select a task to open it, select **Edit**, change something, and then select **Save**.

## Approve and start the run

1. In the top bar, select **Approve plan**.
2. Select **Start**.
3. Go to the **Board** tab. Each task card moves through the lanes: **Pending**, **Running**, **Validating**, and then **Done**.
4. Select a task card. The **Task** panel opens and shows the agent's live log.

If a worker asks a question, it appears in the **Inbox**. Select one of the offered answers, or enter your own and select **Send**. The worker continues where it stopped.

## Check the result

When both tasks are done, the run status changes to `done`. In your repo:

```bash
git log --oneline -3
```

You see one squashed commit per task, plus a commit that ticks the tasks in `tasks.md`.

Go to the **Decisions** tab to see every choice the planner, the agents and orch made during the run, with the reason for each.

## Next steps

- Switch to pull request mode and let CI failures flow back to the worker. See [Choose how tasks merge](how-to/choose-merge-mode.md) and [Use the pull request feedback loop](how-to/use-pr-feedback.md).
- Get a phone notification when orch needs you. See [Get push notifications](how-to/set-up-notifications.md).
- Reach the dashboard from your laptop or phone. See [Secure remote access](how-to/secure-access.md).
- Use a second agent vendor for validation. See [Choose agents and models](how-to/configure-agents.md).
