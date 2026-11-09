/**
 * Planning from briefs (TASK-22; REQ-INTAKE-11, REQ-INTAKE-12, architecture §6.2, §6.4): `Orchestrator.plan` on the
 * `full` fixture folder with the fake agent (scripts/fake-agent.mjs) as the planner. Its planner returns
 * `impl/<KEY>.txt exists and contains OK` as the only criterion of every task it is given.
 * Run after `npm run build`: npm run test:unit
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store } from "../../dist/db.js";
import { Orchestrator } from "../../dist/orchestrator.js";
import { DEFAULT_SERVER_CONFIG } from "../../dist/config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FULL = path.join(ROOT, "test/fixtures/spec-dir/full");
const EXPECTED = JSON.parse(fs.readFileSync(path.join(ROOT, "test/fixtures/spec-dir/full.expected.json"), "utf8"));
const PLANNED = (key) => [`impl/${key}.txt exists and contains OK`];

let tmp, store, orch, repo, prompts;

before(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "orch-plan-test-")));
  const home = path.join(tmp, "home");
  repo = path.join(tmp, "repo");
  prompts = path.join(tmp, "prompts");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  execSync("git init -q -b main && git -c user.name=t -c user.email=t@x commit -q --allow-empty -m init", { cwd: repo });
  store = new Store(path.join(home, "orch.db"));
  store.addProject({ id: "demo", name: "Demo", repo_path: repo });
  const server = {
    ...DEFAULT_SERVER_CONFIG,
    agents: { ...DEFAULT_SERVER_CONFIG.agents, adapters: { claude: { type: "claude", command: path.join(ROOT, "scripts/fake-agent.mjs"), extraArgs: [], env: { FAKE_PROMPT_DIR: prompts } } } },
  };
  orch = new Orchestrator(server, store, { home });
});
after(() => {
  store.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A copy of the `full` folder in the repo, changed by `edit`. */
function folder(name, edit = () => {}) {
  const dir = path.join(repo, "specs", name);
  fs.cpSync(FULL, dir, { recursive: true });
  edit(dir);
  return dir;
}
const plannerCalls = () => (fs.existsSync(prompts) ? fs.readdirSync(prompts) : []).map((f) => fs.readFileSync(path.join(prompts, f), "utf8")).filter((p) => p.startsWith("You are the PLANNER"));
const tasksOf = (run) => Object.fromEntries(store.listTasks(run.id).map((t) => [t.key, t]));
const decisionsOf = (run) => store.listDecisions(run.id).map((d) => d.text);
const close = (run) => store.setRunStatus(run.id, "stopped");

test("every task has brief criteria: the plan is the briefs' values and no agent is called (REQ-INTAKE-11/12)", async () => {
  const before = plannerCalls().length;
  const run = await orch.plan("demo", folder("all"), { llm: true });
  close(run);
  assert.equal(run.status, "plan_pending");
  assert.equal(plannerCalls().length, before, "no planner call");
  const tasks = tasksOf(run);
  for (const e of EXPECTED.tasks) {
    const t = tasks[e.key];
    assert.deepEqual(
      [t.depends_on, !!t.parallel, t.merge_policy, t.validate_mode, t.validate_cmd, t.files_owned, t.acceptance],
      [e.depends_on, e.parallel, e.merge_policy, e.validate_mode, e.validate_cmd, e.files_owned, e.acceptance], e.key);
  }
  const d = decisionsOf(run);
  assert.ok(d.includes("Plan built from briefs; the planner was not run"));
  assert.ok(d.includes("T004: tasks.md marks [P] but the brief says parallel: false; the brief wins"));
});

test("a task without a brief: the planner runs once, for that task only (REQ-INTAKE-12)", async () => {
  const before = plannerCalls().length;
  const run = await orch.plan("demo", folder("partial", (d) => fs.rmSync(path.join(d, "tasks/T003.md"))), { llm: true });
  close(run);
  const calls = plannerCalls().slice(before);
  assert.equal(calls.length, 1);
  const json = JSON.parse(calls[0].match(/## Tasks to plan[\s\S]*?```json\n([\s\S]*?)\n```/)[1]);
  assert.deepEqual(json.map((t) => t.key), ["T003"]);
  const tasks = tasksOf(run);
  assert.deepEqual(tasks.T003.acceptance, PLANNED("T003"));
  for (const e of EXPECTED.tasks.filter((x) => x.key !== "T003")) assert.deepEqual(tasks[e.key].acceptance, e.acceptance, e.key);
  assert.ok(decisionsOf(run).includes("Planner runs for T003 only"));
});

test("--review: brief criteria are kept, the planner's are appended and recorded; brief values win (REQ-INTAKE-12)", async () => {
  const before = plannerCalls().length;
  const run = await orch.plan("demo", folder("review"), { llm: true, review: true });
  close(run);
  assert.equal(plannerCalls().length - before, 1);
  const tasks = tasksOf(run);
  for (const e of EXPECTED.tasks) {
    assert.deepEqual(tasks[e.key].acceptance, [...e.acceptance, ...PLANNED(e.key)], e.key);
    assert.equal(tasks[e.key].merge_policy, e.merge_policy, `${e.key}: the fake planner's merge policy must not override the brief's`);
  }
  assert.ok(decisionsOf(run).includes("Added 1 acceptance criterion to T001; the brief's 4 kept"));
});

test("--review: a planner that drops dependencies never removes tasks of earlier phases (REQ-INTAKE-02)", async () => {
  const run = await orch.plan("demo", folder("dropdeps", (d) => fs.appendFileSync(path.join(d, "spec.md"), "\nPLANNER_DROP_DEPS\n")), { llm: true, review: true });
  close(run);
  const tasks = tasksOf(run);
  assert.deepEqual(tasks.T002.depends_on, ["T001"], "T002 keeps its earlier-phase dependency; nothing changed, no decision");
  assert.deepEqual(tasks.T004.depends_on, ["T001"], "T004's brief list is corrected, but T001 (phase 1) stays");
  const d = decisionsOf(run);
  assert.ok(d.includes("Changed T004's dependencies from [T001, T002, T003] to [T001]"));
  assert.ok(!d.some((x) => x.startsWith("Changed T002's dependencies")));
});

test("errors refuse the plan without creating a run; allowOpen records the override (REQ-INTAKE-13)", async () => {
  const dir = folder("open", (d) => fs.appendFileSync(path.join(d, "tasks/T002.md"), "\nTBD: the logout redirect.\n"));
  const runs = store.listRuns ? store.listRuns().length : null;
  await assert.rejects(orch.plan("demo", dir, { llm: false }), /1 error in .*tasks\/T002\.md:\d+ unresolved marker "TBD".*--allow-open/);
  if (runs !== null) assert.equal(store.listRuns().length, runs);
  const run = await orch.plan("demo", dir, { llm: false, allowOpen: true });
  close(run);
  assert.ok(decisionsOf(run).includes("Planned despite 1 error in the feature folder (--allow-open)"));
});

test("--review cannot be combined with --no-llm", async () => {
  await assert.rejects(orch.plan("demo", folder("nollm"), { llm: false, review: true }), /--review/);
});
