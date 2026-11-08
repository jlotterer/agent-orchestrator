# Validate UI tasks in a browser

Reading a diff and running unit tests can't tell whether a page looks and behaves right. For tasks in *UI validation mode*, orch starts your app from the task's working copy, and the validator uses a browser to check the acceptance criteria against the running app.

## Prerequisites

- orch runs on Linux or macOS (or in Docker). UI validation mode stops the app's whole process group, which Windows doesn't support.
- Your app starts with one shell command and listens on the port in the `PORT` environment variable.
- The validator's agent program has a browser tool. orch doesn't drive a browser itself.

## Give the validator a browser

For Claude Code, add the Playwright MCP server for the user that runs orch:

1. Run:

   ```bash
   claude mcp add --scope user playwright -- npx -y @playwright/mcp@latest --headless
   ```

2. Check that it connects:

   ```bash
   claude mcp list
   ```

   The list shows `playwright` as connected.

The built-in Claude Code adapter runs without permission prompts, so the validator can use the browser tools right away. If you run orch in Docker, install a browser in the image, for example with `npx playwright install --with-deps chromium`.

> [!TIP]
> To give only validators a browser, define a second adapter in `server.json` whose `extraArgs` add `--mcp-config <file>`, and set the project's `roles.validator` to it. See [Configure agents](configure-agents.md).

## Set the start command

1. In the project's `orch.config.json`, add:

   ```json
   "validation": {
     "ui": {
       "startCommand": "npm run dev -- --port $PORT --host 127.0.0.1",
       "url": "http://127.0.0.1:{port}/",
       "readyTimeoutSeconds": 120,
       "env": { "NODE_ENV": "development" }
     }
   }
   ```

2. Save the file. orch reads it when you plan or start a run.

| Key | Default | Effect |
| :--- | :--- | :--- |
| `validation.ui.startCommand` | `""` | The command that starts your app, run with `sh -c` in the task's working copy. |
| `validation.ui.url` | `http://127.0.0.1:{port}/` | The address the validator opens. orch replaces `{port}` with the port it chose. |
| `validation.ui.readyTimeoutSeconds` | `120` | How long orch waits for the app to answer before the attempt fails. |
| `validation.ui.env` | `{}` | Extra environment variables for the app. |

## Mark a task for UI validation

The planner proposes UI mode for tasks that change what users see. To set it yourself:

1. On the **Plan** tab, select the task, and then select **Edit**.
2. In **Validation mode**, select **ui**.
3. Select **Save**.

The **Plan** tab shows **🖥 UI validation** for each task in UI mode. If the project has no start command, it also shows **⚠ no start command**.

UI mode needs the validator agent. If `validation.agent` is `false`, the test gate alone decides, as for any task.

## What happens during UI validation

After the test gate passes, orch:

1. Picks a free port and starts your app with `PORT` set to it.
2. Checks the app's address every second until it answers with a status below 500, or until `readyTimeoutSeconds` passes. If the app never answers or exits, the attempt fails, and the feedback holds the app's last 3,000 characters of output.
3. Gives the validator the app's address. The validator drives the app in a browser and checks each acceptance criterion. It's told not to start or stop the app itself.
4. Stops the app, whatever the result.

orch also stops the app when you stop the task or the run, and when orch shuts down. If orch crashes, it stops the leftover app the next time it starts, and the task's activity says so.

The **Activity** tab shows "starting app", "app ready at …" and "app stopped" for each validation.

## When UI validation is blocked

The task fails right away, without more attempts, and goes to your inbox, when:

- The validator reports that it can't drive a browser (verdict `BLOCKED`).
- The project has no `validation.ui.startCommand`.

The feedback starts with "UI validation blocked:". Fix the setup, and then retry the task.

Every validator, in UI mode or not, also gets the test gate's output.
