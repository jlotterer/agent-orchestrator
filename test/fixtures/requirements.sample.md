# Sample app: Requirements

A small requirements file in the shape `orch-spec` writes, used by the `spec-dir` context fixtures to show which rows and criteria orch pulls into a worker's context for the REQ IDs a brief cites.

## 5. Functional Requirements

### 5.1 Authentication (AUTH)
**User intent:** As a user, I want to sign in once and stay signed in until my session expires or I sign out, so that I am not asked for my password on every page.

| ID | Requirement | Status |
| :--- | :--- | :--- |
| REQ-AUTH-01 | Sessions MUST be stored server-side with an expiry, and the cookie MUST carry only a signed session id. | new |
| REQ-AUTH-02 | The app MUST provide a login page, a login endpoint and a logout endpoint; invalid credentials MUST be answered without revealing whether the user exists. | new |
| REQ-AUTH-03 | A session used within the refresh window before its expiry MUST be extended by the session lifetime from that request. | new |
| REQ-AUTH-04 | Every route outside the public list MUST answer 401 to a request without a valid session. | new |

**Edge cases:**
- A request exactly at the expiry instant is treated as expired (REQ-AUTH-01).
- A cookie whose signature does not verify is treated as missing, with no hint of forgery (REQ-AUTH-04).

**Acceptance criteria:**
- `REQ-AUTH-01`: Given a session created at 0 with a 30-minute lifetime, When it is looked up at 1,800,000, Then it is expired and removed.
- `REQ-AUTH-02`: Given a wrong password, When `POST /api/login` is called, Then the response is 401 `{ "error": "invalid credentials" }` and no cookie is set.
- `REQ-AUTH-03`: Given a session expiring at 1,800,000 and a 5-minute window, When it is used at 1,500,001, Then its expiry becomes 3,300,001; When it is used at 1,500,000, Then its expiry is unchanged.
- `REQ-AUTH-04`: Given no cookie, When `GET /api/me` is requested, Then the response is 401 `{ "error": "not signed in" }`.

### 5.2 Operations (OPS)

| ID | Requirement | Status |
| :--- | :--- | :--- |
| REQ-OPS-01 | `GET /healthz` MUST answer 200 while the app is up. | built |

**Acceptance criteria:**
- `REQ-OPS-01`: Given a running app, When `/healthz` is requested, Then the status is 200.
