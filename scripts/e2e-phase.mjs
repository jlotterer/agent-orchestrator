#!/usr/bin/env node
/**
 * Phase validation e2e (TASK-15, REQ-VAL-06/07, REQ-HITL-01 phase items). PHASE_TRAP in spec.md makes the
 * fake phase validator FAIL phase 1 until a fix-up task has merged impl/FIX-1.<round>.txt (scripts/fake-agent.mjs).
 *   (a) fix-up: phase 1 done → validation FAIL → FIX-1.1 with the failure text, phase 2 waits →
 *       FIX-1.1 done → re-validation PASS → phase 2 runs → run done; tasks.md never gets a FIX- key
 *   (b) maxFixups 0: the failure becomes a phase inbox item; Re-run validates again (still failing),
 *       Accept lets phase 2 proceed
 *
 *   node scripts/e2e-phase.mjs          # both scenarios
 *   node scripts/e2e-phase.mjs b        # only (b)
 */
import fs from "node:fs";
import path from "node:path";
import { makeRepo, writeConfig, startDaemon, api as apiFor, waitFor, cleanup, FAKE_AGENT } from "./lib/e2e.mjs";

const BASE_PORT = 4861;
const CHECK_SH = "#!/bin/sh\nfor f in impl/*.txt; do [ -f \"$f\" ] || continue; grep -q OK \"$f\" || { echo \"$f is not OK\"; exit 1; }; done\necho checks passed\n";
const SPEC = "specs/001-phase";
const TASKS = "# Tasks\n\n## Phase 1: Core\n- [ ] T001 [P] Create impl/T001.txt\n- [ ] T005 [P] Create impl/T005.txt\n\n## Phase 2: Polish\n- [ ] T006 Create impl/T006.txt\n";
const P1 = "Phase 1: Core", P2 = "Phase 2: Polish";

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

async function setup(port, phase = {}) {
  const { repo, home, sh } = makeRepo({
    prefix: "orch-e2e-phase-",
    files: {
      "README.md": "# demo\n", "check.sh": CHECK_SH,
      [`${SPEC}/spec.md`]: "# Feature Specification: Phases\n\nFiles in impl/ must work together.\n\nPHASE_TRAP: the first phase misses an integration step.\n",
      [`${SPEC}/tasks.md`]: TASKS,
    },
  });
  writeConfig(repo, {
    port, publicUrl: `http://localhost:${port}`,
    agents: {
      timeoutMinutes: 2,
      adapters: { claude: { type: "claude", command: FAKE_AGENT, extraArgs: [], env: {} } },
      roles: { planner: { adapter: "claude", model: "" }, worker: { adapter: "claude", model: "" }, validator: { adapter: "claude", model: "" } },
    },
    scheduler: { maxParallel: 2, tickSeconds: 1, maxAttempts: 2, resumeOnRetry: true },
    validation: { command: "sh check.sh", agent: true, phase: { enabled: true, command: "", maxFixups: 2, ...phase } },
    git: { pr: false, mergePolicy: "auto", squash: true, copyFiles: [], setupCommand: "" },
  });
  await startDaemon({ cwd: repo, port, env: { ORCH_HOME: home }, name: `d${port}` });
  const api = apiFor(port);
  const h = {
    repo, sh, api,
    state: () => api("GET", "/api/state"),
    raw: async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); return { status: r.status, body: await r.json() }; },
    planAndStart: async () => {
      const run = await api("POST", "/api/plan", { specDir: path.join(repo, SPEC), llm: true });
      await waitFor(async () => (await h.state()).run?.status === "plan_pending", { timeoutMs: 30_000, label: "plan ready" });
      await api("POST", `/api/runs/${run.id}/approve`);
      await api("POST", `/api/runs/${run.id}/start`);
      return run;
    },
    waitState: (pred, label, timeoutMs = 90_000) => waitFor(async () => {
      const s = await h.state();
      const bad = s.inbox.find((i) => i.type === "failed");
      if (bad) throw new Error(`unexpected failure: ${bad.title}\n${bad.detail}`);
      return pred(s) ? s : null;
    }, { timeoutMs, intervalMs: 250, label }),
    tasksMd: () => fs.readFileSync(path.join(repo, SPEC, "tasks.md"), "utf8"),
  };
  return h;
}
const phaseOf = (s, name) => s.phases.find((p) => p.name === name);
const task = (s, key) => s.tasks.find((t) => t.key === key);
const decided = (s, prefix) => s.decisions.filter((d) => d.text.startsWith(prefix));

const scenarios = {
  async a(port) {
    const h = await setup(port);
    const run = await h.planAndStart();

    // Phase 1 fails validation → FIX-1.1 with the failure text; phase 2 has not started.
    let s = await h.waitState((s) => task(s, "FIX-1.1"), "FIX-1.1 created");
    const fix = task(s, "FIX-1.1");
    assert(fix.synthetic === true, "FIX-1.1 is synthetic");
    assert(fix.phase === P1, `FIX-1.1 belongs to phase 1 (${fix.phase})`);
    assert(fix.merge_policy === "auto", "FIX-1.1 merges automatically");
    assert(fix.description.includes("PHASE_TRAP"), `FIX-1.1 description carries the failure:\n${fix.description}`);
    assert(fix.acceptance.some((a) => a.includes("work together")) && fix.acceptance.some((a) => a.includes("passes")), `FIX-1.1 acceptance: ${JSON.stringify(fix.acceptance)}`);
    const t6 = task(s, "T006");
    assert(t6.depends_on.includes("FIX-1.1"), `T006 depends on FIX-1.1: ${t6.depends_on}`);
    assert(t6.status === "pending" && t6.attempt === 0, `T006 waits (${t6.status}, attempt ${t6.attempt})`);
    assert(fix.order_idx < t6.order_idx, "FIX-1.1 is ordered before phase 2");
    assert(phaseOf(s, P1).fixup_rounds === 1, "phase 1 used one fix-up round");
    assert(decided(s, `Phase "${P1}" failed validation`).length === 1, "decision: phase 1 failed");
    const created = decided(s, "Created fix-up task FIX-1.1");
    assert(created.length === 1 && created[0].actor === "orchestrator", "orchestrator decision: fix-up created");
    console.log("  phase 1 failed; FIX-1.1 created, T006 waits");

    // FIX-1.1 done → phase 1 passes on re-validation → phase 2 runs → the run is done.
    s = await h.waitState((s) => s.run.status === "done", "run done", 120_000);
    for (const k of ["T001", "T005", "FIX-1.1", "T006"]) assert(task(s, k).status === "done", `${k} done`);
    assert(s.phases.every((p) => p.status === "passed"), `all phases passed: ${JSON.stringify(s.phases)}`);
    const passed1 = decided(s, `Phase "${P1}" passed validation`), passed2 = decided(s, `Phase "${P2}" passed validation`);
    assert(passed1.length === 1 && passed1[0].actor === "phase_validator", "decision: phase 1 passed");
    assert(passed2.length === 1, "decision: phase 2 passed");
    assert(s.decisions.indexOf(passed1[0]) > s.decisions.indexOf(created[0]), "phase 1 passed after the fix-up was created");

    // Phase 2 started only after FIX-1.1 was done and phase 1 passed.
    const evs = await h.api("GET", `/api/runs/${run.id}/events?limit=5000`);
    const doneFix = evs.find((e) => e.task_id === fix.id && e.kind === "state" && e.data.message === "done");
    const startT6 = evs.find((e) => e.task_id === t6.id && e.kind === "state" && String(e.data.message).startsWith("worker started"));
    const phase1Pass = evs.find((e) => e.kind === "state" && e.data.message === `phase "${P1}" passed validation`);
    assert(doneFix && startT6 && phase1Pass, "events for FIX-1.1 done, phase 1 pass and T006 start exist");
    assert(doneFix.id < phase1Pass.id && phase1Pass.id < startT6.id, "order: FIX-1.1 done → phase 1 passed → T006 started");

    // tasks.md is ticked for real tasks and never mentions FIX- keys; the fix-up's work is on main.
    const md = h.tasksMd();
    for (const k of ["T001", "T005", "T006"]) assert(md.includes(`- [x] ${k}`), `${k} ticked in tasks.md`);
    assert(!md.includes("FIX-"), `tasks.md has no FIX- key:\n${md}`);
    assert(!h.sh(`git log --format=%s main -- ${SPEC}/tasks.md`).includes("FIX-"), "no tasks.md commit for a FIX- key");
    assert(fs.existsSync(path.join(h.repo, "impl/FIX-1.1.txt")), "the fix-up merged into main");
    // The detached phase worktrees are gone.
    const wts = h.sh("git worktree list --porcelain").split("\n").filter((l) => l.startsWith("worktree "));
    assert(!wts.some((l) => /-phase-\d+$/.test(l)), `phase worktrees removed: ${wts.join(", ")}`);
    console.log("  FIX-1.1 done → phase 1 passed → phase 2 ran; tasks.md untouched for FIX-1.1");
  },

  async b(port) {
    const h = await setup(port, { maxFixups: 0 });
    await h.planAndStart();

    // Fix-ups off: the failure goes to the inbox (and the global inbox) with Re-run and Accept.
    let s = await h.waitState((s) => s.inbox.some((i) => i.type === "phase"), "phase inbox item");
    let item = s.inbox.find((i) => i.type === "phase");
    assert(item.phase_name === P1 && item.detail?.includes("PHASE_TRAP"), `phase item: ${JSON.stringify(item)}`);
    assert(phaseOf(s, P1).status === "needs_human", "phase 1 needs the owner");
    assert(!s.tasks.some((t) => t.synthetic), "no fix-up task with maxFixups 0");
    assert(task(s, "T006").status === "pending" && task(s, "T006").attempt === 0, "T006 waits");
    assert(decided(s, `Phase "${P1}" needs the owner`).length === 1, "orchestrator decision: needs the owner");
    const global = await h.api("GET", "/api/inbox");
    assert(global.some((i) => i.type === "phase" && i.phase_id === item.phase_id && i.project_id), "phase item in the global inbox");
    const early = await h.raw(`/api/phases/${phaseOf(s, P2).id}/accept`);
    assert(early.status === 400 && /pending/.test(early.body.error), `accepting a pending phase is refused: ${JSON.stringify(early)}`);
    console.log("  phase 1 failed; inbox item, T006 waits");

    // Re-run: validates again (still trapped), back in the inbox.
    await h.api("POST", `/api/phases/${item.phase_id}/revalidate`);
    s = await h.waitState((s) => decided(s, `Phase "${P1}" failed validation`).length === 2 && phaseOf(s, P1).status === "needs_human", "re-run failed again");
    assert(decided(s, `Re-running validation of phase "${P1}"`).length === 1, "human decision: re-run");

    // Accept: phase 2 proceeds and the run finishes.
    await h.api("POST", `/api/phases/${item.phase_id}/accept`);
    s = await h.waitState((s) => s.run.status === "done", "run done", 120_000);
    assert(task(s, "T006").status === "done", "T006 done after Accept");
    assert(decided(s, `Accepted phase "${P1}"`).length === 1, "human decision: accepted");
    assert(decided(s, `Phase "${P2}" passed validation`).length === 1, "phase 2 validated");
    assert(!s.inbox.some((i) => i.type === "phase"), "no phase item left");
    console.log("  Re-run failed again; Accept let phase 2 run");
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
console.log(ok ? "\nE2E PHASE OK" : "\nE2E PHASE FAILED");
process.exit(ok ? 0 : 1);
