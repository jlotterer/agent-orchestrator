# Deploy orch on the home server (192.168.1.13)

This guide installs orch in Docker on the home server and registers two projects: `screen_copier` first, then orch itself, so orch can build its own roadmap.

| Item | Value |
| :--- | :--- |
| Server | `192.168.1.13` |
| orch folder | `/home/jeffrey/docker/orch` |
| Projects | `/home/jeffrey/docker/orch/work/repos/screen_copier`, `/home/jeffrey/docker/orch/work/repos/orch` |
| Dashboard | `http://192.168.1.13:4800` |

Sections marked **(on your PC)** happen in a browser on your PC. Everything else happens in an SSH session on the server.

Keep a text file open while you work. You'll collect four values in it: a GitHub token, a Gemini key (optional), an ntfy topic, and an orch access token.

## Get your keys ready (on your PC)

### Create a GitHub token

1. Go to https://github.com/settings/tokens/new and sign in if asked.
2. In **Note**, enter `orch home server`.
3. For **Expiration**, choose **90 days** or **No expiration**.
4. Under **Select scopes**, select **repo** and **workflow**. Leave the other scopes clear.
5. Select **Generate token**.
6. Copy the token into your text file. It starts with `ghp_`. GitHub shows it only once.

### Choose how Gemini signs in

The validator role uses Gemini. Pick one option.

| | Option A: API key | Option B: Google account |
| :--- | :--- | :--- |
| Uses | A key from Google AI Studio | Your Google account, free or on a Google AI plan |
| When you set it up | Now | After the image is built, in [Sign in to Claude Code and Gemini](#sign-in-to-claude-code-and-gemini) |
| Best for | No sign-in to keep alive | Using your Google account's quota |

For Option A:

1. Go to https://aistudio.google.com/apikey and sign in.
2. Select **Create API key**.
3. Copy the key into your text file.

For Option B, there's nothing to do yet.

### Set up phone notifications

1. Install the **ntfy** app on your phone.
2. Choose a topic name that's hard to guess, for example `orch-jeffrey-7k2p9x`.
3. In the app, select **+**, enter the topic name, and select **Subscribe**.
4. Write the topic name in your text file.

### Update screen_copier's main branch

orch builds on `main` as it is on GitHub.

1. On your PC, open the `screen_copier` repo.
2. Merge any work you want orch to build on, for example `task-08-stitching-core`, into `main`.
3. Push `main` to GitHub.

## Prepare the server

### Connect to the server

```bash
ssh jeffrey@192.168.1.13
```

### Check the tools

```bash
docker --version
docker compose version
git --version
openssl version
```

All four commands must print a version.

If Docker is missing:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker jeffrey
exit
```

Connect again, and run the checks again.

If git or openssl is missing:

```bash
sudo apt-get update && sudo apt-get install -y git openssl
```

### Note your user ID

```bash
id -u
```

Write down the number. You need it in [Create the work folder](#create-the-work-folder-and-clone-screen_copier).

## Install orch

### Download orch

```bash
cd /home/jeffrey/docker
git clone https://github.com/jlotterer/orch.git orch
cd /home/jeffrey/docker/orch
```

### Add Python to the image

screen_copier needs Python 3.12, uv, and the libraries that PySide6 and OpenCV need without a display.

1. Open the Dockerfile:

   ```bash
   nano Dockerfile
   ```

2. Find this block:

   ```dockerfile
   # --- your project's toolchain goes here ---------------------------------------
   # Examples:
   #   RUN apt-get update && apt-get install -y python3-pip && pip install --break-system-packages pytest
   #   RUN curl -fsSL https://bun.sh/install | bash
   # ------------------------------------------------------------------------------
   ```

3. Replace it with this block:

   ```dockerfile
   # --- your project's toolchain goes here ---------------------------------------
   # screen_copier: uv + Python 3.12 + libraries PySide6/OpenCV need without a display
   RUN apt-get update && apt-get install -y --no-install-recommends \
         libgl1 libegl1 libglib2.0-0 libxkbcommon0 libfontconfig1 libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/* \
    && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh
   ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python \
       UV_PYTHON=3.12 \
       UV_CACHE_DIR=/work/.cache/uv \
       QT_QPA_PLATFORM=offscreen
   RUN uv python install 3.12 && chmod -R a+rX /opt/uv-python
   # ------------------------------------------------------------------------------
   ```

4. Press **Ctrl+O**, then **Enter** to save. Press **Ctrl+X** to exit.

### Build the image

```bash
docker compose build
```

The first build takes several minutes.

## Add credentials

### Generate the access token

```bash
openssl rand -hex 32
```

Copy the output into your text file as the **orch token**. The dashboard asks for it once per browser.

### Create the .env file

1. Create the file:

   ```bash
   nano /home/jeffrey/docker/orch/.env
   ```

2. Paste this content, and replace each `<...>` with the value from your text file:

   ```bash
   ORCH_TOKEN=<orch token>
   GH_TOKEN=<GitHub token, starts with ghp_>
   GEMINI_API_KEY=<Gemini key>
   GIT_AUTHOR_NAME=Jeffrey
   GIT_AUTHOR_EMAIL=jlotterer@gmail.com
   ```

   If you chose Option B for Gemini, delete the `GEMINI_API_KEY` line.

3. Save and exit.
4. Restrict the file to your user:

   ```bash
   chmod 600 /home/jeffrey/docker/orch/.env
   ```

Leave `ANTHROPIC_API_KEY` out. You sign in with your Claude subscription in the next section.

### Sign in to Claude Code and Gemini

Sign in to Claude Code:

1. Run:

   ```bash
   cd /home/jeffrey/docker/orch
   docker compose run --rm orch claude auth login
   ```

2. Open the printed address in a browser on your PC and sign in to your Claude account.
3. Copy the code it shows, paste it into the SSH window, and press **Enter**.

The sign-in is saved in a Docker volume and survives rebuilds.

If you chose Option B for Gemini, sign in to Gemini:

1. Run:

   ```bash
   docker compose run --rm -e NO_BROWSER=true orch gemini
   ```

2. If Gemini asks for a theme, choose any and press **Enter**.
3. When it asks how to authenticate, choose **Login with Google**.
4. Open the printed address in a browser on your PC and sign in with your Google account.
5. Copy the code it shows, paste it into the SSH window, and press **Enter**.
6. At the Gemini prompt, enter `/quit`.

### Let git push with your GitHub token

```bash
docker compose run --rm orch gh auth status
docker compose run --rm orch gh auth setup-git
```

The first command should report `Logged in to github.com account jlotterer`. It also warns `Missing required token scopes: 'read:org'` and suggests `gh auth refresh`. Ignore both: orch only runs `gh pr create`, `gh pr merge` and `gh pr view`, which need the `repo` scope you already granted, and `gh auth refresh` tries to open a browser, which the server has none of. The second makes git use the token for HTTPS remotes in every repo and worktree. The setting is saved in a Docker volume.

## Add screen_copier

### Create the work folder and clone screen_copier

```bash
cd /home/jeffrey/docker/orch
mkdir -p work/repos
git clone https://github.com/jlotterer/screen_copier.git work/repos/screen_copier
```

If your user ID isn't `1000`, give the container's user ownership of the folder:

```bash
sudo chown -R 1000:1000 /home/jeffrey/docker/orch/work
```

### Create the first-start settings file

On its first start, orch splits this one file into server settings and project settings, and registers the repo as a project.

1. Create the file:

   ```bash
   nano /home/jeffrey/docker/orch/work/orch.config.json
   ```

2. Paste this content, and replace `<your ntfy topic>`:

   ```json
   {
     "repo": "/work/repos/screen_copier",
     "baseBranch": "main",
     "host": "0.0.0.0",
     "port": 4800,
     "auth": { "token": "", "allowInsecure": false },
     "publicUrl": "http://192.168.1.13:4800",
     "agents": { "roles": {
       "planner":   { "adapter": "claude", "model": "" },
       "worker":    { "adapter": "claude", "model": "" },
       "validator": { "adapter": "gemini", "model": "pro" } } },
     "scheduler": { "maxParallel": 3, "tickSeconds": 5, "maxAttempts": 2, "resumeOnRetry": true },
     "validation": {
       "command": "uv run ruff check . && uv run ruff format --check . && uv run pytest -m \"not perf\"",
       "agent": true
     },
     "git": {
       "pr": true,
       "mergePolicy": "auto",
       "squash": true,
       "copyFiles": [],
       "setupCommand": "uv sync --locked",
       "tickTasksMd": true
     },
     "notify": { "ntfyUrl": "https://ntfy.sh/<your ntfy topic>", "ntfyToken": "" }
   }
   ```

3. Save and exit.

Leave `auth.token` empty. orch reads the token from `.env`.

What the main settings do:

| Setting | Effect |
| :--- | :--- |
| `scheduler.maxParallel` | Becomes the server-wide agent limit, `scheduler.maxAgents`, on the first start. `3` lets a wave of three parallel tasks run together. |
| `validation.command` | The test gate: the same lint and tests as screen_copier's CI, without the `perf` timing tests. |
| `git.setupCommand` | Installs Python packages in each task's working copy. |
| `agents.roles.validator` | Gemini checks each task's work. |

### Test screen_copier on Linux

screen_copier's CI runs only on Windows. Check that the tests pass in the container:

```bash
cd /home/jeffrey/docker/orch
docker compose run --rm orch sh -c "cd /work/repos/screen_copier && uv sync --locked && uv run ruff check . && uv run ruff format --check . && uv run pytest -m 'not perf'"
```

If tests fail only because they're Windows-specific, skip those tests when not on Windows, push the fix to `main`, pull it on the server, and run the check again:

```bash
docker compose run --rm orch git -C /work/repos/screen_copier pull
```

## Start orch

### Start the container

```bash
cd /home/jeffrey/docker/orch
docker compose up -d
docker compose logs -f orch
```

Check the log for errors. Press **Ctrl+C** to stop following the log. orch keeps running.

The server needs up to 10 seconds to start. An `orch` command run before that fails with `cannot reach orch at http://127.0.0.1:4800`. To wait for it:

```bash
until docker compose ps orch | grep -q "(healthy)"; do sleep 2; done
```

### Check the health endpoint

```bash
curl http://192.168.1.13:4800/api/health
```

It returns a short JSON response.

### Open the firewall

Only if you use ufw:

```bash
sudo ufw status
```

If it reports `Status: active`:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 4800 proto tcp
```

Don't forward port 4800 on your router. orch has no TLS, so keep it on the private network.

### Open the dashboard

1. On your PC, go to http://192.168.1.13:4800.
2. Enter your orch token.
3. Check that the project switcher at the top left shows **screen_copier**. The board is empty until you create a plan.

If the project switcher shows **No projects**, see [The project is missing after the first start](#the-project-is-missing-after-the-first-start).

### Add a shortcut for the orch command

```bash
echo "alias orch='docker exec orch orch'" >> ~/.bashrc
source ~/.bashrc
orch status
```

The alias runs `orch` inside the container, where the access token is already set. It uses `docker exec` with the container name `orch` on purpose: `docker compose exec` can land in a leftover container from an earlier `docker compose run`, where no server is listening.

## Run your first plan for screen_copier

orch needs a spec folder with a `tasks.md` in the project.

### Create the spec (on your PC)

1. In `screen_copier`, create a folder, for example `specs/001-next-features/`.
2. Add `spec.md` (what to build) and `plan.md` (how to build it).
3. Add `tasks.md` in this format:

   ```markdown
   ## Phase 1: Core
   - [ ] T001 Implement X in src/screen_copier/x.py
   - [ ] T002 [P] Add Y
   - [ ] T003 Add Z (depends on T001)
   ```

   `[P]` means the task can run in parallel with the others in its phase. `(depends on T00X)` adds a dependency. Spec Kit's `/speckit.specify`, `/speckit.plan`, and `/speckit.tasks` commands write these files for you.

4. Commit the folder and push it to `main`.

### Plan, approve, and start

1. Pull the spec onto the server:

   ```bash
   docker exec orch git -C /work/repos/screen_copier pull
   ```

2. Preview the plan, and check the phases, tasks, and dependencies:

   ```bash
   orch plan /work/repos/screen_copier/specs/001-next-features --dry-run
   ```

3. Create the plan:

   ```bash
   orch plan /work/repos/screen_copier/specs/001-next-features
   ```

4. In the dashboard, go to the **Plan** tab. Read the acceptance criteria. To change a task, select it, then select **Edit**.
5. Select **Approve plan**.
6. Start the run:

   ```bash
   orch run --project screen_copier
   ```

Progress shows in the dashboard. Anything that needs you appears in the **Inbox** and on your phone.

## Add orch as a project

With this, orch builds its own roadmap (`specs/001-orch-roadmap/tasks.md`). orch's own test suite stops agent processes, which needs the `init: true` setting that the compose file already has.

### Clone orch into the work folder

```bash
cd /home/jeffrey/docker/orch
git clone https://github.com/jlotterer/orch.git work/repos/orch
```

This is a second clone, separate from the one that runs the container, so the running orch and the repo it changes stay apart.

### Create the project settings

1. Create the file:

   ```bash
   nano /home/jeffrey/docker/orch/work/repos/orch/orch.config.json
   ```

2. Paste this content:

   ```json
   {
     "baseBranch": "main",
     "scheduler": { "maxParallel": 3, "maxAttempts": 2 },
     "validation": { "command": "npm test" },
     "git": { "pr": true, "mergePolicy": "auto", "setupCommand": "npm ci" }
   }
   ```

3. Save and exit.

`npm test` runs the build, the unit tests, the invariants check, and the end-to-end tests, which is what CI runs. The whole suite takes a few minutes per task. Project settings apply at the next run, without a restart.

### Register the project

```bash
orch project add /work/repos/orch
orch project list
```

Both projects are listed. With two projects, add `--project <id>` to commands that act on one project, for example `orch status --project orch`. The id is the repo folder name in lower case, so `screen_copier` and `orch`. `orch plan` finds the project from the spec folder's path.

### Plan and run the roadmap

1. Preview. Finished tasks import as done, and the next wave shows as pending:

   ```bash
   orch plan /work/repos/orch/specs/001-orch-roadmap --dry-run
   ```

2. Create the plan:

   ```bash
   orch plan /work/repos/orch/specs/001-orch-roadmap
   ```

3. In the dashboard, switch to **orch** and go to the **Plan** tab. For each pending task, compare the planner's acceptance criteria with the "Done when" list in its brief under `docs/tasks/`. Set tasks that change prompts or fixtures to merge policy **manual**.
4. Select **Approve plan**, then start the run:

   ```bash
   orch run --project orch
   ```

Each task opens a pull request on GitHub. Review and merge them as they arrive, or let `auto` tasks merge when the validator passes.

## Day-to-day commands

| Task | Command |
| :--- | :--- |
| Show the board | `orch status --project <id>` |
| Stop orch | `cd /home/jeffrey/docker/orch && docker compose down` |
| Start orch | `cd /home/jeffrey/docker/orch && docker compose up -d` |
| Follow the log | `cd /home/jeffrey/docker/orch && docker compose logs -f orch` |
| Apply a change to `work/server.json` | `cd /home/jeffrey/docker/orch && docker compose restart` |
| Pull a repo | `docker exec orch git -C /work/repos/<name> pull` |

## Where settings live

After the first start, settings live in two places:

| File | Holds | To apply a change |
| :--- | :--- | :--- |
| `work/server.json` | Server settings: port, agents, notifications, `scheduler.maxAgents` | Restart the container |
| `work/repos/<name>/orch.config.json` | Project settings: test command, git, `scheduler.maxParallel` | Nothing; the next run picks it up |

The original first-start file is kept as `work/orch.config.json.bak`.

## Upgrade orch

```bash
cd /home/jeffrey/docker/orch
git pull
docker compose build
docker compose up -d
```

Your data and sign-ins are kept. Tasks that were running go back to pending with their working copies kept.

If `git pull` reports a conflict in `Dockerfile`, keep your Python block.

## Add another project

```bash
cd /home/jeffrey/docker/orch
git clone https://github.com/jlotterer/<repo>.git work/repos/<repo>
orch project add /work/repos/<repo>
```

Then create `work/repos/<repo>/orch.config.json` with at least `validation.command`.

## Renew the GitHub token

1. Create a new token as in [Create a GitHub token](#create-a-github-token).
2. Replace `GH_TOKEN` in `/home/jeffrey/docker/orch/.env`.
3. Apply it:

   ```bash
   cd /home/jeffrey/docker/orch && docker compose up -d
   ```

## Troubleshooting

### The project is missing after the first start

1. Check the startup log:

   ```bash
   cd /home/jeffrey/docker/orch
   docker compose logs orch | head -20
   ```

2. Register the project:

   ```bash
   orch project add /work/repos/screen_copier
   orch project list
   ```

3. Reload the dashboard.
4. Check that the server settings exist and list the `gemini` validator and your ntfy address:

   ```bash
   cat /home/jeffrey/docker/orch/work/server.json
   ```

   If they don't, see the next section.

### orch commands say "cannot reach orch at http://127.0.0.1:4800"

The dashboard works, `docker compose ps` says `(healthy)`, but every `orch` command fails with that error. A container from an earlier `docker compose run` (for example a Claude or Gemini sign-in that was never closed) is still running, and `docker compose exec` ran your command in it instead of in the server container. `docker compose down` also warns `Network orch_default Resource is still in use` in that case.

1. List the containers of the project:

   ```bash
   docker ps --filter label=com.docker.compose.project=orch --format "table {{.Names}}\t{{.Status}}\t{{.Command}}"
   ```

2. Remove every container other than `orch`:

   ```bash
   docker rm -f <name>
   ```

3. Run the `orch` command again. The alias in this guide uses `docker exec orch`, which always targets the server container, so this only happens with `docker compose exec`.

### The server settings are missing or wrong

1. Open the file:

   ```bash
   nano /home/jeffrey/docker/orch/work/server.json
   ```

2. Replace the content with this, and replace `<your ntfy topic>`:

   ```json
   {
     "host": "0.0.0.0",
     "port": 4800,
     "publicUrl": "http://192.168.1.13:4800",
     "auth": { "token": "", "allowInsecure": false },
     "notify": { "ntfyUrl": "https://ntfy.sh/<your ntfy topic>", "ntfyToken": "" },
     "agents": { "roles": {
       "planner":   { "adapter": "claude", "model": "" },
       "worker":    { "adapter": "claude", "model": "" },
       "validator": { "adapter": "gemini", "model": "pro" } } },
     "scheduler": { "maxAgents": 3, "tickSeconds": 5 }
   }
   ```

3. Save and exit, then restart:

   ```bash
   cd /home/jeffrey/docker/orch
   docker compose restart
   ```

### Tasks wait even though the wave allows parallel work

`scheduler.maxAgents` in `work/server.json` caps agents across all projects. Raise it to at least the largest `scheduler.maxParallel` you use, then restart the container.

### orch's own end-to-end tests fail in the container

Check that `init: true` is still set on the `orch` service in `docker-compose.yml` (it is in the shipped file), then run `docker compose up -d` to recreate the container.
