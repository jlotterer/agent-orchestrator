# Implementation Plan: Session authentication

**Branch**: `002-session-auth` | **Date**: 2026-11-02 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/002-session-auth/spec.md`

## Execution Flow (/plan command scope)
```
1. Load feature spec from Input path
   → Loaded. Six functional requirements, five acceptance scenarios, three edge cases.
2. Fill Technical Context (scan for NEEDS CLARIFICATION)
   → Project Type: single web service. Structure Decision: Option 1 below.
3. Fill the Constitution Check section based on the constitution document.
4. Evaluate Constitution Check section below
   → No violations. Progress Tracking: Initial Constitution Check PASS.
5. Execute Phase 0 → research.md
   → Three questions researched and settled; see Phase 0.
6. Execute Phase 1 → contracts, data-model.md, quickstart.md, agent file
7. Re-evaluate Constitution Check section
   → Still passes. Progress Tracking: Post-Design Constitution Check PASS.
8. Plan Phase 2 → Describe task generation approach (DO NOT create tasks.md)
9. STOP - Ready for /tasks command
```

**IMPORTANT**: The /plan command STOPS at step 8. Phases 2–4 are executed by other commands:
- Phase 2: /tasks command creates tasks.md
- Phase 3–4: Implementation execution (manual or via tools)

## Summary
Signed-in users keep a server-side session for thirty minutes, extended when they are active in the last five minutes of it, and every route outside a short public list requires one. The technical approach is the smallest thing that satisfies the spec: an in-memory session map behind one interface, a signed cookie that carries only the session id, three endpoints and one middleware. No new runtime dependency; the HMAC comes from `node:crypto`.

## Technical Context
**Language/Version**: TypeScript 5.6 on Node 22 (strict, ESM)
**Primary Dependencies**: none added; `node:http`, `node:crypto` from the standard library
**Storage**: in-memory `Map` for this feature; persistent sessions are roadmap item F05
**Testing**: `node:test` against the compiled `dist/`; `npm test` runs build, unit and the smoke script
**Target Platform**: Linux server behind the existing reverse proxy
**Project Type**: single (web service with server-rendered pages)
**Performance Goals**: middleware adds under 1 ms per request at p95 on the reference box
**Constraints**: no new runtime dependencies; no build step for pages; all time passed in, never read inside the store
**Scale/Scope**: a few hundred concurrent sessions; one process

## Constitution Check
*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**Simplicity**:
- Projects: 1 (the existing service). No new packages.
- Using framework directly? Yes: `node:http` handlers, no wrapper classes beyond the one `SessionStore` interface the spec already requires.
- Single data model? Yes: `Session`; no DTO layer. The `/api/me` response is a projection of `Session`, built inline.
- Avoiding patterns? Yes: no repository or unit-of-work; the `Map` is the store.

**Architecture**:
- Every feature as a library? The session logic is a module under `src/auth/` with no CLI; the constitution's library rule is satisfied by the module boundary and its exported interface.
- Libraries listed: `src/auth/` (store, codec, routes, middleware).
- CLI per library: not applicable; the service has no CLI surface for sessions and the constitution exempts request-handling modules.
- Library docs: this plan, `data-model.md`, `contracts/one.md`.

**Testing (NON-NEGOTIABLE)**:
- RED-GREEN-Refactor cycle enforced? Yes: each task writes its tests first and commits them failing, then makes them pass in the same task.
- Git commits show tests before implementation? Yes, within a task's branch.
- Order: Contract → Integration → E2E → Unit strictly followed? Contract tests for the four endpoints first (T003), integration through the middleware (T004), unit tests for the store arithmetic (T002).
- Real dependencies used? Yes: the real in-memory store and real `node:crypto`; no mocks except a fixed clock.
- Integration tests for: the contract in `contracts/one.md`, the middleware and the store together.
- FORBIDDEN: implementation before test, skipping the RED phase.

**Observability**:
- Structured logging included? One log line per login, logout and refused request, through the existing logger.
- Frontend logs → backend? Not applicable; the login page has no script.
- Error context sufficient? The 401 body is fixed by contract; the log line carries the reason (missing, forged, expired).

**Versioning**:
- Version number assigned? 0.2.0 (minor: new endpoints).
- BUILD increments on every change? Yes, by CI.
- Breaking changes handled? None; every existing route keeps working for a signed-in user, and `/healthz` stays public.

## Project Structure

### Documentation (this feature)
```
specs/002-session-auth/
├── plan.md              # This file (/plan command output)
├── research.md          # Phase 0 output (/plan command)
├── data-model.md        # Phase 1 output (/plan command)
├── quickstart.md        # Phase 1 output (/plan command)
├── contracts/           # Phase 1 output (/plan command)
│   └── one.md
└── tasks.md             # Phase 2 output (/tasks command - NOT created by /plan)
```

### Source Code (repository root)
```
# Option 1: Single project (SELECTED)
src/
├── auth/
│   ├── types.ts         # Session, SessionStore, TokenCodec
│   ├── store.ts         # in-memory SessionStore
│   ├── codec.ts         # HMAC token codec
│   ├── routes.ts        # /login, /api/login, /api/logout, /api/me
│   ├── middleware.ts    # protected-route gate and refresh
│   └── pages/login.html
├── server.ts            # registration order: health, static, auth middleware, routes
└── users.ts             # existing loader; unchanged

test/
├── auth/
│   ├── store.test.ts
│   ├── codec.test.ts
│   ├── routes.test.ts
│   └── middleware.test.ts
└── helpers/http.ts      # fakeRequest helper, existing
```

**Structure Decision**: Option 1. The service is one process and one package; splitting the auth module into its own package would add a build and a version for no consumer.

## Phase 0: Outline & Research

1. **Unknowns from Technical Context**: three questions were open when the spec was written and are settled here.
   - How long is the session and the refresh window? Settled: 30 minutes and 5 minutes, as constants in `src/auth/config.ts` read from the existing settings file under `auth.sessionMinutes` and `auth.refreshWindowMinutes`.
   - Does a refresh rotate the session id? Settled: no. Rotation on every request doubles the store writes and makes two tabs race on the cookie; the threat it defends against (a leaked id) is covered by the short lifetime. Recorded as decision 0007 in the project record.
   - Where does the signing secret come from? Settled: `auth.secret` in the settings file, required at start-up; the server refuses to start without it so a deployment can never run unsigned.

2. **Research tasks** were dispatched for the cookie attributes and for the HMAC truncation length.
   - Cookie: `HttpOnly; SameSite=Lax; Path=/`, plus `Secure` when the request came in over TLS (the proxy sets `X-Forwarded-Proto`). `SameSite=Strict` was rejected because it breaks the redirect back from the identity-less login page in some browsers.
   - Truncation: 16 hex characters (64 bits) of the HMAC-SHA256 are enough for a cookie that is also bounded by a 30-minute lifetime; the full digest would double the cookie size for no practical gain. Compared in constant time with `crypto.timingSafeEqual`.

3. **Consolidated findings** in `research.md`:
   - Decision: in-memory store, signed opaque cookie, no rotation, 30/5 minute lifetimes.
   - Rationale: smallest design that meets FR-001 to FR-006; every alternative added a dependency or a state the spec does not need.
   - Alternatives considered: JWT in the cookie (rejected: carries user data, cannot be revoked by logout), a SQLite session table (deferred to F05), rotation on every request (rejected, decision 0007).

**Output**: research.md with all NEEDS CLARIFICATION resolved.

## Phase 1: Design & Contracts
*Prerequisites: research.md complete*

1. **Extract entities from feature spec** → `data-model.md`:
   - `Session` with `id`, `userId`, `createdAt`, `expiresAt`; live while `now < expiresAt`; removed on lookup when expired; removed on logout.
   - `User` unchanged from the skeleton.

2. **Generate API contracts** from functional requirements → `contracts/one.md`:
   - `GET /login` serves the form; `POST /api/login` sets the cookie or answers 401 with a body that never distinguishes an unknown user from a wrong password (FR-006); `POST /api/logout` removes the session; `GET /api/me` reports the user id and the current expiry so a client can observe a refresh (FR-003).
   - Every protected route answers `401 { "error": "not signed in" }` without a cookie (FR-004).

3. **Generate contract tests** from contracts:
   - One test file per endpoint group; each asserts status, headers and body per the table in `contracts/one.md`. They fail until T003 implements the routes.

4. **Extract test scenarios** from user stories:
   - Scenario 1 → routes test: login sets cookie and redirects. Scenario 2 → middleware test: valid session passes. Scenario 3 → store and middleware tests at the window boundary. Scenario 4 → store test at the expiry instant. Scenario 5 → routes test: logout then `/api/me` is 401.
   - Quickstart: start the app with a sample `users.json`, sign in with curl, call `/api/me`, advance the fake clock in a test to see the refresh.

5. **Update agent file incrementally**:
   - Add the `src/auth/` module and the "time is passed in" rule to the agent context file; keep it under 150 lines.

**Output**: data-model.md, contracts/one.md, failing contract tests, quickstart.md, agent file.

## Phase 2: Task Planning Approach
*This section describes what the /tasks command will do - DO NOT execute during /plan*

**Task Generation Strategy**:
- Load the task template; generate from Phase 1 design docs.
- Each contract → a contract test task marked [P]; each entity → a model task marked [P]; each user story → an integration test task; implementation tasks to make the tests pass.

**Ordering Strategy**:
- TDD order: tests before implementation.
- Dependency order: types and store before routes and middleware; routes and middleware are independent of each other and can run in parallel once the store exists.
- Mark [P] for tasks that touch different files.

**Estimated Output**: 4 tasks in tasks.md (setup, store, routes, middleware), each with its own tests. This is deliberately fewer than the template's usual 25–30: the feature is small, and the project's orchestrator merges one PR per task, so every task must end with a green test run rather than a red one. Test-first ordering therefore happens inside each task, not across tasks.

**IMPORTANT**: This phase is executed by the /tasks command, NOT by /plan.

## Phase 3+: Future Implementation
*These phases are beyond the scope of the /plan command*

**Phase 3**: Task execution (/tasks command creates tasks.md)
**Phase 4**: Implementation (execute tasks.md following constitutional principles)
**Phase 5**: Validation (run tests, execute quickstart.md, performance validation)

## Complexity Tracking
*Fill ONLY if Constitution Check has violations that must be justified*

| Violation | Why Needed | Simpler Alternative Rejected Because |
| :--- | :--- | :--- |
| none | | |

## Risks and mitigations

| Risk | Likelihood | Mitigation |
| :--- | :--- | :--- |
| Off-by-one at the expiry and refresh boundaries | High | The store takes `now` as an argument; unit tests cover `expiresAt - 1`, `expiresAt`, the window edge and one millisecond inside it. The same table drives the middleware test with a fixed clock. |
| Two parallel tasks edit `src/server.ts` | Medium | Only the middleware task touches `server.ts`; the routes task exports a registration function and the middleware task mounts it. |
| Login page breaks without JavaScript | Low | The page is a plain form posting to `/api/login`; the contract test fetches it and checks the field names. |
| Secret missing in a deployment | Low | The server refuses to start without `auth.secret`, with a one-line error naming the key. |
| Sessions lost on restart | Accepted | Documented in the quickstart; persistent sessions are roadmap item F05. |

## Quickstart outline
*Written in full in `quickstart.md`; summarised here so the plan stands alone.*

1. Copy `users.sample.json` to `users.json` and set `auth.secret` in the settings file to any 32-character string.
2. Start the service with `npm start` and open `http://localhost:3000/login` in a browser; sign in as `alice` with the sample password.
3. Call `curl -b cookies.txt -c cookies.txt -X POST -d '{"user":"alice","password":"…"}' http://localhost:3000/api/login` and then `curl -b cookies.txt http://localhost:3000/api/me`; the second call shows the user id and an `expiresAt` thirty minutes ahead.
4. Run `npm test -- test/auth` to see the boundary cases: the store tests move a fake clock to the window edge and to the expiry instant, and the middleware tests show the refresh happening through a protected request.
5. Call `curl -b cookies.txt -X POST http://localhost:3000/api/logout`, then `/api/me` again: the response is 401 with `{ "error": "not signed in" }`.

## Rollout
The feature ships behind no flag: without `auth.secret` the server refuses to start, so a deployment either has sessions configured or does not start at all. The first deployment to the shared box happens after all four tasks have merged and the quickstart has been run by hand once. Existing users are not affected until then, because no route is protected before the middleware task merges; the login and logout routes can be deployed earlier without harm. Rollback is a redeploy of the previous build; there is no data migration, since sessions are in memory.

## Open points carried to the project record
- Decision 0007: no token rotation on refresh. Written during Phase 0; to be filed in `docs/decisions/` when the feature is folded back.
- REQ-AUTH-01 to REQ-AUTH-04 in `docs/requirements.md` move from `new` to `built` when the four tasks merge.
- The public path list is a code constant; a later feature that needs it configurable adds a settings key and a decision record.

## Progress Tracking
*This checklist is updated during execution flow*

**Phase Status**:
- [x] Phase 0: Research complete (/plan command)
- [x] Phase 1: Design complete (/plan command)
- [x] Phase 2: Task planning complete (/plan command - describe approach only)
- [ ] Phase 3: Tasks generated (/tasks command)
- [ ] Phase 4: Implementation complete
- [ ] Phase 5: Validation passed

**Gate Status**:
- [x] Initial Constitution Check: PASS
- [x] Post-Design Constitution Check: PASS
- [x] All NEEDS CLARIFICATION resolved
- [x] Complexity deviations documented

---
*Based on Constitution v2.1.1 - See `/memory/constitution.md`*
