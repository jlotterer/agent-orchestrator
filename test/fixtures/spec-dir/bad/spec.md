# Feature 002: Session authentication (folder with four problems)

## Goal
Users of the sample app sign in once and stay signed in across requests until their session expires or they sign out. The app keeps sessions server-side in a small store, issues an opaque cookie, refreshes a session that is close to expiry, and protects every route except the public ones behind one middleware.

## Covers
- REQ-AUTH-01: sessions are stored server-side and expire
- REQ-AUTH-02: login and logout endpoints with a login page
- REQ-AUTH-03: a session close to expiry is refreshed on use
- REQ-AUTH-04: protected routes reject requests without a valid session

## Out of scope
- Roles, permissions and the admin page (F03).
- Password reset by e-mail (F04).
- Rate limiting of the login endpoint: TBD, depends on whether the reverse proxy stays.

## Contracts

### SessionStore
```ts
export interface Session {
  id: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}

export interface SessionStore {
  create(userId: string, now: number): Session;
  get(id: string, now: number): Session | null;
  touch(id: string, now: number): Session | null;
  remove(id: string): void;
}
```

### TokenCodec
```ts
export interface TokenCodec {
  encode(sessionId: string): string;
  decode(token: string): string | null;
}
```

## Risky logic
Expiry and refresh arithmetic in `SessionStore.get` and `touch`. T001 ships the fixtures for it; T003 un-skips the refresh cases.
