# 0014: Bearer-token authentication; refuse insecure binds

- **Status:** Accepted, 2026-11-07
- **Requirements affected:** REQ-OPS-01, REQ-OPS-02, REQ-OPS-03, REQ-OPS-07

## Context
The dashboard and API control agents that run with full permissions. Today there is no auth; the owner reaches the server over a private network.

## Decision
A single token from env or server config. CLI and agents send it as a Bearer header; the dashboard logs in once and gets an HttpOnly SameSite=Strict cookie (works with EventSource). Health check and login are open. Binding a non-loopback address without a token is refused unless explicitly allowed.

## Alternatives rejected
- **HTTP basic auth.** Awkward for EventSource and the agent CLI.
- **No auth, network only.** One misconfigured port exposes agent control.
- **OAuth/users.** Multi-user is a non-goal.

## Consequences
- Default host becomes `127.0.0.1`. Docker docs must set a token when publishing the port.
