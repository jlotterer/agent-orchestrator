# Write specs with the orch-spec skill

The `orch-spec` skill writes exactly what orch reads. You run one interview per project and one per feature. orch then builds the plan from the skill's task briefs without calling an agent, gives every worker and validator a complete brief, and tells you what to bring back into your documents when the run finishes.

The whole process has four steps:

```text
/orch-spec (project mode)    →  project record: requirements, architecture, decisions, rules, roadmap
/orch-spec (feature mode)    →  specs/NNN-name/: spec.md, tasks.md, tasks/T00N.md briefs
orch plan → approve → start  →  one pull request per task; validators check the brief and the rules
/orch-spec (fold-back mode)  →  requirement statuses, decision records, architecture, briefs
```

If you already have a GitHub Spec Kit folder, see [Import a Spec Kit folder](import-a-spec-kit-folder.md) instead.

## Before you start

- Install orch and an agent program it supports. See [Install orch](../install.md).
- Use Claude Code to run the skill. Other agent programs can read the files the skill writes, because they're plain Markdown, but only Claude Code runs the skill itself.
- Install the skill once per machine. It ships with orch in `skills/orch-spec/`. Link or copy it into your Claude Code skills folder:

  ```bash
  # link, so it follows updates when you pull orch
  ln -s ~/orch/skills/orch-spec ~/.claude/skills/orch-spec
  # or copy
  cp -r ~/orch/skills/orch-spec ~/.claude/skills/orch-spec
  ```

  On Windows, in PowerShell: `New-Item -ItemType Junction -Path "$HOME\.claude\skills\orch-spec" -Target "$HOME\orch\skills\orch-spec"`. The skill's scripts need Node.js 22 or later, which orch needs anyway.

## Step 1: Create the project record

Do this once per project, in the project's repository (run `git init` first if it's new).

1. Start Claude Code in the repository and invoke the skill with a short description of the project:

   ```text
   /orch-spec New project. <Idea in two or three sentences.> Users: <who>. Core job: <one sentence>.
   Not in scope: <list>. Stack: <stack and versions>, test command: <command>.
   Riskiest part: <logic>.
   ```

2. Answer the interview. The skill reads the repository first, then asks up to four questions at a time.

   - **Non-goals are the most valuable answers you give.** Agents add scope you didn't ask for. Every non-goal becomes a rule that validators enforce.
   - **Answer the "why" questions properly.** Each decision record is quoted to agents later as the reason not to change something.
   - **Say "help me decide"** when you don't know. The skill recommends an option and records the alternatives it rejected.
   - **Read `REQUIREMENTS.draft.md` between rounds.** It's the skill's memory of the interview. Edit it directly when something is wrong.

3. Review the files the skill writes and commit them to the base branch:

   | File | Contents |
   | :--- | :--- |
   | `AGENTS.md` | Project rules every agent must follow: stack, banned dependencies and patterns, conventions, test command, definition of done. orch gives this file to every agent and validators enforce it. |
   | `CLAUDE.md` | A map of the documents plus "follow AGENTS.md". If the file exists, the skill merges into it instead of overwriting it. |
   | `docs/requirements.md` | Objective, users, non-goals, `REQ-<DOMAIN>-NN` tables with a status column, Given/When/Then acceptance criteria, edge cases and a glossary. |
   | `docs/architecture.md` | Components, data model, contracts, settings, errors and testing approach. |
   | `docs/decisions/` | One record per significant decision: context, decision, rejected alternatives and consequences. |
   | `docs/roadmap.md` | Features F01, F02 and so on, in order, with the requirement IDs each covers and what each depends on. F01 is always the walking skeleton: layout, test command and CI. |

The skill checks its own work with `skills/orch-spec/scripts/check-project.mjs`, which reports broken links, duplicate requirement IDs and requirements no roadmap feature covers.

## Step 2: Specify a feature

Do this once per feature, in order of the roadmap.

1. Invoke the skill with the feature:

   ```text
   /orch-spec Feature F02 from docs/roadmap.md.
   ```

2. Answer the interview. The skill reads the project record and asks only about the feature: the exact behaviour behind each requirement it covers, the interfaces more than one task shares, edge cases, and what stays out.

3. The skill writes the feature folder, for example `specs/002-session-auth/`:

   | File | Contents |
   | :--- | :--- |
   | `spec.md` | Goal, **Covers** (requirement IDs), **Out of scope**, **Contracts** (every interface two or more tasks share: signatures, routes, schemas, file formats) and **Risky logic**. |
   | `tasks.md` | One line per task in the format orch has always read, such as `- [ ] T003 [P] Session refresh near expiry`. `##` headings are phases. See [Task file format](../reference/tasks-file.md). |
   | `tasks/T00N.md` | One self-contained brief per task. Its frontmatter sets the task's requirements, dependencies, parallel flag, merge policy, validation mode and test command. Its sections hold the goal, acceptance criteria, target files and the contracts it uses. |

   The skill applies orch's rules without being asked, and tells you which ones shaped the result:

   - Tests ship in the same task as the code they test, and no task ends with failing tests, because orch merges a task only after its test command passes. A fixtures-first task adds fixtures with skipped tests, and the tasks that implement the logic turn them on.
   - Tasks are marked parallel (`[P]`) only when they share no target files.
   - Each task is one reviewable pull request.
   - Every brief cites its requirement IDs, and every MUST requirement the feature covers appears in at least one brief.
   - Briefs stay under 8,000 characters, so nothing is cut when orch builds the worker's context.
   - Nothing is left as `TBD`, `TODO` or `[NEEDS CLARIFICATION]`. Open questions are asked in the interview instead.

4. The skill then runs its check script and fixes what it reports. You can run it yourself at any time. It prints nothing and exits with code 0 when the folder is clean:

   ```text
   $ node ~/orch/skills/orch-spec/scripts/check-feature.mjs specs/002-session-auth
   $ echo $?
   0
   ```

   Otherwise it prints one `file:line: message` line per problem. orch runs the same checks when you plan.

5. Commit the folder to the base branch.

## Step 3: Run the feature with orch

1. If the project isn't registered yet, register it, and set its test command in `validation.command` in the repository's `orch.config.json`. See [Add and manage projects](manage-projects.md) and [Project settings](../reference/project-settings.md).

   ```bash
   orch project add ~/projects/shop
   ```

2. Preview the plan. The preview shows each task, the brief orch found for it and the fields the brief sets, the dependencies, and the folder checks. It doesn't create a run or call an agent.

   ```text
   $ orch plan specs/002-session-auth --dry-run
   dry run: "Feature 002: Session authentication" (/home/you/projects/shop/specs/002-session-auth) for project shop: 4 tasks; nothing was created

   Phase 1: Foundation
     [ ]     T001  Session store, types and expiry fixtures
               brief: tasks/T001.md (fields: depends_on, parallel, merge_policy, validate_mode, files_owned, acceptance)
               depends on: none

   Phase 2: Core
     [ ] [P] T002  Login and logout endpoints with the login page
               brief: tasks/T002.md (fields: depends_on, parallel, merge_policy, validate_mode, validate_cmd, files_owned, acceptance)
               depends on: T001
     [ ] [P] T003  Session refresh near expiry
               brief: tasks/T003.md (fields: depends_on, parallel, merge_policy, validate_mode, validate_cmd, files_owned, acceptance)
               depends on: T001
     [ ]     T004  Auth middleware for protected routes
               brief: tasks/T004.md (fields: depends_on, parallel, merge_policy, validate_mode, files_owned, acceptance)
               depends on: T001, T002, T003

   conflicts (the brief wins; each is recorded as a decision at plan time):
     T004: tasks.md marks [P] but the brief says parallel: false; the brief wins

   checks: no problems
   ```

   When a brief disagrees with a `[P]` marker in `tasks.md`, the brief wins and the preview lists the difference under `conflicts`. For each problem the checks can report, see [Folder checks](plan-a-feature.md#folder-checks).

3. Plan the feature. When every task has a brief with acceptance criteria, orch builds the plan from the briefs. No agent runs, so planning is instant, free and repeatable:

   ```text
   $ orch plan specs/002-session-auth
   importing tasks into shop (plan built from the briefs; no planner)…
   run dab25f18 "Feature 002: Session authentication" → plan_pending. Review the plan in the dashboard, then: orch approve
   ```

   The planner runs only for tasks without criteria in a brief. To have the planner review the whole plan anyway, add `--review`. It may add criteria and correct dependencies, but it never removes or rewrites a brief's criteria, and each change is recorded as a decision.

4. In the dashboard's **Plan** tab, check the plan. You can still edit a task's criteria, dependencies or merge policy there. Those edits are stored in orch, not in the brief; Step 4 carries them back. Then select **Approve plan** and **Start**. See [Review and approve a plan](review-a-plan.md).

5. Answer **Inbox** items as they arrive. See [Work with the inbox](work-with-the-inbox.md).

Each worker gets its brief, the requirement rows it cites (from `docs/requirements.md`), the contracts it names, `AGENTS.md`, and the hand-off of earlier work, each within its own size limit. The validator gets the same brief, requirements, contracts and rules, never the worker's conversation, and rejects a change that breaks a rule or a contract, quoting it. See [What agents see and do](../reference/agents.md).

## Step 4: Bring the results back into your documents

Do this after each run. **If you skip it, the project record goes stale.** After a few features, new specs contradict old ones and nothing notices.

1. When the run finishes, the inbox shows **Update project docs**. It lists the requirement IDs the merged tasks covered, the decisions recorded during the run, the plan edits you made in the dashboard, and the contracts the merged tasks named. Select **Copy**, or run `orch docs-update` to print the same text.
2. In Claude Code, run the skill's fold-back mode and paste the text:

   ```text
   /orch-spec Fold back feature F02. <paste the inbox item>
   ```

   The skill sets those requirements to `built`, writes decision records for decisions that matter beyond this feature (and marks the ones they replace as superseded), carries your dashboard plan edits into the briefs, updates `docs/architecture.md` where a contract changed, updates `AGENTS.md` if a rule changed, and marks the roadmap feature as built.
3. Review and commit the changes on the base branch.
4. In the inbox, select **Acknowledge**, or run `orch docs-update --ack`.

Then go back to [Step 2](#step-2-specify-a-feature) for the next feature.

## Related pages

- [Import a Spec Kit folder](import-a-spec-kit-folder.md)
- [Plan a feature](plan-a-feature.md)
- [Update the project docs after a run](work-with-the-inbox.md#update-the-project-docs-after-a-run)
- [Worker context settings](../reference/project-settings.md#worker-context-handoff)
- [skills/README.md](../../../skills/README.md): the skill's modes and scripts in brief
