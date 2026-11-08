# Track cost and agent time

> [!NOTE]
> **Planned.** Cost and agent time tracking isn't in the current release. This page describes how it will work.

orch shows what each task, run and project cost, in money where the agent program reports it, and in agent time. It shows cost only. It doesn't enforce spending limits.

## See costs in the dashboard

- In the top bar, a cost and time tile shows the totals for the selected run and project.
- In the **Task** panel, each task shows its own cost and agent time.

Values that the agent program doesn't report show "n/a". For example, Claude Code reports a cost for each session, but some other agent programs don't.

## How totals add up

- A task's total includes all of its worker and validator sessions, across every attempt and fix round.
- A run's total adds the planner and phase validator sessions to the totals of its tasks.
- A project's total is the sum of its runs.

Totals are stored with each task and run, so archiving old activity logs never changes them.

orch shows the cost figure that the agent program reports. It doesn't calculate prices itself, so check your agent vendor's billing for what you pay.
