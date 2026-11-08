# Contract: auth HTTP API

Routes added by this feature. Every response is JSON unless noted. The cookie is named `sid`, `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` when the request came over HTTPS.

| Method | Path | Body | Success | Failure |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/login` | – | 200, HTML login page | – |
| POST | `/api/login` | `{ "user": string, "password": string }` | 204, sets `sid` | 401 `{ "error": "invalid credentials" }` |
| POST | `/api/logout` | – | 204, clears `sid` | 401 when no valid session |
| GET | `/api/me` | – | 200 `{ "userId": string, "expiresAt": number }` | 401 `{ "error": "not signed in" }` |

Rules:
- A 401 never says whether the user exists.
- `POST /api/login` with a malformed body is 400 `{ "error": "bad request" }`.
- The middleware (T004) answers 401 for every route that is not in the public list: `/login`, `/api/login`, `/healthz`, and anything under `/static/`.
- `expiresAt` in `/api/me` reflects a refresh performed by the same request (T004 calls T003's `refreshIfDue` before the handler runs), so a client can read the new deadline.
