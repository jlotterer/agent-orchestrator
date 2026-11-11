/**
 * Agent accounts (T028; architecture §15; contract sign-in-flows.md; REQ-UI-09, REQ-OPS-08).
 * Flows run `scripts/fake-login.mjs` under script(1), so the flow tests need Linux or macOS and util-linux
 * `script`; run them in Docker on Windows (README "Testing"). Run after `npm run build`: npm run test:unit
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Accounts, AccountError, cleanLine } from "../../dist/accounts.js";
import { startServer } from "../../dist/server.js";
import { Store } from "../../dist/db.js";
import { ADAPTERS } from "../../dist/adapters/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, "..", "..", "scripts", "fake-login.mjs");
const FIX = path.join(here, "..", "fixtures", "accounts");
const fixture = (n) => fs.readFileSync(path.join(FIX, n), "utf8");
const canFlow = (os.platform() === "linux" || os.platform() === "darwin") && spawnSync("script", ["--version"]).error === undefined;
const flowOpts = { skip: canFlow ? false : "needs Linux/macOS with script(1)" };

let tmp;
before(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "orch-accounts-test-")));
  try { fs.chmodSync(FAKE, 0o755); } catch { /* not on Windows */ }
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** An adapter whose commands are the fake CLI; the engine never learns a vendor. */
const fakeAdapter = {
  name: "fake", supportsResume: false,
  launch: () => ({ command: FAKE, args: [], stdin: null }), parseLine: () => [], finish: () => {},
  account: {
    status: (cfg) => ({ command: cfg.command, args: ["status"], stdin: null }),
    parseStatus: (out, code) => ({ signedIn: code === 0, detail: out.trim() }),
    login: (cfg) => ({ command: cfg.command, args: [], stdin: null }),
    failureHint: "try again",
  },
};
const resolveAdapter = (type) => { if (type === "fake") return fakeAdapter; throw new Error("unknown"); };

function make(env = {}, { __opts = {}, ...extra } = {}) {
  const marker = path.join(tmp, `marker-${Math.random().toString(36).slice(2)}`);
  const cfgs = { fake: { type: "fake", command: FAKE, extraArgs: [], env: { FAKE_LOGIN_MARKER: marker, ...env } }, ...extra };
  const acc = new Accounts({ config: () => ({ adapters: cfgs, ghCommand: "orch-test-no-such-gh" }), cwd: tmp, resolveAdapter, ...__opts });
  const events = [];
  acc.on("account", (e) => events.push(e));
  return { acc, events, marker };
}
const until = async (cond, ms = 8000) => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 25)); }
};

describe("parseStatus of the shipped adapters (recorded outputs)", () => {
  test("claude: auth status --json", () => {
    const a = ADAPTERS.claude.account;
    assert.deepEqual(a.status({ command: "claude" }).args, ["auth", "status", "--json"]);
    assert.deepEqual(a.login({ command: "claude" }).args, ["auth", "login"]);
    assert.deepEqual(a.parseStatus(fixture("claude-status-signed-in.txt"), 0), { signedIn: true, detail: "claude.ai" });
    assert.equal(a.parseStatus('{"loggedIn": false}', 1).signedIn, false);
    assert.equal(a.parseStatus("", null).detail, "status check timed out");
    assert.equal(a.parseStatus("garbage", 1).signedIn, false);
  });
  test("codex: login status and login --device-auth with the file store", () => {
    const a = ADAPTERS.codex.account;
    assert.deepEqual(a.status({ command: "codex" }).args, ["login", "status"]);
    assert.deepEqual(a.login({ command: "codex" }).args, ["login", "--device-auth", "-c", "cli_auth_credentials_store=file"]);
    assert.deepEqual(a.parseStatus(fixture("codex-status-signed-in.txt"), 0), { signedIn: true, detail: "Logged in using ChatGPT" });
    assert.equal(a.parseStatus("Not logged in\n", 1).signedIn, false);
    assert.equal(a.parseStatus("", null).detail, "status check timed out");
    assert.ok(a.failureHint.includes("Device authorization"));
  });
  test("antigravity: one tiny headless turn", () => {
    const a = ADAPTERS.antigravity.account;
    assert.ok(a.status({ command: "agy" }).args.includes("--output-format"));
    assert.deepEqual(a.parseStatus(fixture("agy-status-signed-in.txt"), 0), { signedIn: true, detail: "signed in" });
    assert.equal(a.parseStatus("Error: authentication required\n", 1).signedIn, false);
    assert.equal(a.parseStatus('{"status":"ERROR","error":"x"}', 1).signedIn, false);
    assert.equal(a.parseStatus("", null).detail, "status check timed out");
  });
});

describe("GET rows (REQ-UI-09)", () => {
  test("one row per adapter plus gh; a missing command is 'not installed'", async () => {
    const { acc } = make({}, {
      ghost: { type: "fake", command: "orch-test-no-such-cli", extraArgs: [], env: {} },
      mystery: { type: "other", command: FAKE, extraArgs: [], env: {} },
    });
    const rows = await acc.list();
    assert.deepEqual(rows.map((r) => r.id), ["fake", "ghost", "mystery", "gh"]);
    for (const r of rows) for (const k of ["id", "kind", "type", "command", "version", "status", "detail", "loginActive"]) assert.ok(k in r, `${r.id} lacks ${k}`);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    if (canFlow) {
      assert.equal(byId.fake.kind, "adapter");
      assert.equal(byId.fake.version, "1.2.3");
      assert.equal(byId.fake.status, "signed_out");
      assert.equal(byId.fake.loginActive, false);
    }
    assert.equal(byId.ghost.version, null);
    assert.equal(byId.ghost.status, "unknown");
    assert.ok(byId.ghost.detail.startsWith("not installed"));
    if (canFlow) assert.equal(byId.mystery.status, "unknown"); // unknown adapter type: no sign-in support
    assert.equal(byId.gh.kind, "tool");
    assert.equal(byId.gh.version, null);
    assert.ok(byId.gh.detail.startsWith("not installed"));
  });

  test("probes run in parallel, each with its own timeout", async () => {
    const hang = { ...fakeAdapter, account: { ...fakeAdapter.account, status: () => ({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], stdin: null }) } };
    const cfgs = {};
    for (const n of ["a", "b", "c"]) cfgs[n] = { type: "hang", command: process.execPath, extraArgs: [], env: {} };
    const acc = new Accounts({ config: () => ({ adapters: cfgs, ghCommand: "orch-test-no-such-gh" }), cwd: tmp, resolveAdapter: () => hang, probeTimeoutMs: 700 });
    const t0 = Date.now();
    const rows = await acc.list();
    const took = Date.now() - t0;
    assert.ok(took < 2000, `three 700 ms timeouts should overlap, took ${took} ms`);
    for (const r of rows.filter((x) => x.id !== "gh")) { assert.equal(r.status, "unknown"); assert.ok(/timed out/.test(r.detail), r.detail); }
  });
});

describe("cleanLine", () => {
  test("strips ANSI sequences, OSC titles and keeps the last carriage-return frame", () => {
    assert.equal(cleanLine("\x1b[32mOpen https://x.test/a?b=c\x1b[0m\r"), "Open https://x.test/a?b=c");
    assert.equal(cleanLine("\x1b]0;title\x07\x1b[1;31mred\x1b[m"), "red");
    assert.equal(cleanLine("\x1b[?2004hprompt\x1b[?2004l"), "prompt");
    assert.equal(cleanLine("spin |\rspin /\rdone"), "done");
    assert.equal(cleanLine("  \r"), "");
  });

  test("strips two-byte cursor escapes such as save/restore cursor (gh prints ESC 7 after its prompt)", () => {
    assert.equal(cleanLine("? Authenticate Git with your GitHub credentials? (Y/n) \x1b7"), "? Authenticate Git with your GitHub credentials? (Y/n)");
    assert.equal(cleanLine("a\x1b8b\x1bcc"), "abc");
  });
});

describe("sign-in flow", flowOpts, () => {
  test("URL and code reach SSE listeners, input finishes the flow, a second start is 409, nothing is persisted", async () => {
    const lines = [];
    const origLog = console.log, origErr = console.error;
    console.log = (...a) => { lines.push(a.join(" ")); }; console.error = (...a) => { lines.push(a.join(" ")); };
    const home = path.join(tmp, "e2e-home");
    fs.mkdirSync(home, { recursive: true });
    const store = new Store(path.join(home, "orch.db"));
    const orch = Object.assign(new EventEmitter(), {
      home, store, server: { auth: { token: "" }, host: "127.0.0.1", port: 0, agents: { adapters: {} }, git: { ghCommand: "x" } },
    });
    const { acc, marker } = make({ FAKE_LOGIN_PIDFILE: path.join(tmp, "pid-1") });
    const srv = startServer(orch, { accounts: acc });
    try {
      await new Promise((r) => (srv.listening ? r() : srv.once("listening", r)));
      const base = `http://127.0.0.1:${srv.address().port}`;
      const post = (p, body) => fetch(base + p, { method: "POST", body: JSON.stringify(body ?? {}) });

      // GET /api/accounts
      const rows = await (await fetch(base + "/api/accounts")).json();
      assert.deepEqual(rows.map((r) => r.id), ["fake", "gh"]);

      // SSE
      const got = [];
      const ctl = new AbortController();
      const sse = await fetch(base + "/api/events/stream", { signal: ctl.signal });
      (async () => {
        const dec = new TextDecoder(); let buf = "";
        try {
          for await (const chunk of sse.body) {
            buf += dec.decode(chunk, { stream: true });
            let i;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const block = buf.slice(0, i); buf = buf.slice(i + 2);
              const t = /^event: (.+)$/m.exec(block)?.[1], d = /^data: (.+)$/m.exec(block)?.[1];
              if (t === "account" && d) got.push(JSON.parse(d));
            }
          }
        } catch { /* aborted */ }
      })();

      assert.equal((await post("/api/accounts/fake/login")).status, 200);
      assert.equal((await post("/api/accounts/fake/login")).status, 409);
      await until(() => got.some((e) => e.line?.includes("https://example.test/device")));
      assert.ok(got.some((e) => e.id === "fake" && e.line === "Open https://example.test/device and enter code ABCD-EFGH"));
      // a reloaded dashboard can catch up
      const catchUp = await (await fetch(base + "/api/accounts/fake/login")).json();
      assert.equal(catchUp.active, true);
      assert.ok(catchUp.lines.some((l) => l.includes("ABCD-EFGH")));

      assert.equal((await post("/api/accounts/fake/login/input", { text: "ok" })).status, 200);
      await until(() => got.some((e) => e.done));
      const done = got.find((e) => e.done);
      assert.equal(done.id, "fake");
      assert.equal(done.exitCode, 0);
      assert.ok(fs.existsSync(marker), "the CLI ran to its end and wrote the marker");
      // the input was echoed by the pty but never sent back
      assert.ok(!got.some((e) => e.line === "ok"), "echoed input must not be sent");
      // the status probe ran again and the card can refresh
      await until(() => got.some((e) => e.account));
      assert.equal(got.find((e) => e.account).account.status, "signed_in");
      assert.equal((await post("/api/accounts/fake/login/input", { text: "late" })).status, 409);
      ctl.abort();

      // REQ-OPS-08: not in the events table, not in any file under the data directory, not in any log line
      const secrets = ["ABCD-EFGH", "https://example.test/device"];
      const dump = JSON.stringify(store.db.prepare("SELECT * FROM events").all());
      for (const s of secrets) assert.ok(!dump.includes(s), `${s} must not be in the events table`);
      for (const t of store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)) {
        const all = JSON.stringify(store.db.prepare(`SELECT * FROM "${t}"`).all());
        for (const s of secrets) assert.ok(!all.includes(s), `${s} must not be in table ${t}`);
      }
      store.db.close();
      const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
      for (const f of walk(home)) {
        const text = fs.readFileSync(f, "latin1");
        for (const s of secrets) assert.ok(!text.includes(s), `${s} must not be in ${path.relative(home, f)}`);
      }
      for (const l of lines) for (const s of secrets) assert.ok(!l.includes(s), `${s} must not be logged: ${l}`);
    } finally {
      console.log = origLog; console.error = origErr;
      srv.close();
    }
  });

  test("typed input never reaches the store, any file or a log line", async () => {
    const lines = [];
    const origLog = console.log;
    console.log = (...a) => { lines.push(a.join(" ")); };
    try {
      const { acc, events } = make({ FAKE_LOGIN_MODE: "prompt" });
      acc.startLogin("fake");
      await until(() => events.some((e) => e.line?.includes("Paste the code here")));
      acc.sendInput("fake", "S3CRET-PASTED-CODE-123");
      await until(() => events.some((e) => e.done));
      assert.ok(!events.some((e) => e.line?.includes("S3CRET")), "echo of the input is dropped");
      for (const l of lines) assert.ok(!l.includes("S3CRET") && !l.includes("ABCD-EFGH"), l);
      const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
      for (const f of walk(tmp)) assert.ok(!fs.readFileSync(f, "latin1").includes("S3CRET-PASTED-CODE-123"), `input leaked into ${f}`);
    } finally { console.log = origLog; }
  });

  test("ANSI colour codes are stripped and the echoed input line is not sent", async () => {
    const { acc, events } = make({ FAKE_LOGIN_MODE: "ansi" });
    acc.startLogin("fake");
    await until(() => events.some((e) => e.line?.includes("ABCD-EFGH")));
    acc.sendInput("fake", "pasted-123");
    await until(() => events.some((e) => e.done));
    for (const e of events.filter((x) => x.line !== undefined)) {
      assert.ok(!/[\x00-\x08\x0b-\x1f\x7f]/.test(e.line), `control character in ${JSON.stringify(e.line)}`);
    }
    assert.ok(events.some((e) => e.line === "Open https://example.test/device and enter code ABCD-EFGH"));
    assert.ok(!events.some((e) => e.line === "pasted-123"), "echo must be dropped");
    assert.ok(events.some((e) => e.line === "Signed in"));
  });

  test("a prompt without a newline is shown, and empty input sends Enter", async () => {
    const { acc, events } = make({ FAKE_LOGIN_MODE: "prompt" });
    acc.startLogin("fake");
    await until(() => events.some((e) => e.line === "Paste the code here >"));
    acc.sendInput("fake", "");
    await until(() => events.some((e) => e.done));
    assert.equal(events.find((e) => e.done).exitCode, 0);
  });

  test("input ends in Enter (CR), so a full-screen menu in raw mode is selected too", async () => {
    const { acc, events } = make({ FAKE_LOGIN_MODE: "raw" });
    acc.startLogin("fake");
    await until(() => events.some((e) => e.line?.includes("ABCD-EFGH")));
    acc.sendInput("fake", "");
    await until(() => events.some((e) => e.done));
    assert.equal(events.find((e) => e.done).exitCode, 0);
    assert.ok(events.some((e) => e.line?.startsWith("Enter key received")));
  });

  test("a cursor-position query (ESC[6n) from the CLI is answered, so gh-style prompts do not hang", async () => {
    const { acc, events } = make({ FAKE_LOGIN_MODE: "cpr" });
    acc.startLogin("fake");
    await until(() => events.some((e) => e.line?.includes("cursor report received")));
    acc.sendInput("fake", "Y");
    await until(() => events.some((e) => e.done));
    assert.equal(events.find((e) => e.done).exitCode, 0);
  });

  test("a failed flow reports its exit code and the adapter's hint", async () => {
    const { acc, events } = make({ FAKE_LOGIN_MODE: "fail" });
    acc.startLogin("fake");
    await until(() => events.some((e) => e.line?.includes("ABCD-EFGH")));
    acc.sendInput("fake", "x");
    await until(() => events.some((e) => e.done));
    const d = events.find((e) => e.done);
    assert.equal(d.exitCode, 3);
    assert.equal(d.hint, "try again");
  });

  test("cancel kills the child, sends done, and probes the status again", async () => {
    const pidFile = path.join(tmp, "pid-cancel");
    const { acc, events } = make({ FAKE_LOGIN_MODE: "hang", FAKE_LOGIN_PIDFILE: pidFile });
    acc.startLogin("fake");
    await until(() => events.some((e) => e.line?.includes("ABCD-EFGH")));
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    acc.cancel("fake");
    await until(() => events.some((e) => e.done));
    assert.equal(events.find((e) => e.done).cancelled, true);
    await until(() => events.some((e) => e.account));
    assert.equal(events.find((e) => e.account).account.loginActive, false);
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    assert.equal(acc.isActive("fake"), false);
  });

  test("a flow still running after the time limit is killed", async () => {
    const { acc, events } = make({ FAKE_LOGIN_MODE: "hang" }, { __opts: { loginTimeoutMs: 600 } });
    acc.startLogin("fake");
    await until(() => events.some((e) => e.done));
    assert.equal(events.find((e) => e.done).timedOut, true);
    await until(() => events.some((e) => e.account));
  });

  test("a command that cannot start ends the flow instead of hanging", async () => {
    const { acc, events } = make({}, { ghost: { type: "fake", command: "orch-test-no-such-cli", extraArgs: [], env: {} } });
    acc.startLogin("ghost");
    await until(() => events.some((e) => e.done));
    assert.notEqual(events.find((e) => e.done).exitCode, 0);
  });

  test("unknown id is 404; no running flow is 409 for input and cancel", () => {
    const { acc } = make();
    assert.throws(() => acc.startLogin("nope"), (e) => e instanceof AccountError && e.status === 404);
    assert.throws(() => acc.sendInput("fake", "x"), (e) => e.status === 409);
    assert.throws(() => acc.cancel("fake"), (e) => e.status === 409);
  });
});

describe("unsupported platforms", () => {
  test("a login on Windows answers 501 with the exact command to run by hand", () => {
    const acc = new Accounts({
      config: () => ({ adapters: { claude: { type: "claude", command: "claude", extraArgs: [], env: {} }, codex: { type: "codex", command: "codex", extraArgs: [], env: {} } }, ghCommand: "gh" }),
      cwd: tmp, platform: "win32",
    });
    const cases = { claude: "claude auth login", codex: "codex login --device-auth -c cli_auth_credentials_store=file", gh: "gh auth login --hostname github.com --git-protocol https --web" };
    for (const [id, cmd] of Object.entries(cases)) {
      assert.throws(() => acc.startLogin(id), (e) => e.status === 501 && e.body.command === cmd && e.message.includes(cmd), id);
    }
  });

  test("the HTTP layer answers 501 with the command in the body", async () => {
    const home = path.join(tmp, "http501");
    fs.mkdirSync(home, { recursive: true });
    const orch = Object.assign(new EventEmitter(), {
      home, store: new Store(path.join(home, "orch.db")),
      server: { auth: { token: "" }, host: "127.0.0.1", port: 0, agents: { adapters: {} }, git: { ghCommand: "gh" } },
    });
    const acc = new Accounts({ config: () => ({ adapters: {}, ghCommand: "gh" }), cwd: tmp, platform: "win32" });
    const srv = startServer(orch, { accounts: acc });
    try {
      await new Promise((r) => (srv.listening ? r() : srv.once("listening", r)));
      const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/accounts/gh/login`, { method: "POST", body: "{}" });
      assert.equal(res.status, 501);
      const body = await res.json();
      assert.equal(body.command, "gh auth login --hostname github.com --git-protocol https --web");
    } finally { srv.close(); orch.store.db.close(); }
  });
});
