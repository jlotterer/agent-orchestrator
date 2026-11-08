/**
 * Project registry (TASK-07; architecture §5.3, §5.4).
 * Run after `npm run build`: npm run test:unit
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../../dist/db.js";
import { registerProject, archiveProject, resolveProjectForCwd } from "../../dist/projects.js";

let tmp;
let n = 0;
let savedCeiling;

before(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "orch-projects-test-")));
  // Never let git discover a repository above the test directory.
  savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = tmp;
});
after(() => {
  if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const store = () => new Store(path.join(tmp, `orch-${n++}.db`));
function dir(name) {
  const d = path.join(tmp, `case-${n++}`, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function gitRepo(name = "repo", branch = "main") {
  const d = dir(name);
  execFileSync("git", ["init", "-q", "-b", branch], { cwd: d });
  return d;
}

describe("registerProject", () => {
  test("registers a git repo, creates a starter config and names its path", async () => {
    const s = store();
    const repo = gitRepo("My App", "develop");
    const { project, configCreated } = await registerProject(s, repo);
    assert.equal(project.id, "my-app");
    assert.equal(project.name, "My App");
    assert.equal(project.repo_path, repo);
    assert.equal(project.archived, false);
    assert.equal(configCreated, path.join(repo, "orch.config.json"));
    const cfg = JSON.parse(fs.readFileSync(configCreated, "utf8"));
    assert.deepEqual(cfg, { baseBranch: "develop", validation: { command: "" } });
    assert.deepEqual(s.listProjects().map((p) => p.id), ["my-app"]);
  });

  test("base branch comes from origin/HEAD when set", async () => {
    const repo = gitRepo("remote-head");
    execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"], { cwd: repo });
    const { configCreated } = await registerProject(store(), repo);
    assert.equal(JSON.parse(fs.readFileSync(configCreated, "utf8")).baseBranch, "trunk");
  });

  test("an existing settings file is kept and no config path is reported", async () => {
    const repo = gitRepo("has-config");
    fs.writeFileSync(path.join(repo, "orch.config.json"), '{"baseBranch":"x"}');
    const res = await registerProject(store(), repo, { name: "Custom" });
    assert.equal(res.configCreated, undefined);
    assert.equal(res.project.name, "Custom");
    assert.equal(fs.readFileSync(path.join(repo, "orch.config.json"), "utf8"), '{"baseBranch":"x"}');
  });

  test("a non-git directory is rejected", async () => {
    const s = store();
    await assert.rejects(registerProject(s, dir("plain")), /not a git repository/);
    assert.deepEqual(s.listProjects({ archived: true }), []);
  });

  test("a missing directory is rejected", async () => {
    await assert.rejects(registerProject(store(), path.join(tmp, "does-not-exist")), /no such directory/);
  });

  test("a subdirectory of a repo is rejected, naming the root", async () => {
    const repo = gitRepo("root");
    const sub = path.join(repo, "pkg");
    fs.mkdirSync(sub);
    await assert.rejects(registerProject(store(), sub), (e) => /not a git repository root/.test(e.message) && e.message.includes(repo));
  });

  test("registering the same path twice is refused, naming the existing project", async () => {
    const s = store();
    const repo = gitRepo("twice");
    await registerProject(s, repo);
    await assert.rejects(registerProject(s, repo), /already registered as project 'twice'/);
    // A different spelling of the same directory is the same project.
    await assert.rejects(registerProject(s, path.join(repo, "..", "twice")), /'twice'/);
  });

  test("ids get -2, -3 suffixes on collision", async () => {
    const s = store();
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await registerProject(s, gitRepo("app"))).project.id);
    assert.deepEqual(ids, ["app", "app-2", "app-3"]);
  });
});

describe("archiveProject", () => {
  test("refused with an unfinished run, naming it; allowed once the run is finished", async () => {
    const s = store();
    const { project } = await registerProject(s, gitRepo("busy"));
    const run = s.createRun("/specs/1", "Feature", "main", "paused", project.id);
    assert.throws(() => archiveProject(s, project.id), new RegExp(`unfinished run ${run.id} \\(paused`));
    assert.equal(s.getProject(project.id).archived, false);

    s.setRunStatus(run.id, "stopped");
    const archived = archiveProject(s, project.id);
    assert.equal(archived.archived, true);
    assert.deepEqual(s.listProjects(), []);
    assert.ok(fs.existsSync(project.repo_path), "archiving never deletes the repo");
  });

  test("every unfinished state blocks archiving", async () => {
    for (const status of ["planning", "plan_pending", "ready", "running", "paused"]) {
      const s = store();
      const { project } = await registerProject(s, gitRepo("p"));
      s.createRun("/s", "R", "main", status, project.id);
      assert.throws(() => archiveProject(s, project.id), /unfinished run/, status);
    }
  });

  test("unknown project id", () => {
    assert.throws(() => archiveProject(store(), "ghost"), /no project 'ghost'/);
  });

  test("re-registering an archived path un-archives it with its history", async () => {
    const s = store();
    const repo = gitRepo("comeback");
    const { project } = await registerProject(s, repo);
    const run = s.createRun("/s", "Old", "main", "done", project.id);
    archiveProject(s, project.id);

    const again = await registerProject(s, repo);
    assert.equal(again.project.id, project.id);
    assert.equal(again.project.archived, false);
    assert.equal(again.unarchived, true);
    assert.equal(again.configCreated, undefined);
    assert.deepEqual(s.listRuns(project.id).map((r) => r.id), [run.id]);
    assert.deepEqual(s.listProjects().map((p) => p.id), [project.id]);
  });
});

describe("resolveProjectForCwd", () => {
  const P = (id, repo_path, archived = false) => ({ id, name: id, repo_path, archived, last_start_at: null, created_at: "", updated_at: "" });

  test("deepest containing repo wins; archived and unrelated projects are ignored", () => {
    const root = dir("ws");
    const outer = path.join(root, "outer");
    const inner = path.join(outer, "vendor", "inner");
    const gone = path.join(root, "gone");
    fs.mkdirSync(path.join(inner, "src"), { recursive: true });
    fs.mkdirSync(gone);
    const projects = [P("outer", outer), P("inner", inner), P("gone", gone, true), P("other", path.join(root, "other"))];

    assert.equal(resolveProjectForCwd(projects, path.join(inner, "src")).id, "inner");
    assert.equal(resolveProjectForCwd(projects, inner).id, "inner");
    assert.equal(resolveProjectForCwd(projects, path.join(outer, "vendor")).id, "outer");
    assert.equal(resolveProjectForCwd(projects, gone), undefined);
    assert.equal(resolveProjectForCwd(projects, root), undefined);
    // A sibling whose name starts with a project's name is not inside it.
    fs.mkdirSync(path.join(root, "outer-2"));
    assert.equal(resolveProjectForCwd(projects, path.join(root, "outer-2")), undefined);
  });
});
