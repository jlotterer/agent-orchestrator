# Contract: Codex CLI (`codex exec`) headless interface

What orch's `codex` adapter relies on. Source: OpenAI's Codex docs (non-interactive mode, CLI reference, authentication pages), read 2026-11-09. Items marked **verify** are not documented and must be confirmed in the real run; the recorded stream fixtures are the final word.

## Launch
- Package `@openai/codex` (`npm install -g @openai/codex`); `codex --version`.
- One-shot: `codex exec [flags] -` reads the prompt from stdin (`-` forces stdin; a prompt argument plus piped stdin makes the argument the instruction and stdin extra context, so always use `-`). Alias `codex e`.
- Flags: `--json` (NDJSON events on stdout; without it only the final message goes to stdout and progress to stderr), `-m/--model <name>` (overrides config), `-s/--sandbox read-only|workspace-write|danger-full-access` (default `read-only`), `-a/--ask-for-approval on-request|never`, `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`: no approvals, no sandbox; orch's worktree is the boundary, as with Claude's `bypassPermissions`), `--skip-git-repo-check` (needed outside a git repo; worktrees are repos), `-C/--cd <path>`, `-c key=value` config overrides, `--output-last-message <path>`, `--output-schema <path>`, `--ephemeral` (do not persist the session; orch must **not** pass it, resume needs the rollout). `--full-auto` is removed.
- Resume: `codex exec resume <SESSION_ID> [flags] "<prompt>"`; `--last` picks the most recent session. The id is the `thread_id` from `thread.started` (**verify**). **verify** that `-` (stdin prompt) works with `resume`; if not, the adapter passes the prompt as the argument on resume only and the brief's size fallback applies.

## Stream (`--json`, one JSON object per line, top-level `type`)
```
{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"completed","exit_code":0,"aggregated_output":"…"}}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"…final text…"}}
{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":2,"reasoning_output_tokens":0}}
```
- Session id: `thread_id` on `thread.started`.
- Assistant text: `item.completed` with `item.type: agent_message` and `item.text`; the last one is `finalText`.
- Tools: `item.type: command_execution` (`command`, `status`, and on completion the exit code and output; **verify** the exact field names, the example shows the likely ones), `file_change`, `mcp_tool_call`, `web_search`, `reasoning`, `plan_update`. Map `command_execution` and `mcp_tool_call` to orch `tool` events (call on `item.started`, result on `item.completed`), `file_change` to a `tool` event named `file_change`, and skip `reasoning`. Tolerate unknown item types.
- Errors: `turn.failed` and `error` events; shapes undocumented (**verify**). Any of them, or a non-zero exit, sets `isError`.
- Usage: `turn.completed.usage` has tokens only. No cost: `costUsd` stays null (run row shows n/a, as TASK-17 defined).
- Exit codes: undocumented beyond "non-zero on error". Treat non-zero as failure, as the runner already does.

## Authentication (subscription first)
- Device code (preferred for headless): `codex login --device-auth`; prints a URL and a code; the account must allow device authorization in ChatGPT security settings. Works for a ChatGPT subscription; **verify** with the owner's Plus/Pro account in the Docker image: `docker compose run --rm orch codex login --device-auth`.
- `codex login status` exits 0 when credentials are present (use it for the docs' "check your login" step).
- API key alternatives: `printenv OPENAI_API_KEY | codex login --with-api-key`, or `CODEX_API_KEY=<key> codex exec …` (documented by example; **verify** it is read without a login). `forced_login_method = "chatgpt"|"api"` in config.
- Storage: `$CODEX_HOME/auth.json` (default `~/.codex`) when `cli_auth_credentials_store` is `file`; `auto` may try a keyring first, so set `file` in the image (`-c cli_auth_credentials_store=file` at login, or `config.toml` in the volume). Mount `/home/orch/.codex` as the `codex-home` volume. Never print `auth.json`.
