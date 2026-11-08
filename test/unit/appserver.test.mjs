/**
 * src/appserver.ts (architecture §10.4, TASK-16): start the app on a free port, wait for readiness,
 * stop the whole process group, and kill leftovers from pidfiles. POSIX process groups are required,
 * so the lifecycle tests are skipped on Windows (run them in Docker, see README "Testing").
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { startApp, killLeftovers, AppStartError, pidFile } from "../../dist/appserver.js";
import { loadPrompt, render } from "../../dist/prompts.js";

const posix = process.platform !== "win32";
const skip = posix ? {} : { skip: "needs POSIX process groups" };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "orch-app-"));
const node = JSON.stringify(process.execPath);
/** An app that serves 200 on $PORT and starts a child of its own (to prove the whole group is stopped). */
const SERVER = `${node} -e "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'}); require('http').createServer((q,s)=>s.end('hi '+process.env.GREETING)).listen(process.env.PORT,'127.0.0.1',()=>console.log('listening on '+process.env.PORT))"`;

describe("startApp", () => {
  test("serves on a free port, substitutes {port}, records a pidfile, stops the whole group", skip, async () => {
    const dir = tmpdir();
    const app = await startApp({ cwd: dir, startCommand: SERVER, urlTemplate: "http://127.0.0.1:{port}/x", env: { GREETING: "there" }, readyTimeoutSeconds: 10, pidDir: path.join(dir, "run"), taskId: "t1" });
    assert.equal(app.url, `http://127.0.0.1:${app.port}/x`);
    assert.equal(await (await fetch(app.url)).text(), "hi there");
    assert.match(app.output(), new RegExp(`listening on ${app.port}`));
    assert.equal(fs.readFileSync(pidFile(path.join(dir, "run"), "t1"), "utf8").trim(), String(app.pid));
    await app.stop();
    await app.stop(); // idempotent
    assert.equal(alive(-app.pid), false, "process group gone");
    assert.equal(fs.existsSync(pidFile(path.join(dir, "run"), "t1")), false, "pidfile removed");
  });

  test("a status below 500 counts as ready (404)", skip, async () => {
    const dir = tmpdir();
    const cmd = `${node} -e "require('http').createServer((q,s)=>{s.statusCode=404;s.end()}).listen(process.env.PORT,'127.0.0.1')"`;
    const app = await startApp({ cwd: dir, startCommand: cmd, urlTemplate: "", env: {}, readyTimeoutSeconds: 10, pidDir: dir, taskId: "t404" });
    assert.equal(app.url, `http://127.0.0.1:${app.port}/`, "default url");
    await app.stop();
  });

  test("never ready (503): AppStartError after the timeout with the app's output; app stopped", skip, async () => {
    const dir = tmpdir();
    const cmd = `${node} -e "console.log('booting forever'); require('http').createServer((q,s)=>{s.statusCode=503;s.end()}).listen(process.env.PORT,'127.0.0.1')"`;
    let spawned;
    const t0 = Date.now();
    await assert.rejects(
      startApp({ cwd: dir, startCommand: cmd, urlTemplate: "", env: {}, readyTimeoutSeconds: 2, pidDir: dir, taskId: "t2", onSpawn: (a) => (spawned = a) }),
      (e) => e instanceof AppStartError && /did not become ready .* within 2 s/.test(e.message) && e.output.includes("booting forever"),
    );
    assert.ok(Date.now() - t0 < 6000, "gave up near the timeout");
    assert.equal(alive(-spawned.pid), false, "app stopped");
    assert.equal(fs.existsSync(pidFile(dir, "t2")), false, "pidfile removed");
  });

  test("an app that exits fails at once with its output", skip, async () => {
    const dir = tmpdir();
    const t0 = Date.now();
    await assert.rejects(
      startApp({ cwd: dir, startCommand: "echo cannot bind >&2; exit 3", urlTemplate: "", env: {}, readyTimeoutSeconds: 30, pidDir: dir, taskId: "t3" }),
      (e) => e instanceof AppStartError && /exited \(code 3\)/.test(e.message) && e.output.includes("cannot bind"),
    );
    assert.ok(Date.now() - t0 < 5000, "did not wait for the timeout");
  });

  test("a SIGTERM-ignoring app is SIGKILLed after the grace period", { ...skip, timeout: 15_000 }, async () => {
    const dir = tmpdir();
    const cmd = `${node} -e "process.on('SIGTERM',()=>{}); require('http').createServer((q,s)=>s.end()).listen(process.env.PORT,'127.0.0.1')"`;
    const app = await startApp({ cwd: dir, startCommand: cmd, urlTemplate: "", env: {}, readyTimeoutSeconds: 10, pidDir: dir, taskId: "t4" });
    await app.stop();
    assert.equal(alive(-app.pid), false);
  });
});

describe("killLeftovers", () => {
  test("kills recorded groups and removes their pidfiles; stale and junk pidfiles are removed", skip, async () => {
    const dir = tmpdir();
    const child = spawn("sh", ["-c", `${node} -e "setTimeout(()=>{},60000)"`], { detached: true, stdio: "ignore" });
    child.unref();
    fs.writeFileSync(pidFile(dir, "live"), `${child.pid}\n`);
    fs.writeFileSync(pidFile(dir, "stale"), "999999999\n"); // no such process group
    fs.writeFileSync(pidFile(dir, "junk"), "not a pid\n");
    fs.writeFileSync(path.join(dir, "other.txt"), "kept");
    const { found, done } = killLeftovers(dir);
    assert.deepEqual(found.map((f) => [f.taskId, f.alive]).sort(), [["live", true], ["stale", false]]);
    await done;
    assert.equal(alive(-child.pid), false, "leftover group killed");
    assert.deepEqual(fs.readdirSync(dir), ["other.txt"]);
  });

  test("no run directory: nothing found", async () => {
    const { found, done } = killLeftovers(path.join(tmpdir(), "missing"));
    assert.deepEqual(found, []);
    await done;
  });
});

describe("validator prompts (REQ-VAL-02)", () => {
  const vars = { gate_output: "`npm test` passed. Its output:\n\n12 tests passed", app_url: "http://127.0.0.1:5173/" };
  test("the standard validator prompt carries the gate output", () => {
    const p = render(loadPrompt("validator", os.tmpdir()), vars);
    assert.match(p, /## Test gate output\n`npm test` passed\. Its output:\n\n12 tests passed/);
    assert.doesNotMatch(p, /App under test/);
  });
  test("the UI validator prompt carries the gate output, the app url and the BLOCKED verdict", () => {
    const p = render(loadPrompt("validator-ui", os.tmpdir()), vars);
    assert.match(p, /12 tests passed/);
    assert.match(p, /## App under test[\s\S]*http:\/\/127\.0\.0\.1:5173\//);
    assert.match(p, /"BLOCKED"/);
  });
});
