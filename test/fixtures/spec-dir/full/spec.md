# Feature 002: Session authentication

## Goal
Users of the sample app sign in once and stay signed in across requests until their session expires or they sign out. The app keeps sessions server-side in a small store, issues an opaque cookie, refreshes a session that is close to expiry, and protects every route except the public ones behind one middleware. This feature is the second on the roadmap; it builds on the walking skeleton (F01) and is the base for roles and permissions (F03).

## Covers
- REQ-AUTH-01: sessions are stored server-side and expire
- REQ-AUTH-02: login and logout endpoints with a login page
- REQ-AUTH-03: a session close to expiry is refreshed on use
- REQ-AUTH-04: protected routes reject requests without a valid session

## Out of scope
- Roles, permissions and the admin page (F03).
- Password reset by e-mail (F04).
- Token rotation on every request (rejected in decision 0007; refresh only near expiry).
- Rate limiting of the login endpoint (handled by the reverse proxy; see architecture.md section 9).

## Contracts

### SessionStore
The one interface every task in this feature shares. T001 implements it; T002, T003 and T004 consume it and must not add methods to it.

```ts
export interface Session {
  id: string;          // 32 hex chars, from crypto.randomBytes(16)
  userId: string;
  createdAt: number;   // epoch ms
  expiresAt: number;   // epoch ms; createdAt + auth.sessionMinutes * 60_000
}

export interface SessionStore {
  create(userId: string, now: number): Session;
  get(id: string, now: number): Session | null;      // null when unknown or expired
  touch(id: string, now: number): Session | null;    // extends expiresAt when within auth.refreshWindowMinutes of expiry
  remove(id: string): void;
}
```

Rules: `get` never returns an expired session and removes it as a side effect. `touch` returns the session unchanged when it is not close to expiry. Both take `now` as an argument so the store never reads the clock.

### TokenCodec
Encodes a session id into the cookie value and back. The cookie carries only the id, signed; it never carries user data.

```ts
export interface TokenCodec {
  encode(sessionId: string): string;                 // `${id}.${hmacSha256(id, auth.secret).slice(0, 16)}`
  decode(token: string): string | null;              // null when the signature does not match
}
```

The signature is truncated to 16 hex characters; a mismatch is a `null`, never an exception.

## Risky logic
Expiry and refresh arithmetic in `SessionStore.get` and `touch` (off-by-one at the boundary, refresh inside versus outside the window). T001 ships the fixtures for it in `test/fixtures/sessions.json` and the tests that read them; T003 implements refresh against those fixtures and un-skips the refresh cases.
