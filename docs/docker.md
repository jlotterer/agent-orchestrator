# Running orch in Docker

The container holds the toolchain (node, git, gh, Claude Code, orch). Everything that changes —
your repos, the worktrees, the SQLite database and the settings — lives on one mounted directory,
`./work`, which is orch's data directory (`ORCH_HOME=/work` in the image), so you can rebuild the
image freely.

```
work/                       ← ORCH_HOME
├── server.json             ← server settings (written on the first start, see step 2)
├── orch.db                 ← state for every project
├── worktrees/<project>/    ← created by orch, one dir per active task
└── repos/myapp/            ← a project (a clone), with its own orch.config.json
```

Each repo is a project. One daemon runs them all, with a shared limit on concurrent agents
(`scheduler.maxAgents` in `server.json`).

Keeping the repos and the worktrees on the same mount matters: git records worktree paths in
`<repo>/.git/worktrees/`, and those paths must be the same every time the container starts.

## 1. Build

```bash
cd ~/orch
docker compose build
```

If your project's tests need more than node (python, go, a database client), add it in the
marked section of the `Dockerfile` first. `validation.command` and `git.setupCommand` run inside
this container, so whatever `npm test` or `pytest` needs has to be in the image.

## 2. Put the repo and the first-start settings in `work/`

```bash
mkdir -p work/repos
git clone git@github.com:you/myapp.git work/repos/myapp      # or https://
```

For the first start, write the settings as one file, `work/orch.config.json` (the image points
`ORCH_CONFIG` at it). Paths are container paths:

```json
{
  "repo": "/work/repos/myapp",
  "baseBranch": "main",
  "host": "0.0.0.0",
  "port": 4800,
  "auth": { "token": "", "allowInsecure": false },
  "publicUrl": "http://my-server:4800",
  "agents": { "roles": { "planner": { "adapter": "claude", "model": "" }, "worker": { "adapter": "claude", "model": "" }, "validator": { "adapter": "gemini", "model": "pro" } } },
  "scheduler": { "maxParallel": 1, "tickSeconds": 5, "maxAttempts": 2, "resumeOnRetry": true },
  "validation": { "command": "npm test", "agent": true },
  "git": { "pr": true, "mergePolicy": "auto", "squash": true, "copyFiles": [], "setupCommand": "npm ci", "tickTasksMd": true },
  "notify": { "ntfyUrl": "https://ntfy.sh/your-topic", "ntfyToken": "" }
}
```

On its first start, orch splits this file in two and registers the repo as a project:

* `work/server.json` gets the server keys: `host`, `port`, `publicUrl`, `auth`, `notify`, `agents`,
  `scheduler.tickSeconds`, and `scheduler.maxAgents` (the global agent limit, set from
  `scheduler.maxParallel`).
* `work/orch.config.json` keeps only the project keys; the original is saved as
  `work/orch.config.json.bak`. Because the repo has no settings file of its own, orch also writes the
  project keys to `work/repos/myapp/orch.config.json`. That is the file it reads from then on, at the
  start of every run. Commit it to the repo if you like.

After that, change server settings in `work/server.json` (restart the container) and project
settings in the repo's `orch.config.json` (no restart; they apply at the next run start).

`host` must be `0.0.0.0` inside the container, or the published port can't reach orch. Because
that is a non-local address, orch refuses to start without an access token (see
[Access token](#access-token) below). Leave `auth.token` empty here and set `ORCH_TOKEN` in `.env`
instead, so the secret stays out of the mounted directory.

If the host user isn't uid 1000, `chown -R 1000:1000 work` (the container runs as uid 1000).

## 3. Credentials

**Claude Code: subscription or API key.** orch only launches the `claude` CLI, so it bills the
same way Claude Code does in your editor. You do *not* need an API key; a Claude subscription
login works and is usually the cheaper, more predictable option. Pick one:

* **Subscription, interactive login (recommended).** Run once; the login is saved in the
  `claude-home` volume and survives rebuilds:

  ```bash
  docker compose run --rm orch claude auth login
  ```

  It prints a URL; sign in on your laptop and paste the code back.

* **Subscription, headless token.** On any machine where you're already logged in, run
  `claude setup-token`; it gives you a long-lived token and tells you which environment variable
  to put it in. Add that variable to `.env` and to the `environment:` block in
  `docker-compose.yml`.

* **API key (pay per token, no usage caps).** Put `ANTHROPIC_API_KEY=sk-ant-...` in `.env`.

Subscription usage caps still apply: an orchestrated run starts several fresh sessions per task,
so it reaches the caps faster than interactive use. When Claude Code is rate-limited it exits with
an error; orch treats that as a failed attempt, retries once, then parks the task in the inbox.
Pause the run and press Start again later; nothing is lost.

**Gemini CLI** (only if a role uses the `gemini` adapter): set `GEMINI_API_KEY` in `.env`, or
log in once with `docker compose run --rm orch gemini` (saved in the `gemini-home` volume).

<a id="access-token"></a>**Access token.** The dashboard, API, live stream and CLI all need it once
a token is set. Generate one:

```bash
openssl rand -hex 32
```

and put it in `.env` as `ORCH_TOKEN`. The browser asks for it once and remembers it in a cookie.
`docker compose exec orch orch …` and the agents inside the container get it from the environment.
The health check (`/api/health`) stays open, so the Docker `HEALTHCHECK` needs no token.

Create `.env` next to `docker-compose.yml` (it is gitignored):

```bash
ORCH_TOKEN=paste-the-generated-token-here
# ANTHROPIC_API_KEY=sk-ant-...   # only if you chose API billing
GH_TOKEN=ghp_...                 # repo scope; needed for git.pr: true
GIT_AUTHOR_NAME=Your Name
GIT_AUTHOR_EMAIL=you@example.com
```

**GitHub pushes.** With `GH_TOKEN` set, make git use it for HTTPS remotes (once, persisted in
the `gh-config` volume):

```bash
docker compose run --rm orch gh auth setup-git
```

For SSH remotes instead, uncomment the `~/.ssh` mount in `docker-compose.yml` and make sure the
key has no passphrase (there is no agent inside the container).

**Local-merge mode** (`git.pr: false`) needs no GitHub credentials at all; the merged `main`
sits in `work/repos/myapp` and you push it yourself.

## 4. Run

```bash
docker compose up -d
docker compose logs -f orch
```

Dashboard: `http://my-server:4800` (it asks for the access token once). The CLI works through
`docker compose exec`, which already has `ORCH_TOKEN`:

```bash
docker compose exec orch orch plan /work/repos/myapp/specs/001-auth
docker compose exec orch orch status
docker compose exec orch orch approve && docker compose exec orch orch run
```

Or alias it: `alias orch='docker compose -f ~/orch/docker-compose.yml exec orch orch'`.

To add another repo, clone it under `work/repos/` and register it by its path inside the container:
`docker compose exec orch orch project add /work/repos/otherapp`. `docker compose exec` starts in
`/work`, which is not inside any repo, so once two projects are registered, name the project:
`orch status --project otherapp`, or pass `-e ORCH_PROJECT=otherapp` to `exec`. `orch plan` still
finds the project from the spec folder's path.

## 5. Upgrading

```bash
cd ~/orch && git pull && docker compose build && docker compose up -d
```

State is in `work/`, logins are in the named volumes; a rebuild loses nothing. If the daemon
restarts mid-run, any task that was active goes back to `pending` and its worktree is kept.

**From a single-repo install** (`work/orch.config.json` with `repo`, `dbPath: /work/.orch/orch.db`,
`worktreeDir: /work/orch-worktrees`): the first start of the new image upgrades it as in step 2. It
also copies `work/.orch/orch.db` to `work/orch.db` and assigns every existing run to the project, so
the history stays visible; the **Decisions** tab records the upgrade. New worktrees go to
`work/worktrees/<project>/`; tasks that already had a worktree in `work/orch-worktrees/` keep using it.
Once the run history looks right, you can delete `work/.orch/`.

## Notes

* **Nested sessions.** Don't start the container from inside a Claude Code session with the
  socket mounted; Claude Code detects nesting and refuses. Plain `docker compose up` from a shell
  is fine.
* **Root.** The image runs as the non-root user `orch` (uid 1000), because Claude Code refuses
  `bypassPermissions` as root. Don't override `user:` in compose. Agents still have full
  permissions inside their worktree and the container.
* **Exposure.** With `ORCH_TOKEN` set, every API call, the live stream and the dashboard need the
  token; without it, `orch serve` exits with an error rather than listen on `0.0.0.0`. There is no
  TLS, so the token crosses the network in clear text: reach the dashboard over SSH, Tailscale or
  a private network, or put it behind a reverse proxy with HTTPS. Do not expose port 4800 to the
  internet. For localhost-only access, publish `"127.0.0.1:4800:4800"`. Setting
  `auth.allowInsecure: true` turns the startup check off; only do that behind another layer of
  auth.
* **Secrets in worktrees.** `git.copyFiles` copies e.g. `.env` into every worktree; the agent can
  read it. Only list what the tests need.
* **Disk.** Each worktree is a full checkout plus `node_modules` if `setupCommand` installs them.
  Finished worktrees are removed; stopped or failed ones are kept for inspection until you retry
  or skip the task.
