# Run in Docker

The orch Docker image holds the whole toolchain: Node.js, git, the GitHub CLI, Claude Code and orch. Everything that changes lives in one mounted folder, `./work`, which is orch's data directory. You can rebuild the image at any time without losing state. For more detail, see [docs/docker.md](../../docker.md) in the orch source.

## Prerequisites

- Docker with Docker Compose.
- The orch source, cloned to `~/orch`.

## Build the image

1. If your project's tests need more than Node.js, such as Python, Go or a database client, add them in the marked section of the `Dockerfile`. Your test and setup commands run inside the container.
2. Build:

   ```bash
   cd ~/orch
   docker compose build
   ```

## Prepare the work folder

The `work` folder next to `docker-compose.yml` holds your repos and orch's state:

```text
work/                      data directory (ORCH_HOME=/work in the container)
├── server.json            server settings
├── orch.db                state for every project
├── worktrees/<project>/   task working copies
└── repos/myapp/           a project, with its own orch.config.json
```

Keep repos and working copies on the same mount. git records working copy paths inside each repo, and those paths must stay the same every time the container starts.

1. Clone your repo into the work folder:

   ```bash
   mkdir -p work/repos
   git clone git@github.com:<you>/myapp.git work/repos/myapp
   ```

2. Create the first-start settings file, `work/orch.config.json`. Paths are paths inside the container:

   ```json
   {
     "repo": "/work/repos/myapp",
     "baseBranch": "main",
     "host": "0.0.0.0",
     "port": 4800,
     "publicUrl": "http://my-server:4800",
     "validation": { "command": "npm test" },
     "git": { "pr": true, "setupCommand": "npm ci" },
     "notify": { "ntfyUrl": "https://ntfy.sh/<topic>" }
   }
   ```

   On its first start, orch splits this file: server settings go to `work/server.json`, and project settings go to `work/repos/myapp/orch.config.json`. The original is kept as `work/orch.config.json.bak`. After that, edit `work/server.json` for server settings (restart the container to apply them) and the repo's `orch.config.json` for project settings.

3. If your user ID on the host isn't 1000, give the container's user ownership of the folder:

   ```bash
   sudo chown -R 1000:1000 work
   ```

`host` must be `0.0.0.0` inside the container, so a published port can reach orch. That's a network address, so orch requires an access token. Set it in `.env` in the next section, not in the settings file.

## Add credentials

1. Create `.env` next to `docker-compose.yml`. Git ignores it.

   ```bash
   ORCH_TOKEN=<token from: openssl rand -hex 32>
   GH_TOKEN=<GitHub token with repo scope, for pull request mode>
   GIT_AUTHOR_NAME=<your name>
   GIT_AUTHOR_EMAIL=<your email>
   # ANTHROPIC_API_KEY=<key>   only if you use API billing instead of a subscription
   # GEMINI_API_KEY=<key>      only if a role uses Antigravity CLI with an API key instead of a Google account
   # CODEX_API_KEY=<key>       only if a role uses Codex CLI with an API key instead of a ChatGPT account
   ```

2. Sign in to Claude Code with your subscription. You can also do this from the dashboard after you start orch: open the **Agents** tab and click **Sign in** on the `claude` card. The sign-in is saved in a Docker volume and survives rebuilds. From a terminal:

   ```bash
   docker compose run --rm orch claude auth login
   ```

   It prints an address. Open it on your laptop, sign in, and paste the code back.

   Instead of an interactive sign-in, you can run `claude setup-token` on a machine where you're signed in, and add the variable it names to `.env` and to the `environment:` section of `docker-compose.yml`.

3. For pull request mode over HTTPS, let git use your GitHub token:

   ```bash
   docker compose run --rm orch gh auth setup-git
   ```

   For SSH remotes instead, uncomment the `~/.ssh` mount in `docker-compose.yml`. The key must have no passphrase.

4. If a role uses Antigravity CLI, sign in once with your Google account:

   ```bash
   docker compose run --rm orch agy
   ```

   It prints an address. Open it on your laptop, sign in, and paste the code back. The session is saved in the `gemini-home` volume.

5. If a role uses Codex CLI, sign in once with your ChatGPT account:

   ```bash
   docker compose run --rm orch codex login --device-auth
   ```

   It prints an address and a code. Open the address on your laptop and enter the code. The login is saved in the `codex-home` volume. Check it with `docker compose run --rm orch codex login status`.

Local merge mode needs no GitHub credentials. The merged base branch stays in `work/repos/myapp`, and you push it yourself.

## Start orch

1. Start the container:

   ```bash
   docker compose up -d
   ```

2. Follow its log:

   ```bash
   docker compose logs -f orch
   ```

3. In a browser, go to `http://my-server:4800`, and sign in with the token from `.env`.

Run `orch` commands through `docker compose exec`, which already has `ORCH_TOKEN`:

```bash
docker compose exec orch orch plan /work/repos/myapp/specs/001-auth
docker compose exec orch orch status
```

To make this shorter, add an alias: `alias orch='docker compose -f ~/orch/docker-compose.yml exec orch orch'`.

## Upgrade

- Run:

  ```bash
  cd ~/orch && git pull && docker compose build && docker compose up -d
  ```

State is in `work/` and sign-ins are in named volumes, so a rebuild loses nothing. Tasks that were active go back to pending with their working copies kept.

If you upgrade from a single-repo container, the first start of the new image upgrades it as described in [Install orch](../install.md#upgrade-from-a-single-repo-installation). It also copies `work/.orch/orch.db` to `work/orch.db`. When the run history looks right, delete `work/.orch/`.

## Things to know

- The container runs as the non-root user `orch` (user ID 1000), because Claude Code refuses full permissions as root. Don't override `user:` in the compose file.
- The compose file sets `init: true`, so the container cleans up processes that agents or tests leave behind. Keep it. Without it, a test command that stops background processes can hang.
- Don't start the container from inside a Claude Code session with the Docker socket mounted. Claude Code detects the nesting and refuses to run.
- To allow access only from the server itself, publish the port as `"127.0.0.1:4800:4800"`.
- Each working copy is a full checkout, plus anything `setupCommand` installs. Finished working copies are removed. Stopped or failed ones stay until you retry or skip the task.
