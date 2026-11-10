# Set up orch on a home server

This walkthrough takes you from an empty Linux box on your network to orch running in Docker with your first project registered and a plan approved. It gathers the pieces that [Run in Docker](run-in-docker.md), [Secure remote access](secure-access.md), and [Get push notifications](set-up-notifications.md) describe one at a time, in the order you do them.

Replace these placeholders as you go:

| Placeholder | Meaning | Example |
| :--- | :--- | :--- |
| `<server>` | The server's address on your network | `192.168.1.20` |
| `<user>` | Your user on the server | `alice` |
| `<orch>` | Where the orch source and data live on the server | `/home/alice/orch` |
| `<repo>` | Your project's repository name | `myapp` |
| `<github-user>` | Your GitHub account | `octocat` |

Sections marked **(on your PC)** happen in a browser on your PC. Everything else happens in an SSH session on the server.

Keep a text file open while you work. You'll collect four values in it: a GitHub token, a Gemini API key (optional), an ntfy topic, and an orch access token.

## Before you begin

- A Linux server on your private network that stays on. Any recent Debian or Ubuntu works.
- A Claude subscription, for Claude Code.
- Your project on GitHub, with a test command that passes on `main`.

## Get your keys ready (on your PC)

### Create a GitHub token

orch uses it to push branches and open pull requests.

1. Go to https://github.com/settings/tokens/new and sign in if asked.
2. In **Note**, enter `orch home server`.
3. For **Expiration**, choose **90 days** or **No expiration**.
4. Under **Select scopes**, select **repo** and **workflow**. Leave the other scopes clear.
5. Select **Generate token**.
6. Copy the token into your text file. It starts with `ghp_`. GitHub shows it only once.

### Choose how Antigravity signs in

Skip this section if every role uses Claude Code. The example settings in this walkthrough use Antigravity CLI (`agy`, from Google) as the validator, so a different model checks the worker's code.

| | Option A: API key | Option B: Google account |
| :--- | :--- | :--- |
| Uses | A Gemini API key from Google AI Studio | Your Google account, free or on a Google AI plan |
| When you set it up | Now, plus one settings file after the image is built | After the image is built, in [Sign in to Claude Code and Antigravity](#sign-in-to-claude-code-and-antigravity) |
| Best for | No sign-in to keep alive | Using your Google account's quota |

For Option A:

1. Go to https://aistudio.google.com/apikey and sign in.
2. Select **Create API key**.
3. Copy the key into your text file.

For Option B, there's nothing to do yet.

### Set up phone notifications

1. Install the **ntfy** app on your phone.
2. Choose a topic name that's hard to guess, for example `orch-<user>-7k2p9x`.
3. In the app, select **+**, enter the topic name, and select **Subscribe**.
4. Write the topic name in your text file.

### Update your project's main branch

orch builds on `main` as it is on GitHub. Merge any work you want orch to build on into `main`, and push it.

## Prepare the server

### Connect to the server

```bash
ssh <user>@<server>
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
sudo usermod -aG docker <user>
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

Write down the number. You need it in [Clone your project](#clone-your-project).

## Install orch

### Download orch

```bash
mkdir -p "$(dirname <orch>)"
git clone https://github.com/jlotterer/agent-orchestrator.git <orch>
cd <orch>
```

### Add your project's toolchain to the image

Your test command and setup command run inside the container, so the image needs whatever they need. Node.js, git, and the GitHub CLI are already there.

1. Open the Dockerfile:

   ```bash
   nano Dockerfile
   ```

2. Find the block that starts with `# --- your project's toolchain goes here`.
3. Replace the example lines with what your project needs. For example, for a Python project that uses uv:

   ```dockerfile
   RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh
   ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_PYTHON=3.12 UV_CACHE_DIR=/work/.cache/uv
   RUN uv python install 3.12 && chmod -R a+rX /opt/uv-python
   ```

   If your tests need system libraries, such as the ones a GUI toolkit needs without a display, install them with `apt-get` in the same block.

4. Press **Ctrl+O**, then **Enter** to save. Press **Ctrl+X** to exit.

If your project only needs Node.js, skip this section.

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
   nano <orch>/.env
   ```

2. Paste this content, and replace each `<...>` with the value from your text file:

   ```bash
   ORCH_TOKEN=<orch token>
   GH_TOKEN=<GitHub token, starts with ghp_>
   GEMINI_API_KEY=<Gemini key>
   GIT_AUTHOR_NAME=<your name>
   GIT_AUTHOR_EMAIL=<your email>
   ```

   If you chose Option B for Antigravity, or don't use Antigravity, delete the `GEMINI_API_KEY` line.

3. Save and exit.
4. Restrict the file to your user:

   ```bash
   chmod 600 <orch>/.env
   ```

Leave `ANTHROPIC_API_KEY` out. You sign in with your Claude subscription in the next section.

### Sign in to Claude Code and Antigravity

You can skip this section and sign in from the dashboard later: after you start orch, open the **Agents** tab and click **Sign in** on each card (Claude Code, Antigravity CLI, Codex CLI and `gh`). The steps below do the same from a terminal.

Sign in to Claude Code:

1. Run:

   ```bash
   cd <orch>
   docker compose run --rm orch claude auth login
   ```

2. Open the printed address in a browser on your PC and sign in to your Claude account.
3. Copy the code it shows, paste it into the SSH window, and press **Enter**.

The sign-in is saved in a Docker volume and survives rebuilds.

If you chose Option A for Antigravity, tell it to use the key:

```bash
docker compose run --rm orch sh -c 'echo "{\"modelProvider\": \"gemini\"}" > ~/.gemini/antigravity-cli/settings.json'
```

The key in `.env` alone has no effect without this setting.

If you chose Option B for Antigravity, sign in with your Google account:

1. Run:

   ```bash
   docker compose run --rm orch agy
   ```

2. Open the printed address in a browser on your PC and sign in with your Google account.
3. Copy the code it shows, paste it into the SSH window, and press **Enter**.
4. When the prompt appears, enter `/quit`.

The session is saved in the `gemini-home` volume. The container has no keyring, so Antigravity keeps the session in a file under `~/.gemini/antigravity-cli/`.

### Let git push with your GitHub token

```bash
docker compose run --rm orch gh auth status
docker compose run --rm orch gh auth setup-git
```

The first command should report `Logged in to github.com account <github-user>`. The second makes git use the token for HTTPS remotes in every repo and working copy. The setting is saved in a Docker volume.

## Add your first project

### Clone your project

```bash
cd <orch>
mkdir -p work/repos
git clone https://github.com/<github-user>/<repo>.git work/repos/<repo>
```

If your user ID isn't `1000`, give the container's user ownership of the folder:

```bash
sudo chown -R 1000:1000 <orch>/work
```

### Create the first-start settings file

On its first start, orch splits this one file into server settings and project settings, and registers the repo as a project.

1. Create the file:

   ```bash
   nano <orch>/work/orch.config.json
   ```

2. Paste this content. Replace the placeholders, and set `validation.command` and `git.setupCommand` to your project's test and install commands:

   ```json
   {
     "repo": "/work/repos/<repo>",
     "baseBranch": "main",
     "host": "0.0.0.0",
     "port": 4800,
     "auth": { "token": "", "allowInsecure": false },
     "publicUrl": "http://<server>:4800",
     "agents": { "roles": {
       "planner":   { "adapter": "claude", "model": "" },
       "worker":    { "adapter": "claude", "model": "" },
       "validator": { "adapter": "antigravity", "model": "" } } },
     "scheduler": { "maxParallel": 2, "tickSeconds": 5, "maxAttempts": 2, "resumeOnRetry": true },
     "validation": { "command": "npm test", "agent": true },
     "git": {
       "pr": true,
       "mergePolicy": "auto",
       "squash": true,
       "copyFiles": [],
       "setupCommand": "npm ci",
       "tickTasksMd": true
     },
     "notify": { "ntfyUrl": "https://ntfy.sh/<your ntfy topic>", "ntfyToken": "" }
   }
   ```

   If every role uses Claude Code, set the validator's adapter to `claude`.

3. Save and exit.

Leave `auth.token` empty. orch reads the token from `.env`.

What the main settings do:

| Setting | Effect |
| :--- | :--- |
| `scheduler.maxParallel` | How many of this project's tasks run at once. On the first start it also sets the server-wide limit, `scheduler.maxAgents`. |
| `validation.command` | The test gate, run in each task's working copy before the validator. Use the same command as your CI. |
| `git.setupCommand` | Prepares each new working copy, for example by installing packages. |
| `agents.roles.validator` | Which agent checks each task's work. |

### Test your project in the container

Check that the test command passes in the container before orch depends on it:

```bash
docker compose run --rm orch sh -c "cd /work/repos/<repo> && npm ci && npm test"
```

Replace the commands with your setup and test commands. If tests fail only because they assume another operating system, fix that in your project first, push to `main`, and pull on the server:

```bash
docker compose run --rm orch git -C /work/repos/<repo> pull
```

## Start orch

### Start the container

```bash
cd <orch>
docker compose up -d
docker compose logs -f orch
```

Check the log for errors. Press **Ctrl+C** to stop following the log. orch keeps running.

### Check the health endpoint

```bash
curl http://<server>:4800/api/health
```

It returns a short JSON response.

### Open the firewall

Only if you use ufw:

```bash
sudo ufw status
```

If it reports `Status: active`, allow your network. Replace the range with yours:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 4800 proto tcp
```

Don't forward port 4800 on your router. orch has no TLS, so keep it on the private network. See [Secure remote access](secure-access.md).

### Open the dashboard

1. On your PC, go to `http://<server>:4800`.
2. Enter your orch token.
3. Check that the project switcher at the top left shows your project. The board is empty until you create a plan.

If the project switcher shows **No projects**, see [The project is missing after the first start](#the-project-is-missing-after-the-first-start).

### Add a shortcut for the orch command

```bash
echo "alias orch='docker compose -f <orch>/docker-compose.yml exec orch orch'" >> ~/.bashrc
source ~/.bashrc
orch status
```

The alias runs `orch` inside the container, where the access token is already set.

## Run your first plan

orch needs a spec folder with a `tasks.md` in the project. See [Plan a feature](plan-a-feature.md) for the details.

### Create the spec (on your PC)

1. In your project, create a folder, for example `specs/001-next-features/`.
2. Add `spec.md` (what to build) and `plan.md` (how to build it).
3. Add `tasks.md` in this format:

   ```markdown
   ## Phase 1: Core
   - [ ] T001 Implement X in src/x.js
   - [ ] T002 [P] Add Y
   - [ ] T003 Add Z (depends on T001)
   ```

   `[P]` means the task can run in parallel with the others in its phase. `(depends on T00X)` adds a dependency. Spec Kit's `/speckit.specify`, `/speckit.plan`, and `/speckit.tasks` commands write these files for you.

4. Commit the folder and push it to `main`.

### Plan, approve, and start

1. Pull the spec onto the server:

   ```bash
   docker compose -f <orch>/docker-compose.yml exec orch git -C /work/repos/<repo> pull
   ```

2. Preview the plan, and check the phases, tasks, and dependencies:

   ```bash
   orch plan /work/repos/<repo>/specs/001-next-features --dry-run
   ```

3. Create the plan:

   ```bash
   orch plan /work/repos/<repo>/specs/001-next-features
   ```

4. In the dashboard, go to the **Plan** tab. Read the acceptance criteria. To change a task, select it, then select **Edit**.
5. Select **Approve plan**.
6. Start the run:

   ```bash
   orch run --project <repo>
   ```

Progress shows in the dashboard. Anything that needs you appears in the **Inbox** and on your phone.

## Add another project

```bash
cd <orch>
git clone https://github.com/<github-user>/<other-repo>.git work/repos/<other-repo>
orch project add /work/repos/<other-repo>
orch project list
```

Then create `work/repos/<other-repo>/orch.config.json` with at least `validation.command`. See [Project settings](../reference/project-settings.md).

With two or more projects, add `--project <name>` to commands that act on one project, for example `orch status --project <other-repo>`. `orch plan` finds the project from the spec folder's path.

If the second project's tests need tools the image doesn't have, add them to the Dockerfile and rebuild.

## Day-to-day commands

| Task | Command |
| :--- | :--- |
| Show the board | `orch status --project <name>` |
| Stop orch | `cd <orch> && docker compose down` |
| Start orch | `cd <orch> && docker compose up -d` |
| Follow the log | `cd <orch> && docker compose logs -f orch` |
| Apply a change to `work/server.json` | `cd <orch> && docker compose restart` |
| Pull a repo | `docker compose -f <orch>/docker-compose.yml exec orch git -C /work/repos/<name> pull` |

## Where settings live

After the first start, settings live in two places:

| File | Holds | To apply a change |
| :--- | :--- | :--- |
| `work/server.json` | Server settings: port, agents, notifications, `scheduler.maxAgents` | Restart the container |
| `work/repos/<name>/orch.config.json` | Project settings: test command, git, `scheduler.maxParallel` | Nothing; the next run picks it up |

The original first-start file is kept as `work/orch.config.json.bak`.

## Upgrade orch

```bash
cd <orch>
git pull
docker compose build
docker compose up -d
```

Your data and sign-ins are kept. Tasks that were running go back to pending with their working copies kept.

If `git pull` reports a conflict in `Dockerfile`, keep your toolchain block.

## Renew the GitHub token

1. Create a new token as in [Create a GitHub token](#create-a-github-token).
2. Replace `GH_TOKEN` in `<orch>/.env`.
3. Apply it:

   ```bash
   cd <orch> && docker compose up -d
   ```

## Troubleshooting

### The project is missing after the first start

1. Check the startup log:

   ```bash
   cd <orch>
   docker compose logs orch | head -20
   ```

2. Register the project:

   ```bash
   orch project add /work/repos/<repo>
   orch project list
   ```

3. Reload the dashboard.
4. Check that the server settings exist and list your validator and your ntfy address:

   ```bash
   cat <orch>/work/server.json
   ```

   If they don't, see the next section.

### The server settings are missing or wrong

1. Open the file:

   ```bash
   nano <orch>/work/server.json
   ```

2. Replace the content with this, and replace the placeholders:

   ```json
   {
     "host": "0.0.0.0",
     "port": 4800,
     "publicUrl": "http://<server>:4800",
     "auth": { "token": "", "allowInsecure": false },
     "notify": { "ntfyUrl": "https://ntfy.sh/<your ntfy topic>", "ntfyToken": "" },
     "agents": { "roles": {
       "planner":   { "adapter": "claude", "model": "" },
       "worker":    { "adapter": "claude", "model": "" },
       "validator": { "adapter": "antigravity", "model": "" } } },
     "scheduler": { "maxAgents": 2, "tickSeconds": 5 }
   }
   ```

3. Save and exit, then restart:

   ```bash
   cd <orch>
   docker compose restart
   ```

### Tasks wait even though the phase allows parallel work

`scheduler.maxAgents` in `work/server.json` caps agents across all projects. Raise it to at least the largest `scheduler.maxParallel` you use, then restart the container. See [Run tasks in parallel](run-in-parallel.md).

### A test command hangs in the container

The compose file sets `init: true`, which lets the container clean up processes that tests leave behind. If you copied the service definition elsewhere, add that line back and run `docker compose up -d` to recreate the container.
