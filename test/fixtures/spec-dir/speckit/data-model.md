# Data Model: Session authentication

## Entities

### Session
| Field | Type | Rules |
| :--- | :--- | :--- |
| `id` | string | 32 hex characters from 16 random bytes; the only value that reaches the client, signed |
| `userId` | string | references `User.id` from the skeleton's `users.json` |
| `createdAt` | number | epoch milliseconds; set once |
| `expiresAt` | number | epoch milliseconds; `createdAt + 30 min` at creation, moved to `now + 30 min` by a refresh |

**State**: a session is *live* while `now < expiresAt`; it is *expired* at and after `expiresAt`. Expired sessions are removed when they are next looked up. There is no *revoked* state: logout removes the row.

### User (existing)
Unchanged. The login endpoint reads `users.json` through the existing loader and compares the password hash with the existing helper.

## Storage
An in-memory `Map<string, Session>` behind the `SessionStore` interface. Sessions do not survive a restart; this is accepted for F02 and listed as a follow-up in the roadmap (persistent sessions, F05).

## Validation rules
- `id` must match `/^[0-9a-f]{32}$/` before any lookup; anything else is treated as "no session".
- `expiresAt` is never earlier than `createdAt`.
- A refresh never shortens a session.
