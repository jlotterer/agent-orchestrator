#!/usr/bin/env node
/**
 * UI validation mode e2e (TASK-16; REQ-VAL-02, REQ-VAL-08, REQ-VAL-09, REQ-INTAKE-04/09 for `validate_mode`).
 * orch starts scripts/fake-app.mjs as the project's app; the fake UI validator fetches the URL it is given
 * (scripts/fake-agent.mjs). Every scenario ends by checking that no fake-app process is left (kill -0 on the
 * pids the app recorded) and that no app pidfile is left in $ORCH_HOME/run.
 *   (a) a UI task passes only on HTTP 200 from the app; a standard task gets no app; both validator prompts
 *       contain the gate output; the planner's validate_mode is applied and the owner can edit it
 *   (b) NEVER_READY with a 3 s readiness timeout: the attempt fails with the app's output in the feedback
 *   (c) the validator returns BLOCKED: the task fails on attempt 1 (no retry) and is in the inbox
 *   (d) kill -9 the daemon during UI validation, restart: the leftover app is killed, the task reruns
 *   (e) stop the task during UI validation: the app is stopped with it
 *   (f) SIGTERM the daemon during UI validation: the app is stopped before the daemon exits
 *
 *   node scripts/e2e-ui.mjs          # all scenarios
 *   node scripts/e2e-ui.mjs b c      # only (b) and (c)
 */
import fs from "node:fs";
import path from "node:path";
import { makeRepo, writeConfig, startDaemon, api as apiFor, waitFor, cleanup, sleep, FAKE_AGENT, ROOT } from "./lib/e2e.mjs";

const BASE_PORT = 4871;
const FAKE_APP = path.join(ROOT, "scripts/fake-app.mjs");
const CHECK_SH = "#!/bin/sh\nfor f in impl/*.txt; do [ -f \"$f\" ] || continue; grep -q OK \"$f\" || { echo \"$f is not OK\"; exit 1; }; done\necho checks passed: GATE_MARKER\n";
const SPEC = "specs/001-ui";

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

async function setup(port, { tasks, ui = {}, maxAttempts = 2 }) {
  const { repo, home, tmp } = makeRepo({
    prefix: "orch-e2e-ui-",
    files: {
      "README.md": "# demo\n", "check.sh": CHECK_SH,
      [`${SPEC}/spec.md`]: "# Feature Specification: UI\n\nThe app shows the impl/ files.\n",
      [`${SPEC}/tasks.md`]: `# Tasks\n\n## Phase 1: Core\n${tasks}`,
    },
  });
  const state = path.join(tmp, "state");
  fs.mkdirSync(state);
  writeConfig(repo, {
    port, publicUrl: `http://localhost:${port}`,
    agents: {
      timeoutMinutes: 2,
      adapters: { claude: { type: "claude", command: FAKE_AGENT, extraArgs: [], env: {} } },
      roles: { planner: { adapter: "claude", model: "" }, worker: { adapter: "claude", model: "" }, validator: { adapter: "claude", model: "" } },
    },
    scheduler: { maxParallel: 2, tickSeconds: 1, maxAttempts, resumeOnRetry: true },
    validation: {
      command: "sh check.sh", agent: true, phase: { enabled: false },
      ui: { startCommand: `node "${FAKE_APP}"`, readyTimeoutSeconds: 10, ...ui },
    },
    git: { pr: false, mergePolicy: "auto", squash: true, copyFiles: [], setupCommand: "" },
  });
  const pidsFile = path.join(state, "app.pids"), promptLog = path.join(state, "prompts.log");
  const env = { ORCH_HOME: home, FAKE_STATE_DIR: state, FAKE_APP_PIDS: pidsFile, FAKE_PROMPT_LOG: promptLog };
  const h = {
    repo, home, state, port,
    daemon: await startDaemon({ cwd: repo, port, env, name: `d${port}` }),
    api: apiFor(port),
    restart: async () => { h.daemon = await startDaemon({ cwd: repo, port, env, name: `d${port}'` }); },
    state_: () => h.api("GET", "/api/state"),
    raw: async (p, body) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }); return { status: r.status, body: await r.json() }; },
    plan: async () => {
      const run = await h.api("POST", "/api/plan", { specDir: path.join(repo, SPEC), llm: true });
      await waitFor(async () => (await h.state_()).run?.status === "plan_pending", { timeoutMs: 30_000, label: "plan ready" });
      return run;
    },
    start: async (run) => { await h.api("POST", `/api/runs/${run.id}/approve`); await h.api("POST", `/api/runs/${run.id}/start`); },
    wait: async (pred, label, timeoutMs = 60_000) => {
      try {
        return await waitFor(async () => { const s = await h.state_(); return pred(s) ? s : null; }, { timeoutMs, intervalMs: 250, label });
      } catch (e) {
        // Say where it got stuck: task states and the run's last events.
        const s = await h.state_().catch(() => null);
        if (s?.run) {
          console.log("  tasks:", s.tasks.map((t) => `${t.key}=${t.status}#${t.attempt}`).join(" "));
          for (const ev of (await h.events(s.run.id)).slice(-15)) console.log(`  [${ev.kind}] ${JSON.stringify(ev.data).slice(0, 300)}`);
        }
        throw e;
      }
    },
    events: async (runId) => h.api("GET", `/api/runs/${runId}/events?limit=5000`),
    appPids: () => (fs.existsSync(pidsFile) ? fs.readFileSync(pidsFile, "utf8").split("\n").filter(Boolean).map(Number) : []),
    pidfiles: () => { const d = path.join(home, "run"); return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /^app-.+\.pid$/.test(f)) : []; },
    prompts: () => (fs.existsSync(promptLog) ? fs.readFileSync(promptLog, "utf8").split("\n---\n") : []),
    /** No fake app is left: every recorded pid is gone and orch's pidfiles are removed. */
    noAppLeft: async (label) => {
      await waitFor(() => h.appPids().every((p) => !alive(p)) && !h.pidfiles().length, { timeoutMs: 10_000, label: `${label}: no app left (pids ${h.appPids().filter(alive)}, pidfiles ${h.pidfiles()})` });
    },
  };
  return h;
}
const task = (s, key) => s.tasks.find((t) => t.key === key);
const validatorPrompts = (h, key) => h.prompts().filter((p) => p.includes("You are the VALIDATOR") && p.includes(`# Task ${key}:`));

const scenarios = {
  async a(port) {
    const h = await setup(port, { tasks: "- [ ] T001 [P] Create impl/T001.txt UI_MODE\n- [ ] T005 [P] Create impl/T005.txt\n" });
    const run = await h.plan();
    let s = await h.state_();
    assert(task(s, "T001").validate_mode === "ui", `planner proposed ui for T001: ${task(s, "T001").validate_mode}`);
    assert(task(s, "T005").validate_mode === "standard", "T005 stays standard");
    // REQ-INTAKE-09: the owner edits the mode; bad values and unknown fields are refused.
    const bad = await h.raw(`/api/tasks/${task(s, "T005").id}/edit`, { validate_mode: "browser" });
    assert(bad.status === 400 && /validate_mode/.test(bad.body.error), `bad mode refused: ${JSON.stringify(bad)}`);
    const unknown = await h.raw(`/api/tasks/${task(s, "T005").id}/edit`, { status: "done" });
    assert(unknown.status === 400 && /cannot edit status/.test(unknown.body.error), `unknown field refused: ${JSON.stringify(unknown)}`);
    await h.api("POST", `/api/tasks/${task(s, "T005").id}/edit`, { validate_mode: "ui" });
    s = await h.state_();
    assert(task(s, "T005").validate_mode === "ui", "edit applied");
    assert(s.decisions.some((d) => d.actor === "human" && d.text === "Edited task T005: validate_mode"), "human decision for the edit");
    await h.api("POST", `/api/tasks/${task(s, "T005").id}/edit`, { validate_mode: "standard" });
    await h.start(run);

    s = await h.wait((s) => s.run.status === "done" || s.inbox.some((i) => i.type === "failed"), "run done", 90_000);
    assert(s.run.status === "done", `run done: ${JSON.stringify(s.inbox)}`);
    const evs = await h.events(run.id);
    const t1 = task(s, "T001"), t5 = task(s, "T005");
    const v1 = evs.find((e) => e.task_id === t1.id && e.kind === "verdict");
    assert(v1?.data.verdict === "PASS", `T001 PASS: ${JSON.stringify(v1?.data)}`);
    assert(/^http:\/\/127\.0\.0\.1:\d+\/$/.test(v1.data.app_url), `verdict records the app url: ${v1.data.app_url}`);
    assert(v1.data.findings.some((f) => f === `app answered 200 at ${v1.data.app_url}`), `the validator got 200 from the app: ${v1.data.findings}`);
    assert(evs.some((e) => e.task_id === t1.id && /^app ready at /.test(e.data.message ?? "")), "app ready event");
    assert(evs.some((e) => e.task_id === t1.id && /^app stopped /.test(e.data.message ?? "")), "app stopped event");
    assert(!evs.some((e) => e.task_id === t5.id && /^starting app/.test(e.data.message ?? "")), "no app for the standard task");
    assert(h.appPids().length === 1, `one app was started: ${h.appPids()}`);

    // REQ-VAL-02: both validators see the gate output; only the UI one gets the app.
    const [p1] = validatorPrompts(h, "T001"), [p5] = validatorPrompts(h, "T005");
    assert(p1 && p1.includes("## App under test") && p1.includes(v1.data.app_url), "UI validator prompt has the app url");
    for (const [k, p] of [["T001", p1], ["T005", p5]]) {
      assert(p && p.includes("## Test gate output") && p.includes("checks passed: GATE_MARKER") && p.includes("`sh check.sh` passed"), `${k} validator prompt has the gate output`);
    }
    assert(!p5.includes("## App under test"), "standard validator prompt has no app section");
    await h.noAppLeft("a");
    console.log("  UI task passed on HTTP 200; app stopped; gate output in both validator prompts");
  },

  async b(port) {
    const h = await setup(port, { tasks: "- [ ] T001 Create impl/T001.txt UI_MODE\n", ui: { readyTimeoutSeconds: 3, env: { NEVER_READY: "1" } }, maxAttempts: 1 });
    const run = await h.plan();
    const t0 = Date.now();
    await h.start(run);
    const s = await h.wait((s) => task(s, "T001").status === "failed", "T001 failed", 60_000);
    const fb = task(s, "T001").last_feedback;
    assert(/did not become ready at http:\/\/127\.0\.0\.1:\d+\/ within 3 s/.test(fb), `feedback says not ready: ${fb}`);
    assert(fb.includes("NEVER_READY: answering 503"), `feedback has the app's output: ${fb}`);
    const item = s.inbox.find((i) => i.type === "failed" && i.task_key === "T001");
    assert(item?.detail?.includes("NEVER_READY"), "failed item in the inbox with the app output");
    const evs = await h.events(run.id);
    assert(!evs.some((e) => e.kind === "verdict"), "the validator never ran");
    assert(Date.now() - t0 < 45_000, "failed after the short readiness timeout");
    await h.noAppLeft("b");
    console.log("  app never ready: attempt failed after 3 s with the app's output");
  },

  async c(port) {
    const h = await setup(port, { tasks: "- [ ] T001 Create impl/T001.txt UI_BLOCKED\n", maxAttempts: 3 });
    const run = await h.plan();
    await h.start(run);
    const s = await h.wait((s) => task(s, "T001").status === "failed", "T001 failed");
    const t1 = task(s, "T001");
    assert(t1.attempt === 1, `failed on attempt 1 without retrying (attempt ${t1.attempt})`);
    assert(t1.last_feedback === "UI validation blocked: no browser tool available", `feedback: ${t1.last_feedback}`);
    const item = s.inbox.find((i) => i.type === "failed" && i.task_key === "T001");
    assert(item && item.detail.includes("UI validation blocked"), `inbox item: ${JSON.stringify(s.inbox)}`);
    const global = await h.api("GET", "/api/inbox");
    assert(global.some((i) => i.type === "failed" && i.task_key === "T001"), "in the global inbox too");
    assert(!s.decisions.some((d) => d.text.startsWith("Retrying T001")), "no retry decision");
    await sleep(2500); // a retry would start within a tick
    assert(task(await h.state_(), "T001").attempt === 1, "still attempt 1");
    await h.noAppLeft("c");
    console.log("  BLOCKED verdict: failed on attempt 1, in the inbox");
  },

  async d(port) {
    const h = await setup(port, { tasks: "- [ ] T001 Create impl/T001.txt UI_HANG\n" });
    const run = await h.plan();
    await h.start(run);
    await waitFor(() => fs.existsSync(path.join(h.state, "validator-T001.pid")) && h.pidfiles().length === 1, { timeoutMs: 60_000, label: "UI validation running" });
    const pidfile = path.join(h.home, "run", h.pidfiles()[0]);
    // The pidfile holds the group leader (`sh -c`, or the app itself when sh execs it); fake-app records its own pid.
    const appPid = Number(fs.readFileSync(pidfile, "utf8"));
    const [nodePid] = h.appPids();
    assert(alive(-appPid) && nodePid && alive(nodePid), `the app runs (group ${appPid}, app pid ${nodePid})`);
    h.daemon.kill("SIGKILL");
    await new Promise((r) => h.daemon.once("exit", r));
    await sleep(500);
    assert(alive(nodePid), "the app outlived the killed daemon (detached group)");
    await h.restart();
    await waitFor(() => !alive(-appPid) && !alive(nodePid) && !fs.existsSync(pidfile), { timeoutMs: 15_000, label: "leftover app killed after restart" });
    const t1 = task(await h.state_(), "T001");
    const evs = await h.events(run.id);
    assert(evs.some((e) => e.task_id === t1.id && e.data.message === `daemon restarted: stopped the leftover UI app (pid ${appPid})`), "restart logged the leftover app");
    // The task was reset by the restart and reruns (the hang happens once); the run finishes.
    const s = await h.wait((s) => s.run.status === "done", "run done after the restart", 90_000);
    assert(task(s, "T001").status === "done", "T001 done");
    await h.noAppLeft("d");
    console.log("  kill -9 during UI validation: restart killed the leftover app; task reran");
  },

  async e(port) {
    const h = await setup(port, { tasks: "- [ ] T001 Create impl/T001.txt UI_HANG\n" });
    const run = await h.plan();
    await h.start(run);
    await waitFor(() => fs.existsSync(path.join(h.state, "validator-T001.pid")) && h.pidfiles().length === 1, { timeoutMs: 60_000, label: "UI validation running" });
    const appPid = Number(fs.readFileSync(path.join(h.home, "run", h.pidfiles()[0]), "utf8"));
    const t1 = task(await h.state_(), "T001");
    await h.api("POST", `/api/tasks/${t1.id}/stop`);
    await waitFor(() => !alive(-appPid) && !h.pidfiles().length, { timeoutMs: 10_000, label: "app stopped with the task" });
    const s = await h.wait((s) => s.run.status === "done", "run done after the stop", 90_000);
    assert(s.decisions.some((d) => d.text === "Stopped T001"), "stop recorded");
    await h.noAppLeft("e");
    console.log("  stopping the task stopped its app");
  },

  async f(port) {
    const h = await setup(port, { tasks: "- [ ] T001 Create impl/T001.txt UI_HANG\n" });
    const run = await h.plan();
    await h.start(run);
    await waitFor(() => fs.existsSync(path.join(h.state, "validator-T001.pid")) && h.pidfiles().length === 1, { timeoutMs: 60_000, label: "UI validation running" });
    const appPid = Number(fs.readFileSync(path.join(h.home, "run", h.pidfiles()[0]), "utf8"));
    h.daemon.kill("SIGTERM");
    await new Promise((r) => h.daemon.once("exit", r));
    assert(!alive(-appPid), "the app was stopped before the daemon exited");
    assert(!h.pidfiles().length, "pidfile removed on shutdown");
    console.log("  daemon shutdown stopped the app");
  },
};

const only = process.argv.slice(2);
let ok = true;
let port = BASE_PORT;
for (const [name, fn] of Object.entries(scenarios)) {
  const p = port++;
  if (only.length && !only.includes(name)) continue;
  console.log(`(${name})`);
  try {
    await fn(p);
    console.log(`(${name}) ok`);
  } catch (e) {
    ok = false;
    console.error(`(${name}) FAILED: ${e.stack ?? e}`);
  }
  await cleanup({ ok });
}
console.log(ok ? "\nE2E UI OK" : "\nE2E UI FAILED");
process.exit(ok ? 0 : 1);
