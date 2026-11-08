# Add and manage projects

One orch server manages all of your repos. Each registered repo is a *project*, with its own settings file, runs and inbox items.

> [!NOTE]
> **Planned.** The `orch project` commands and the dashboard project controls described on this page are in development. In the current release, you register your first project by starting orch from inside its repo. See [Quickstart](../quickstart.md#without-project-commands).

## Add a project

Prerequisites:

- orch is running (`orch serve`).
- The repo is cloned on the server, and you know the path of its top-level folder.

Steps:

1. Register the repo:

   ```bash
   orch project add <repo-path> --name <name>
   ```

   - `<repo-path>` is the path of the repo's top-level folder, for example `~/projects/shop`.
   - `<name>` is optional. It's the display name, and it defaults to the folder name.

2. Read the output. orch confirms the project ID, name and path:

   ```text
   registered project shop "shop" at /home/you/projects/shop
   created starter settings file /home/you/projects/shop/orch.config.json; set validation.command there
   ```

3. If orch created a starter settings file, open it and set `validation.command` to your test command. The starter file contains only the detected base branch and an empty test command.

The project ID comes from the folder name. If another project already uses that ID, orch adds a number, such as `shop-2`.

orch refuses a path in these cases:

| Message | Cause |
| :--- | :--- |
| "`<path>` is not a git repository" | The folder isn't inside a git repo. |
| "`<path>` is not a git repository root (the repository root is `<root>`)" | The folder is inside a repo, but isn't its top-level folder. Use the path it suggests. |
| "`<path>` is already registered as project '`<id>`'" | That repo is already a project. |

### Add a project from the dashboard

**Planned.**

<!-- TODO(verify): exact dialog and button labels once the dashboard project controls ship -->

1. In the top bar, open the project switcher and select **Add project**.
2. Enter the repo path and, optionally, a name.
3. Confirm the dialog. If orch refuses the path, the reason appears in the dialog.

## List projects

- Run:

  ```bash
  orch project list
  ```

  Each line shows the project ID, name, the status and ID of its current run, the repo path, and, when they apply, the number of open inbox items and any error.

To include archived projects, add `--archived`.

In the dashboard (**Planned**), the project switcher in the top bar lists every project with a status dot for its current run and its inbox count. Select a project to switch the **Board**, **Plan**, **Decisions** and **Activity** tabs to it. The dashboard remembers your choice in that browser.

## Archive a project

Archiving removes a project from the project list and the inbox. It doesn't delete the repo or the project's history.

Prerequisite: the project has no unfinished run. If it has one, stop the run first. See [Run and control a run](control-a-run.md).

- Run:

  ```bash
  orch project remove <project-id>
  ```

  orch confirms: "archived project `<project-id>` (the repository and its history are kept; `orch project add` restores it)".

In the dashboard (**Planned**), select **Archive** for the project, and then confirm.

## Restore an archived project

- Register the same path again:

  ```bash
  orch project add <repo-path>
  ```

  orch restores the project with all of its earlier runs and prints "restored archived project …".

## Choose which project a command acts on

Commands such as `orch status`, `orch plan` and `orch run` act on one project. orch picks it in this order:

1. The `--project <project-id>` flag.
2. The `ORCH_PROJECT` environment variable.
3. The project whose repo contains your current folder. For `orch plan`, orch checks the spec folder first.
4. The only project, when just one is registered.

If none of these applies, the command stops with exit code `2` and lists your projects. `orch answer` doesn't need a project, because question numbers are unique across projects.

For example, to check the status of `shop` from anywhere:

```bash
orch status --project shop
```

## Change a project's settings

Edit `orch.config.json` in the project's repo. orch reads it again each time you plan or start a run in that project, so you don't need to restart orch. A run that's already going keeps the settings it started with.

If the file contains an error, orch shows it for that project and refuses to plan or start a run there. Other projects aren't affected. For every key, see [Project settings](../reference/project-settings.md).

## If a project's repo moves

If you move or delete a project's repo folder, the project shows an error, and orch refuses to plan or start a run in it. Its history stays viewable. To fix it, move the repo back. To track the repo at its new path instead, archive the project and add the new path.
