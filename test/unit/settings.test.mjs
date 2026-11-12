/**
 * Settings schema, helpers and the dashboard forms (the routes are in settings-api.test.mjs, which needs SQLite) (T029; REQ-UI-10, REQ-UI-11; architecture §5.2, §15, §19;
 * decision 0026). Run after `npm run build`: npm run test:unit
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { DEFAULT_SERVER_CONFIG, DEFAULT_PROJECT_CONFIG, FORBIDDEN_PROJECT_KEYS } from "../../dist/config.js";
import {
  settingsSchema, buildDefaults, classify, checkSettings, maskServerSettings, resolveSecrets, applyPatch, pruneDefaults,
} from "../../dist/settings-schema.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---------------------------------------------------------------------------------------------
// REQ-UI-11: one description of every setting
// ---------------------------------------------------------------------------------------------

/**
 * The setting keys the §19 table of an architecture document names, env-var rows excluded. A row lists several keys
 * separated by " / "; a key without a dot, or starting with a dot, is a sibling of the row's first key.
 */
function documentedKeys(markdown) {
  const section = markdown.split(/^## 19\. /m)[1]?.split(/^## 20\. /m)[0] ?? "";
  const keys = new Set();
  for (const line of section.split(/\r?\n/)) {
    if (!line.startsWith("| `")) continue;
    const cells = line.split("|").map((c) => c.trim());
    if (cells[2].startsWith("env")) continue;
    const tokens = [...cells[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const parent = tokens[0].includes(".") ? tokens[0].slice(0, tokens[0].lastIndexOf(".") + 1) : "";
    tokens.forEach((t, i) => {
      const rel = t.startsWith(".") ? t.slice(1) : t;
      keys.add(i === 0 ? t : rel.includes(".") ? rel : parent + rel);
    });
  }
  return keys;
}

/** The comparison the unit test makes, returning a message that names every key that is on one side only. */
function driftMessage(markdown, schemaKeys) {
  const doc = documentedKeys(markdown), schema = new Set(schemaKeys);
  const notInDoc = [...schema].filter((k) => !doc.has(k)), notInSchema = [...doc].filter((k) => !schema.has(k));
  return [
    ...notInDoc.map((k) => `'${k}' is in the schema but not in the architecture §19 table`),
    ...notInSchema.map((k) => `'${k}' is in the architecture §19 table but not in the schema`),
  ].join("; ");
}

describe("settings schema (REQ-UI-11)", () => {
  const architecture = fs.readFileSync(path.join(ROOT, "docs", "architecture.md"), "utf8");

  test("the defaults built from the schema are the loaders' defaults", () => {
    assert.deepEqual(buildDefaults("server"), DEFAULT_SERVER_CONFIG);
    assert.deepEqual(buildDefaults("project"), DEFAULT_PROJECT_CONFIG);
    // Pinned values: changing a default is a decision, not a side effect of editing the schema.
    assert.equal(DEFAULT_SERVER_CONFIG.port, 4800);
    assert.equal(DEFAULT_SERVER_CONFIG.scheduler.maxAgents, 2);
    assert.deepEqual(Object.keys(DEFAULT_SERVER_CONFIG.agents.adapters), ["claude", "antigravity", "codex"]);
    assert.equal(DEFAULT_PROJECT_CONFIG.git.feedback.trigger, "/orch");
    assert.deepEqual(DEFAULT_PROJECT_CONFIG.handoff.contextFiles, ["spec.md", "data-model.md", "plan.md"]);
  });

  test("the keys of the architecture §19 table and of the schema are the same, both ways", () => {
    const msg = driftMessage(architecture, settingsSchema.map((e) => e.key));
    assert.equal(msg, "", msg);
  });

  test("a key on one side only fails the comparison and names the key", () => {
    const keys = settingsSchema.map((e) => e.key);
    const withExtra = driftMessage(architecture, [...keys, "scheduler.newThing"]);
    assert.match(withExtra, /'scheduler\.newThing' is in the schema but not in the architecture §19 table/);
    const withoutRow = driftMessage(architecture.split(/\r?\n/).filter((l) => !l.includes("`retention.eventDays`")).join("\n"), keys);
    assert.match(withoutRow, /'retention\.eventDays' is in the schema but not in the architecture §19 table/);
    const extraRow = driftMessage(architecture.replace("| `defaults.*` |", "| `made.up` | server | string | — | — |\n| `defaults.*` |"), keys);
    assert.match(extraRow, /'made\.up' is in the architecture §19 table but not in the schema/);
  });

  test("entries are well formed and keys are unique per scope", () => {
    const seen = new Set();
    for (const e of settingsSchema) {
      const id = `${e.scope}:${e.key}`;
      assert.ok(!seen.has(id), `duplicate ${id}`);
      seen.add(id);
      assert.ok(["server", "project"].includes(e.scope), id);
      assert.ok(["string", "int", "bool", "enum", "list", "map"].includes(e.type), id);
      assert.ok(e.description && e.group, `${id} needs a description and a group`);
      if (e.type === "enum") assert.ok(e.enum?.length, `${id} needs enum values`);
    }
  });

  test("secrets and restart keys are the ones the brief names", () => {
    const secret = settingsSchema.filter((e) => e.secret).map((e) => e.key).sort();
    assert.deepEqual(secret, ["agents.adapters.<name>.env", "auth.token", "notify.ntfyToken"]);
    const restart = settingsSchema.filter((e) => e.restart).map((e) => e.key);
    for (const k of ["host", "port", "publicUrl", "auth.token", "auth.allowInsecure", "retention.eventDays"]) assert.ok(restart.includes(k), k);
    assert.ok(!restart.includes("agents.roles.<role>.adapter"));
  });

  test("no project entry is a key a project file may not set", () => {
    for (const e of settingsSchema.filter((x) => x.scope === "project")) {
      for (const f of FORBIDDEN_PROJECT_KEYS) assert.ok(!(e.key === f || e.key.startsWith(f + ".")), `${e.key} is forbidden in project files`);
    }
  });
});

describe("settings helpers", () => {
  test("classify: values, maps, groups, unknown keys, placeholders", () => {
    assert.equal(classify("server", "port").kind, "leaf");
    assert.equal(classify("server", "agents").kind, "group");
    assert.equal(classify("server", "agents.adapters.claude").kind, "group");
    assert.equal(classify("server", "agents.adapters.claude.command").kind, "leaf");
    assert.equal(classify("server", "agents.adapters.claude.env").kind, "map");
    assert.equal(classify("server", "agents.roles.phaseValidator.model").kind, "leaf");
    assert.equal(classify("server", "agents.roles.boss.model").kind, "unknown");
    assert.equal(classify("server", "defaults.git.pr").kind, "map");
    assert.equal(classify("server", "nope").kind, "unknown");
    assert.equal(classify("project", "port").kind, "unknown");
    assert.equal(classify("project", "validation.ui.env").kind, "map");
  });

  test("checkSettings: types, enums, bounds and unknown keys", () => {
    assert.deepEqual(checkSettings("server", { port: 4801, notify: { ntfyUrl: "https://x" } }, { strict: true }), []);
    assert.match(checkSettings("server", { port: "4801" }, { strict: true })[0], /port must be a whole number/);
    assert.match(checkSettings("server", { port: 0 }, { strict: true })[0], /port must be at least 1/);
    assert.match(checkSettings("server", { bogus: 1 }, { strict: true })[0], /'bogus' is not a server setting/);
    assert.deepEqual(checkSettings("project", { bogus: 1 }, { strict: false }), []);
    assert.match(checkSettings("project", { git: { mergePolicy: "sometimes" } }, { strict: false })[0], /git\.mergePolicy must be one of auto, manual/);
    assert.match(checkSettings("project", { git: { copyFiles: "a" } }, { strict: false })[0], /list of strings/);
    assert.match(checkSettings("server", { agents: { adapters: { x: { env: { A: 1 } } } } }, { strict: true })[0], /values must be strings/);
    assert.deepEqual(checkSettings("project", { git: { pr: null } }, { strict: false }), [], "null removes a key");
  });

  test("masking and resolving secrets", () => {
    const settings = { auth: { token: "t" }, notify: { ntfyToken: "" }, agents: { adapters: { claude: { env: { KEY: "v", EMPTY: "" } } } } };
    const masked = maskServerSettings(settings);
    assert.deepEqual(masked.auth.token, { set: true });
    assert.deepEqual(masked.notify.ntfyToken, { set: false });
    assert.deepEqual(masked.agents.adapters.claude.env, { KEY: { set: true }, EMPTY: { set: false } });
    assert.ok(!JSON.stringify(masked).includes('"v"'));
    const back = resolveSecrets(masked, settings);
    assert.equal(back.auth?.token, undefined, "a masked token is dropped from the patch, so the stored one stays");
    assert.deepEqual(back.agents.adapters.claude.env, { KEY: "v", EMPTY: "" }, "masked env values come back from the stored file");
    const edited = resolveSecrets({ agents: { adapters: { claude: { env: { KEY: { set: true }, NEW: "n" } } } } }, settings);
    assert.deepEqual(edited.agents.adapters.claude.env, { KEY: "v", NEW: "n" }, "a key left out is removed");
  });

  test("applyPatch merges objects, replaces lists and maps, and null removes a key", () => {
    const base = { git: { pr: false, copyFiles: ["a"] }, validation: { ui: { env: { A: "1" } } } };
    const out = applyPatch("project", base, { git: { copyFiles: ["b"] }, validation: { ui: { env: { B: "2" } } }, baseBranch: "dev" });
    assert.deepEqual(out, { git: { pr: false, copyFiles: ["b"] }, validation: { ui: { env: { B: "2" } } }, baseBranch: "dev" });
    assert.deepEqual(applyPatch("project", base, { git: { pr: null } }).git, { copyFiles: ["a"] });
  });

  test("pruneDefaults keeps what differs from the default and what the file already had", () => {
    const defaults = buildDefaults("server");
    const doc = pruneDefaults({ port: 4800, host: "0.0.0.0", scheduler: { maxAgents: 2, tickSeconds: 5 }, retention: { eventDays: 30 } }, defaults, { retention: { eventDays: 30 } });
    assert.deepEqual(doc, { host: "0.0.0.0", retention: { eventDays: 30 } });
  });
});

const TOKEN = "s3cret-access-token";
const NTFY_TOKEN = "ntfy-secret-token";
const ENV_SECRET = "adapter-env-secret";

// ---------------------------------------------------------------------------------------------
// The Settings tab
// ---------------------------------------------------------------------------------------------

describe("dashboard Settings tab", () => {
  const html = fs.readFileSync(path.join(ROOT, "dashboard", "index.html"), "utf8");
  // The form renderers are pure functions between two markers, so they run here without a browser.
  const block = html.split("// <settings-forms>")[1]?.split("// </settings-forms>")[0];
  const sandbox = {};
  before(() => {
    assert.ok(block, "dashboard/index.html needs the // <settings-forms> block");
    vm.runInNewContext(`const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");\n${block}\nthis.api = { serverFormHtml, projectFormHtml };`, sandbox);
  });
  const schema = JSON.parse(JSON.stringify(settingsSchema));
  const serverView = () => ({
    settings: maskServerSettings({ ...structuredClone(DEFAULT_SERVER_CONFIG), auth: { token: TOKEN, allowInsecure: false }, notify: { ntfyUrl: "https://ntfy.sh/x", ntfyToken: NTFY_TOKEN }, agents: { ...structuredClone(DEFAULT_SERVER_CONFIG.agents), adapters: { claude: { type: "claude", command: "claude", extraArgs: ["--a"], env: { API_KEY: ENV_SECRET } }, codex: { type: "codex", command: "codex", extraArgs: [], env: {} } } } }),
    restartRequired: ["port"],
  });
  const projectView = () => ({ settings: { scheduler: { maxParallel: 2 }, roles: { worker: { adapter: "codex", model: "m" } } }, effective: { ...structuredClone(DEFAULT_PROJECT_CONFIG), name: "demo", scheduler: { maxParallel: 2, maxAttempts: 2, resumeOnRetry: true }, roles: { planner: { adapter: "claude", model: "" }, worker: { adapter: "codex", model: "m" }, validator: { adapter: "claude", model: "" }, phaseValidator: { adapter: "claude", model: "" } } }, warnings: [] });

  test("the tab, its two forms and the raw editor exist", () => {
    assert.match(html, /data-tab="settings"/);
    assert.match(html, /id="tab-settings"/);
    assert.match(html, /\/api\/settings\/server/);
    assert.match(html, /\/api\/projects\/\$\{[^}]+\}\/settings/);
    assert.match(html, /notify-test/);
  });

  test("Server form: groups, role table with the project's override, write-only secrets, read-only server group", () => {
    const out = sandbox.api.serverFormHtml(schema, serverView(), { project: { id: "demo", name: "Demo" }, projectSettings: projectView() });
    for (const g of ["Agents", "Notifications", "Server"]) assert.match(out, new RegExp(`<h3[^>]*>${g}<`), g);
    assert.match(out, /Send test/);
    assert.match(out, /edit server\.json and restart/i);
    for (const k of ["host", "port", "publicUrl", "retention.eventDays"]) assert.match(out, new RegExp(`data-key="${k.replace(".", "\\.")}"[^>]*(disabled|readonly)`), `${k} is read-only`);
    assert.match(out, /data-restart="port"|restart-badge/, "a pending restart shows a badge");
    // roles: server default and the project's override side by side
    assert.match(out, /Demo/);
    assert.match(out, /data-role="worker"/);
    assert.match(out, /value="codex" selected|selected[^>]*value="codex"/);
    // adapters
    assert.match(out, /data-adapter="claude"/);
    assert.match(out, /API_KEY/);
    // secrets: never a value, only whether it is set
    for (const secret of [TOKEN, NTFY_TOKEN, ENV_SECRET]) assert.ok(!out.includes(secret), `the form leaks ${secret}`);
    assert.match(out, /type="password"/);
    assert.match(out, /placeholder="[^"]*(set|unchanged)/i);
  });

  test("Project form: validation, scheduler, git and roles groups, Advanced behind a toggle", () => {
    const out = sandbox.api.projectFormHtml(schema, projectView(), { serverSettings: serverView() });
    for (const g of ["Validation", "Scheduler", "Git", "Roles"]) assert.match(out, new RegExp(`<h3[^>]*>${g}<`), g);
    assert.match(out, /data-key="scheduler\.maxParallel"[^>]*value="2"/);
    assert.match(out, /Advanced/);
    const adv = out.split(/class="advanced"/)[1] ?? "";
    for (const k of ["handoff.specChars", "git.feedback.pollSeconds"]) {
      assert.ok(adv.includes(`data-key="${k}"`), `${k} is under Advanced`);
      assert.ok(!out.split(/class="advanced"/)[0].includes(`data-key="${k}"`), `${k} is not shown by default`);
    }
    assert.match(out, /<textarea[^>]*id="projectRaw"/, "raw JSON editor");
    assert.ok(!out.includes('data-key="agents'), "no server-only key in the project form");
    assert.match(out, /<select[^>]*data-key="git\.mergePolicy"/);
  });

  test("an unknown type falls back to the raw editor", () => {
    const odd = [...schema, { key: "git.odd", scope: "project", type: "matrix", description: "odd", group: "Git", default: null }];
    const out = sandbox.api.projectFormHtml(odd, projectView(), { serverSettings: serverView() });
    assert.match(out, /git\.odd/);
    assert.ok(!/data-key="git\.odd"/.test(out), "no form field for a type the page does not know");
  });
});
