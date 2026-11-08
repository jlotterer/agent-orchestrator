# Validate UI tasks in a browser

> [!NOTE]
> **Planned.** UI validation mode isn't in the current release. This page describes how it will work.

Reading a diff and running unit tests can't tell whether a page looks and behaves right. For tasks in *UI validation mode*, orch starts your app from the task's working copy, and the validator uses a browser to check the acceptance criteria against the running app.

## Prerequisites

- Your app can start with one shell command and listen on the port in the `PORT` environment variable.
- The validator's agent program has a browser tool. For Claude Code, add a browser MCP server such as Playwright MCP to the configuration of the user that runs orch.

## Set the start command

1. In the project's `orch.config.json`, add:

   ```json
   "validation": {
     "ui": {
       "startCommand": "npm run dev",
       "url": "http://127.0.0.1:{port}/",
       "readyTimeoutSeconds": 120,
       "env": { "NODE_ENV": "development" }
     }
   }
   ```

2. Save the file.

| Key | Default | Effect |
| :--- | :--- | :--- |
| `validation.ui.startCommand` | `""` | The command that starts your app, run in the task's working copy. |
| `validation.ui.url` | `http://127.0.0.1:{port}/` | The address the validator opens. orch replaces `{port}` with the port it chose. |
| `validation.ui.readyTimeoutSeconds` | `120` | How long orch waits for the app to answer before the attempt fails. |
| `validation.ui.env` | `{}` | Extra environment variables for the app. |

## Mark a task for UI validation

The planner proposes UI mode for tasks that change what users see. To set it yourself:

1. On the **Plan** tab, select the task, and then select **Edit**.
2. Set the validation mode to `ui`.
3. Select **Save**.

The **Plan** tab shows each task's mode.

## What happens during UI validation

After the test gate passes, orch:

1. Picks a free port and starts your app with `PORT` set to it.
2. Checks the app's address every second until it answers, or until `readyTimeoutSeconds` passes. If the app never answers, the attempt fails, and the last part of the app's output becomes the feedback.
3. Gives the validator the app's address. The validator drives the app in a browser and checks each acceptance criterion.
4. Stops the app, whatever the result. orch also stops it when you stop the task or the run, and cleans up leftover app processes when it restarts after a crash.

If the validator reports that it can't drive a browser, the task fails right away, without more attempts, and goes to your inbox. Add a browser tool to the validator's agent program, and then retry the task.

Every validator, in UI mode or not, also gets the test gate's output.
