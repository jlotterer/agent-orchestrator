# 0025: The dashboard signs the agent CLIs in by driving their own login flows

- **Status:** Accepted, 2026-11-10
- **Supersedes:** nothing. [0007](0007-agent-adapters.md) (vendor code only in `src/adapters/`) stands; REQ-OPS-07 (credentials stay in each CLI's own store) is kept.
- **Requirements affected:** REQ-UI-09, REQ-OPS-08

## Context
Each agent CLI is signed in on the orch server with the owner's own subscription. Until now that meant `docker compose run --rm orch <cli> login`, a browser on another machine and knowing which volume holds what. A login that quietly lapses (the Gemini case, [0024](0024-retire-gemini-add-antigravity-codex.md)) shows up only as failed tasks. The owner wants to see, in the dashboard, which CLIs are installed and signed in, and to sign one in from the browser.

## Decision
- The dashboard has an **Agents** tab: one card per adapter in `agents.adapters` plus the GitHub CLI, with the installed version and signed-in state, and a **Sign in** button.
- Sign in runs **the CLI's own login command** on the server under a pseudo-terminal (`script(1)`), streams what it prints (the URL and the one-time code) to open dashboards, and writes the owner's typed answer (a pasted code, or Enter) back to it. When the process ends, orch re-checks the status. Credentials are written by the CLI into its own store (the existing volumes); orch never sees, holds or proxies a token.
- The engine, `src/accounts.ts`, is vendor-free. Each adapter contributes only its status and login commands through an optional `account` member of `AgentAdapter`; the `gh` pair is the one non-adapter entry, because GitHub is not an agent vendor.
- A flow is not an orchestration event: its output and the owner's input are streamed to open dashboards only and never reach the store, the event log, `decide()`, a file or a log line (REQ-OPS-08). The invariants check and a unit test enforce this.
- Linux and macOS servers only (the Docker image is Linux). Elsewhere the API answers 501 with the exact command to run by hand. The CLI commands stay documented as the fallback.

## Alternatives rejected
- **orch's own OAuth screens and token storage.** Each vendor's subscription login is meant for its own CLI; reimplementing it, then holding and refreshing tokens in orch, would put the owner's subscription credentials in orch's database and break whenever a vendor changes its flow. Driving the CLI keeps the vendor's own client, store and refresh logic.
- **Docs only (keep `docker compose run`).** It works, but a lapsed login stays invisible until tasks fail, and it needs shell access to the server's Docker host.
- **A pty library (`node-pty`).** A new runtime dependency with a native build, banned by [0009](0009-locked-stack.md); `script(1)` is already in the image.
- **Persisting flow transcripts for audit.** They contain one-time codes and pasted secrets; a record of "who signed in when" is not worth a place for those to leak.

## Consequences
- The Agents tab depends on `script` being installed (util-linux on Linux; present on macOS). The unit tests that run a flow need it, so on Windows hosts they run in Docker.
- Output that a CLI draws with cursor movement rather than lines can look rough; the panel shows lines, not a terminal. A CLI whose login needs a real keyring (Antigravity without one) shows its failure text and the API-key instructions instead.
- Antigravity's login is a full-screen menu that never exits after sign-in: the panel can press Enter on the highlighted Google choice, cannot pick the other choice, and the owner cancels the flow once the card reads signed in. Its signed-out probe waits for the 15 s timeout and reads `unknown`.
- `GET /api/accounts` runs the status commands each time it is called. Antigravity has no status command, so its probe is one tiny headless model turn; the dashboard calls it only when the Agents tab opens or is refreshed, never on the tick.
- Every adapter added later can offer sign-in by implementing `account`, with no dashboard change.
