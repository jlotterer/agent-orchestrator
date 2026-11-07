# orch.

An orchestrator / worker / validator runner for Claude Code, with a live dashboard.

You write a spec with GitHub Spec Kit. `orch` turns its `tasks.md` into a plan, runs each task
in its own git worktree with a **fresh-context worker**, checks the result with an **independent
validator**, opens the PR, merges it, and moves on. Every decision an agent makes is logged.
Anything that needs *you* lands in an inbox and pings your phone.

```
spec.md / plan.md / tasks.md  ──►  orch plan  ──►  [you approve]  ──►  orch run
                                                                        │
                      ┌─────────────────────────────────────────────────┘
                      ▼
          for each task (respecting dependencies, N in parallel):
          worktree ─► worker (fresh context + hand-off brief) ─► commit
                   ─► validation command (deterministic gate)
                   ─► validator agent (fresh context, PASS/FAIL with evidence)
                   ─► PR ─► merge (auto, or wait for you) ─► tick tasks.md ─► next
```

## Why it looks like this

* **Fresh context per task.** Each worker starts clean. What it needs from earlier tasks arrives as
  a short hand-off brief the orchestrator writes from the previous workers' summaries, the
  decisions log, and your answers. Nothing depends on a single long session staying coherent.
* **Validation is a different agent.** The validator never sees the worker's reasoning, only the
  task, the acceptance criteria and the diff. It runs the tests itself and must cite evidence per
  criterion. Set `agent.validatorModel` to a different model for a second opinion.
* **The orchestrator is code, not a model.** It only calls an LLM for two things: drafting the plan
  and nothing else. Scheduling, retries, git and merges are deterministic and inspectable.
* **Decisions are first-class.** Agents run `orch decide "..." --why "..."` when they make a
  judgement call. Blocking ambiguity is `orch ask "..." --options "A,B"`; the task pauses, you
  answer from the dashboard or phone, and the worker resumes *its own session* with the answer.

## Install

Requirements: Node 20+, git, [Claude Code](https://docs.claude.com/en/docs/claude-code) logged in,
and `gh` (GitHub CLI) if you want PRs. Linux or WSL2.

```bash
git clone <this repo> ~/orch && cd ~/orch
npm install && npm run build
npm link            # puts `orch` on your PATH (optional; agents get it automatically)
```

## Set up a project

```bash
cd ~/projects/myapp
orch init           # writes orch.config.json
```

Edit `orch.config.json`:

| key | what |
|---|---|
| `repo` | path to the git repo (`.`) |
| `baseBranch` | branch to branch from and merge into (`main`) |
| `validation.command` | the deterministic gate run in every worktree before the validator (`npm test`, `pytest`, …) |
| `scheduler.maxParallel` | `1` = sequential. Raise it once you trust the dependency graph |
| `scheduler.maxAttempts` | worker attempts before a task goes to your inbox (`2`) |
| `git.pr` | `true` = push + `gh pr create` + `gh pr merge`; `false` = merge locally, no GitHub needed |
| `git.mergePolicy` | default `auto` (merge when validated) or `manual` (wait for you). The planner marks risky tasks `manual` on its own |
| `git.feedback` | PR mode only: wait for CI before auto-merging, and send CI failures and `/orch` review comments back to the worker. See [Merging](#merging) |
| `git.copyFiles` / `git.setupCommand` | e.g. `[".env"]` and `npm ci` for each new worktree |
| `agents.roles.{planner,worker,validator}` | which adapter and model each role uses, e.g. `{"adapter": "gemini", "model": "pro"}` for the validator |
| `agents.adapters.claude.extraArgs` | defaults to `--permission-mode bypassPermissions`. Tighten with `--allowedTools` if you prefer |
| `agents.adapters.gemini.extraArgs` | defaults to `--yolo --skip-trust` (both required for headless runs in a worktree) |
| `notify.ntfyUrl` | `https://ntfy.sh/<your-topic>` for push notifications |
| `publicUrl` | what the notification links to, e.g. `http://my-server:4800` |

Add `.orch/` to `.gitignore`.

Start the daemon:

```bash
orch serve          # dashboard on http://<host>:4800
```

For a server, use the included `orch.service` (systemd):

```bash
sed "s#WORKDIR#$PWD#; s#ORCHBIN#$(which orch)#; s#USER#$USER#" ~/orch/orch.service | sudo tee /etc/systemd/system/orch.service
sudo systemctl enable --now orch
```

## Daily use

1. Write the spec with Spec Kit as usual: `/speckit.specify`, `/speckit.plan`, `/speckit.tasks`.
   You end up with `specs/003-thing/{spec.md,plan.md,tasks.md}`.
2. `orch plan specs/003-thing` (or **New plan…** in the dashboard). The planner reads the spec,
   writes acceptance criteria for every task, checks the dependency graph, flags risky tasks as
   manual-merge, and logs its decisions. If something in the spec is ambiguous enough to matter it
   asks instead of guessing.
3. Open the dashboard. **Plan** tab: read the acceptance criteria, click any task to edit them,
   its dependencies or merge policy. **Approve plan**.
4. **Start**. Watch the **Board** or walk away. Your phone buzzes when:
   * a worker asks a question → answer with one tap or a sentence
   * a task fails after its retries → inspect the log, retry or skip
   * a manual-merge task is validated → review the PR, **Merge now** (or comment `/orch …` on the PR to send it back)
   * a PR's CI keeps failing, or its checks hang → look at the PR
   * the run finishes
5. **Decisions** tab is the audit trail: every planner, worker, validator and human decision with
   its rationale, in order. **Activity** is the run-level event stream.

CLI equivalents: `orch status`, `orch approve`, `orch run|pause|stop`, `orch answer <id> <text>`,
`orch retry|skip|merge T003`.

### Task files

`orch` reads Spec Kit's `tasks.md` format:

```markdown
## Phase 2: Core
- [ ] T003 [P] Implement POST /auth/signup in src/routes/auth.ts
- [ ] T004 [P] Implement POST /auth/login
- [ ] T005 Add auth middleware (depends on T004)
```

Rules: tasks depend on every task in earlier phases; a task without `[P]` also depends on the
previous task in its phase; "depends on T00X" in the text adds an edge. The planner can override
all of this, and so can you in the dashboard. Already-ticked tasks (`- [x]`) are imported as done.
Any markdown file that follows the `- [ ] T001 …` convention works, Spec Kit or not.

### What the agents see

* **Worker**: the task, acceptance criteria, `plan.md` + `spec.md` (capped by `handoff.specChars`),
  the hand-off brief, and any feedback from a failed attempt. Prompt: `prompts/worker.md`.
* **Validator**: the task, criteria, the worker's summary (as claims to check), the diff. It runs the
  checks itself. Prompt: `prompts/validator.md`.
* **Planner**: all spec files plus the parsed task list. Prompt: `prompts/planner.md`.

Override any prompt by copying it to `<repo>/.orch/prompts/<name>.md`.

### Retries and context

A failed attempt (gate, validator, or worker-reported failure) re-runs the worker with the feedback.
With `scheduler.resumeOnRetry: true` (default) it resumes the same Claude session so it keeps what it
learned; set it to `false` for a clean start each time. Answering a question never consumes an
attempt. "Re-run from scratch" in the dashboard resets attempts and starts fresh in the same
worktree.

### Merging

* `git.pr: true`: push, `gh pr create`, wait for the PR's checks (auto), then
  `gh pr merge --squash --delete-branch`; or wait in the inbox (manual). If the merge fails
  (conflict, required checks, auth) the task goes to the inbox as **merge needs you**; fix it on
  GitHub and click **Merged elsewhere**, or **Re-run**.
* `git.pr: false`: rebases the task branch and squash-merges into `baseBranch` locally. Needs
  `baseBranch` checked out and clean in the repo. Good for a server that is the only writer.

#### The PR feedback loop (`git.feedback`, PR mode)

While a task's PR is open, orch polls it every `pollSeconds` (default 60):

* **CI fails** → the failed checks and the tail of their GitHub Actions logs go back to the worker
  as feedback. The worker resumes its own session, fixes and commits; orch re-runs the gate and the
  validator, pushes, and waits for CI again. Auto tasks sit in the **Waiting on CI** lane meanwhile
  and merge only once checks pass (`waitForChecks`).
* **A reviewer wants changes** → a "Request changes" review, or any PR comment with a line that
  starts with `/orch` (`trigger`), sends every new human comment since the last round, including
  inline `file:line` comments, back to the worker the same way. Use `/orch` on your own PRs:
  GitHub doesn't let a PR's author request changes, and orch opens PRs with your `gh` account.
  Comments from bots (`[bot]` logins, `ignoreAuthors`) never trigger a round.
* **Merged or closed on GitHub** → orch notices: merged marks the task done, closed marks it failed.

Fix rounds have their own budget (`maxRounds`, default 3); each round gets the full
`maxAttempts` for validation. The task goes to your inbox instead of running another round when
the rounds are used up, when a round produces no new commits, when checks stay pending past
`checksTimeoutMinutes`, when "changes requested" is still open after a fix (an auto task waits for
you rather than merging over a reviewer), or when someone pushed commits to the PR branch that
conflict with orch's local branch. Commits that only add to the branch (e.g. applied suggestions)
are pulled in before the next round. Every round is logged in the **Decisions** tab.

If a PR has no checks at all, orch waits `noChecksGraceSeconds` (90) after each push for CI to
show up, then merges. Set `feedback.enabled: false` to merge right after the PR is created.

After a merge, the task is ticked in `tasks.md` on the base branch (committed in local mode; left
as a working-tree change in PR mode so you can commit it with your next push).

### Parallelism

`scheduler.maxParallel: 2` runs two tasks at once when the dependency graph allows it. Each has its
own worktree and branch; merges are serialized. The usual failure mode is two parallel tasks
editing the same file; the planner tries to keep `[P]` tasks file-disjoint, and the validator will
catch a bad merge, but if you see conflicts, add dependency edges in the Plan tab.

## Mixing agents (Claude for coding, Gemini for validation)

Each role runs through an *adapter*: a small module that knows how to launch one agent CLI
headlessly and how to read its event stream. Two ship today:

| adapter | CLI | invocation | resume |
|---|---|---|---|
| `claude` | Claude Code | `claude -p --output-format stream-json --verbose` | `--resume <session>` |
| `gemini` | Gemini CLI | `gemini -p … --output-format stream-json --yolo --skip-trust` | `--resume <session>` |

Pick per role in `orch.config.json`:

```json
"agents": {
  "roles": {
    "planner":   { "adapter": "claude", "model": "" },
    "worker":    { "adapter": "claude", "model": "" },
    "validator": { "adapter": "gemini", "model": "pro" }
  }
}
```

The validator is the natural place for a second vendor: it only reads the diff and runs tests,
and a model from a different lab shares fewer blind spots with the worker than another Claude
model does. Workers are better left on Claude Code, since that is the harness your skills,
hooks and `CLAUDE.md` are written for. Gemini CLI authenticates on its own (`gemini` once
interactively, or `GEMINI_API_KEY` in `agents.adapters.gemini.env`).

Everything downstream of the adapter is shared: the prompts, the JSON contract at the end of
each agent's final message, `orch decide` / `orch ask`, retries, resume, and the dashboard log.
Adding another CLI (Codex, OpenCode, …) means one file in `src/adapters/` implementing
`launch()` and `parseLine()`; see `src/adapters/gemini.ts` for the shape.

Status: the Claude adapter is exercised end to end against the real CLI. The Gemini adapter is
written against Gemini CLI 0.67's stream-json event schema (read from the CLI source) and
tested with a fake agent that speaks that dialect, but it has not yet been run against a live
Gemini account here. Expect to tune `prompts/validator.md` slightly for Gemini's style on the
first few runs; the JSON extractor is forgiving (last fenced block, else last object).

## Testing

```bash
npm run build && npm run test:unit && npm run test:e2e
```

`scripts/e2e.mjs` runs the whole loop against a fake agent (`scripts/fake-agent.mjs`) in a throwaway
repo, with workers on the Claude adapter and the validator on the Gemini adapter: planning,
approval, two parallel workers, a question answered mid-task with session resume, a gate failure
retried, a validator rejection retried, a manual-merge approval, and tasks.md ticked on main.

`scripts/e2e-pr.mjs` runs PR mode against a fake `gh` (`scripts/fake-gh.mjs`) and a local bare
`origin`: a CI failure fed back and fixed before auto-merge, a `/orch` review comment fixed before a
manual merge (with a bot comment that must be ignored), and a PR merged by hand on "GitHub".

The e2e tests need Linux or macOS (they spawn `.mjs` files and `sh`). On Windows, run them in a
container: `docker run --rm -v "$PWD:/src" -w /src node:22 sh -c "npm ci && npm run build && npm run test:e2e"`.

## Layout

```
src/orchestrator.ts   state machine: plan → approve → run → validate → merge; questions, decisions, retries
src/adapters/         one adapter per agent CLI (claude.ts, gemini.ts) + the shared process runner
src/git.ts            worktrees, diffs, push, gh pr create/merge/view, CI logs, local merge
src/prfeedback.ts     PR feedback loop helpers: check verdicts, review comments, worker feedback text
src/speckit.ts        tasks.md parser and ticker
src/db.ts             SQLite: runs, tasks, events, decisions, questions
src/server.ts         REST + SSE, serves the dashboard
src/cli.ts            `orch` (human commands and the agent-facing decide/ask)
prompts/*.md          the three role prompts
dashboard/index.html  the UI, no build step
```

## Safety notes

Workers run headless with `--permission-mode bypassPermissions` inside their worktree. That is the
point of the tool, but it means a worker can run anything your user can. Run the daemon as a
low-privilege user on a machine you don't mind an agent working in, keep secrets out of
`git.copyFiles` unless the task needs them, and use `--allowedTools` in `agent.extraArgs` if you
want a tighter leash. Manual merge policy is your other lever: the planner already uses it for auth,
migrations, billing and irreversible changes.
