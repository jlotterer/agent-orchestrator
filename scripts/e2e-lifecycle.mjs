#!/usr/bin/env node
/**
 * Regression e2e for the built task lifecycle (TASK-04). Each scenario gets its own throwaway repo,
 * daemon and port, and runs independently of the others:
 *   (a) stop mid-task            (b) kill -9 + restart        (c) agent timeout
 *   (d) failing setup command    (e) worker makes no commits  (f) plan without tasks.md
 *   (g) planner fails            (h) answer while paused      (i) dirty main checkout at merge
 *   (j) merge conflict           (k) skipped dependency       (l) answer twice
 *   (m) edit criteria before approval
 *
 *   node scripts/e2e-lifecycle.mjs          # all scenarios
 *   node scripts/e2e-lifecycle.mjs b h      # only (b) and (h)
 *
 * A scenario may carry `todo: "<reason>"` to be listed but not run (TASK-04 "Done when").
 */
import fs from "node:fs";
import path from "node:path";
import { makeRepo, writeConfig, startDaemon, api as apiFor, waitFor, cleanup, sleep, FAKE_AGENT } from "./lib/e2e.mjs";

const BASE_PORT = 4821;
const CHECK_SH = "#!/bin/sh\nfor f in impl/*.txt; do [ -f \"$f\" ] || continue; grep -q OK \"$f\" || { echo \"$f is not OK\"; exit 1; }; done\necho checks passed\n";
const SPEC = "specs/001-life";

// ------------------------------------------------------------------ helpers
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const merge = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b ?? {})) o[k] = isObj(v) && isObj(a[k]) ? merge(a[k], v) : v; return o; };
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

function baseConfig(port) {
  return {
    repo: ".", baseBranch: "main", worktreeDir: "../wt", dbPath: ".orch/orch.db", port, publicUrl: `http://localhost:${port}`,
    agents: {
      timeoutMinutes: 2,
      adapters: { claude: { type: "claude", command: FAKE_AGENT, extraArgs: [], env: {} } },
      roles: { planner: { adapter: "claude", model: "" }, worker: { adapter: "claude", model: "" }, validator: { adapter: "claude", model: "" } },
    },
    scheduler: { maxParallel: 2, tickSeconds: 1, maxAttempts: 2, resumeOnRetry: true },
    validation: { command: "sh check.sh", agent: true },
    git: { pr: false, mergePolicy: "auto", squash: true, copyFiles: [], setupCommand: "" },
  };
}

/**
 * One repo + daemon. `tasks` is the body of tasks.md (null = no tasks.md); `spec` the spec.md text.
 * Returns helpers bound to that daemon.
 */
async function setup(port, { tasks, spec = "# Feature Specification: Lifecycle\n\nFiles in impl/.\n", config = {} } = {}) {
  const files = { "README.md": "# demo\n", "check.sh": CHECK_SH, [`${SPEC}/spec.md`]: spec };
  if (tasks !== null) files[`${SPEC}/tasks.md`] = `# Tasks\n\n${tasks}`;
  const { tmp, repo, home, sh } = makeRepo({ prefix: "orch-e2e-life-", files });
  const stateDir = path.join(tmp, "state");
  fs.mkdirSync(stateDir);
  writeConfig(repo, merge(baseConfig(port), config));
  const env = { FAKE_STATE_DIR: stateDir, ORCH_HOME: home };
  let daemon = await startDaemon({ cwd: repo, port, env, name: `d${port}` });
  const api = apiFor(port);
  const h = {
    tmp, repo, sh, api, stateDir,
    get daemon() { return daemon; },
    restart: async () => { daemon = await startDaemon({ cwd: repo, port, env, name: `d${port}'` }); },
    state: () => api("GET", "/api/state"),
    task: async (key) => (await api("GET", "/api/state")).tasks.find((t) => t.key === key),
    /** POST without throwing: { status, body }. */
    raw: async (p, body) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }); return { status: r.status, body: await r.json() }; },
    plan: (llm = false) => api("POST", "/api/plan", { specDir: path.join(repo, SPEC), llm }),
    planAndStart: async (llm = false) => { const run = await h.plan(llm); await api("POST", `/api/runs/${run.id}/approve`); await api("POST", `/api/runs/${run.id}/start`); return run; },
    /** Wait until task `key` satisfies `pred(task, state)`; returns the task. */
    waitTask: (key, pred, label, timeoutMs = 60_000) => waitFor(async () => { const s = await h.state(); const t = s.tasks.find((x) => x.key === key); return t && pred(t, s) ? t : null; }, { timeoutMs, intervalMs: 250, label }),
    waitRunDone: (timeoutMs = 90_000, label = "run done") => waitFor(async () => { const s = await h.state(); const bad = s.inbox.find((i) => i.type === "failed"); if (bad) throw new Error(`unexpected failure: ${bad.title}\n${bad.detail}`); return s.run.status === "done" ? s : null; }, { timeoutMs, intervalMs: 300, label }),
    events: (runId) => api("GET", `/api/runs/${runId}/events?limit=5000`),
    commitsAhead: (branch) => Number(sh(`git rev-list --count main..${branch}`).trim()),
  };
  return h;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readPid = (h, key) => waitFor(() => { const f = path.join(h.stateDir, `${key}.pid`); return fs.existsSync(f) && Number(fs.readFileSync(f, "utf8")); }, { timeoutMs: 30_000, label: `${key} agent pid` });
const stateMsgs = (evs, taskId) => evs.filter((e) => e.task_id === taskId && e.kind === "state").map((e) => e.data.message ?? "");

// ------------------------------------------------------------------ scenarios
const scenarios = [
  {
    id: "a", name: "stop mid-task keeps the branch; start again completes", reqs: "REQ-SCHED-04",
    run: async (port) => {
      const h = await setup(port, { tasks: "## Phase 1\n- [ ] T001 Build the slow part SLEEP_LONG\n", config: { scheduler: { maxAttempts: 3 } } });
      const run = await h.planAndStart();
      const pid = await readPid(h, "T001");
      const t = await h.waitTask("T001", (t) => t.status === "running" && t.branch && h.commitsAhead(t.branch) >= 1, "T001 wip commit");
      await h.api("POST", `/api/runs/${run.id}/stop`);
      await waitFor(() => !alive(pid), { timeoutMs: 5_000, label: "agent process to end" });
      const s = await h.state();
      const t1 = s.tasks.find((x) => x.key === "T001");
      assert(s.run.status === "stopped", `run should be stopped, is ${s.run.status}`);
      assert(t1.status === "pending", `T001 should be pending after stop, is ${t1.status}`);
      assert(h.commitsAhead(t.branch) >= 1, "branch lost its commits on stop");
      assert(fs.existsSync(t.worktree), "worktree removed on stop");
      await h.api("POST", `/api/runs/${run.id}/start`);
      await h.waitRunDone();
      assert(h.sh("cat impl/T001.txt").includes("OK"), "T001 work not on main");
      assert(fs.existsSync(path.join(h.repo, "impl/T001.wip")), "pre-stop commit not merged");
    },
  },
  {
    id: "b", name: "kill -9 mid-task; restart recovers without losing state", reqs: "REQ-SCHED-05, REQ-NFR-01, REQ-NFR-07",
    run: async (port) => {
      const h = await setup(port, {
        tasks: "## Phase 1\n- [ ] T001 [P] Build the slow part SLEEP_LONG\n- [ ] T002 [P] Add greeting\n",
        config: { scheduler: { maxAttempts: 3 } },
      });
      const run = await h.planAndStart();
      const pid = await readPid(h, "T001");
      await h.waitTask("T002", (t, s) => t.status === "needs_input" && s.tasks.find((x) => x.key === "T001").status === "running", "T002 asking while T001 runs");
      const before = await h.state();
      assert(before.decisions.length >= 2 && before.questions.length === 1, `expected decisions and a question before the crash (${before.decisions.length}/${before.questions.length})`);
      const t001 = before.tasks.find((t) => t.key === "T001");

      h.daemon.kill("SIGKILL");
      await waitFor(() => h.daemon.exitCode !== null || h.daemon.signalCode !== null, { timeoutMs: 5_000, label: "daemon to die" });
      await waitFor(() => !alive(pid), { timeoutMs: 10_000, label: "orphaned agent to exit" });
      await h.restart();

      const after = await h.state();
      const ids = (xs) => new Set(xs.map((x) => x.id));
      const decAfter = ids(after.decisions), qAfter = ids(after.questions);
      const lostD = before.decisions.filter((d) => !decAfter.has(d.id)), lostQ = before.questions.filter((q) => !qAfter.has(q.id));
      assert(!lostD.length && !lostQ.length, `lost after restart: ${lostD.length} decisions, ${lostQ.length} questions`);
      assert(after.decisions.length >= before.decisions.length && after.questions.length === before.questions.length,
        `counts before ${before.decisions.length}/${before.questions.length}, after ${after.decisions.length}/${after.questions.length}`);
      assert(after.questions.every((q) => !q.answer), "open question got answered by a restart");
      assert(fs.existsSync(t001.worktree), "T001 worktree lost in the crash");
      const evs = await h.events(run.id);
      assert(stateMsgs(evs, t001.id).some((m) => /daemon restarted while task was active; task reset to pending/.test(m)), "no recovery event for T001");

      const q = after.questions[0];
      await h.api("POST", `/api/questions/${q.id}/answer`, { answer: "French" });
      const s = await h.waitRunDone(90_000, "after the restart: run done");
      assert(h.sh("cat impl/T002.txt").includes("greeting=French"), "answer did not reach T002 after the restart");
      assert(s.decisions.length > before.decisions.length, "no decisions recorded after restart");
    },
  },
  {
    id: "c", name: "agent timeout fails the attempt with a timeout message", reqs: "REQ-WORK-07, REQ-WORK-04",
    run: async (port) => {
      const h = await setup(port, { tasks: "## Phase 1\n- [ ] T001 Build the slow part SLEEP_LONG\n", config: { agents: { timeoutMinutes: 0.05 }, scheduler: { maxAttempts: 1 } } });
      await h.planAndStart();
      const t = await h.waitTask("T001", (t) => t.status === "failed", "T001 failed by timeout", 30_000);
      assert(/timed out after 3 s/.test(t.last_feedback ?? ""), `feedback should mention the timeout:\n${t.last_feedback}`);
      const s = await h.state();
      assert(s.inbox.some((i) => i.type === "failed" && i.task_key === "T001" && /timed out/.test(i.detail)), "failed T001 not in the inbox with the timeout");
    },
  },
  {
    id: "d", name: "failing setup command fails each attempt with its output", reqs: "REQ-WORK-08, REQ-WORK-04, REQ-GIT-01",
    run: async (port) => {
      const h = await setup(port, { tasks: "## Phase 1\n- [ ] T001 Add file\n", config: { git: { setupCommand: "echo setup-broke-42; exit 1" } } });
      const run = await h.planAndStart();
      const t = await h.waitTask("T001", (t) => t.status === "failed", "T001 failed by setup");
      assert(t.attempt === 2, `expected 2 attempts, got ${t.attempt}`);
      assert(/setup command failed \(exit 1\)/.test(t.last_feedback) && /setup-broke-42/.test(t.last_feedback), `feedback lacks the setup output:\n${t.last_feedback}`);
      const evs = await h.events(run.id);
      const setups = evs.filter((e) => e.task_id === t.id && e.kind === "git" && /^setup: .* → exit 1/.test(e.data.message ?? ""));
      assert(setups.length === 2, `setup should run on every attempt (ran ${setups.length}x)`);
      const s = await h.state();
      assert(s.decisions.some((d) => d.actor === "orchestrator" && d.text.startsWith("Retrying T001 (attempt 2/2)")), "no retry decision");
    },
  },
  {
    id: "e", name: "worker without commits fails with 'no commits', lands in the inbox", reqs: "REQ-WORK-05, REQ-WORK-04, REQ-HITL-06, REQ-SCHED-07",
    run: async (port) => {
      const h = await setup(port, { tasks: "## Phase 1\n- [ ] T001 Change nothing NO_COMMIT\n", config: { scheduler: { resumeOnRetry: false } } });
      const run = await h.planAndStart();
      const t = await h.waitTask("T001", (t) => t.status === "failed", "T001 failed");
      assert(t.attempt === 2 && /No commits on the task branch/.test(t.last_feedback), `attempt ${t.attempt}, feedback: ${t.last_feedback}`);
      const s = await h.state();
      assert(s.inbox.some((i) => i.type === "failed" && i.task_key === "T001"), "failed T001 not in the inbox");
      assert(s.decisions.some((d) => d.actor === "orchestrator" && d.text.startsWith("Retrying T001")), "no retry decision");
      await sleep(3_000); // several ticks: the "waiting on you" line must appear exactly once
      const waiting = (await h.events(run.id)).filter((e) => e.kind === "state" && e.data.waiting);
      assert(waiting.length === 1 && /T001 \(failed\)/.test(waiting[0].data.message), `expected one "waiting on you" naming T001, got ${waiting.length}`);
    },
  },
  {
    id: "f", name: "plan without tasks.md (or with no tasks) is rejected, naming the file", reqs: "REQ-INTAKE-03",
    run: async (port) => {
      const h = await setup(port, { tasks: null });
      let r = await h.raw("/api/plan", { specDir: path.join(h.repo, SPEC), llm: false });
      assert(r.status === 400 && /tasks\.md/.test(r.body.error), `expected 400 naming tasks.md, got ${r.status} ${JSON.stringify(r.body)}`);
      fs.writeFileSync(path.join(h.repo, SPEC, "tasks.md"), "# Tasks\n\nNothing here yet.\n");
      r = await h.raw("/api/plan", { specDir: path.join(h.repo, SPEC), llm: false });
      assert(r.status === 400 && /no tasks found in .*tasks\.md/.test(r.body.error), `expected 400 'no tasks found', got ${r.status} ${JSON.stringify(r.body)}`);
      assert((await h.state()).run === null, "a run was created for a rejected plan");
    },
  },
  {
    id: "g", name: "planner failure falls back to the imported tasks with a decision", reqs: "REQ-INTAKE-06, REQ-INTAKE-08",
    run: async (port) => {
      const h = await setup(port, { tasks: "## Phase 1\n- [ ] T001 Add file\n- [ ] T005 Add other file\n", spec: "# Feature Specification: Broken\n\nPLANNER_FAIL\n" });
      const run = await h.plan(true);
      const s = await h.state();
      assert(s.run.id === run.id && s.run.status === "plan_pending", `run should await approval, is ${s.run.status}`);
      assert(s.tasks.map((t) => t.key).join() === "T001,T005" && s.tasks.every((t) => t.acceptance.length === 0), "tasks not imported unchanged");
      assert(s.decisions.some((d) => d.actor === "orchestrator" && d.text.startsWith("Planner produced no usable output")), "no fallback decision");
      assert(s.inbox.some((i) => i.type === "approve_plan"), "approve_plan not in the inbox");
      const r = await h.raw(`/api/runs/${run.id}/start`);
      assert(r.status === 400 && /not approved/.test(r.body.error), "starting an unapproved plan was not refused");
    },
  },
  {
    id: "h", name: "answer while paused reaches the worker on resume", reqs: "REQ-SCHED-08, REQ-SCHED-03, REQ-HITL-03, REQ-WORK-03",
    run: async (port) => {
      const h = await setup(port, { tasks: "## Phase 1\n- [ ] T002 Add greeting\n- [ ] T010 Add follow-up (depends on T002)\n" });
      const run = await h.planAndStart();
      await h.waitTask("T002", (t) => t.status === "needs_input", "T002 asks");
      await h.api("POST", `/api/runs/${run.id}/pause`);
      const q = (await h.state()).questions.find((x) => !x.answer);
      await h.api("POST", `/api/questions/${q.id}/answer`, { answer: "French" });
      await sleep(2_500); // a few ticks: nothing may start while paused
      let s = await h.state();
      const byKey = Object.fromEntries(s.tasks.map((t) => [t.key, t]));
      assert(s.run.status === "paused", `run should stay paused, is ${s.run.status}`);
      assert(["needs_input", "pending"].includes(byKey.T002.status) && byKey.T002.attempt === 1, `T002 ran while paused (status ${byKey.T002.status}, attempt ${byKey.T002.attempt})`);
      assert(byKey.T010.status === "pending" && byKey.T010.attempt === 0, "T010 started while paused");
      await h.api("POST", `/api/runs/${run.id}/start`);
      s = await h.waitRunDone();
      const t2 = s.tasks.find((t) => t.key === "T002");
      assert(h.sh("cat impl/T002.txt").includes("greeting=French"), "answer did not reach the worker");
      const evs = await h.events(run.id);
      assert(stateMsgs(evs, t2.id).some((m) => /resuming previous session/.test(m)), "worker session was not resumed after the answer");
    },
  },
  {
    id: "h2", name: "answering while paused does not consume an attempt", reqs: "REQ-HITL-03",
    todo: "today the resumed worker runs as attempt 2: §8 T11 and the owner-reviewed fixture transitions.json \"T11: answered while the run is paused\" send the task to pending, and the next start counts an attempt. Needs an owner decision on T11 (e.g. stay needs_input so the tick applies T10).",
    run: async (port) => {
      const h = await setup(port, { tasks: "## Phase 1\n- [ ] T002 Add greeting\n" });
      const run = await h.planAndStart();
      await h.waitTask("T002", (t) => t.status === "needs_input", "T002 asks");
      await h.api("POST", `/api/runs/${run.id}/pause`);
      const q = (await h.state()).questions.find((x) => !x.answer);
      await h.api("POST", `/api/questions/${q.id}/answer`, { answer: "French" });
      await h.api("POST", `/api/runs/${run.id}/start`);
      const s = await h.waitRunDone();
      const t2 = s.tasks.find((t) => t.key === "T002");
      assert(t2.attempt === 1, `answering consumed an attempt (attempt ${t2.attempt})`);
    },
  },
  {
    id: "i", name: "dirty main checkout at local merge goes to the inbox", reqs: "REQ-GIT-02, REQ-GIT-04, REQ-GIT-01, REQ-GIT-05",
    run: async (port) => {
      const h = await setup(port, { tasks: "## Phase 1\n- [ ] T001 Add file\n" });
      fs.appendFileSync(path.join(h.repo, "README.md"), "local edit\n");
      await h.planAndStart();
      const t = await h.waitTask("T001", (t) => t.status === "pr_open", "T001 parked for merge");
      assert(t.attempt === 1, `merge failure consumed attempts (attempt ${t.attempt})`);
      assert(/clean working tree/.test(t.last_feedback ?? ""), `feedback should name the unclean tree:\n${t.last_feedback}`);
      const s = await h.state();
      assert(s.inbox.some((i) => i.type === "merge" && i.task_key === "T001" && /clean working tree/.test(i.feedback)), "T001 not in the inbox with the reason");
      h.sh("git checkout -- README.md");
      await h.api("POST", `/api/tasks/${t.id}/merge`);
      await h.waitRunDone();
      assert(h.sh("cat impl/T001.txt").includes("OK"), "T001 not merged after cleaning up");
      assert(!fs.existsSync(t.worktree), "worktree of a done task still exists");
      assert(!h.sh("git branch --list").includes(t.branch), "branch of a done task not deleted");
      assert(/- \[x\] T001/.test(h.sh(`git show HEAD:${SPEC}/tasks.md`)), "tasks.md tick not committed on main");
    },
  },
  {
    id: "j", name: "parallel tasks conflicting on one file: one merges, the other goes to the inbox", reqs: "REQ-GIT-04, REQ-GIT-06, REQ-WORK-01",
    run: async (port) => {
      const h = await setup(port, { tasks: "## Phase 1\n- [ ] T001 [P] Write shared file CONFLICT_FILE\n- [ ] T005 [P] Also write shared file CONFLICT_FILE\n" });
      await h.planAndStart();
      const s = await waitFor(async () => { const s = await h.state(); const st = s.tasks.map((t) => t.status).sort().join(); return st === "done,pr_open" ? s : null; }, { timeoutMs: 60_000, intervalMs: 250, label: "one done, one parked" });
      const done = s.tasks.find((t) => t.status === "done"), parked = s.tasks.find((t) => t.status === "pr_open");
      assert(done.branch !== parked.branch, "tasks shared a branch");
      assert(parked.attempt === 1, `conflict consumed attempts (attempt ${parked.attempt})`);
      assert(/Merge step failed: rebase onto main failed/.test(parked.last_feedback ?? ""), `feedback should carry the conflict:\n${parked.last_feedback}`);
      assert(s.inbox.some((i) => i.type === "merge" && i.task_key === parked.key), "conflicting task not in the inbox");
      assert(h.sh("cat shared.txt").includes(`written by ${done.key}`), "main does not hold the merged task's file");
      // The task shows done just before its tasks.md tick is committed; wait for that commit, then require a clean tree.
      await waitFor(() => h.sh("git log --oneline -1").includes(`${done.key}: tick in tasks.md`), { timeoutMs: 5_000, label: "tasks.md tick commit" });
      assert(h.sh("git status --porcelain --untracked-files=no").trim() === "", "main checkout left dirty after the failed merge");
    },
  },
  {
    id: "k", name: "a skipped dependency lets its dependant start", reqs: "REQ-SCHED-06, REQ-GIT-01",
    run: async (port) => {
      const h = await setup(port, { tasks: "## Phase 1\n- [ ] T001 Change nothing NO_COMMIT\n- [ ] T005 Add follow-up (depends on T001)\n", config: { scheduler: { maxAttempts: 1 } } });
      await h.planAndStart();
      const t1 = await h.waitTask("T001", (t) => t.status === "failed", "T001 failed");
      assert((await h.task("T005")).status === "pending", "T005 should wait for T001");
      await h.api("POST", `/api/tasks/${t1.id}/skip`);
      const s = await h.waitRunDone();
      const byKey = Object.fromEntries(s.tasks.map((t) => [t.key, t]));
      assert(byKey.T001.status === "skipped" && byKey.T005.status === "done", `statuses ${byKey.T001.status}/${byKey.T005.status}`);
      assert(s.decisions.some((d) => d.actor === "human" && d.text === "Skipped T001"), "skip not recorded as a human decision");
      assert(!fs.existsSync(t1.worktree), "skipped task's worktree not removed");
    },
  },
  {
    id: "l", name: "answering a question twice is refused", reqs: "REQ-HITL-03, REQ-ADAPT-04",
    run: async (port) => {
      const h = await setup(port, { tasks: "## Phase 1\n- [ ] T002 Add greeting\n" });
      await h.planAndStart();
      const t = await h.waitTask("T002", (t) => t.status === "needs_input", "T002 asks");
      const q = (await h.state()).questions[0];
      assert(q.task_id === t.id && q.options.join() === "English,French", "question not attached to T002 with its options");
      await h.api("POST", `/api/questions/${q.id}/answer`, { answer: "French" });
      const r = await h.raw(`/api/questions/${q.id}/answer`, { answer: "English" });
      assert(r.status === 400 && /already answered/.test(r.body.error), `second answer not refused: ${r.status} ${JSON.stringify(r.body)}`);
      const s = await h.waitRunDone();
      assert(s.questions[0].answer === "French", `stored answer changed to ${s.questions[0].answer}`);
      assert(h.sh("cat impl/T002.txt").includes("greeting=French"), "first answer did not reach the worker");
      assert(s.decisions.filter((d) => d.actor === "human" && d.text.startsWith("Answered:")).length === 1, "expected exactly one answer decision");
    },
  },
  {
    id: "m", name: "editing criteria before approval records a human decision", reqs: "REQ-INTAKE-09 (part), REQ-INTAKE-08",
    run: async (port) => {
      const h = await setup(port, { tasks: "## Phase 1\n- [ ] T001 Add file\n- [ ] T002 Add greeting\n" });
      const run = await h.plan(false);
      const r = await h.raw(`/api/runs/${run.id}/start`);
      assert(r.status === 400 && /not approved/.test(r.body.error), "starting an unapproved plan was not refused");
      const t2 = await h.task("T002");
      await h.api("POST", `/api/tasks/${t2.id}/edit`, { acceptance: ["greets in French", "impl/T002.txt exists"] });
      const s = await h.state();
      const t2b = s.tasks.find((t) => t.key === "T002");
      assert(t2b.acceptance.join("|") === "greets in French|impl/T002.txt exists", `criteria not updated: ${JSON.stringify(t2b.acceptance)}`);
      const d = s.decisions.find((d) => d.actor === "human" && /T002/.test(d.text) && /acceptance/.test(d.text));
      assert(d && d.task_id === t2.id, "no human decision naming T002's edit");
      assert(s.run.status === "plan_pending", "editing changed the run status");
    },
  },
];

// ------------------------------------------------------------------ runner
const only = process.argv.slice(2);
const selected = scenarios.filter((s) => !only.length || only.includes(s.id));
const results = [];
for (const [i, s] of scenarios.entries()) {
  if (!selected.includes(s)) continue;
  const label = `(${s.id}) ${s.name}`;
  if (s.todo) { results.push({ s, status: "todo", note: s.todo }); console.log(`TODO ${label}: ${s.todo}`); continue; }
  console.log(`\n=== ${label}  [${s.reqs}]`);
  const started = Date.now();
  let ok = false, note = "";
  try { await s.run(BASE_PORT + i); ok = true; } catch (e) { note = e.message; console.error(`FAILED ${label}: ${e.message}`); }
  await cleanup({ ok });
  results.push({ s, status: ok ? "pass" : "fail", note, secs: ((Date.now() - started) / 1000).toFixed(1) });
}
console.log("\nlifecycle scenarios:");
for (const r of results) console.log(`  ${r.status.toUpperCase().padEnd(4)} (${r.s.id}) ${r.s.name}${r.secs ? ` ${r.secs}s` : ""}${r.status !== "pass" && r.note ? `\n         ${r.note.split("\n")[0]}` : ""}`);
const failed = results.filter((r) => r.status === "fail").length;
console.log(failed ? `E2E-LIFECYCLE FAILED (${failed})` : "E2E-LIFECYCLE PASSED");
process.exit(failed ? 1 : 0);
