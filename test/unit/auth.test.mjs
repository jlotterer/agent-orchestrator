/**
 * Bearer-token auth, login cookie, bind guard and token resolution (TASK-08; architecture §16,
 * decision 0014). Run after `npm run build`: npm run test:unit
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAuthorized, loginCookie, bindGuard, resolveToken, tokenMatches, COOKIE_NAME } from "../../dist/auth.js";
import { loadConfig, loadServerConfig, loadProjectConfig, toLegacyConfig, DEFAULT_CONFIG } from "../../dist/config.js";

const req = (headers = {}) => ({ headers });
const TOKEN = "s3cret token/with;odd=chars";

describe("isAuthorized", () => {
  test("no token configured: everything is allowed", () => {
    assert.equal(isAuthorized(req(), ""), true);
  });
  test("Bearer header with the right token", () => {
    assert.equal(isAuthorized(req({ authorization: `Bearer ${TOKEN}` }), TOKEN), true);
    assert.equal(isAuthorized(req({ authorization: `bearer ${TOKEN}` }), TOKEN), true);
  });
  test("missing, wrong, prefixed or differently sized tokens are refused", () => {
    assert.equal(isAuthorized(req(), TOKEN), false);
    assert.equal(isAuthorized(req({ authorization: "Bearer nope" }), TOKEN), false);
    assert.equal(isAuthorized(req({ authorization: `Bearer ${TOKEN}x` }), TOKEN), false);
    assert.equal(isAuthorized(req({ authorization: `Basic ${TOKEN}` }), TOKEN), false);
    assert.equal(isAuthorized(req({ authorization: "Bearer " }), TOKEN), false);
  });
  test("the login cookie authorizes, among other cookies", () => {
    const value = loginCookie(TOKEN).split(";")[0];
    assert.equal(isAuthorized(req({ cookie: value }), TOKEN), true);
    assert.equal(isAuthorized(req({ cookie: `theme=dark; ${value}; other=1` }), TOKEN), true);
    assert.equal(isAuthorized(req({ cookie: `${COOKIE_NAME}=wrong` }), TOKEN), false);
    assert.equal(isAuthorized(req({ cookie: `x${COOKIE_NAME}=${encodeURIComponent(TOKEN)}` }), TOKEN), false);
    assert.equal(isAuthorized(req({ cookie: `${COOKIE_NAME}=%E0%A4%A` }), TOKEN), false); // malformed escape
  });
  test("a wrong header does not mask a right cookie", () => {
    const value = loginCookie(TOKEN).split(";")[0];
    assert.equal(isAuthorized(req({ authorization: "Bearer stale", cookie: value }), TOKEN), true);
  });
  test("tokenMatches compares exactly", () => {
    assert.equal(tokenMatches("abc", "abc"), true);
    assert.equal(tokenMatches("abc", "abd"), false);
    assert.equal(tokenMatches("", "abc"), false);
  });
});

describe("loginCookie", () => {
  test("HttpOnly, SameSite=Strict, Path=/, long-lived, value round-trips", () => {
    const c = loginCookie(TOKEN);
    assert.match(c, /^orch_token=/);
    assert.match(c, /; HttpOnly/);
    assert.match(c, /; SameSite=Strict/);
    assert.match(c, /; Path=\//);
    assert.match(c, /; Max-Age=\d+/);
    assert.equal(decodeURIComponent(c.split(";")[0].slice("orch_token=".length)), TOKEN);
  });
});

describe("bindGuard", () => {
  test("loopback hosts are always allowed", () => {
    for (const host of ["127.0.0.1", "::1", "localhost", "LOCALHOST"]) assert.equal(bindGuard({ host, token: "", allowInsecure: false }), null, host);
  });
  test("a non-loopback host without a token is refused, naming both options", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.5"]) {
      const msg = bindGuard({ host, token: "", allowInsecure: false });
      assert.ok(msg, host);
      assert.match(msg, /auth\.token/);
      assert.match(msg, /auth\.allowInsecure/);
      assert.ok(msg.includes(host));
    }
  });
  test("a token or the explicit opt-out allows a non-loopback host", () => {
    assert.equal(bindGuard({ host: "0.0.0.0", token: "t", allowInsecure: false }), null);
    assert.equal(bindGuard({ host: "0.0.0.0", token: "", allowInsecure: true }), null);
  });
});

describe("resolveToken", () => {
  test("ORCH_TOKEN wins over the settings file; blanks are ignored", () => {
    assert.equal(resolveToken("file", { ORCH_TOKEN: "env" }), "env");
    assert.equal(resolveToken("file", {}), "file");
    assert.equal(resolveToken("file", { ORCH_TOKEN: "  " }), "file");
    assert.equal(resolveToken(undefined, {}), "");
    assert.equal(resolveToken(" padded ", {}), "padded");
  });
});

describe("config: auth settings", () => {
  let tmp;
  const saved = process.env.ORCH_TOKEN;
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orch-auth-")); delete process.env.ORCH_TOKEN; });
  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (saved === undefined) delete process.env.ORCH_TOKEN; else process.env.ORCH_TOKEN = saved;
  });

  test("legacy defaults: host 127.0.0.1, auth off", () => {
    assert.equal(DEFAULT_CONFIG.host, "127.0.0.1");
    assert.deepEqual(DEFAULT_CONFIG.auth, { token: "", allowInsecure: false });
  });
  test("legacy orch.config.json: auth from the file, ORCH_TOKEN overrides", () => {
    const p = path.join(tmp, "orch.config.json");
    fs.writeFileSync(p, JSON.stringify({ repo: ".", auth: { token: "from-file", allowInsecure: true } }));
    assert.deepEqual(loadConfig(p).config.auth, { token: "from-file", allowInsecure: true });
    process.env.ORCH_TOKEN = "from-env";
    try { assert.equal(loadConfig(p).config.auth.token, "from-env"); } finally { delete process.env.ORCH_TOKEN; }
  });
  test("server.json: auth from the file, ORCH_TOKEN overrides, carried by toLegacyConfig", () => {
    const home = path.join(tmp, "home");
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(home); fs.mkdirSync(repo);
    fs.writeFileSync(path.join(home, "server.json"), JSON.stringify({ auth: { token: "srv" } }));
    const s = loadServerConfig(home);
    assert.deepEqual(s.auth, { token: "srv", allowInsecure: false });
    assert.deepEqual(toLegacyConfig(s, loadProjectConfig(repo, s).config, repo, { home }).auth, { token: "srv", allowInsecure: false });
    process.env.ORCH_TOKEN = "env-srv";
    try { assert.equal(loadServerConfig(home).auth.token, "env-srv"); } finally { delete process.env.ORCH_TOKEN; }
  });
});
