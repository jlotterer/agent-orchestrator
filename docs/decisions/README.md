# Decision Records

Short records of significant decisions and **why** they were made. Agents: read the relevant record before proposing a change to the stack or the approach. Never reverse a decision silently. Add a new record that supersedes the old one, and set the old one's status to `Superseded by NNNN`.

| # | Decision | Status |
| :--- | :--- | :--- |
| [0001](0001-deterministic-orchestrator.md) | The orchestrator is deterministic code, not an LLM | Accepted |
| [0002](0002-sqlite-single-source-of-truth.md) | All state lives in SQLite owned by the daemon | Accepted |
| [0003](0003-fresh-context-and-handoff-brief.md) | Fresh context per role invocation, with a bounded hand-off brief | Accepted |
| [0004](0004-independent-validation.md) | A deterministic gate, then an independent validator | Accepted |
| [0005](0005-decisions-and-inbox.md) | Decisions and questions are first-class records; one inbox | Accepted |
| [0006](0006-worktree-branch-pr-per-task.md) | One worktree, one branch, one PR per task; risky work waits for the owner | Accepted |
| [0007](0007-agent-adapters.md) | Adapters per agent CLI; vendor code only in adapters | Accepted; built-in CLIs changed by 0024 |
| [0008](0008-speckit-input-contract.md) | Spec Kit tasks.md is the input contract, not a dependency | Accepted; extended by 0023 |
| [0009](0009-locked-stack.md) | Locked stack: TypeScript, Node ≥ 20, one runtime dependency, no-build dashboard | Node floor superseded by 0022 |
| [0010](0010-pr-feedback-loop.md) | PR feedback loop with a comment trigger and its own round budget | Accepted |
| [0011](0011-multi-project-daemon.md) | One daemon manages many projects | Accepted |
| [0012](0012-global-agent-cap.md) | One unfinished run per project; a global cap on concurrent agents | Accepted |
| [0013](0013-project-config-in-repo.md) | Project settings live in the repo; server settings are separate | Accepted |
| [0014](0014-bearer-token-auth.md) | Bearer-token authentication; refuse insecure binds | Accepted |
| [0015](0015-phase-validation-fixups.md) | Phase validation creates fix-up tasks automatically | Accepted |
| [0016](0016-ui-validation-app-lifecycle.md) | UI validation: orch manages the app under test | Accepted |
| [0017](0017-file-ownership.md) | File ownership: auto-serialize overlaps; advisory scope findings | Accepted |
| [0018](0018-hand-rolled-diff-viewer.md) | Hand-rolled diff viewer in the dashboard | Accepted |
| [0019](0019-event-archive-retention.md) | Archive event logs to compressed files, then delete | Accepted |
| [0020](0020-pure-core-and-fixtures.md) | Pure decision functions pinned by owner-reviewed fixtures | Accepted |
| [0021](0021-docs-split-and-dogfooding.md) | Split the handoff doc; orch builds its own roadmap | Accepted |
| [0022](0022-node-22-floor.md) | Raise the Node floor to 22 (better-sqlite3 13 needs it) | Accepted |
| [0023](0023-orch-owns-spec-skill.md) | orch owns its spec skill (`orch-spec`); Spec Kit remains a compatible import | Accepted |
| [0024](0024-retire-gemini-add-antigravity-codex.md) | Retire the Gemini CLI adapter (Google ended its individual sign-in); add Antigravity CLI and Codex CLI adapters | Accepted |
| [0025](0025-dashboard-sign-in.md) | The dashboard signs the agent CLIs in by driving their own login flows; orch holds no tokens | Accepted |
| [0026](0026-settings-schema-and-forms.md) | Settings stay in two files; one schema drives the loaders' defaults, the forms and the documented table | Accepted |

New records use [the template](#template).

## Template
```markdown
# NNNN: <Decision title>
- **Status:** Proposed | Accepted | Superseded by NNNN, <date>
- **Requirements affected:** REQ-…
## Context
## Decision
## Alternatives rejected
## Consequences
```
