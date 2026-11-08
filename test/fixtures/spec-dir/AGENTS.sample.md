# Sample app: agent rules

Rules every agent follows in this repository. orch passes this file to the planner, workers and validators as the project rules part of their context (`handoff.projectFiles`).

- Stack: TypeScript strict, Node 22, `node:test`. No new runtime dependencies without a decision record.
- Time is passed in: no module under `src/auth/` reads the clock.
- Tests ship in the same task as the code they test; a task never ends with failing tests.
- Never log a cookie value, a session id or a password.
- Definition of done: `npm run typecheck && npm test` pass; docs updated in the same PR when behaviour or contracts changed.
