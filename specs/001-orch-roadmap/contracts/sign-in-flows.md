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

## Real run (2026-11-10)

Run on the AORUS server in a scratch container (`orch:t028`, port 4801, fresh volumes, no `GH_TOKEN`), each CLI signed in through the Agents tab. Versions: Claude Code 2.1.321, Codex 0.167.0, Antigravity (`agy`) 1.5.3, gh 2.103.3. `script` gave usable lines for all four.

**Claude Code** (`claude auth login`), exact lines:
```
Opening browser to sign in…
If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=…&state=…
Paste code here if prompted >
```
Pasting the code shown after sign-in finished the flow; the card read `signed_in`, detail `claude.ai`.

**Codex** (`codex login --device-auth -c cli_auth_credentials_store=file`), exact lines; the process exits on its own once the device is approved, no input needed:
```
Welcome to Codex [v0.167.0]
OpenAI's command-line coding agent
Follow these steps to sign in with ChatGPT using device code authorization:
1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device
2. Enter this one-time code (expires in 15 minutes)
   BCSF-IQFJZ
Continue only if you started this login in Codex. If a website or another person gave you this code, cancel.
```
Status afterwards: `Logged in using ChatGPT`.

**gh** (`gh auth login --hostname github.com --git-protocol https --web`), exact lines. gh asks `Authenticate Git with your GitHub credentials?` even with `--git-protocol` (answer `Y`), then waits for Enter; the exit code is 0 once the code is entered on github.com:
```
! Did you know that expiring tokens can be requested with --expiring? Read more at https://gh.io/gh-expiring-tokens
? Authenticate Git with your GitHub credentials? (Y/n)
? Authenticate Git with your GitHub credentials? Yes
! Failed to copy one-time code to clipboard
  No clipboard utilities available. Please install xsel, xclip, wl-clipboard or Termux:API add-on for termux-clipboard-get/set.
! First copy your one-time code: 66F6-2D74
Press Enter to open https://github.com/login/device in your browser...
! Failed opening a web browser at https://github.com/login/device
  exec: "xdg-open,x-www-browser,www-browser,wslview": executable file not found in $PATH
  Please try entering the URL in your browser manually
```
Status afterwards: `Logged in to github.com account <name> (/home/orch/.config/gh/hosts.yml)`.

**Antigravity** (bare `agy`): it draws a full-screen menu, not lines. The default choice is already the Google sign-in, so **Send** with an empty box (Enter) selects it. Option 2 cannot be chosen from the panel because the panel sends no arrow keys. Lines seen:
```
Welcome to the Antigravity CLI. You are currently not signed in.
Select login method:
 > 1. Google OAuth
2. Use a Google Cloud project
↑/↓ Navigate · enter Select
 Signing in...Your browser should open automatically. If not:
 https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=…&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&…
 Copy and paste the URL or click on the link below:
 If you aren't automatically redirected, paste the authorization code below:
 authorization code...
```
After consent, Google's page shows a code; pasting it signs in. The CLI then carries on into its first-run screens ("Welcome to Antigravity CLI! Choose your color scheme") and never exits, so the flow ends only on **Cancel** or the 10-minute limit; the re-probe then reads signed in. A signed-out `agy -p` does not fail fast: it starts its own OAuth and waits, so the probe hits its 15 s timeout and the card reads `unknown` ("status check timed out after 15 s") rather than signed out. The token is `~/.gemini/antigravity-cli/antigravity-oauth-token`, in the `gemini-home` volume; it survived a container recreate.

**Engine findings, fixed in T028:**
- A line-mode prompt accepts LF, but a full-screen menu in raw keyboard mode needs CR for Enter. Input now ends in CR; the pty turns it into a newline for line-mode prompts.
- gh asks the terminal for its cursor position (`ESC[6n`) and hangs without an answer. The engine now replies with the size it set (rows 50, cols 1000).
- gh leaves a bare `ESC 7` (save cursor) after its prompt; the line cleaner now strips two-byte escapes of that kind.
- One status read right after the gh and Antigravity flows reported Antigravity as signed out; three reads later it was signed in again. Not reproduced.
