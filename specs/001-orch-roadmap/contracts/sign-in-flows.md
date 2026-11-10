# Contract: CLI sign-in flows the dashboard drives

What T028's accounts panel relies on. Versions checked in the orch Docker image on 2026-11-09: Claude Code 2.1.319, gh 2.103.3, util-linux `script` present at `/usr/bin/script`. Codex and Antigravity facts come from `contracts/codex-cli.md` and `contracts/antigravity-cli.md`; items marked **verify** are confirmed in T028's real run.

## Generic protocol (vendor-free, lives in `src/accounts.ts`)
- A flow is one child process started from a `LaunchSpec` the adapter (or the `gh` entry) provides, run under a pseudo-terminal: `script -qfec "<command> <args>" /dev/null` on Linux (CLIs that insist on a TTY then work; `-f` flushes per line). macOS: `script -q /dev/null <command> <args>`. Other platforms: the panel says sign-in is unsupported there (HTTP 501) and shows the CLI command to run by hand.
- Output is read line by line, ANSI escape sequences and carriage returns stripped, and sent to connected dashboards only, as SSE `account` events `{id, line}`. The pty echoes what the owner types, so a line equal to the last input is dropped before sending. Nothing from a flow is written to the store, the event log, stderr beyond start/exit notices, or any file.
- Input: the dashboard posts `{text}`; orch writes `text + "\n"` to the child's stdin. Empty text sends a bare Enter (gh's "Press Enter to open" prompt). Input is never echoed back or logged.
- One active flow per account id; a second start is refused with 409. A flow is killed after 10 minutes or on cancel. On exit the panel gets `{id, done: true, exitCode}` and orch re-runs the status probe.
- Status probe: `<command> --version` (version, or "not installed" when spawn fails) then the account `status` spec; `parseStatus(stdout, exitCode)` returns `{signedIn, detail}`. Probes run on demand (GET) with a 15 s timeout each, in parallel across accounts, never on the tick.
- URL and code highlighting is generic: every `https://` token becomes a link; any token matching `[A-Z0-9]{4}-[A-Z0-9]{4}` or `[A-Za-z0-9_-]{8,}` on a line that also contains "code" gets a copy button.

## Claude Code (`claude`)
- Status: `claude auth status --json` → `{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", …}`. `signedIn = loggedIn === true`; `detail = authMethod`.
- Login: `claude auth login` (default `--claudeai`, the subscription; `--console` for API billing). Headless it prints a URL to open and then asks for the code shown after sign-in to be pasted (**verify** the exact prompt text; the panel treats any waiting prompt the same way). Credentials: `~/.claude/.credentials.json` (volume `claude-home`).
- Alternative the docs keep: `claude setup-token` for a long-lived token placed in the adapter env.

## Codex CLI (`codex`)
- Status: `codex login status` → exit 0 when credentials exist; stdout names the method. `signedIn = exitCode === 0`.
- Login: `codex login --device-auth` prints a URL and a one-time code; no input needed; the process exits when the device is approved (**verify** it exits on its own and how long it waits). The account must allow device authorization in ChatGPT security settings; the panel shows that hint when the flow fails. Store credentials in a file: run the login with `-c cli_auth_credentials_store=file` so no keyring is tried; `~/.codex/auth.json` (volume `codex-home`).

## Antigravity CLI (`agy`)
- Status: no status command is documented. Probe: `agy -p "reply with ok" --output-format json --print-timeout 60s`; `signedIn` is `status === "SUCCESS"`; an `authentication required` error means signed out (**verify** the exact text).
- Login: interactive `agy` run under the pty prints an authorization URL and asks for the code to be pasted back (the documented remote/SSH flow). The session goes to the OS keyring; T027 settles whether the image can hold one. If it cannot, the panel shows the API-key instructions (`modelProvider: gemini` + `GEMINI_API_KEY`) instead of a Sign in button.

## GitHub CLI (`gh`, not an adapter; commands live in `src/accounts.ts`)
- Status: `gh auth status` → exit 0 when a host is logged in; stdout names the account. Honour `git.ghCommand` from server settings.
- Login: `gh auth login --hostname github.com --git-protocol https --web` prints `! First copy your one-time code: XXXX-XXXX` then `Press Enter to open https://github.com/login/device in your browser...`; the owner copies the code, sends an empty input, opens the URL on any device, and the process exits 0 once approved. `GH_TOKEN` in the environment makes `gh` ignore the stored login, so the panel says so when that variable is set. Store: `~/.config/gh` (volume `gh-config`).
