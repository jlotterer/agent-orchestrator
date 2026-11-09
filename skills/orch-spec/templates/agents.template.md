<!--
Template notes (do not copy into the output):
- AGENTS.md is the project rules file orch hands to every planner, worker, task validator and phase validator
  (handoff.projectFiles; budget handoff.rulesChars, 6,000 characters). Validators reject a change that breaks a
  rule here and quote it, so write rules as checkable statements, not advice.
- Vendor-neutral: no agent or model names. CLAUDE.md (or another vendor file) points here.
- Keep it under 6,000 characters. Point to docs for detail; never repeat them.
- Every non-goal from the interview becomes a rule here, because agents add scope you did not ask for.
-->
# <Project Name>: Rules for agents

Read this before changing anything. Your task brief says what to build; this file says how every change in this repository is made. A validator checks your change against both.

## Stack (locked; see [docs/decisions/](docs/decisions/))
- <runtime / language / version range>
- <framework or UI, with the version range>
- <persistence>
- <test framework; lint and format tools>

## Commands
- Install: `<cmd>`
- Test: `<cmd>` (the gate every task must pass before merge)
- Lint / typecheck: `<cmd>`
- Run: `<cmd>`

## Rules
1. Tests ship in the same change as the code they test. A change never leaves a failing or disabled test behind, except a fixtures-first task whose brief says which task un-skips them.
2. Stay inside your brief's target files. A change outside them is raised in the PR description, not made.
3. <layering rule, e.g. "`src/core/` is pure: no file system, network, clock or database access; facts are passed in">
4. <layout rule, e.g. "one module per domain under `src/<domain>/`; tests mirror it under `test/<domain>/`">
5. <style rule, e.g. "strict types; the formatter decides layout; no lint suppressions without a comment naming the reason">
6. Secrets never enter the repository, logs or fixtures.
7. Do not reverse a decision record. Propose a new record in the PR instead.

## Banned
- <library or pattern>: <reason, or the decision record>
- New runtime dependencies without a decision record.

## Non-goals (do not build these, even if they seem helpful)
- <non-goal from the interview, and why>

## Definition of done
- `<test cmd>` and `<lint cmd>` pass.
- Every acceptance criterion in the brief has an automated test, or the brief marks it as a manual step.
- Nothing in **Banned** or **Non-goals** was introduced.
- Docs under `docs/` are updated in the same change when behaviour, contracts or defaults changed.
