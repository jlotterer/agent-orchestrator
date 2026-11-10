# Install orch

Install orch on the always-on machine where your agents work. That's usually a Linux server, but WSL2 on Windows and Docker also work. To run orch in a container instead, see [Run in Docker](how-to/run-in-docker.md).

## Prerequisites

- Linux, or WSL2 on Windows. orch doesn't run natively on Windows.
- Node.js 22 or later.
- git.
- [Claude Code](https://docs.claude.com/en/docs/claude-code), installed and signed in as the user that runs orch. A Claude subscription sign-in works. You don't need an API key.
- The GitHub CLI, `gh`, signed in, if you want orch to open pull requests. You don't need it for local merge mode.
- Optional: Antigravity CLI (`agy`) or Codex CLI, if you want to use them for some roles. See [Choose agents and models](how-to/configure-agents.md).

> [!WARNING]
> Agents run with full permissions inside their working copy, so a worker can run any command your user account can run. Run orch as a non-root user on a machine you don't mind an agent working in. Claude Code refuses to run with full permissions as root.

## Install the software

1. Clone the orch repository and go to its folder:

   ```bash
   git clone <orch-repo-url> ~/orch && cd ~/orch
   ```

   Replace `<orch-repo-url>` with the address of the orch repository.

2. Install the dependencies and build:

   ```bash
   npm install && npm run build
   ```

3. Put the `orch` command on your `PATH`:

   ```bash
   npm link
   ```

   This step is optional for agents, because orch gives them the command automatically. You need it to use `orch` in your own terminal.

4. Confirm the command works:

   ```bash
   orch help
   ```

   orch prints the list of commands.

## Start orch for the first time

orch keeps its state in a data directory, `~/.orch` by default. Server settings live in `server.json` in that directory. If the file doesn't exist, orch uses the defaults. Create it when you want to change a setting, starting from `examples/server.example.json` in the orch source. See [Server settings](reference/server-settings.md).

1. Start the server:

   ```bash
   orch serve
   ```

2. In another terminal, check that it's up:

   ```bash
   curl http://127.0.0.1:4800/api/health
   ```

   orch answers with its version and uptime, for example `{"ok":true,"version":"0.1.0","uptimeSec":12}`.

3. In a browser on the same machine, go to `http://127.0.0.1:4800`. The dashboard opens.

By default, orch listens only on `127.0.0.1`, so only the same machine can reach it. To use the dashboard from your laptop or phone, see [Secure remote access](how-to/secure-access.md).

Next, register a project and run a feature. See [Quickstart: your first run](quickstart.md).

## Run orch as a service

To keep orch running after you sign out and start it when the server boots, use the systemd unit included with orch, `orch.service`.

1. Go to the repo of your first project. Run the next command from there, so orch can find that project's settings on its first start.
2. Install the unit:

   ```bash
   sed "s#WORKDIR#$PWD#; s#ORCHBIN#$(which orch)#; s#USER#$USER#" ~/orch/orch.service | sudo tee /etc/systemd/system/orch.service
   ```

3. Turn it on and start it:

   ```bash
   sudo systemctl enable --now orch
   ```

4. Check that it's running:

   ```bash
   systemctl status orch
   ```

The unit runs orch as your user, with `ORCH_HOME` set to `~/.orch`. orch's messages go to the system journal. To read them, run `journalctl -u orch -f`.

## Choose a data directory

To keep orch's state somewhere other than `~/.orch`, set the `ORCH_HOME` environment variable before you start orch, and in every terminal where you use the `orch` command:

```bash
export ORCH_HOME=/srv/orch
```

The data directory holds these items:

```text
$ORCH_HOME/
├── server.json            server settings
├── orch.db                every project's runs, tasks, decisions and questions
├── worktrees/<project>/   one working copy per active task
├── archive/<project>/     archived agent logs
└── run/                   process files for apps under test
```

## Upgrade orch

1. Stop orch. If it runs as a service, run `sudo systemctl stop orch`.
2. Get the new version and rebuild:

   ```bash
   cd ~/orch && git pull && npm install && npm run build
   ```

3. Start orch again. If it runs as a service, run `sudo systemctl start orch`.

orch upgrades its database automatically when it starts, without losing data. If a task was active when you stopped orch, it goes back to pending with its working copy kept, and it starts again when its turn comes.

### Upgrade from a single-repo installation

Earlier versions of orch managed one repo and kept all of their settings in that repo's `orch.config.json`. The first time a newer orch starts and finds such a file (and no `server.json` yet), it upgrades the installation once:

1. It writes the server settings (`host`, `port`, `publicUrl`, `auth`, `notify`, `agents`, `scheduler.tickSeconds`, `git.ghCommand`) to `$ORCH_HOME/server.json`. The global agent limit, `scheduler.maxAgents`, starts at the old file's `scheduler.maxParallel`.
2. It saves the original file as `orch.config.json.bak` and rewrites `orch.config.json` with only the project settings.
3. It registers the repo as a project. If the old database exists (by default `.orch/orch.db` in the repo), orch copies it to `$ORCH_HOME/orch.db` and assigns every existing run to the project, so your past runs, decisions and questions stay visible.

The **Decisions** tab records the upgrade. If the upgrade fails partway, orch restores the original file, and it tries again on the next start.

orch looks for the old file in the current folder and its parent folders, or at the path given by `--config` or the `ORCH_CONFIG` environment variable. Start orch from the repo folder, or use the systemd steps above, which do this for you.

## Uninstall orch

1. Stop orch, and if it runs as a service, remove the service:

   ```bash
   sudo systemctl disable --now orch
   sudo rm /etc/systemd/system/orch.service
   ```

2. Remove the command from your `PATH`:

   ```bash
   cd ~/orch && npm unlink -g orch
   ```

3. Optional: delete the data directory and the orch source:

   ```bash
   rm -rf ~/.orch ~/orch
   ```

> [!CAUTION]
> Deleting `~/.orch` permanently removes the history of every run, including decisions and questions, and any work in progress in task working copies. Your project repos and their merged changes aren't affected. Each repo keeps its `orch.config.json`, which you can delete if you no longer need it.
