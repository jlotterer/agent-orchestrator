#!/usr/bin/env node
/**
 * End-to-end test for TASK-09 and TASK-10 (architecture §5, §7.1, §7.4, §14, §15; decisions 0011, 0012):
 *   multi   : one daemon, two registered repos ("alpha" with three independent tasks, "beta" with one),
 *             server.json `scheduler.maxAgents: 1`. Polls that never more than one task is active, that
 *             beta's task starts before alpha's third (fair share, REQ-PROJ-09), that a second plan or a
 *             start while the project has an unfinished run is refused naming that run (REQ-PROJ-07), that
 *             worktrees live under ORCH_HOME, and that ntfy titles captured by a local HTTP sink name the
 *             project (REQ-HITL-02).
 *   projects: a daemon with no projects; the CLI registers two repos (a non-git dir is refused with exit 1, the
 *             starter settings path is printed), resolves the project from the cwd, --project and ORCH_PROJECT,
 *             and exits 2 outside both repos (listing both) and for `orch answer` without arguments. GET /api/inbox
 *             holds items of both projects with project_name; DELETE on a project with a running run is 400; an
 *             archived project leaves the default list and `project add` restores it; the served dashboard
 *             has the project switcher and global inbox element ids (REQ-PROJ-01, -02, -03, -04, REQ-UI-07,
 *             -08, REQ-HITL-01). Alpha's finished run, backdated 40 days, is
 *             archived by `orch archive-events`: a gzip file under ORCH_HOME/archive, one "Log archived to"
 *             event from the log endpoints, decisions kept (TASK-12, REQ-OPS-04).
 *   legacy  : an old-style orch.config.json plus a 0.1-schema database holding a finished run. On first
 *             start the repo becomes a project, server.json is written, the settings file is reduced to
 *             project keys (original kept as .bak) and the old run is visible with its decisions (REQ-PROJ-10).
 *
 *   node scripts/e2e-multi.mjs             # all scenarios
 *   node scripts/e2e-multi.mjs legacy      # one of them
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import Database from "better-sqlite3";
import { makeRepo, writeConfig, startDaemon, api as apiFor, waitFor, cleanup, sleep, FAKE_AGENT, ROOT } from "./lib/e2e.mjs";
import { Store } from "../dist/db.js";
import { registerProject } from "../dist/projects.js";

const PORT = 4841;
const LEGACY_PORT = 4842;
const PROJECTS_PORT = 4843;
const ACTIVE = ["running", "validating"];
/** Stable dashboard element ids (architecture §15.3; TASK-11). */
const DASHBOARD_IDS = ["projectSwitcher", "projectMenu", "projectList", "btnAddProject", "btnArchiveProject", "addProjectDlg", "addProjectErr", "globalInbox", "inboxCount", "projectError", "runSel", "board", "live"];
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

// ------------------------------------------------------------------ scenario: projects API, global inbox, CLI scoping
/** Run the human CLI (`dist/cli.js`) in `cwd`: { code, out, err }. Agent and project variables are cleared unless given. */
function cli(args, { cwd, home, env = {} }) {
  const base = { ...process.env };
  for (const k of ["ORCH_URL", "ORCH_TOKEN", "ORCH_PROJECT", "ORCH_TASK_ID", "ORCH_RUN_ID", "ORCH_CONFIG"]) delete base[k];
  const r = spawnSync("node", [path.join(ROOT, "dist/cli.js"), ...args], { cwd, encoding: "utf8", env: { ...base, ORCH_HOME: home, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const expectExit = (r, code, what) => assert(r.code === code, `${what}: expected exit ${code}, got ${r.code}\nstdout: ${r.out}\nstderr: ${r.err}`);

async function projects() {
  const spec = (name) => ({
    "README.md": `# ${name}\n`,
    "specs/001-x/spec.md": `# Feature Specification: ${name}\n\nFiles in impl/.\n`,
    "specs/001-x/tasks.md": "# Tasks\n\n## Phase 1: Core\n- [ ] T001 Create impl/T001.txt\n",
  });
  const a = makeRepo({ prefix: "orch-e2e-proj-a-", files: spec("alpha") });
  const b = makeRepo({ prefix: "orch-e2e-proj-b-", files: spec("beta") });
  const home = a.home;
  const outside = a.tmp; // contains repo and home, but no registered repo contains it
  const plain = path.join(a.tmp, "plain");
  fs.mkdirSync(plain);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "server.json"), JSON.stringify({ port: PROJECTS_PORT, agents: AGENTS, scheduler: { maxAgents: 2, tickSeconds: 1 } }, null, 2));
  await startDaemon({ cwd: outside, port: PROJECTS_PORT, env: { ORCH_HOME: home }, name: "projects" });
  const api = apiFor(PROJECTS_PORT);
  const run = (args, cwd = outside, env = {}) => cli(args, { cwd, home, env });

  // REQ-PROJ-01: a directory that is not a git repository is refused (exit 1, error on stderr).
  const bad = run(["project", "add", plain]);
  expectExit(bad, 1, "project add <non-git dir>");
  assert(/^error: .*not a git repository/m.test(bad.err), "project add <non-git dir> should say 'not a git repository': " + bad.err);

  // REQ-PROJ-01, -02: registering prints the starter settings path.
  const addA = run(["project", "add", a.repo, "--name", "alpha"]);
  expectExit(addA, 0, "project add alpha");
  const starter = path.join(fs.realpathSync(a.repo), "orch.config.json");
  assert(addA.out.includes(starter) && fs.existsSync(starter), `project add should print the starter settings path ${starter}: ${addA.out}`);
  const addB = run(["project", "add", b.repo, "--name", "beta"]);
  expectExit(addB, 0, "project add beta");
  const again = run(["project", "add", b.repo]);
  expectExit(again, 1, "project add (already registered)");
  assert(again.err.includes("already registered"), "re-adding should name the existing project: " + again.err);
  const list = await api("GET", "/api/projects");
  const pa = list.find((p) => p.name === "alpha"), pb = list.find((p) => p.name === "beta");
  assert(list.length === 2 && pa && pb, "GET /api/projects should list alpha and beta: " + JSON.stringify(list));
  // Project settings: no validation command, agent validator (the fake agent).
  for (const r of [a, b]) writeConfig(r.repo, { baseBranch: "main", validation: { command: "", agent: true }, git: { pr: false } });

  // REQ-UI-07: inside repo B, status shows B; --project and ORCH_PROJECT pick a project explicitly.
  const inB = run(["status"], path.join(b.repo, "specs"));
  expectExit(inB, 0, "status inside repo B");
  assert(inB.out.startsWith(`project ${pb.id} "beta"`), "status inside repo B should show beta: " + inB.out);
  const flagged = run(["status", "--project", pa.id], b.repo);
  expectExit(flagged, 0, "status --project");
  assert(flagged.out.startsWith(`project ${pa.id} `), "--project should win over the cwd: " + flagged.out);
  const envd = run(["status"], b.repo, { ORCH_PROJECT: pa.id });
  assert(envd.code === 0 && envd.out.startsWith(`project ${pa.id} `), "ORCH_PROJECT should win over the cwd: " + envd.out + envd.err);
  // ... outside both repos it is a usage error listing both projects.
  const amb = run(["status"]);
  expectExit(amb, 2, "status outside both repos");
  assert(amb.err.includes(pa.id) && amb.err.includes(pb.id), "the ambiguity error should list both projects: " + amb.err);
  const unknown = run(["status", "--project", "nope"]);
  expectExit(unknown, 2, "status --project <unknown>");
  // REQ-UI-08: usage errors exit 2.
  expectExit(run(["answer"]), 2, "answer without arguments");
  expectExit(run(["project"]), 2, "project without a subcommand");
  expectExit(run(["frobnicate"]), 2, "unknown command");

  // Plans: B from its repo through the CLI (the spec dir picks the project), A through the project route.
  const planB = run(["plan", "specs/001-x", "--no-llm"], b.repo);
  expectExit(planB, 0, "plan in repo B");
  const runA = await api("POST", `/api/projects/${pa.id}/plan`, { specDir: path.join(a.repo, "specs/001-x"), llm: false });
  assert(runA.project_id === pa.id, "the project plan route put the run in the wrong project");
  const stateB = await api("GET", `/api/projects/${pb.id}/state`);
  assert(stateB.project.id === pb.id && stateB.run?.status === "plan_pending" && stateB.inboxCount === 1, "beta's state: " + JSON.stringify({ project: stateB.project, run: stateB.run, inboxCount: stateB.inboxCount }));

  // REQ-HITL-01: one inbox across projects, each item labelled with its project.
  const inbox = await api("GET", "/api/inbox");
  const labels = inbox.map((i) => `${i.project_name}:${i.type}`).sort();
  assert(JSON.stringify(labels) === JSON.stringify(["alpha:approve_plan", "beta:approve_plan"]), "global inbox: " + JSON.stringify(inbox));
  assert(inbox.every((i) => i.project_id === (i.project_name === "alpha" ? pa.id : pb.id)), "inbox items need project_id");
  const counts = Object.fromEntries((await api("GET", "/api/projects")).map((p) => [p.id, p.inboxCount]));
  assert(counts[pa.id] === 1 && counts[pb.id] === 1, "project list inbox counts: " + JSON.stringify(counts));

  // REQ-PROJ-03, REQ-HITL-01 (TASK-11): the served dashboard has the project switcher, the add/archive
  // controls, the global inbox and the project error panel under stable ids (architecture §15.3).
  const html = await (await fetch(`http://127.0.0.1:${PROJECTS_PORT}/`)).text();
  for (const id of DASHBOARD_IDS) assert(html.includes(`id="${id}"`), `the dashboard has no #${id}`);
  assert(html.includes("/api/projects/${enc(pid)}/state") && html.includes(`"/api/inbox"`), "the dashboard should read the project state and the global inbox");

  // Run A through the CLI; while it runs, archiving it is refused (REQ-PROJ-04).
  expectExit(run(["approve"], a.repo), 0, "approve in repo A");
  expectExit(run(["run"], a.repo), 0, "run in repo A");
  const del = await fetch(`http://127.0.0.1:${PROJECTS_PORT}/api/projects/${pa.id}`, { method: "DELETE" });
  const delBody = await del.json();
  assert(del.status === 400 && delBody.error?.includes(runA.id), `DELETE on a project with a running run should be 400 naming ${runA.id}: ${del.status} ${JSON.stringify(delBody)}`);
  const rm = run(["project", "remove", pa.id]);
  expectExit(rm, 1, "project remove <project with a running run>");
  await waitFor(async () => (await api("GET", `/api/projects/${pa.id}/state`)).run?.status === "done", { timeoutMs: 60_000, intervalMs: 300, label: "alpha's run" });
  assert(a.sh("ls impl").trim() === "T001.txt", "alpha's work did not land");

  // REQ-OPS-04: once alpha's run is 40 days old, `orch archive-events` moves its log to a gzip file and the
  // log endpoints return one "Log archived to" event; decisions stay.
  const db = new Database(path.join(home, "orch.db"));
  db.pragma("busy_timeout = 5000");
  db.prepare("UPDATE runs SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - 40 * 86_400_000).toISOString(), runA.id);
  db.close();
  const arch = run(["archive-events"]);
  expectExit(arch, 0, "archive-events");
  assert(arch.out.includes(runA.id), "archive-events should name the archived run: " + arch.out);
  const archFile = path.join(home, "archive", pa.id, `${runA.id}-events.jsonl.gz`);
  assert(fs.existsSync(archFile), "no archive file at " + archFile);
  const archived = await api("GET", `/api/runs/${runA.id}`);
  const taskLog = await api("GET", `/api/tasks/${archived.tasks[0].id}/events?after=0`);
  const runLog = await api("GET", `/api/runs/${runA.id}/events`);
  for (const [what, log] of [["task", taskLog], ["run", runLog]]) {
    assert(log.length === 1 && log[0].kind === "info" && log[0].data.message === `Log archived to ${archFile}`, `${what} log of an archived run: ` + JSON.stringify(log));
  }
  assert(archived.decisions.some((d) => d.actor === "orchestrator" && d.text.startsWith("Archived ")), "no archive decision");
  assert(archived.decisions.length > 1 && archived.tasks[0].summary, "archiving lost decisions or the task summary");
  expectExit(run(["archive-events"]), 0, "archive-events (nothing to do)");

  // Archive B after stopping its run: gone from the default list, repo kept, `project add` restores it with its runs.
  expectExit(run(["stop"], b.repo), 0, "stop in repo B");
  expectExit(run(["project", "remove", pb.id]), 0, "project remove beta");
  assert(!(await api("GET", "/api/projects")).some((p) => p.id === pb.id), "archived project still in the default list");
  assert((await api("GET", "/api/projects?archived=1")).some((p) => p.id === pb.id && p.archived), "archived project missing from ?archived=1");
  assert(fs.existsSync(path.join(b.repo, "README.md")), "archiving touched the repo");
  assert(!(await api("GET", "/api/inbox")).some((i) => i.project_id === pb.id), "archived project still in the global inbox");
  const restored = run(["project", "add", b.repo]);
  expectExit(restored, 0, "project add (restore archived)");
  assert(/restored/.test(restored.out), "re-adding an archived project should restore it: " + restored.out);
  const back = await api("GET", `/api/projects/${pb.id}/state`);
  assert(back.runs.length === 1 && back.runs[0].status === "stopped", "restored project lost its run history: " + JSON.stringify(back.runs));
  // Only alpha and beta again: outside both repos is still ambiguous; `project list` shows both.
  const ls = run(["project", "list"]);
  expectExit(ls, 0, "project list");
  assert(ls.out.includes(pa.id) && ls.out.includes(pb.id), "project list: " + ls.out);
  console.log(`projects: registered ${pa.id} + ${pb.id}; CLI scoping, exit codes, global inbox and archive checked`);
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
const scenarios = { multi, projects, legacy };
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
