# Track cost and agent time

orch shows what each task, run and project cost, in money where the agent program reports it, and in agent time. It shows cost only. It doesn't enforce spending limits.

## See costs in the dashboard

- In the top bar, the cost and time tile shows the totals for the selected run and project, for example **Run $0.42 · 6m 10s  Project $3.17 · 1h 2m**.
- In the **Task** panel, the **Cost** row shows the task's own cost and agent time.

A cost that no agent program reported shows "n/a", not $0. For example, Claude Code reports a cost for each session, but Gemini CLI doesn't, so a run whose planner and validators use Gemini CLI shows agent time for them but no cost. Agent time is always counted.

## How totals add up

- A task's total includes all of its worker and validator sessions, across every attempt and fix round, including a session you stopped.
- A run's total adds the planner and phase validator sessions to the totals of its tasks.
- A project's total is the sum of its runs.

Totals are stored with each task and run, so archiving old activity logs never changes them.

orch shows the cost figure that the agent program reports. It doesn't calculate prices itself, so check your agent vendor's billing for what you pay.
