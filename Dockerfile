# orch — orchestrator / worker / validator runner for coding agents
#
# The image contains: node, git, gh, Claude Code, Antigravity CLI (agy), Codex CLI, and orch itself.
# Your repos, worktrees, database and settings live on a mounted volume (/work = ORCH_HOME).
# Add your project's own toolchain (python, go, …) in the marked section below,
# because validation commands and setup commands run inside this container.

FROM node:22-bookworm

ARG CLAUDE_CODE_VERSION=latest
ENV DEBIAN_FRONTEND=noninteractive

# --- system deps: git, gh, build tools for better-sqlite3 ---------------------
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg git python3 make g++ openssh-client \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# --- your project's toolchain goes here ---------------------------------------
# Examples:
#   RUN apt-get update && apt-get install -y python3-pip && pip install --break-system-packages pytest
#   RUN curl -fsSL https://bun.sh/install | bash
# ------------------------------------------------------------------------------

# --- Claude Code + Codex CLI + Antigravity CLI ----------------------------------
# Gemini CLI is gone (T027, decision 0024): Google ended its Google-account sign-in for individuals.
ARG CODEX_CLI_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @openai/codex@${CODEX_CLI_VERSION}
# Antigravity CLI ships as one binary; its installer drops it in ~/.local/bin of the building user.
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash \
 && mv /root/.local/bin/agy /usr/local/bin/agy && chmod 755 /usr/local/bin/agy && agy --version

# --- non-root user (Claude Code refuses --dangerously-skip-permissions as root) -
# The node image ships a 'node' user with uid 1000; rename it so files on the mount are uid 1000.
RUN groupmod -n orch node && usermod -l orch -d /home/orch -m node \
 && mkdir -p /work /home/orch/.claude /home/orch/.gemini/antigravity-cli /home/orch/.codex /home/orch/.config/gh \
 # Codex: keep credentials in $CODEX_HOME/auth.json; there is no OS keyring in the container.
 && printf 'cli_auth_credentials_store = "file"\n' > /home/orch/.codex/config.toml \
 && chown -R orch:orch /work /home/orch

# --- orch ----------------------------------------------------------------------
WORKDIR /opt/orch
COPY --chown=orch:orch package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY --chown=orch:orch . .
RUN npm run build && npm link

USER orch
ENV HOME=/home/orch
# All orch state (server.json, orch.db, worktrees/) lives in /work; repos are projects under /work too.
ENV ORCH_HOME=/work
# Only read on the first start of an install that still has a single-file config (it is then upgraded).
ENV ORCH_CONFIG=/work/orch.config.json
EXPOSE 4800
WORKDIR /work

# Health: /api/health answers without the access token
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD curl -fsS http://127.0.0.1:4800/api/health >/dev/null || exit 1

CMD ["orch", "serve"]
