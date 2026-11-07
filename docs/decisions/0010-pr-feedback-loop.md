# 0010: PR feedback loop with a comment trigger and its own round budget

- **Status:** Accepted, 2026-11-07
- **Requirements affected:** REQ-PRFB-01 … REQ-PRFB-07

## Context
After a PR opens, CI failures and review comments previously needed the owner to re-run tasks by hand. orch opens PRs with the owner's own `gh` account, and GitHub forbids requesting changes on your own PR.

## Decision
orch polls open PRs. Auto tasks wait for checks. Failed checks (with log tails) and review feedback go back to the worker as fix rounds. A "changes requested" review or a comment line starting with `/orch` triggers a round; bots never do. Fix rounds have their own limit, separate from attempts. Unsafe situations go to the inbox.

## Alternatives rejected
- **"Changes requested" only.** Never fires in the single-owner setup.
- **Share the attempt budget.** A PR round would steal validation retries.
- **Webhooks.** Needs inbound exposure; polling works behind NAT.

## Consequences
- Built in R1. Decision logic moves into `src/core/prpoll.ts` (TASK-03) without behaviour change.
