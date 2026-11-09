/**
 * Server/project config split and ORCH_HOME layout (TASK-05; architecture §5.1, §5.2, §19).
 * Run after `npm run build`: npm run test:unit
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadServerConfig, loadProjectConfig, writeStarterProjectConfig, toLegacyConfig,
  FORBIDDEN_PROJECT_KEYS, DEFAULT_SERVER_CONFIG, CONFIG_FILENAME,
} from "../../dist/config.js";
import { orchHome, serverConfigPath, dbPath, worktreesDir, archiveDir, runDir, projectSlug } from "../../dist/paths.js";

let tmp;
const dirs = [];
function mkdir(name) {
  const d = path.join(tmp, `${name}-${dirs.length}`);
  fs.mkdirSync(d, { recursive: true });
  dirs.push(d);
  return d;
}
function home(server) {
  const h = mkdir("home");
  if (server !== undefined) fs.writeFileSync(path.join(h, "server.json"), JSON.stringify(server));
  return h;
}
function repo(project, name = "repo") {
  const r = mkdir(name);
  if (project !== undefined) fs.writeFileSync(path.join(r, CONFIG_FILENAME), JSON.stringify(project));
  return r;
}
const load = (project, server) => loadProjectConfig(repo(project), loadServerConfig(home(server)));

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orch-config-test-")); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("ORCH_HOME paths", () => {
  test("default is ~/.orch", () => {
    assert.equal(orchHome({}), path.join(os.homedir(), ".orch"));
    assert.equal(orchHome({ ORCH_HOME: "  " }), path.join(os.homedir(), ".orch"));
  });

  test("ORCH_HOME overrides every derived path", () => {
    const saved = process.env.ORCH_HOME;
    const h = path.join(tmp, "custom-home");
    process.env.ORCH_HOME = h;
    try {
      assert.equal(orchHome(), h);
      assert.equal(serverConfigPath(), path.join(h, "server.json"));
      assert.equal(dbPath(), path.join(h, "orch.db"));
      assert.equal(worktreesDir("my-app"), path.join(h, "worktrees", "my-app"));
      assert.equal(archiveDir("my-app"), path.join(h, "archive", "my-app"));
      assert.equal(runDir(), path.join(h, "run"));
    } finally {
      if (saved === undefined) delete process.env.ORCH_HOME; else process.env.ORCH_HOME = saved;
    }
  });

  test("relative ORCH_HOME resolves against cwd", () => {
    assert.equal(orchHome({ ORCH_HOME: "rel-home" }), path.resolve("rel-home"));
  });

  test("project ids cannot escape their directory", () => {
    for (const bad of ["", ".", "..", "a/b", "a\\b"]) assert.throws(() => worktreesDir(bad, tmp), /invalid project id/);
  });

  test("projectSlug", () => {
    assert.equal(projectSlug("My App"), "my-app");
    assert.equal(projectSlug("--Foo_Bar.2--"), "foo_bar-2");
    assert.equal(projectSlug("screen_copier"), "screen_copier");
    assert.equal(projectSlug("???"), "project");
  });
});

describe("loadServerConfig", () => {
  test("missing server.json yields the §19 defaults", () => {
    const s = loadServerConfig(home());
    assert.deepStrictEqual(s, DEFAULT_SERVER_CONFIG);
    assert.equal(s.host, "127.0.0.1");
    assert.equal(s.scheduler.maxAgents, 2);
    assert.equal(s.retention.eventDays, 30);
    assert.equal(s.git.ghCommand, "gh");
    assert.deepStrictEqual(s.auth, { token: "", allowInsecure: false });
    assert.deepStrictEqual(s.defaults, {});
  });

  test("file values merge over defaults without mutating them", () => {
    const s = loadServerConfig(home({ port: 4900, scheduler: { maxAgents: 4 }, auth: { token: "t" } }));
    assert.equal(s.port, 4900);
    assert.equal(s.scheduler.maxAgents, 4);
    assert.equal(s.scheduler.tickSeconds, 5);
    assert.equal(s.auth.token, "t");
    assert.equal(s.auth.allowInsecure, false);
    s.agents.adapters.x = { type: "x", command: "x", extraArgs: [], env: {} };
    assert.equal(DEFAULT_SERVER_CONFIG.agents.adapters.x, undefined);
  });

  test("ORCH_HOME is the default home", () => {
    const h = home({ port: 4999 });
    const saved = process.env.ORCH_HOME;
    process.env.ORCH_HOME = h;
    try { assert.equal(loadServerConfig().port, 4999); } finally {
      if (saved === undefined) delete process.env.ORCH_HOME; else process.env.ORCH_HOME = saved;
    }
  });

  test("a server role naming an undefined adapter is rejected", () => {
    assert.throws(() => loadServerConfig(home({ agents: { roles: { worker: { adapter: "nope", model: "" } } } })), /agents\.roles\.worker\.adapter 'nope'/);
  });

  test("server-only keys under defaults are rejected", () => {
    assert.throws(() => loadServerConfig(home({ defaults: { agents: {} } })), /'defaults\.agents'/);
  });

  test("malformed JSON names the file", () => {
    const h = mkdir("home");
    fs.writeFileSync(path.join(h, "server.json"), "{ nope");
    assert.throws(() => loadServerConfig(h), (e) => e.message.includes(path.join(h, "server.json")));
  });
});

describe("loadProjectConfig", () => {
  test("a project file with agents.adapters is rejected, naming 'agents'", () => {
    assert.throws(() => load({ agents: { adapters: { evil: { type: "claude", command: "/bin/sh" } } } }), /'agents'/);
  });

  for (const key of FORBIDDEN_PROJECT_KEYS) {
    test(`forbidden key '${key}' is rejected with its name`, () => {
      const raw = key === "git.ghCommand" ? { git: { ghCommand: "/tmp/gh" } } : { [key]: "x" };
      assert.throws(() => load(raw), (e) => e.message.includes(`'${key}'`) && /server\.json/.test(e.message));
    });
  }

  test("several forbidden keys are all named", () => {
    assert.throws(() => load({ host: "0.0.0.0", notify: {} }), (e) => e.message.includes("'host'") && e.message.includes("'notify'"));
  });

  test("other git keys are fine", () => {
    const { config } = load({ git: { pr: false, squash: false } });
    assert.equal(config.git.pr, false);
    assert.equal(config.git.squash, false);
  });

  test("precedence: built-in < server defaults < project (maxParallel)", () => {
    assert.equal(load(undefined).config.scheduler.maxParallel, 1);
    assert.equal(load({}, { defaults: { scheduler: { maxParallel: 3 } } }).config.scheduler.maxParallel, 3);
    assert.equal(load({ scheduler: { maxParallel: 1 } }, { defaults: { scheduler: { maxParallel: 3 } } }).config.scheduler.maxParallel, 1);
  });

  test("precedence merges nested keys independently", () => {
    const { config } = load(
      { git: { feedback: { maxRounds: 5 } }, validation: { command: "npm test" } },
      { defaults: { git: { mergePolicy: "manual", feedback: { pollSeconds: 30 } }, validation: { command: "make check" } } },
    );
    assert.equal(config.git.feedback.maxRounds, 5);       // project
    assert.equal(config.git.feedback.pollSeconds, 30);    // server defaults
    assert.equal(config.git.feedback.trigger, "/orch");   // built-in
    assert.equal(config.git.mergePolicy, "manual");       // server defaults
    assert.equal(config.validation.command, "npm test");  // project beats defaults
    assert.equal(config.validation.phase.maxFixups, 2);   // built-in
  });

  test("built-in project defaults match §19", () => {
    const { config, warnings, path: p } = load(undefined);
    assert.equal(p, null);
    assert.deepStrictEqual(warnings, []);
    assert.equal(config.baseBranch, "main");
    assert.deepStrictEqual(config.scheduler, { maxParallel: 1, maxAttempts: 2, resumeOnRetry: true });
    assert.deepStrictEqual(config.validation.phase, { enabled: true, command: "", maxFixups: 2 });
    assert.deepStrictEqual(config.validation.ui, { startCommand: "", url: "http://127.0.0.1:{port}/", readyTimeoutSeconds: 120, env: {} });
    assert.deepStrictEqual(config.handoff, {
      specChars: 12000, historyChars: 6000, contextFiles: ["spec.md", "data-model.md", "plan.md"],
      briefChars: 8000, reqChars: 4000, contractChars: 6000, rulesChars: 6000,
      requirementsFile: "docs/requirements.md", projectFiles: ["AGENTS.md"],
    });
  });

  test("name defaults to the repo directory name", () => {
    const r = repo(undefined, "my-repo");
    assert.equal(loadProjectConfig(r, loadServerConfig(home())).config.name, path.basename(r));
    assert.equal(load({ name: "Shop" }).config.name, "Shop");
  });

  test("unknown keys warn and are ignored", () => {
    const { config, warnings } = load(
      { colour: "blue", scheduler: { maxParallel: 2, tickSeconds: 1 }, validation: { ui: { env: { FOO: "1" } } } },
      { defaults: { mystery: 1 } },
    );
    assert.equal(config.colour, undefined);
    assert.equal(config.scheduler.tickSeconds, undefined);
    assert.equal(config.scheduler.maxParallel, 2);
    assert.deepStrictEqual(config.validation.ui.env, { FOO: "1" }); // env is a free-form map
    assert.ok(warnings.some((w) => w.includes("'colour'")), warnings.join("\n"));
    assert.ok(warnings.some((w) => w.includes("'scheduler.tickSeconds'")), warnings.join("\n"));
    assert.ok(warnings.some((w) => w.includes("server.json defaults") && w.includes("'mystery'")), warnings.join("\n"));
    assert.equal(warnings.length, 3);
  });

  test("roles start from the server's roles and accept a model-only override", () => {
    const server = { agents: { roles: { validator: { adapter: "gemini", model: "pro" } } } };
    const { config } = load({ roles: { worker: { model: "opus" } } }, server);
    assert.deepStrictEqual(config.roles.worker, { adapter: "claude", model: "opus" });
    assert.deepStrictEqual(config.roles.validator, { adapter: "gemini", model: "pro" });
    assert.deepStrictEqual(config.roles.phaseValidator, { adapter: "gemini", model: "pro" }); // falls back to validator
  });

  test("phaseValidator can be set explicitly", () => {
    const { config } = load({ roles: { phaseValidator: { adapter: "claude", model: "x" } } });
    assert.deepStrictEqual(config.roles.phaseValidator, { adapter: "claude", model: "x" });
  });

  test("a role naming an adapter server.json does not define is rejected", () => {
    assert.throws(() => load({ roles: { validator: { adapter: "codex", model: "" } } }), /roles\.validator\.adapter 'codex'/);
  });

  test("an adapter defined only in server.json may be used by a project", () => {
    const server = { agents: { adapters: { codex: { type: "codex", command: "codex", extraArgs: [], env: {} } } } };
    assert.equal(load({ roles: { worker: { adapter: "codex", model: "" } } }, server).config.roles.worker.adapter, "codex");
  });

  test("the project file is re-read on every call (REQ-PROJ-06 groundwork)", () => {
    const r = repo({ validation: { command: "one" } });
    const s = loadServerConfig(home());
    assert.equal(loadProjectConfig(r, s).config.validation.command, "one");
    fs.writeFileSync(path.join(r, CONFIG_FILENAME), JSON.stringify({ validation: { command: "two" } }));
    assert.equal(loadProjectConfig(r, s).config.validation.command, "two");
  });

  test("loading does not mutate the server config", () => {
    const s = loadServerConfig(home({ defaults: { scheduler: { maxParallel: 3 } } }));
    const before = JSON.stringify(s);
    const { config } = loadProjectConfig(repo({ scheduler: { maxParallel: 1 } }), s);
    config.roles.worker.model = "changed";
    assert.equal(JSON.stringify(s), before);
  });
});

describe("writeStarterProjectConfig", () => {
  test("writes baseBranch and an empty gate command when missing", () => {
    const r = repo(undefined);
    const res = writeStarterProjectConfig(r, { baseBranch: "trunk" });
    assert.equal(res.created, true);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(res.path, "utf8")), { baseBranch: "trunk", validation: { command: "" } });
    assert.equal(loadProjectConfig(r, loadServerConfig(home())).config.baseBranch, "trunk");
  });

  test("never overwrites an existing file", () => {
    const r = repo({ baseBranch: "dev" });
    const res = writeStarterProjectConfig(r, { baseBranch: "main" });
    assert.equal(res.created, false);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(res.path, "utf8")), { baseBranch: "dev" });
  });
});

describe("toLegacyConfig", () => {
  test("maps server + project onto today's Config shape", () => {
    const h = home({ port: 4811, publicUrl: "http://box:4811", git: { ghCommand: "/opt/gh" }, scheduler: { tickSeconds: 2 }, notify: { ntfyUrl: "https://ntfy.sh/x" } });
    const s = loadServerConfig(h);
    const r = repo({ baseBranch: "dev", scheduler: { maxParallel: 2 }, validation: { command: "npm test" } }, "Legacy App");
    const { config: p } = loadProjectConfig(r, s);
    const c = toLegacyConfig(s, p, r, { home: h });
    assert.equal(c.repo, path.resolve(r));
    assert.equal(c.baseBranch, "dev");
    assert.equal(c.worktreeDir, path.join(h, "worktrees", projectSlug(path.basename(r))));
    assert.equal(c.dbPath, path.join(h, "orch.db"));
    assert.equal(c.port, 4811);
    assert.equal(c.publicUrl, "http://box:4811");
    assert.equal(c.git.ghCommand, "/opt/gh");
    assert.equal(c.scheduler.tickSeconds, 2);
    assert.equal(c.scheduler.maxParallel, 2);
    assert.equal(c.validation.command, "npm test");
    assert.equal(c.notify.ntfyUrl, "https://ntfy.sh/x");
    assert.deepStrictEqual(Object.keys(c.agents.roles).sort(), ["planner", "validator", "worker"]);
    assert.deepStrictEqual(c.agents.adapters, s.agents.adapters);
    assert.deepStrictEqual(c.git.feedback, p.git.feedback);
    assert.deepStrictEqual(c.handoff, p.handoff);
  });

  test("an explicit project id names the worktree dir", () => {
    const h = home();
    const s = loadServerConfig(h);
    const r = repo(undefined);
    assert.equal(toLegacyConfig(s, loadProjectConfig(r, s).config, r, { home: h, projectId: "shop-2" }).worktreeDir, path.join(h, "worktrees", "shop-2"));
  });
});

describe("example files", () => {
  const root = path.resolve(import.meta.dirname, "../..");

  test("orch.config.example.json holds project keys only and loads cleanly", () => {
    const r = mkdir("example-repo");
    fs.copyFileSync(path.join(root, "orch.config.example.json"), path.join(r, CONFIG_FILENAME));
    const server = { agents: { adapters: {} } }; // keep built-ins; the example's roles must resolve against them
    const { warnings } = loadProjectConfig(r, loadServerConfig(home(server)));
    assert.deepStrictEqual(warnings, []);
  });

  test("examples/server.example.json loads cleanly", () => {
    const h = mkdir("example-home");
    fs.copyFileSync(path.join(root, "examples", "server.example.json"), path.join(h, "server.json"));
    const s = loadServerConfig(h);
    const { warnings } = loadProjectConfig(repo(undefined), s);
    assert.deepStrictEqual(warnings, []);
  });
});
