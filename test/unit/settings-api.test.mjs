/**
 * The Settings API (T029; REQ-UI-10; architecture §5.2, §15.1, §16): a real Orchestrator and HTTP server over a temp
 * ORCH_HOME and a git repo. Opens a Store, so on the Windows dev host run it in Docker (see README "Testing").
 * Run after `npm run build`: npm run test:unit
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { Store } from "../../dist/db.js";
import { Orchestrator } from "../../dist/orchestrator.js";
import { startServer } from "../../dist/server.js";
import { DEFAULT_SERVER_CONFIG, loadServerConfig } from "../../dist/config.js";
import { settingsSchema } from "../../dist/settings-schema.js";

// ---------------------------------------------------------------------------------------------
// REQ-UI-10: the Settings API
// ---------------------------------------------------------------------------------------------

const TOKEN = "s3cret-access-token";
const NTFY_TOKEN = "ntfy-secret-token";
const ENV_SECRET = "adapter-env-secret";

let tmp, home, repo, store, orch, srv, base, sink, sinkHits;
const sh = (cmd, cwd) => execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const serverFile = () => path.join(home, "server.json");
const projectFile = () => path.join(repo, "orch.config.json");
const read = (f) => fs.readFileSync(f, "utf8");
const writeServer = (doc) => fs.writeFileSync(serverFile(), JSON.stringify(doc, null, 2) + "\n");
const call = async (method, p, body, headers = {}) => {
  const res = await fetch(base + p, { method, headers: { authorization: `Bearer ${TOKEN}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
};

describe("settings routes (a real orchestrator and server)", () => {
before(async () => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "orch-settings-test-")));
  home = path.join(tmp, "home");
  repo = path.join(tmp, "repo");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  sh("git init -q -b main && git config user.name t && git config user.email t@x && git commit -q --allow-empty -m init", repo);
  fs.writeFileSync(projectFile(), JSON.stringify({ baseBranch: "main", validation: { command: "" } }, null, 2) + "\n");
  sh("git add -A && git commit -q -m settings", repo);

  // A local ntfy sink: records what it is sent; answers 500 when the path ends in /fail.
  sinkHits = [];
  sink = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { sinkHits.push({ url: req.url, headers: req.headers, body }); res.writeHead(req.url.endsWith("/fail") ? 500 : 200); res.end("{}"); });
  });
  await new Promise((r) => sink.listen(0, "127.0.0.1", r));

  writeServer({
    auth: { token: TOKEN },
    notify: { ntfyUrl: `http://127.0.0.1:${sink.address().port}/topic`, ntfyToken: NTFY_TOKEN },
    agents: { adapters: { claude: { env: { API_KEY: ENV_SECRET } } } },
  });
  store = new Store(path.join(home, "orch.db"));
  store.addProject({ id: "demo", name: "Demo", repo_path: repo });
  orch = new Orchestrator({ ...loadServerConfig(home), port: 0 }, store, { home });
  srv = startServer(orch);
  await new Promise((r) => (srv.listening ? r() : srv.once("listening", r)));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => {
  srv?.close();
  sink?.close();
  store?.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("GET /api/settings/*", () => {
  test("the routes need the access token like every other route", async () => {
    for (const p of ["/api/settings/schema", "/api/settings/server", "/api/projects/demo/settings"]) {
      assert.equal((await fetch(base + p)).status, 401, p);
    }
  });

  test("schema returns the entries", async () => {
    const r = await call("GET", "/api/settings/schema");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.map((e) => e.key), settingsSchema.map((e) => e.key));
    assert.ok(r.json.find((e) => e.key === "auth.token").secret);
    assert.ok(r.json.find((e) => e.key === "port").restart);
  });

  test("server settings return every secret as {set} and never its value", async () => {
    const r = await call("GET", "/api/settings/server");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.settings.auth.token, { set: true });
    assert.deepEqual(r.json.settings.notify.ntfyToken, { set: true });
    assert.deepEqual(r.json.settings.agents.adapters.claude.env, { API_KEY: { set: true } });
    assert.deepEqual(r.json.settings.agents.adapters.codex.env, {});
    assert.equal(r.json.settings.port, 4800, "defaults fill what the file leaves out");
    for (const secret of [TOKEN, NTFY_TOKEN, ENV_SECRET]) assert.ok(!r.text.includes(secret), `the response leaks ${secret}`);
  });

  test("an unset secret is {set: false}", async () => {
    const saved = read(serverFile());
    writeServer({});
    try {
      const r = await call("GET", "/api/settings/server");
      assert.deepEqual(r.json.settings.notify.ntfyToken, { set: false });
      assert.deepEqual(r.json.settings.auth.token, { set: true }, "the running token (here from the file at start) still counts");
    } finally { fs.writeFileSync(serverFile(), saved); }
  });
});

describe("PUT /api/settings/server", () => {
  test("a masked or omitted secret keeps the stored value", async () => {
    const before = JSON.parse(read(serverFile()));
    const r = await call("PUT", "/api/settings/server", { settings: {
      auth: { token: { set: true } }, notify: { ntfyToken: { set: true }, ntfyUrl: before.notify.ntfyUrl },
      agents: { adapters: { claude: { env: { API_KEY: { set: true } } } } },
    } });
    assert.equal(r.status, 200, r.text);
    const after = JSON.parse(read(serverFile()));
    assert.equal(after.auth.token, TOKEN);
    assert.equal(after.notify.ntfyToken, NTFY_TOKEN);
    assert.equal(after.agents.adapters.claude.env.API_KEY, ENV_SECRET);

    const r2 = await call("PUT", "/api/settings/server", { settings: { notify: { ntfyUrl: before.notify.ntfyUrl } } });
    assert.equal(r2.status, 200, r2.text);
    assert.equal(JSON.parse(read(serverFile())).auth.token, TOKEN, "omitting the token keeps it");
  });

  test("a new secret value replaces the stored one, and is not echoed", async () => {
    const r = await call("PUT", "/api/settings/server", { settings: { agents: { adapters: { claude: { env: { API_KEY: { set: true }, OTHER: "new-env-secret" } } } } } });
    assert.equal(r.status, 200, r.text);
    assert.ok(!r.text.includes("new-env-secret"));
    assert.deepEqual(JSON.parse(read(serverFile())).agents.adapters.claude.env, { API_KEY: ENV_SECRET, OTHER: "new-env-secret" });
    // leaving a key out removes it
    await call("PUT", "/api/settings/server", { settings: { agents: { adapters: { claude: { env: { API_KEY: { set: true } } } } } } });
    assert.deepEqual(JSON.parse(read(serverFile())).agents.adapters.claude.env, { API_KEY: ENV_SECRET });
  });

  test("a body the loader refuses, or with a key outside the schema, is a 400 and server.json is unchanged", async () => {
    const before = read(serverFile());
    const bad = [
      [{ agents: { roles: { validator: { adapter: "nope" } } } }, /agents\.roles\.validator\.adapter 'nope' is not defined in agents\.adapters/],
      [{ agents: { adapters: { old: { type: "gemini", command: "gemini", extraArgs: [], env: {} } } } }, /retired/],
      [{ defaults: { agents: {} } }, /'defaults\.agents' is a server setting/],
      [{ bogus: 1 }, /'bogus' is not a server setting/],
      [{ scheduler: { maxAgnets: 3 } }, /'scheduler\.maxAgnets' is not a server setting/],
      [{ port: "4801" }, /port must be a whole number/],
      [{ agents: { roles: { boss: { adapter: "claude" } } } }, /'agents\.roles\.boss' is not a server setting/],
    ];
    for (const [settings, re] of bad) {
      const r = await call("PUT", "/api/settings/server", { settings });
      assert.equal(r.status, 400, JSON.stringify(settings));
      assert.match(r.json.error, re);
      assert.equal(read(serverFile()), before, "server.json must not change");
    }
    assert.deepEqual(fs.readdirSync(home).filter((f) => f.endsWith(".tmp")), [], "no temp file is left");
  });

  test("a valid body rewrites server.json as 2-space JSON and answers with the restart keys", async () => {
    const r = await call("PUT", "/api/settings/server", { settings: { scheduler: { maxAgents: 3 }, port: 4900, publicUrl: "http://example:4900", retention: { eventDays: 7 }, host: "127.0.0.1" } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
    assert.deepEqual([...r.json.restartRequired].sort(), ["port", "publicUrl", "retention.eventDays"], "host was not changed");
    const text = read(serverFile());
    assert.ok(text.endsWith("}\n"));
    assert.equal(text, JSON.stringify(JSON.parse(text), null, 2) + "\n");
    const file = JSON.parse(text);
    assert.equal(file.scheduler.maxAgents, 3);
    assert.equal(file.port, 4900);
    assert.equal(file.host, undefined, "a value equal to the default that the file did not have is not written");
    assert.deepEqual(fs.readdirSync(home).filter((f) => f.endsWith(".tmp")), []);
    // hot where no restart is needed; the listener keeps its values until a restart
    assert.equal(orch.server.scheduler.maxAgents, 3);
    assert.equal(orch.server.port, 0, "the running port is unchanged");
    assert.equal(orch.server.publicUrl, DEFAULT_SERVER_CONFIG.publicUrl);
    // GET reports what is waiting for a restart
    const g = await call("GET", "/api/settings/server");
    assert.deepEqual([...g.json.restartRequired].sort(), ["port", "publicUrl", "retention.eventDays"]);
    assert.equal(g.json.settings.port, 4900);
  });

  test("changing agents.roles.validator takes effect for the next launch without a restart", async () => {
    const ctx = orch.context("demo");
    assert.equal(ctx.cfg.agents.roles.validator.adapter, "claude");
    const events = [];
    orch.on("change", (c) => events.push(c));
    const r = await call("PUT", "/api/settings/server", { settings: { agents: { roles: { validator: { adapter: "codex", model: "o3" } } } } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.restartRequired, []);
    const next = orch.context("demo"), cfg = next.cfg;
    assert.notEqual(next, ctx, "project contexts were rebuilt");
    assert.deepEqual(cfg.agents.roles.validator, { adapter: "codex", model: "o3" });
    assert.equal(cfg.agents.roles.worker.adapter, "claude");
    assert.equal(orch.agentFor(cfg, cfg.agents.roles.validator).adapterConfig.type, "codex", "the next launch resolves the new adapter");
    assert.ok(events.some((c) => c.what === "settings"), "open dashboards are told to refetch");
    // put it back
    assert.equal((await call("PUT", "/api/settings/server", { settings: { agents: { roles: { validator: { adapter: "claude", model: "" } } } } })).status, 200);
    assert.equal(orch.context("demo").cfg.agents.roles.validator.adapter, "claude");
  });

  test("reloadServer keeps what the daemon bound at start", () => {
    const run = orch.server;
    writeServer({ ...JSON.parse(read(serverFile())), host: "0.0.0.0", auth: { token: "other" } });
    const fresh = orch.reloadServer();
    assert.equal(fresh.host, run.host);
    assert.equal(fresh.port, run.port);
    assert.equal(fresh.auth.token, TOKEN);
    writeServer({ ...JSON.parse(read(serverFile())), host: "127.0.0.1", auth: { token: TOKEN } });
    orch.reloadServer();
  });
});

describe("project settings", () => {
  const head = () => sh("git log -1 --format=%s", repo).trim();
  const commits = () => Number(sh("git rev-list --count HEAD", repo));

  test("GET returns the file, the effective settings and the loader's warnings", async () => {
    const r = await call("GET", "/api/projects/demo/settings");
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.settings, { baseBranch: "main", validation: { command: "" } });
    assert.equal(r.json.effective.scheduler.maxAttempts, 2);
    assert.equal(r.json.effective.roles.phaseValidator.adapter, "claude");
    assert.equal(r.json.exists, true);
    assert.equal((await call("GET", "/api/projects/ghost/settings")).status, 404);
  });

  test("server-only keys are a 400 with the loader's message and nothing is written", async () => {
    const before = read(projectFile()), n = commits();
    for (const key of ["agents", "host", "port", "publicUrl", "auth", "notify", "dbPath", "worktreeDir", "repo"]) {
      const r = await call("PUT", "/api/projects/demo/settings", { settings: { [key]: key === "port" ? 1 : {} } });
      assert.equal(r.status, 400, key);
      assert.match(r.json.error, new RegExp(`'${key}' is a server setting and is not allowed in project settings; set it in server.json instead \\(decision 0013\\)`), key);
    }
    const gh = await call("PUT", "/api/projects/demo/settings", { settings: { git: { ghCommand: "x" } } });
    assert.equal(gh.status, 400);
    assert.match(gh.json.error, /'git\.ghCommand' is a server setting/);
    assert.equal(read(projectFile()), before);
    assert.equal(commits(), n);
    assert.equal(sh("git status --porcelain", repo).trim(), "");
  });

  test("a value the loader or the schema refuses is a 400 and the file is unchanged", async () => {
    const before = read(projectFile());
    const unknownAdapter = await call("PUT", "/api/projects/demo/settings", { settings: { roles: { worker: { adapter: "nope" } } } });
    assert.equal(unknownAdapter.status, 400);
    assert.match(unknownAdapter.json.error, /roles\.worker\.adapter 'nope' is not defined in server\.json agents\.adapters/);
    const wrongType = await call("PUT", "/api/projects/demo/settings", { settings: { scheduler: { maxParallel: "two" } } });
    assert.equal(wrongType.status, 400);
    assert.match(wrongType.json.error, /scheduler\.maxParallel must be a whole number/);
    assert.equal(read(projectFile()), before);
  });

  test("a valid body is written, committed on the base branch and picked up by the next tick", async () => {
    const n = commits();
    const ctxBefore = orch.context("demo");
    const r = await call("PUT", "/api/projects/demo/settings", { settings: { scheduler: { maxParallel: 3 }, git: { pr: false }, mystery: 1 } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.committed, true, r.text);
    assert.equal(r.json.reason, undefined);
    assert.ok(r.json.warnings.some((w) => w.includes("mystery")), "the loader's warnings are returned");
    assert.deepEqual(JSON.parse(read(projectFile())), { baseBranch: "main", validation: { command: "" }, scheduler: { maxParallel: 3 }, git: { pr: false }, mystery: 1 });
    assert.equal(read(projectFile()), JSON.stringify(JSON.parse(read(projectFile())), null, 2) + "\n");
    assert.equal(head(), "chore(orch): update project settings");
    assert.equal(commits(), n + 1);
    assert.equal(sh("git rev-parse --abbrev-ref HEAD", repo).trim(), "main");
    assert.equal(sh("git status --porcelain", repo).trim(), "", "the commit holds the whole change");
    assert.match(sh("git show HEAD:orch.config.json", repo), /"maxParallel": 3/);
    const ctx = orch.context("demo");
    assert.notEqual(ctx, ctxBefore);
    assert.equal(ctx.cfg.scheduler.maxParallel, 3);
    assert.equal(ctx.cfg.git.pr, false);
    // null removes a key
    const r2 = await call("PUT", "/api/projects/demo/settings", { settings: { mystery: null, git: { pr: null } } });
    assert.equal(r2.status, 200, r2.text);
    assert.deepEqual(JSON.parse(read(projectFile())), { baseBranch: "main", validation: { command: "" }, scheduler: { maxParallel: 3 }, git: {} });
  });

  test("replace: true writes the body as the whole file", async () => {
    const r = await call("PUT", "/api/projects/demo/settings", { replace: true, settings: { baseBranch: "main", validation: { command: "npm test" } } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(JSON.parse(read(projectFile())), { baseBranch: "main", validation: { command: "npm test" } });
    assert.equal(orch.context("demo").cfg.validation.command, "npm test");
  });

  test("a base checkout with other changes gets the file written but not committed, with the reason", async () => {
    fs.writeFileSync(path.join(repo, "notes.txt"), "x\n");
    sh("git add notes.txt && git commit -q -m notes", repo);
    fs.writeFileSync(path.join(repo, "notes.txt"), "changed\n"); // an unstaged change
    const n = commits();
    try {
      const r = await call("PUT", "/api/projects/demo/settings", { settings: { scheduler: { maxAttempts: 5 } } });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.committed, false);
      assert.match(r.json.reason, /uncommitted changes/);
      assert.equal(JSON.parse(read(projectFile())).scheduler.maxAttempts, 5, "the file is written anyway");
      assert.equal(commits(), n);
      assert.equal(orch.context("demo").cfg.scheduler.maxAttempts, 5);
      assert.match(sh("git status --porcelain", repo), /notes\.txt/, "the owner's change is untouched");
      assert.ok(!sh("git diff --cached --name-only", repo).trim(), "nothing was staged");
    } finally {
      sh("git checkout -- notes.txt", repo);
      sh("git add orch.config.json && git commit -q -m 'settings by hand'", repo);
    }
  });

  test("a checkout on a task branch is never committed to", async () => {
    sh("git checkout -q -b task-7-something", repo);
    const n = commits();
    try {
      const r = await call("PUT", "/api/projects/demo/settings", { settings: { scheduler: { maxAttempts: 4 } } });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.committed, false);
      assert.match(r.json.reason, /task-7-something.*not the base branch 'main'/);
      assert.equal(commits(), n);
    } finally {
      sh("git checkout -q -- . && git checkout -q main", repo);
    }
  });

  test("an unchanged file is not committed and says so", async () => {
    const cur = JSON.parse(read(projectFile()));
    const r = await call("PUT", "/api/projects/demo/settings", { settings: cur });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.committed, false);
    assert.match(r.json.reason, /unchanged/);
  });

  test("a project file that is not valid JSON is reported and can be replaced", async () => {
    fs.writeFileSync(projectFile(), "{ not json");
    sh("git commit -q -am broken", repo);
    const g = await call("GET", "/api/projects/demo/settings");
    assert.equal(g.status, 200);
    assert.match(g.json.error, /orch\.config\.json/);
    assert.equal(g.json.invalidText, "{ not json");
    assert.equal((await call("PUT", "/api/projects/demo/settings", { settings: { scheduler: { maxAttempts: 2 } } })).status, 400, "a patch cannot be applied to it");
    const fix = await call("PUT", "/api/projects/demo/settings", { replace: true, settings: { baseBranch: "main" } });
    assert.equal(fix.status, 200, fix.text);
    assert.deepEqual(JSON.parse(read(projectFile())), { baseBranch: "main" });
  });
});

describe("POST /api/settings/notify-test", () => {
  test("sends one ntfy message with the configured URL and token, and answers {ok}", async () => {
    sinkHits.length = 0;
    const r = await call("POST", "/api/settings/notify-test", {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    assert.equal(sinkHits.length, 1);
    assert.equal(sinkHits[0].url, "/topic");
    assert.equal(sinkHits[0].body, "orch: test notification");
    assert.equal(sinkHits[0].headers.authorization, `Bearer ${NTFY_TOKEN}`);
  });

  test("a failing topic answers {ok: false, error} and the token is nowhere in the response or the event log", async () => {
    const saved = read(serverFile());
    writeServer({ ...JSON.parse(saved), notify: { ntfyUrl: `http://127.0.0.1:${sink.address().port}/fail`, ntfyToken: NTFY_TOKEN } });
    orch.reloadServer();
    try {
      const r = await call("POST", "/api/settings/notify-test", {});
      assert.equal(r.status, 200);
      assert.equal(r.json.ok, false);
      assert.match(r.json.error, /500/);
      assert.ok(!r.text.includes(NTFY_TOKEN));
      // an unreachable host: the error is a message, not an exception, and still has no token
      writeServer({ ...JSON.parse(saved), notify: { ntfyUrl: `http://127.0.0.1:1/${NTFY_TOKEN}`, ntfyToken: NTFY_TOKEN } });
      orch.reloadServer();
      const down = await call("POST", "/api/settings/notify-test", {});
      assert.equal(down.json.ok, false);
      assert.ok(!down.text.includes(NTFY_TOKEN), down.text);
    } finally {
      fs.writeFileSync(serverFile(), saved);
      orch.reloadServer();
    }
    const events = JSON.stringify(store.db.prepare("SELECT * FROM events").all());
    for (const secret of [TOKEN, NTFY_TOKEN, ENV_SECRET]) assert.ok(!events.includes(secret), "no secret in the event log");
  });

  test("no ntfy URL: {ok: false, error}", async () => {
    const saved = read(serverFile());
    writeServer({ ...JSON.parse(saved), notify: { ntfyUrl: "", ntfyToken: NTFY_TOKEN } });
    orch.reloadServer();
    try {
      const r = await call("POST", "/api/settings/notify-test", {});
      assert.deepEqual(r.json, { ok: false, error: "no ntfy URL is set" });
    } finally { fs.writeFileSync(serverFile(), saved); orch.reloadServer(); }
  });
});

}); // settings routes

