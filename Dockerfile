# orch — orchestrator / worker / validator runner for Claude Code
#
# The image contains: node, git, gh, Claude Code, and orch itself.
# Your repo, worktrees, database and config live on a mounted volume (/work).
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

# --- Claude Code + Gemini CLI ---------------------------------------------------
ARG GEMINI_CLI_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @google/gemini-cli@${GEMINI_CLI_VERSION}

# --- non-root user (Claude Code refuses --dangerously-skip-permissions as root) -
# The node image ships a 'node' user with uid 1000; rename it so files on the mount are uid 1000.
RUN groupmod -n orch node && usermod -l orch -d /home/orch -m node \
 && mkdir -p /work /home/orch/.claude /home/orch/.gemini /home/orch/.config/gh \
 && chown -R orch:orch /work /home/orch

# --- orch ----------------------------------------------------------------------
WORKDIR /opt/orch
COPY --chown=orch:orch package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY --chown=orch:orch . .
RUN npm run build && npm link

USER orch
ENV HOME=/home/orch
ENV ORCH_CONFIG=/work/orch.config.json
EXPOSE 4800
WORKDIR /work

# Health: the dashboard answers /api/state
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD curl -fsS http://127.0.0.1:4800/api/state >/dev/null || exit 1

CMD ["orch", "serve"]
