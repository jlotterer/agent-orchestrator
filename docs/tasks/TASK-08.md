# TASK-08: Bearer-token auth, health check and bind guard
**Status:** todo · **Wave:** 4 · **Depends on:** TASK-05 · **Parallel:** Yes (with TASK-07)

## Goal
Protect the API, live stream and dashboard with a token, refuse unsafe network binds, add an open health check, and keep secrets out of storage and prompts.

## Covers
REQ-OPS-01, REQ-OPS-02, REQ-OPS-03, REQ-OPS-07, REQ-NFR-08

## Read first
- [CLAUDE.md](../../CLAUDE.md)
- [requirements.md §5.11](../requirements.md#511-operations--security-ops)
- [architecture.md §16](../architecture.md#16-authentication)
- [architecture.md §15.1](../architecture.md#151-http-api)
- [decision 0014](../decisions/0014-bearer-token-auth.md)
- `docs/docker.md`, `docker-compose.yml`

## Scope
- `src/auth.ts`: `isAuthorized(req, token): boolean` (Bearer header or `orch_token` cookie, SHA-256 + `timingSafeEqual`), `loginCookie(token)`, and `bindGuard({host, token, allowInsecure}): string | null` (returns an error message).
- `src/server.ts`: gate every route except `GET /`, `GET /api/health` and `POST /api/login`. Return 401 `{error:"unauthorized"}`. Add `/api/health` returning `{ok, version, uptimeSec}`.
- `src/config.ts`: `auth.token` and `auth.allowInsecure` are read from `ORCH_TOKEN` or config. In legacy single-repo mode they sit on the legacy `Config`, and the default host becomes `127.0.0.1`.
- `src/cli.ts`: run the bind guard in `serve`. All API calls send `Authorization: Bearer` from `ORCH_TOKEN` or the server config.
- `src/orchestrator.ts`: `taskEnv` adds `ORCH_TOKEN`. `publicConfig()` exposes only booleans for secrets.
- `dashboard/index.html`: on a 401, show a token prompt, `POST /api/login`, then reload state and reconnect SSE.
- `docs/docker.md`, `docker-compose.yml`, `README.md`: set a token when publishing the port; note that the image runs as non-root.
- `scripts/e2e-auth.mjs`: the e2e checks listed under Done when.

## Out of scope
Multi-user, TLS, rate limiting.

## Target files
- `src/auth.ts`
- `src/server.ts`
- `src/config.ts`
- `src/cli.ts`
- `src/orchestrator.ts`
- `dashboard/index.html`
- `docs/docker.md`
- `docker-compose.yml`
- `README.md`
- `scripts/e2e-auth.mjs`
- `test/unit/auth.test.mjs`
- `package.json`

## Done when
- e2e: with a token configured, `GET /api/state` without it returns 401, and `GET /api/health` returns 200 with the version.
- e2e: `orch status` with `ORCH_TOKEN` set succeeds; without it, it exits 1 with "unauthorized".
- e2e: a fake worker's `orch decide` succeeds (the token reached the agent env), and the login cookie lets the SSE stream connect.
- e2e: `serve` with host `0.0.0.0` and no token exits 1, with a message naming `auth.token` and `auth.allowInsecure`.
- e2e: after a full run, the token string does not occur in the DB file or in any event's data.
- `npm test` passes.
- `npm run typecheck` passes and docs touched by this change (README, architecture, decisions) are updated in the same PR, including this brief's status line.
