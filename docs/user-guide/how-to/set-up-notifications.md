# Get push notifications

orch can send a push notification to your phone or desktop whenever something needs you, so you can walk away from a run. It uses [ntfy](https://ntfy.sh), a free notification service that you can also host yourself.

## When orch notifies you

orch sends a notification when:

- A plan is ready for your approval.
- A worker or the planner asks a question.
- A task fails after its attempts.
- A `manual` task passes validation and waits for your review.
- Merging fails, or a pull request needs you (CI keeps failing, checks hang, a reviewer still asks for changes).
- A phase needs you (**Planned**).
- A run finishes.

Each notification title starts with the project name in square brackets, for example `[shop]`, and names the task. Selecting the notification opens the task's pull request, or the dashboard at `publicUrl`.

## Set up ntfy

1. Install the ntfy app on your phone, or open ntfy in a browser.
2. Choose a topic name that's hard to guess, for example `orch-7f3k9q`, and subscribe to it in the app. Anyone who knows the topic name can read its messages.
3. In `~/.orch/server.json`, set:

   ```json
   "notify": {
     "ntfyUrl": "https://ntfy.sh/<topic>",
     "ntfyToken": ""
   },
   "publicUrl": "http://my-server:4800"
   ```

   - `<topic>` is your topic name.
   - `ntfyToken` is an access token for a protected topic or a self-hosted ntfy server. Leave it empty for a public topic.
   - `publicUrl` is the address you use to reach the dashboard.

4. Restart orch.

The **Setup** section of the dashboard shows "ntfy on" when notifications are configured.

If the notification service can't be reached, orch logs the error and carries on. The inbox works the same with or without notifications.
