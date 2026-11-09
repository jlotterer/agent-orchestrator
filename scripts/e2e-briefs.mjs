#!/usr/bin/env node
/**
 * Planning from briefs and the context every agent gets (TASK-22; REQ-INTAKE-11/12/13/14, REQ-WORK-09/11,
 * REQ-VAL-10/11). The feature folder is the `full` fixture of architecture §6.4 (test/fixtures/spec-dir/full),
 * copied into a repo that also has `AGENTS.md` (the project rules) and `docs/requirements.md` (the sample file).
 * Every prompt the fake agent receives is saved on its own (FAKE_PROMPT_DIR), so the scenarios can check what
 * reached which agent.
 *   (a) `orch plan` on `full`: no planner call, the plan has the briefs' values, the [P] conflict and
 *       "plan built from briefs" are decisions; `--review`: one planner call over every task, T001 keeps its
 *       brief criteria plus the planner's addition (recorded), T004 keeps the brief's merge policy;
 *       the HTTP plan route refuses the `bad` fixture (400 naming spec.md:15) and `allowOpen` records the override
 *       and the warnings as decisions
 *   (b) T003's brief removed: one planner call, for T003 only; only T003's criteria come from it
 *   (c) a run of `full` (made runnable: no validate commands, no UI, auto merge, BREAK_RULE in T001's brief,
 *       briefChars 1800): the worker prompt holds brief → REQ rows → contract → rules → hand-off, in that order;
 *       the validator prompt holds the same and not the worker's log; the T001 validator rejects quoting the
 *       rule and the retry's feedback carries the quote; cuts are decisions; the phase validator gets spec.md,
 *       the briefs' frontmatter and the rules; the run finishes
 *
 *   node scripts/e2e-briefs.mjs          # all scenarios
 *   node scripts/e2e-briefs.mjs c        # only (c)
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeRepo, writeConfig, startDaemon, api as apiFor, waitFor, cleanup, FAKE_AGENT, ROOT } from "./lib/e2e.mjs";

const BASE_PORT = 4891;
const FIXTURES = path.join(ROOT, "test/fixtures/spec-dir");
const EXPECTED = JSON.parse(fs.readFileSync(path.join(FIXTURES, "full.expected.json"), "utf8"));
const RULE = "Never write RULE_BROKEN into a file in impl/.";
const AGENTS_MD = `# Agent rules\n\n- Keep each task to its own files.\n- ${RULE}\n`;

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const decided = (s, text) => s.decisions.filter((d) => d.text.startsWith(text));
const task = (s, key) => s.tasks.find((t) => t.key === key);

/** A repo with AGENTS.md, docs/requirements.md and the given feature folders; a daemon on `port`. */
async function setup(port, { handoff = {} } = {}) {
  const { repo, home, tmp } = makeRepo({
    prefix: "orch-e2e-briefs-",
    files: {
      "README.md": "# demo\n", "AGENTS.md": AGENTS_MD,
      "docs/requirements.md": fs.readFileSync(path.join(ROOT, "test/fixtures/requirements.sample.md"), "utf8"),
    },
  });
  const prompts = path.join(tmp, "prompts");
  writeConfig(repo, {
    port, publicUrl: `http://localhost:${port}`,
    agents: {
      timeoutMinutes: 2,
      adapters: { claude: { type: "claude", command: FAKE_AGENT, extraArgs: [], env: { FAKE_PROMPT_DIR: prompts } } },
      roles: { planner: { adapter: "claude", model: "" }, worker: { adapter: "claude", model: "" }, validator: { adapter: "claude", model: "" } },
    },
    scheduler: { maxParallel: 2, tickSeconds: 1, maxAttempts: 3, resumeOnRetry: false },
    validation: { command: "", agent: true, phase: { enabled: true, command: "", maxFixups: 1 } },
    git: { pr: false, mergePolicy: "auto", squash: true, copyFiles: [], setupCommand: "" },
    handoff,
  });
  await startDaemon({ cwd: repo, port, env: { ORCH_HOME: home, FAKE_PROMPT_DIR: prompts }, name: `d${port}` });
  const api = apiFor(port);
  const cliEnv = { ...process.env, ORCH_HOME: home, ORCH_URL: `http://127.0.0.1:${port}`, ORCH_TOKEN: "", ORCH_PROJECT: "" };
  const h = {
    repo, api,
    state: () => api("GET", "/api/state"),
    /** Copy a fixture folder into specs/<name>, then let `edit(dir)` change it. */
    folder: (fixture, name, edit = () => {}) => {
      const dir = path.join(repo, "specs", name);
      fs.cpSync(path.join(FIXTURES, fixture), dir, { recursive: true });
      edit(dir);
      return dir;
    },
    cli: (...args) => spawnSync("node", [path.join(ROOT, "dist/cli.js"), ...args], { cwd: repo, encoding: "utf8", env: cliEnv }),
    /** Every prompt received so far, oldest first, with its role and task key. */
    prompts: () => (fs.existsSync(prompts) ? fs.readdirSync(prompts).sort((a, b) => parseInt(a) - parseInt(b) || a.localeCompare(b)) : []).map((f) => {
      const text = fs.readFileSync(path.join(prompts, f), "utf8");
      const role = text.startsWith("You are the PLANNER") ? "planner" : text.startsWith("You are the PHASE VALIDATOR") ? "phase" : text.startsWith("You are the VALIDATOR") ? "validator" : "worker";
      return { role, key: (text.match(/# Task (T\d+)/) || [])[1] ?? null, text };
    }),
    stopRun: async () => { const s = await h.state(); if (s.run) await api("POST", `/api/runs/${s.run.id}/stop`); },
    raw: async (p, body) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    },
  };
  return h;
}

/** `needle`s appear in `text` in this order; returns their indexes. */
function inOrder(text, needles, what) {
  let at = -1;
  for (const n of needles) {
    const i = text.indexOf(n, at + 1);
    assert(i > at, `${what}: "${n}" missing or out of order\n---\n${text.slice(0, 6000)}`);
    at = i;
  }
}

const scenarios = {
  async a(port) {
    const h = await setup(port);
    const dir = h.folder("full", "002-auth");

    // REQ-INTAKE-11/12: every task has brief criteria → the plan is built without an agent.
    const r = h.cli("plan", dir);
    assert(r.status === 0, `orch plan exited ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert(r.stdout.includes("plan built from the briefs"), `CLI does not say the plan comes from the briefs:\n${r.stdout}`);
    let s = await h.state();
    assert(s.run?.status === "plan_pending", `run status ${s.run?.status}`);
    assert(h.prompts().length === 0, `an agent was called: ${h.prompts().map((p) => p.role)}`);
    for (const e of EXPECTED.tasks) {
      const t = task(s, e.key);
      const got = { depends_on: t.depends_on, parallel: !!t.parallel, merge_policy: t.merge_policy, validate_mode: t.validate_mode, validate_cmd: t.validate_cmd, files_owned: t.files_owned, acceptance: t.acceptance };
      const want = { depends_on: e.depends_on, parallel: e.parallel, merge_policy: e.merge_policy, validate_mode: e.validate_mode, validate_cmd: e.validate_cmd, files_owned: e.files_owned, acceptance: e.acceptance };
      assert(JSON.stringify(got) === JSON.stringify(want), `${e.key} plan values differ from the brief:\n got ${JSON.stringify(got)}\nwant ${JSON.stringify(want)}`);
    }
    assert(decided(s, "Plan built from briefs; the planner was not run").length === 1, "no 'plan built from briefs' decision");
    const conflict = decided(s, "T004: tasks.md marks [P] but the brief says parallel: false; the brief wins");
    assert(conflict.length === 1 && conflict[0].task_id === task(s, "T004").id, "the [P] conflict is not a decision on T004");
    assert(s.inbox.some((i) => i.type === "approve_plan"), "approve_plan not in the inbox");
    console.log("  plan from briefs: no agent, brief values, conflict and 'built from briefs' decisions");

    // REQ-INTAKE-12 --review: one planner call over the whole plan; brief criteria kept, additions recorded.
    await h.stopRun();
    const rv = h.cli("plan", "--review", dir);
    assert(rv.status === 0, `orch plan --review exited ${rv.status}\n${rv.stdout}\n${rv.stderr}`);
    const planners = h.prompts().filter((p) => p.role === "planner");
    assert(planners.length === 1, `--review: ${planners.length} planner calls`);
    const pp = planners[0].text;
    assert(pp.includes("This is a review of the whole plan") && pp.includes("These tasks already have criteria from their briefs. Do not remove or rewrite them"), "planner prompt lacks the review section");
    for (const k of ["T001", "T002", "T003", "T004"]) assert(pp.includes(`"key": "${k}"`), `review planner prompt lacks ${k}`);
    assert(pp.includes("### Rules: AGENTS.md") && pp.includes(RULE), "planner prompt lacks the project rules (REQ-WORK-11)");
    s = await h.state();
    const t1 = task(s, "T001"), want1 = EXPECTED.tasks[0].acceptance;
    assert(JSON.stringify(t1.acceptance) === JSON.stringify([...want1, "impl/T001.txt exists and contains OK"]), `T001 criteria after review: ${JSON.stringify(t1.acceptance)}`);
    assert(decided(s, "Added 1 acceptance criterion to T001; the brief's 4 kept").length === 1, "the planner's addition is not a decision");
    assert(task(s, "T004").merge_policy === "auto", "the planner overrode the brief's merge policy of T004");
    assert(decided(s, "Planner reviews the whole plan (--review)").length === 1, "no review decision");
    console.log("  --review: one planner call, brief criteria kept, addition recorded, brief values kept");

    // REQ-INTAKE-13 on the HTTP route: errors refuse the plan; allowOpen records the override and the warnings.
    await h.stopRun();
    const bad = h.folder("bad", "009-bad");
    const runsBefore = (await h.state()).runs.length;
    const refused = await h.raw("/api/plan", { specDir: bad, llm: false });
    assert(refused.status === 400 && /1 error in .*spec\.md:15 unresolved marker "TBD".*--allow-open/.test(refused.body.error), `bad folder not refused: ${JSON.stringify(refused)}`);
    assert((await h.state()).runs.length === runsBefore, "a refused plan created a run");
    const allowed = await h.raw("/api/plan", { specDir: bad, llm: false, allowOpen: true });
    assert(allowed.status === 200, `allowOpen plan: ${JSON.stringify(allowed)}`);
    s = await h.state();
    assert(decided(s, "Planned despite 1 error in the feature folder (--allow-open)").length === 1, "the override is not a decision");
    const warnings = decided(s, "Import warning: ");
    for (const k of ["tasks/T003.md:22 T002 and T003 are both parallel and both list src/auth/session.ts", "tasks/T004.md:1 brief is 8265 characters", "tasks/T005.md:9 task appears to add only tests"]) {
      assert(warnings.some((d) => d.text.includes(k)), `warning not recorded: ${k}\n${warnings.map((d) => d.text).join("\n")}`);
    }
    assert(warnings.find((d) => d.text.includes("tasks/T005.md")).task_id === task(s, "T005").id, "a brief's warning is not on its task");
    await h.stopRun();
    console.log("  HTTP plan refuses errors; allowOpen records the override and three warnings");
  },

  async b(port) {
    const h = await setup(port);
    const dir = h.folder("full", "003-partial", (d) => fs.rmSync(path.join(d, "tasks/T003.md")));
    const run = await h.api("POST", "/api/plan", { specDir: dir, llm: true });
    await waitFor(async () => (await h.state()).run?.status === "plan_pending", { timeoutMs: 30_000, label: "plan ready" });
    const planners = h.prompts().filter((p) => p.role === "planner");
    assert(planners.length === 1, `${planners.length} planner calls`);
    const json = JSON.parse(planners[0].text.match(/## Tasks to plan[\s\S]*?```json\n([\s\S]*?)\n```/)[1]);
    assert(JSON.stringify(json.map((t) => t.key)) === '["T003"]', `planner saw ${json.map((t) => t.key)}`);
    assert(planners[0].text.includes("Only the tasks below need planning"), "planner prompt lacks the subset note");
    const s = await h.state();
    assert(JSON.stringify(task(s, "T003").acceptance) === '["impl/T003.txt exists and contains OK"]', `T003: ${JSON.stringify(task(s, "T003").acceptance)}`);
    for (const e of EXPECTED.tasks.filter((t) => t.key !== "T003")) {
      assert(JSON.stringify(task(s, e.key).acceptance) === JSON.stringify(e.acceptance), `${e.key}'s criteria changed: ${JSON.stringify(task(s, e.key).acceptance)}`);
    }
    assert(task(s, "T004").merge_policy === "auto", "planner output applied to T004 outside the subset");
    assert(decided(s, "Planner runs for T003 only").length === 1, "no subset decision");
    await h.api("POST", `/api/runs/${run.id}/stop`);
    console.log("  one planner call for T003 only; the other tasks keep their brief criteria");
  },

  async c(port) {
    const h = await setup(port, { handoff: { briefChars: 1800 } });
    const dir = h.folder("full", "004-run", (d) => {
      for (const k of ["T001", "T002", "T003", "T004"]) {
        const f = path.join(d, `tasks/${k}.md`);
        let text = fs.readFileSync(f, "utf8")
          .replace(/^validate_command: .*\n/m, "").replace(/^validate: ui$/m, "validate: standard").replace(/^merge_policy: manual$/m, "merge_policy: auto");
        if (k === "T001") text = text.replace(/^(# T001: .*\n)/m, "$1\nBREAK_RULE: in this test the worker breaks a project rule on its first attempt.\n");
        fs.writeFileSync(f, text);
      }
    });
    const run = await h.api("POST", "/api/plan", { specDir: dir, llm: true });
    let s = await h.state();
    assert(s.run.status === "plan_pending" && h.prompts().length === 0, "the runnable folder should plan from briefs");
    assert(decided(s, "Import warning: tasks/T001.md:1 brief is").length === 1, "the brief-size warning is not a decision");
    await h.api("POST", `/api/runs/${run.id}/approve`);
    await h.api("POST", `/api/runs/${run.id}/start`);
    const answered = new Set();
    s = await waitFor(async () => {
      const st = await h.state();
      for (const i of st.inbox) {
        if (i.type === "question" && !answered.has(i.id)) { answered.add(i.id); await h.api("POST", `/api/questions/${i.id}/answer`, { answer: "English" }); }
        if (i.type === "failed") throw new Error(`unexpected failure: ${i.title}\n${i.detail}`);
      }
      return st.run.status === "done" ? st : null;
    }, { timeoutMs: 180_000, intervalMs: 300, label: "run done" });
    const all = h.prompts();
    const of = (role, key) => all.filter((p) => p.role === role && p.key === key);

    // REQ-WORK-09: brief → requirement rows → contracts → rules → hand-off, in that order.
    const w1 = of("worker", "T001");
    assert(w1.length === 2, `T001 worker ran ${w1.length} times, expected 2 (rule broken once)`);
    inOrder(w1[0].text, ["## Brief", "### Brief: tasks/T001.md", "BREAK_RULE", "## Requirements covered", "### Requirements: REQ-AUTH-01 (docs/requirements.md)", "| REQ-AUTH-01 |",
      "## Contracts", "### Contract: SessionStore (spec.md)", "export interface SessionStore", "## Project rules", "### Rules: AGENTS.md", RULE, "## Hand-off from earlier tasks"], "T001 worker prompt");
    assert(!w1[0].text.includes("## Project context (from the spec)"), "a task with a brief also got the spec excerpt");
    assert(w1[0].text.includes("… (truncated, "), "T001's brief over briefChars has no cut marker");
    assert(decided(s, "T001: brief cut from ").some((d) => /to 1800 characters \(handoff\.briefChars\)$/.test(d.text)), "the cut is not a decision");
    inOrder(of("worker", "T003")[0].text, ["### Brief: tasks/T003.md", "### Requirements: REQ-AUTH-03, REQ-AUTH-04 (docs/requirements.md)", "| REQ-AUTH-03 |", "| REQ-AUTH-04 |",
      "### Contract: SessionStore (spec.md)", "### Contract: TokenCodec (spec.md)", "### Contract: contracts/auth-api.md", "### Rules: AGENTS.md", "## Hand-off from earlier tasks"], "T003 worker prompt");

    // REQ-VAL-10: the validator gets the same parts and never the worker's log.
    const v1 = of("validator", "T001");
    assert(v1.length === 2, `T001 validator ran ${v1.length} times`);
    inOrder(v1[0].text, ["### Brief: tasks/T001.md", "### Requirements: REQ-AUTH-01 (docs/requirements.md)", "### Contract: SessionStore (spec.md)", "### Rules: AGENTS.md", "## Diff against"], "T001 validator prompt");
    for (const leak of ["## Hand-off from earlier tasks", "Used a plain text file for T001", "Implemented."]) assert(!v1[0].text.includes(leak), `validator prompt contains the worker's log: ${leak}`);

    // REQ-VAL-11: the rejection quotes the rule, and the retry's feedback carries it.
    const quote = `breaks project rule "${RULE}": impl/T001.txt contains RULE_BROKEN`;
    assert(w1[1].text.includes("## Feedback from the previous attempt") && w1[1].text.includes(quote), `retry prompt lacks the quoted rule:\n${w1[1].text.split("## Feedback")[1]}`);
    const ev = await h.api("GET", `/api/tasks/${task(s, "T001").id}/events`);
    assert(ev.some((e) => e.kind === "verdict" && e.data.verdict === "FAIL" && (e.data.reasons ?? []).includes(quote)), "the FAIL verdict with the quote is not in the task's events");
    assert(task(s, "T001").status === "done" && fs.readFileSync(path.join(h.repo, "impl/T001.txt"), "utf8").trim() === "OK", "T001 not fixed on retry");

    // REQ-WORK-11 / §10.3: the phase validator gets spec.md, each brief's frontmatter and criteria, and the rules.
    const phase2 = all.find((p) => p.role === "phase" && p.text.includes("(phase 2 of 2)"));
    assert(phase2, "no phase 2 validator prompt");
    inOrder(phase2.text, ["### T002", "Brief tasks/T002.md frontmatter:", "covers: [REQ-AUTH-02]", "Acceptance criteria:", "### spec.md", "### SessionStore", "### Rules: AGENTS.md", RULE], "phase validator prompt");
    assert(s.tasks.every((t) => t.status === "done"), "not every task is done");
    console.log("  worker/validator/phase prompts carry brief, REQ rows, contracts and rules; rule break quoted and fixed; run done");
  },
};

const only = process.argv.slice(2);
const keys = Object.keys(scenarios).filter((k) => !only.length || only.includes(k));
let ok = false;
try {
  for (const [i, k] of keys.entries()) {
    console.log(`(${k})`);
    await scenarios[k](BASE_PORT + i);
    await cleanup({ ok: true });
  }
  ok = true;
  console.log(`\nE2E BRIEFS PASSED (${keys.join(", ")})`);
} catch (e) {
  console.error("\nE2E BRIEFS FAILED:", e?.stack ?? e);
  process.exitCode = 1;
} finally {
  await cleanup({ ok });
}
