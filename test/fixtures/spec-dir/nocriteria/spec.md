# Feature 004: Health page

## Goal
Operators open one page and see whether the app is up. The page polls the existing `/healthz` endpoint and shows a green or red dot with the last response time. There is nothing else on it.

## Covers
- REQ-OPS-01: a health page that reflects the health endpoint

## Out of scope
- Alerting or history (a later feature).
- Any change to `/healthz` itself.

## Contracts
None: the page only reads the existing endpoint.

## Risky logic
None. The page is a static file and a short script.
