# Contract: auth endpoints

| Method | Path | Request | Response |
| :--- | :--- | :--- | :--- |
| GET | `/login` | – | 200 HTML form with `user` and `password` fields |
| POST | `/api/login` | `{ "user": string, "password": string }` | 204 + `Set-Cookie: sid=…; HttpOnly; SameSite=Lax; Path=/` or 401 `{ "error": "invalid credentials" }` |
| POST | `/api/logout` | – | 204 + cleared cookie, or 401 when there is no valid session |
| GET | `/api/me` | – | 200 `{ "userId", "expiresAt" }` or 401 `{ "error": "not signed in" }` |

Protected routes are every route except `/login`, `/api/login`, `/healthz` and `/static/*`. The 401 body is always `{ "error": "not signed in" }`.
