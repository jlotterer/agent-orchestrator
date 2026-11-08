#!/usr/bin/env node
/**
 * End-to-end test for TASK-09 (architecture §5, §7.1, §7.4, §14; decisions 0011, 0012):
 *   multi   : one daemon, two registered repos ("alpha" with three independent tasks, "beta" with one),
 *             server.json `scheduler.maxAgents: 1`. Polls that never more than one task is active, that
 *             beta's task starts before alpha's third (fair share, REQ-PROJ-09), that a second plan or a
 *             start while the project has an unfinished run is refused naming that run (REQ-PROJ-07), that
 *             worktrees live under ORCH_HOME, and that ntfy titles captured by a local HTTP sink name the
 *             project (REQ-HITL-02).
 *   legacy  : an old-style orch.config.json plus a 0.1-schema database holding a finished run. On first
 *             start the repo becomes a project, server.json is written, the settings file is reduced to
 *             project keys (original kept as .bak) and the old run is visible with its decisions (REQ-PROJ-10).
 *
 *   node scripts/e2e-multi.mjs             # both scenarios
 *   node scripts/e2e-multi.mjs legacy      # one of them
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import Database from "better-sqlite3";
import { makeRepo, writeConfig, startDaemon, api as apiFor, waitFor, cleanup, sleep, FAKE_AGENT } from "./lib/e2e.mjs";
import { Store } from "../dist/db.js";
import { registerProject } from "../dist/projects.js";

const PORT = 4841;
const LEGACY_PORT = 4842;
const ACTIVE = ["running", "validating"];
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const AGENTS = {
  timeoutMinutes: 2,
  adapters: { claude: { type: "claude", command: FAKE_AGENT, extraArgs: [], env: {} } },
  roles: { planner: { adapter: "claude", model: "" }, worker: { adapter: "claude", model: "" }, validator: { adapter: "claude", model: "" } },
};

/** POST without throwing: { status, body }. */
const rawPost = async (port, p, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

/** A local stand-in for ntfy: records the Title header of every POST. */
async function startSink() {
  const titles = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => { titles.push(String(req.headers.title ?? "")); res.end("ok"); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { titles, url: `http://127.0.0.1:${server.address().port}/orch-e2e`, close: () => server.close() };
}

// ------------------------------------------------------------------ scenario: two projects, one agent slot
async function multi() {
  const a = makeRepo({
    prefix: "orch-e2e-multi-a-",
    files: {
      "README.md": "# alpha\n",
      "specs/001-a/spec.md": "# Feature Specification: Alpha\n\nFiles in impl/.\n",
      "specs/001-a/tasks.md": "# Tasks\n\n## Phase 1: Core\n- [ ] T001 [P] Create impl/T001.txt\n- [ ] T005 [P] Create impl/T005.txt\n- [ ] T006 [P] Create impl/T006.txt\n",
    },
  });
  const b = makeRepo({
    prefix: "orch-e2e-multi-b-",
    files: {
      "README.md": "# beta\n",
      "specs/001-b/spec.md": "# Feature Specification: Beta\n\nFiles in impl/.\n",
      "specs/001-b/tasks.md": "# Tasks\n\n## Phase 1: Core\n- [ ] T001 Create impl/T001.txt\n",
    },
  });
  const home = a.home;
  const sink = await startSink();
  try {
    // New-style install: server.json in ORCH_HOME, project settings in each repo, both repos registered.
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "server.json"), JSON.stringify({
      port: PORT, publicUrl: `http://localhost:${PORT}`, agents: AGENTS,
      scheduler: { maxAgents: 1, tickSeconds: 1 },
      notify: { ntfyUrl: sink.url },
    }, null, 2));
    // maxParallel 3: only the global cap may serialize alpha's tasks.
    for (const r of [a, b]) writeConfig(r.repo, { baseBranch: "main", scheduler: { maxParallel: 3 }, validation: { command: "", agent: true }, git: { pr: false } });
    const store = new Store(path.join(home, "orch.db"));
    const pa = (await registerProject(store, a.repo, { name: "alpha" })).project;
    const pb = (await registerProject(store, b.repo, { name: "beta" })).project;
    store.db.close();
    console.log(`registered ${pa.id} (alpha) and ${pb.id} (beta)`);

    await startDaemon({ cwd: a.tmp, port: PORT, env: { ORCH_HOME: home }, name: "multi" });
    const api = apiFor(PORT);

    // Plans go to the project whose repo contains the spec dir.
    const runA = await api("POST", "/api/plan", { specDir: path.join(a.repo, "specs/001-a"), llm: false });
    const runB = await api("POST", "/api/plan", { specDir: path.join(b.repo, "specs/001-b"), llm: false });
    assert(runA.project_id === pa.id && runB.project_id === pb.id, `runs in the wrong projects: ${runA.project_id}, ${runB.project_id}`);
    const stateB = await api("GET", `/api/state?project=${pb.id}`);
    assert(stateB.project?.name === "beta" && stateB.run?.id === runB.id, "GET /api/state?project= did not show beta's run");

    // REQ-PROJ-07: a second plan while alpha's run is unfinished is refused, naming that run.
    const again = await rawPost(PORT, "/api/plan", { specDir: path.join(a.repo, "specs/001-a"), llm: false });
    assert(again.status === 400 && again.body.error?.includes(runA.id), `second plan in alpha should be refused naming ${runA.id}: ${again.status} ${JSON.stringify(again.body)}`);
    console.log("refused:", again.body.error);

    for (const r of [runA, runB]) await api("POST", `/api/runs/${r.id}/approve`);
    await api("POST", `/api/runs/${runA.id}/start`);
    await api("POST", `/api/runs/${runB.id}/start`);

    // REQ-PROJ-08: poll both runs; never more than one task active with maxAgents 1.
    let maxActive = 0, samples = 0;
    await waitFor(async () => {
      const [sa, sb] = await Promise.all([api("GET", `/api/runs/${runA.id}`), api("GET", `/api/runs/${runB.id}`)]);
      const tasks = [...sa.tasks, ...sb.tasks];
      const failed = tasks.find((t) => t.status === "failed");
      if (failed) throw new Error(`task failed: ${failed.key}\n${failed.last_feedback}`);
      const active = tasks.filter((t) => ACTIVE.includes(t.status)).length;
      maxActive = Math.max(maxActive, active);
      samples++;
      return sa.run.status === "done" && sb.run.status === "done";
    }, { timeoutMs: 120_000, intervalMs: 40, label: "both runs to finish" });
    assert(maxActive === 1, `expected at most (and at some point) 1 active task across projects, saw ${maxActive} (${samples} samples)`);
    console.log(`cap: at most ${maxActive} active task over ${samples} samples`);

    // REQ-PROJ-09: beta's only task starts before alpha's third (event ids are global and increasing).
    const starts = async (run) => (await api("GET", `/api/runs/${run.id}/events?limit=2000`))
      .filter((e) => e.kind === "state" && /^worker started/.test(e.data.message ?? ""));
    const [startsA, startsB] = [await starts(runA), await starts(runB)];
    assert(startsA.length === 3 && startsB.length === 1, `expected 3 + 1 worker starts, got ${startsA.length} + ${startsB.length}`);
    assert(startsB[0].id < startsA[2].id, `beta's task (event ${startsB[0].id}) should start before alpha's third (event ${startsA[2].id})`);
    console.log(`fairness: start order ${[...startsA.map((e) => ["alpha", e.id]), ["beta", startsB[0].id]].sort((x, y) => x[1] - y[1]).map((x) => x[0]).join(" → ")}`);

    // REQ-OPS-06: worktrees live under ORCH_HOME/worktrees/<project-id>.
    for (const [run, p] of [[runA, pa], [runB, pb]]) {
      const evs = await api("GET", `/api/runs/${run.id}/events?limit=2000`);
      const wt = evs.filter((e) => e.kind === "git" && /^worktree /.test(e.data.message ?? ""));
      const dir = path.join(home, "worktrees", p.id) + path.sep;
      assert(wt.length > 0 && wt.every((e) => e.data.message.includes(dir)), `${p.id} worktrees not under ${dir}: ${wt.map((e) => e.data.message).join("; ")}`);
    }
    assert(a.sh("ls impl").trim().split("\n").length === 3 && b.sh("ls impl").trim() === "T001.txt", "work did not land on each repo's main");

    // REQ-HITL-02: every notification names its project.
    await waitFor(() => sink.titles.some((t) => t.startsWith("[alpha] Run complete")) && sink.titles.some((t) => t.startsWith("[beta] Run complete")),
      { timeoutMs: 5_000, label: "run-complete notifications" }).catch(() => { throw new Error("notifications: " + JSON.stringify(sink.titles)); });
    assert(sink.titles.every((t) => /^\[(alpha|beta)\] /.test(t)), "a notification title lacks the project name: " + JSON.stringify(sink.titles));
    console.log("notifications:", sink.titles.join(" | "));

    // REQ-PROJ-07 for start: a stopped run cannot start again while a newer run of its project is unfinished.
    const b2 = await api("POST", "/api/plan", { specDir: path.join(b.repo, "specs/001-b"), llm: false });
    await api("POST", `/api/runs/${b2.id}/approve`);
    await api("POST", `/api/runs/${b2.id}/stop`);
    const b3 = await api("POST", "/api/plan", { specDir: path.join(b.repo, "specs/001-b"), llm: false });
    const restart = await rawPost(PORT, `/api/runs/${b2.id}/start`);
    assert(restart.status === 400 && restart.body.error?.includes(b3.id), `starting ${b2.id} should be refused naming ${b3.id}: ${restart.status} ${JSON.stringify(restart.body)}`);
    console.log("refused:", restart.body.error);
  } finally {
    sink.close();
  }
}

// ------------------------------------------------------------------ scenario: upgrade a single-repo install
/** The 0.1 schema as released (same as test/unit/db.test.mjs), before projects and user_version. */
const SCHEMA_0_1 = `
CREATE TABLE runs (id TEXT PRIMARY KEY, spec_dir TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
  base_branch TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, notes TEXT);
CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), key TEXT NOT NULL, title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', acceptance TEXT NOT NULL DEFAULT '[]', depends_on TEXT NOT NULL DEFAULT '[]',
  parallel INTEGER NOT NULL DEFAULT 0, phase TEXT, order_idx INTEGER NOT NULL, status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 2, merge_policy TEXT NOT NULL DEFAULT 'auto',
  validate_cmd TEXT, worktree TEXT, branch TEXT, pr_url TEXT, session_id TEXT, summary TEXT, files TEXT NOT NULL DEFAULT '[]',
  last_feedback TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(run_id, key));
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, task_id TEXT, ts TEXT NOT NULL,
  kind TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, task_id TEXT, ts TEXT NOT NULL,
  actor TEXT NOT NULL, text TEXT NOT NULL, rationale TEXT);
CREATE TABLE questions (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, task_id TEXT NOT NULL, ts TEXT NOT NULL,
  text TEXT NOT NULL, options TEXT NOT NULL DEFAULT '[]', answer TEXT, answered_at TEXT);
`;

async function legacy() {
  const c = makeRepo({ prefix: "orch-e2e-legacy-", files: { "README.md": "# old\n", "specs/001-old/tasks.md": "# Tasks\n\n- [x] T001 Old work\n" } });
  const legacyCfg = {
    repo: ".", baseBranch: "main", worktreeDir: "../wt", dbPath: ".orch/orch.db", port: LEGACY_PORT, publicUrl: `http://localhost:${LEGACY_PORT}`,
    agents: AGENTS,
    scheduler: { maxParallel: 2, tickSeconds: 1, maxAttempts: 3, resumeOnRetry: true },
    validation: { command: "true", agent: true },
    git: { pr: false, mergePolicy: "auto", squash: true, copyFiles: [], setupCommand: "", ghCommand: "gh" },
  };
  writeConfig(c.repo, legacyCfg);

  // The database a previous single-repo version left behind: one completed run with a task, a decision, a question.
  const TS = "2026-01-01T00:00:00.000Z";
  fs.mkdirSync(path.join(c.repo, ".orch"));
  const db = new Database(path.join(c.repo, ".orch", "orch.db"));
  db.exec(SCHEMA_0_1);
  db.prepare("INSERT INTO runs VALUES ('oldrun1', ?, 'Old feature', 'done', 'main', ?, ?, NULL)").run(path.join(c.repo, "specs/001-old"), TS, TS);
  db.prepare(`INSERT INTO tasks (id, run_id, key, title, order_idx, status, attempt, summary, created_at, updated_at)
    VALUES ('oldtask1', 'oldrun1', 'T001', 'Old work', 0, 'done', 1, 'did the old work', ?, ?)`).run(TS, TS);
  db.prepare("INSERT INTO decisions (run_id, task_id, ts, actor, text, rationale) VALUES ('oldrun1', 'oldtask1', ?, 'worker', 'Chose the old way', 'it was simpler')").run(TS);
  db.prepare("INSERT INTO questions (run_id, task_id, ts, text, options, answer, answered_at) VALUES ('oldrun1', 'oldtask1', ?, 'Old question?', '[]', 'yes', ?)").run(TS, TS);
  db.close();

  await startDaemon({ cwd: c.repo, port: LEGACY_PORT, env: { ORCH_HOME: c.home }, name: "legacy" });
  const api = apiFor(LEGACY_PORT);
  const s = await api("GET", "/api/state");
  assert(s.project && fs.realpathSync(s.project.repo) === fs.realpathSync(c.repo), "the legacy repo was not registered as a project: " + JSON.stringify(s.project));
  assert(s.run?.id === "oldrun1" && s.run.status === "done" && s.run.project_id === s.project.id, "the old run is not visible in the project: " + JSON.stringify(s.run));
  assert(s.tasks.length === 1 && s.tasks[0].summary === "did the old work", "the old run's task is missing");
  assert(s.questions.length === 1 && s.questions[0].answer === "yes", "the old run's question is missing");
  const decisions = s.decisions.map((d) => `${d.actor}:${d.text}`);
  assert(decisions.includes("worker:Chose the old way"), "the old decision is missing: " + decisions.join("; "));
  assert(decisions.includes(`orchestrator:Upgraded single-repo install to project ${s.project.id}`), "no upgrade decision: " + decisions.join("; "));

  // Settings split: server keys in server.json, project keys stay in the repo, the original kept as .bak.
  const server = JSON.parse(fs.readFileSync(path.join(c.home, "server.json"), "utf8"));
  assert(server.port === LEGACY_PORT && server.scheduler.maxAgents === 2 && server.scheduler.tickSeconds === 1 && server.agents?.adapters?.claude && server.git?.ghCommand === "gh",
    "server.json is missing settings: " + JSON.stringify(server));
  const project = JSON.parse(fs.readFileSync(path.join(c.repo, "orch.config.json"), "utf8"));
  for (const k of ["repo", "agents", "port", "dbPath", "worktreeDir", "publicUrl"]) assert(!(k in project), `orch.config.json still has '${k}'`);
  assert(!("tickSeconds" in project.scheduler) && !("ghCommand" in project.git), "orch.config.json still has server-only nested keys");
  assert(project.scheduler.maxAttempts === 3 && project.validation.command === "true", "project settings were lost: " + JSON.stringify(project));
  assert(JSON.stringify(JSON.parse(fs.readFileSync(path.join(c.repo, "orch.config.json.bak"), "utf8"))) === JSON.stringify(legacyCfg), ".bak is not the original file");
  assert(fs.existsSync(path.join(c.home, "orch.db")), "the database was not copied into ORCH_HOME");
  assert(s.config.maxAttempts === 3 && s.config.maxAgents === 2, "effective config does not come from the split files: " + JSON.stringify(s.config));

  // The upgraded project works: a new run plans and runs to completion.
  fs.writeFileSync(path.join(c.repo, "specs/001-old/tasks.md"), "# Tasks\n\n- [x] T001 Old work\n- [ ] T005 New work\n");
  c.sh("git commit -qam 'new task'");
  const run = await api("POST", "/api/plan", { specDir: path.join(c.repo, "specs/001-old"), llm: false });
  await api("POST", `/api/runs/${run.id}/approve`);
  await api("POST", `/api/runs/${run.id}/start`);
  await waitFor(async () => (await api("GET", "/api/state")).run?.status === "done", { timeoutMs: 60_000, intervalMs: 300, label: "new run in the upgraded project" });
  const runs = (await api("GET", "/api/state")).runs.map((r) => r.id);
  assert(runs.includes("oldrun1") && runs.includes(run.id), "runs list should hold the old and the new run: " + runs.join());
  console.log(`upgraded to project ${s.project.id}; old run visible; new run ${run.id} done`);
}

// ------------------------------------------------------------------ runner
const scenarios = { multi, legacy };
const only = process.argv.slice(2);
let failed = 0;
for (const [name, fn] of Object.entries(scenarios)) {
  if (only.length && !only.includes(name)) continue;
  console.log(`\n=== ${name}`);
  let ok = false;
  try { await fn(); ok = true; } catch (e) { failed++; console.error(`FAILED ${name}: ${e.message}`); }
  await cleanup({ ok });
  await sleep(100);
}
console.log(failed ? `E2E-MULTI FAILED (${failed})` : "E2E-MULTI PASSED");
process.exit(failed ? 1 : 0);
