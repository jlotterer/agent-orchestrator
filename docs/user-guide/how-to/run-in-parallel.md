# Run tasks in parallel

By default, orch runs one task at a time per project. Once you trust a feature's dependency graph, you can let it run several tasks at once. Two limits control this: one per project and one for the whole server.

## Raise a project's parallel limit

`scheduler.maxParallel` sets how many tasks of one project run at the same time. The default is `1`, which means one task after another.

1. In the project's `orch.config.json`, set:

   ```json
   "scheduler": { "maxParallel": 2 }
   ```

2. Save the file. The setting applies from the next run you plan or start.

orch then runs up to two tasks at once when their dependencies allow it. Each task has its own working copy and branch, so they don't see each other's uncommitted changes. Merges into the same repo still happen one at a time.

## Set the global agent limit

All projects share your agent subscription, so the server has one more limit: `scheduler.maxAgents` in `~/.orch/server.json`. It caps the number of agent sessions running at once across all projects. Workers, validators and planners all count. The default is `2`. Set it to `1` to run strictly one agent at a time.

1. In `~/.orch/server.json`, set:

   ```json
   "scheduler": { "maxAgents": 3 }
   ```

2. Restart orch.

When an answered question lets a paused worker continue, orch resumes it even if that briefly goes over the limit, because that worker already held a slot.

## How orch shares slots between projects

When slots are scarce, the project that started a task least recently goes next. One busy project can't keep another one waiting indefinitely. For example, with `maxAgents` set to `1`, project A with five ready tasks and project B with one, B's task starts before A's third task.

## Keep parallel tasks apart

The usual problem with parallel tasks is two of them changing the same file, which causes a merge conflict. To avoid that:

- Mark tasks `[P]` in `tasks.md` only when they touch different files. The planner also tries to keep `[P]` tasks apart.
- If you see conflicts, add a dependency between the tasks in the **Plan** tab. See [Review and approve a plan](review-a-plan.md#edit-a-task).

The validator also catches a bad merge, because it runs the tests on the combined result.

### Owned files

**Planned.** Each task can list the files or folders it owns, such as `src/auth/**` or `src/auth/login.ts`. The planner proposes them, and you can edit them in the plan.

orch never runs two tasks of the same project at the same time when their owned files overlap, even if both are ready. When it holds a task back for this reason, it records a decision that names both tasks. The **Plan** tab shows the resulting order.

orch compares the fixed part of each path, up to the first wildcard. `src/auth/**` and `src/auth/login.ts` overlap, while `src/auth/**` and `src/billing/**` don't. This is cautious on purpose: it can hold back two tasks that wouldn't have collided, but it never runs two that would. A task without owned files isn't restricted.

The validator also reports any changes a task made outside its owned files, as a finding in its verdict. Such changes don't fail the task by themselves.
