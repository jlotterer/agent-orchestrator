# Contract: auth HTTP API

| Method | Path | Body | Success | Failure |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/login` | – | 200, HTML login page | – |
| POST | `/api/login` | `{ "user": string, "password": string }` | 204, sets `sid` | 401 `{ "error": "invalid credentials" }` |
| POST | `/api/logout` | – | 204, clears `sid` | 401 when no valid session |
| GET | `/api/me` | – | 200 `{ "userId": string, "expiresAt": number }` | 401 `{ "error": "not signed in" }` |

Rules:
- A 401 never says whether the user exists.
- The middleware (T004) answers 401 for every route that is not in the public list: `/login`, `/api/login`, `/healthz`, and anything under `/static/`.
