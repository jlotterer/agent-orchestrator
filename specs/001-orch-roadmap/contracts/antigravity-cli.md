# Contract: Antigravity CLI (`agy`) headless interface

What orch's `antigravity` adapter relies on. Source: Google's CLI docs (headless, reference, authenticate, permissions pages), read 2026-11-09. Items marked **verify** are not documented and must be confirmed in the real run; the recorded stream fixtures are the final word.

## Launch
- Binary `agy`; install `curl -fsSL https://antigravity.google/cli/install.sh | bash` (default `~/.local/bin/agy`); `agy --version`.
- Headless flags: `--output-format stream-json` (NDJSON on stdout; diagnostics on stderr), `--input-format stream-json` (prompt on stdin as NDJSON; any `-p` text is then dropped), `--model <slug>` (`agy models` lists them; an unknown slug exits 1 with an `ERROR` envelope), `--effort low|medium|high`, `--print-timeout <dur>` (default `0s` = none), `--json-schema <schema or path>`.
- Prompt delivery: write one line `{"event":"user","message":{"content":"<prompt>"}}` to stdin. The docs say a clean close of stdin exits 0; **verify** that closing stdin right after the user event lets the turn finish (if the CLI aborts the turn, the runner must hold stdin open until the `result` event; see the brief). `-p "<prompt>"` as an argument is the fallback for prompts under 100 KB only (OS argument limit).
- Resume: `--conversation <id>` (by id) or `--continue` (most recent; scope undocumented, so always pass the id).
- Permissions: `--dangerously-skip-permissions` auto-approves every tool call (`permission_mode: always-proceed` in `init`). Without it a tool needing approval is soft-denied, the run still exits 0 and only stderr says so. Scoped `permissions.allow` rules live in `~/.gemini/antigravity-cli/settings.json`.
- Trust: `trustedWorkspaces` in that settings file; headless behaviour in an untrusted folder is undocumented. **verify** on a fresh worktree.

## Stream (one JSON object per line, top-level `event`)
```
{"event":"init","conversation_id":"c3b6…","init":{"cwd":"/w","tools":["run_command","write_to_file"],"permission_mode":"always-proceed","model":"gemini-3.8-flash-medium"}}
{"event":"step_update","step_update":{"conversation_id":"c3b6…","step_index":0,"state":"DONE","step_type":"user_input"}}
{"event":"step_update","step_update":{"conversation_id":"c3b6…","step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"apple"}}
{"event":"step_update","step_update":{"conversation_id":"c3b6…","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":" pie"}}
{"event":"step_update","step_update":{"conversation_id":"c3b6…","step_index":4,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":0.07,"tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hi"},"output":"hi\r\n"}}}
{"event":"result","result":{"conversation_id":"c3b6…","status":"SUCCESS","response":"…final text…","duration_seconds":6.88,"num_turns":1,"usage":{"input_tokens":1,"output_tokens":2,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":3}}}
```
- Session id is `conversation_id` (on `init`, every `step_update`, `result`).
- Assistant text: `step_type: agent_response`; concatenate `text_delta` over the step's `ACTIVE` lines and its `DONE` line; a short reply arrives in one `DONE`. `result.response` holds the final answer: prefer it for `finalText`, fall back to the last agent_response text.
- Tools: a `step_type: tool` step carries call and result together (`tool_info.name`, `.parameters`, `.output`, and on failure `.error {type, message}`). There is no separate tool-result event. Other step types seen: `checkpoint`; `subagent_info` may appear. Skip unknown events and step types.
- Errors: no dedicated error event. Failure = `result.status` other than `SUCCESS` (`ERROR`, `CANCELED`, `INTERRUPTED`, `INVALID`) with `result.error` (string), or `tool_info.error`.
- Cost: none reported, only tokens; the adapter leaves `costUsd` null (the run row then shows n/a, as TASK-17 defined).
- Exit codes: 0 on success and on a soft-denied tool; non-zero with the reason on stderr on a failed run; 1 for an unknown model or malformed stdin; 2 for unsupported `control_*` events or slash commands in stdin. Timeout code undocumented.
- Not authenticated and no terminal: exits with an `authentication required` error on stderr instead of hanging.

## Authentication (subscription first)
- Interactive `agy` signs in with a Google account and stores the session in the **OS keyring** (Linux: Secret Service over D-Bus). No on-disk credential file and no `agy login` subcommand are documented. Over SSH the CLI prints an authorization URL and asks for the code to be pasted back. **verify** whether the orch Docker image (no keyring daemon) can store the session at all; the troubleshooting page mentions keyring and SSH forwarding. If it cannot, document the smallest working setup (for example a file-backed keyring in the container) or state plainly that only the API key works in Docker.
- API key fallback: `"modelProvider": "gemini"` in `~/.gemini/antigravity-cli/settings.json` **and** `GEMINI_API_KEY` exported; the key alone has no effect. `GOOGLE_API_KEY` and `.env` files are ignored.
- Settings dir `~/.gemini/antigravity-cli/`; keep mounting `/home/orch/.gemini` as a volume so settings and any trust entries survive rebuilds.
