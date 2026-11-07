# Running orch in Docker

The container holds the toolchain (node, git, gh, Claude Code, orch). Everything that changes —
your repo, the worktrees, the SQLite database and the config — lives on one mounted directory,
`./work`, so you can rebuild the image freely.

```
work/
├── orch.config.json      ← ORCH_CONFIG points here
├── repo/                 ← your project (a clone)
├── orch-worktrees/       ← created by orch, one dir per running task
└── .orch/orch.db         ← state
```

Keeping the repo and the worktrees on the same mount matters: git records worktree paths in
`repo/.git/worktrees/`, and those paths must be the same every time the container starts.

## 1. Build

```bash
cd ~/orch
docker compose build
```

If your project's tests need more than node (python, go, a database client), add it in the
marked section of the `Dockerfile` first. `validation.command` and `git.setupCommand` run inside
this container, so whatever `npm test` or `pytest` needs has to be in the image.

## 2. Put the repo and config in `work/`

```bash
mkdir -p work
git clone git@github.com:you/myapp.git work/repo      # or https://
```

`work/orch.config.json` — paths are container paths:

```json
{
  "repo": "/work/repo",
  "baseBranch": "main",
  "worktreeDir": "/work/orch-worktrees",
  "dbPath": "/work/.orch/orch.db",
  "host": "0.0.0.0",
  "port": 4800,
  "publicUrl": "http://my-server:4800",
  "agents": { "roles": { "planner": { "adapter": "claude", "model": "" }, "worker": { "adapter": "claude", "model": "" }, "validator": { "adapter": "gemini", "model": "pro" } } },
  "scheduler": { "maxParallel": 1, "tickSeconds": 5, "maxAttempts": 2, "resumeOnRetry": true },
  "validation": { "command": "npm test", "agent": true },
  "git": { "pr": true, "mergePolicy": "auto", "squash": true, "copyFiles": [], "setupCommand": "npm ci", "tickTasksMd": true },
  "notify": { "ntfyUrl": "https://ntfy.sh/your-topic", "ntfyToken": "" }
}
```

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

Create `.env` next to `docker-compose.yml` (it is gitignored):

```bash
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
sits in `work/repo` and you push it yourself.

## 4. Run

```bash
docker compose up -d
docker compose logs -f orch
```

Dashboard: `http://my-server:4800`. The CLI works through `docker compose exec`:

```bash
docker compose exec orch orch plan /work/repo/specs/001-auth
docker compose exec orch orch status
docker compose exec orch orch approve && docker compose exec orch orch run
```

Or alias it: `alias orch='docker compose -f ~/orch/docker-compose.yml exec orch orch'`.

## 5. Upgrading

```bash
cd ~/orch && git pull && docker compose build && docker compose up -d
```

State is in `work/`, logins are in the named volumes; a rebuild loses nothing. If the daemon
restarts mid-run, any task that was active goes back to `pending` and its worktree is kept.

## Notes

* **Nested sessions.** Don't start the container from inside a Claude Code session with the
  socket mounted; Claude Code detects nesting and refuses. Plain `docker compose up` from a shell
  is fine.
* **Root.** Claude Code refuses `bypassPermissions` as root, which is why the image runs as `orch`
  (uid 1000). Don't override `user:` in compose.
* **Exposure.** The dashboard has no authentication. Bind it to localhost
  (`"127.0.0.1:4800:4800"`) and reach it over SSH or Tailscale, or put it behind a reverse proxy
  with auth. Do not expose port 4800 to the internet.
* **Secrets in worktrees.** `git.copyFiles` copies e.g. `.env` into every worktree; the agent can
  read it. Only list what the tests need.
* **Disk.** Each worktree is a full checkout plus `node_modules` if `setupCommand` installs them.
  Finished worktrees are removed; stopped or failed ones are kept for inspection until you retry
  or skip the task.
