# 0024: Retire the Gemini CLI adapter; add Antigravity CLI and Codex CLI adapters

- **Status:** Accepted, 2026-11-09
- **Supersedes:** nothing. [0007](0007-agent-adapters.md) (adapters per CLI, vendor code only in `src/adapters/`) stands; this record changes which CLIs ship as built-in adapters.
- **Requirements affected:** REQ-ADAPT-01, REQ-ADAPT-02, REQ-ADAPT-03, REQ-VAL-04, REQ-NFR-04, assumption A3, question Q1

## Context
orch's second vendor was Gemini CLI, used as the validator so that a model from a different lab checks the worker's code. On 2026-06-18 Google ended Gemini CLI's Google-account sign-in for individuals: the CLI now answers `UNSUPPORTED_CLIENT` and points at Antigravity, Google's successor product, whose terminal CLI is `agy`. The owner's subscription can therefore no longer drive orch's validator, and the `gemini` adapter had never completed a live run (Q1). A `server.json` that still names it would make every validation burn an attempt.

## Decision
- `src/adapters/gemini.ts` and the `gemini` default adapter are removed. A `server.json` that still has an adapter of `type: "gemini"` fails to load with an upgrade error that names the adapter and the two replacements. No alias and no silent remap: a wrong default would spend the owner's money without a decision.
- Two adapters ship instead, both as built-in defaults in `src/config.ts`:
  - `antigravity`: Antigravity CLI (`agy`), `--output-format stream-json --input-format stream-json --dangerously-skip-permissions`, prompt as one NDJSON user event on stdin, resume with `--conversation <id>`.
  - `codex`: OpenAI Codex CLI (`codex exec --json --dangerously-bypass-approvals-and-sandbox -`), prompt on stdin, resume with `codex exec resume <id>`.
- Both leave `costUsd` null (the CLIs report tokens, not money), so their rows show "n/a" as TASK-17 defined.
- The Docker image installs `agy` and `@openai/codex` instead of `@google/gemini-cli`; compose keeps the `gemini-home` volume (Antigravity's settings live under `~/.gemini/antigravity-cli/`, the directory name is Google's) and adds `codex-home`.
- Each new adapter must complete one real task in the image on a subscription login before this record is Accepted; the recorded streams are the unit fixtures in `test/fixtures/adapters/`.

## Alternatives rejected
- **Keep `gemini` as a deprecated alias mapped to `antigravity`.** The CLIs differ in flags, stream and sign-in; an unnoticed remap would run the wrong program with the wrong permissions on the owner's account.
- **Gemini API key instead of the subscription.** It keeps the old CLI alive at per-token prices and does not fix the sign-in; Antigravity offers the same API-key fallback if ever wanted.
- **One new adapter only.** Two vendors besides Claude keep the validator independent of the worker even when one vendor's sign-in breaks again, which is exactly what happened here.

## Consequences
- The vendor regex in `scripts/check-invariants.mjs` also matches `antigravity`, `agy`, `codex` and `openai`; the `src/config.ts` allowlist covers only the new defaults and the retirement error.
- Q1 in `docs/requirements.md` is closed; A3 says "a second adapter" instead of naming Gemini.
- Owners upgrading edit `server.json` once (the error message says how) and sign the CLIs in inside the container (`codex login --device-auth`; `agy` interactively). The user guide documents both.
- The fake agent speaks three dialects (`claude`, `antigravity`, `codex`); e2e runs the planner on Codex and the validator on Antigravity.
