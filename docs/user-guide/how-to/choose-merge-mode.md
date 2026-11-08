# Choose how tasks merge

Two project settings control merging. The *merge mode* decides where a task's changes go: a GitHub pull request, or straight into your local base branch. The *merge policy* decides whether orch merges on its own or waits for you.

## Compare the merge modes

| | Pull request mode | Local merge mode |
| :--- | :--- | :--- |
| Setting | `"git": { "pr": true }` (default) | `"git": { "pr": false }` |
| Needs | The GitHub CLI, `gh`, signed in, and a remote named `origin` | Nothing beyond git |
| What orch does | Pushes the branch, opens a pull request, waits for CI, merges on GitHub | Rebases the branch and squash-merges it into your local checkout |
| CI and review feedback | Sent back to the worker automatically | Not available |
| `tasks.md` tick | Left as an uncommitted change on your base branch, so you can commit it with your next push | Committed on the base branch |
| Best for | Repos with CI and reviewers on GitHub | A server that's the only writer to the repo, or repos without GitHub |

## Use pull request mode

1. Make sure `gh` is installed and signed in as the user that runs orch:

   ```bash
   gh auth status
   ```

2. In the project's `orch.config.json`, set:

   ```json
   "git": { "pr": true }
   ```

3. Save the file. The setting applies from the next run you plan or start.

When a task passes validation, orch pushes its branch (`orch/<task-key>-<title>`), reuses the branch's open pull request or creates one, and then:

- For `auto` tasks, waits for the pull request's checks to pass, and then merges with `gh pr merge --squash --delete-branch`. While it waits, the task is in the **Waiting on CI** lane.
- For `manual` tasks, puts the task in your inbox with the pull request link.

If the merge fails because of a conflict, required checks or authentication, the task goes to the inbox as a **review** item with the error. Fix it on GitHub, and then select **Merged elsewhere**. Or select **Re-run**.

To merge straight after the pull request is created, without waiting for CI, set `"git": { "feedback": { "enabled": false } }`.

For how orch reacts to CI results and review comments while the pull request is open, see [Use the pull request feedback loop](use-pr-feedback.md).

## Use local merge mode

1. In the project's `orch.config.json`, set:

   ```json
   "git": { "pr": false }
   ```

2. In the repo's main checkout, check out the base branch, and keep it free of uncommitted changes to tracked files. orch merges into this checkout.
3. Save the file. The setting applies from the next run you plan or start.

When a task passes validation, orch rebases its branch onto the base branch and squash-merges it as one commit. To keep each task's individual commits with a fast-forward merge instead, set `"git": { "squash": false }`. Then orch removes the task's working copy and deletes its branch.

If the main checkout is on another branch, or has uncommitted changes to tracked files, the task goes to your inbox with "local merge needs '`<base>`' checked out" or "local merge needs a clean working tree". Fix the checkout, and then select **Merge now**.

You push the merged base branch yourself.

## Set the merge policy

Each task has a merge policy:

- `auto`: orch merges the task as soon as it passes validation (and, in pull request mode, CI).
- `manual`: orch waits for your review. See [Review and merge a task](review-and-merge.md).

The project setting `git.mergePolicy` sets the default for every task (`auto` unless you change it). The planner sets `manual` on risky tasks on its own, and you can change any task's policy in the plan. See [Review and approve a plan](review-a-plan.md#edit-a-task).

To review every task, set:

```json
"git": { "mergePolicy": "manual" }
```

## Prepare each working copy

Each task gets a fresh working copy of the repo. If your tests need files that aren't in git, or need dependencies installed, set these keys:

```json
"git": {
  "copyFiles": [".env"],
  "setupCommand": "npm ci"
}
```

- `copyFiles`: files copied from the repo's main checkout into each new working copy.
- `setupCommand`: a command run in each new working copy before the worker starts. If it fails, the attempt fails and its output becomes the feedback.

> [!WARNING]
> Agents can read every file you copy into a working copy. List only what the tests need, and keep production secrets out of `copyFiles`.

## Turn off the tasks.md tick

By default, orch ticks each merged task in `tasks.md`. To leave `tasks.md` alone, set `"git": { "tickTasksMd": false }`. orch never ticks `tasks.md` on task branches, and it skips the tick when `tasks.md` is outside the repo.
