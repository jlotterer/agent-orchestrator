/**
 * skills/orch-spec/scripts (TASK-19; REQ-SPEC-02, REQ-SPEC-03, REQ-SPEC-04; architecture §6.4).
 * check-feature.mjs must pass `test/fixtures/spec-dir/full` and report exactly the four problems of `bad`, with
 * the files, lines and messages of `bad.expected.json`. scaffold-briefs.mjs must add briefs to a Spec Kit folder
 * without touching tasks.md. The scripts are run as a user would run them (child process), plus a few direct
 * calls for the rules the fixtures do not pin down.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPTS = path.join(ROOT, "skills/orch-spec/scripts");
const CHECK = path.join(SCRIPTS, "check-feature.mjs");
const SCAFFOLD = path.join(SCRIPTS, "scaffold-briefs.mjs");
const FIXTURES = path.join(ROOT, "test/fixtures/spec-dir");
const REQS = path.join(ROOT, "test/fixtures/requirements.sample.md");
const { checkFeature } = await import(`file://${CHECK.replace(/\\/g, "/")}`);
const { checkProject } = await import(`file://${path.join(SCRIPTS, "check-project.mjs").replace(/\\/g, "/")}`);

const run = (script, ...args) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
const expected = (folder) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${folder}.expected.json`), "utf8"));
const asLines = (problems) => problems.map((p) => `${p.file}:${p.line}: ${p.message}`);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "orch-spec-"));
const copyFixture = (folder) => { const d = path.join(tmp(), folder); fs.cpSync(path.join(FIXTURES, folder), d, { recursive: true }); return d; };

describe("check-feature.mjs on the fixtures", () => {
  test("full: exit 0 and no output", () => {
    const r = run(CHECK, path.join(FIXTURES, "full"), "--requirements", REQS);
    assert.equal(r.out, "", r.out);
    assert.equal(r.err, "");
    assert.equal(r.code, 0);
  });

  test("bad: exactly the four expected problems, as file:line: message, in §6.4 order", () => {
    const r = run(CHECK, path.join(FIXTURES, "bad"), "--requirements", REQS);
    assert.equal(r.code, 1);
    assert.deepEqual(r.out.split("\n"), asLines(expected("bad").problems));
  });

  test("bad --json: kind, rule, file, line and message match the fixture", () => {
    const r = run(CHECK, path.join(FIXTURES, "bad"), "--requirements", REQS, "--json");
    assert.equal(r.code, 1);
    const got = JSON.parse(r.out).map(({ kind, rule, file, line, message }) => ({ kind, rule, file, line, message }));
    const want = expected("bad").problems.map(({ kind, rule, file, line, message }) => ({ kind, rule, file, line, message }));
    assert.deepEqual(got, want);
    const overlap = JSON.parse(r.out).find((p) => p.rule === "parallel-overlap");
    assert.deepEqual(overlap.tasks, ["T002", "T003"]);
    assert.equal(overlap.path, "src/auth/session.ts");
  });

  test("version: the orch: 2 error at line 2, nothing else applied", () => {
    const r = run(CHECK, path.join(FIXTURES, "version"), "--requirements", REQS);
    assert.equal(r.code, 1);
    assert.deepEqual(r.out.split("\n"), asLines(expected("version").problems));
  });

  test("speckit (no tasks/): nothing to report", () => {
    const r = run(CHECK, path.join(FIXTURES, "speckit"), "--no-requirements");
    assert.equal(r.code, 0);
    assert.equal(r.out, "");
  });

  test("usage errors exit 2", () => {
    assert.equal(run(CHECK).code, 2);
    assert.equal(run(CHECK, path.join(FIXTURES, "does-not-exist")).code, 2);
    assert.equal(run(CHECK, path.join(FIXTURES, "full"), "--bogus").code, 2);
  });
});

describe("check-feature rules beyond the fixtures (direct calls)", () => {
  const reqText = fs.readFileSync(REQS, "utf8");
  const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const edit = (dir, rel, fn) => write(dir, rel, fn(fs.readFileSync(path.join(dir, rel), "utf8")));
  const rules = (dir, opts = {}) => checkFeature(dir, { requirementsText: reqText, ...opts }).map((p) => [p.rule, p.file, p.line, p.message]);

  test("frontmatter: unknown key warns, bad types and values error, missing required keys error", () => {
    const d = copyFixture("full");
    edit(d, "tasks/T002.md", (t) => t.replace("parallel: true", "parallel: yes\ncolour: red").replace("merge_policy: manual", "merge_policy: later"));
    edit(d, "tasks/T003.md", (t) => t.replace("covers: [REQ-AUTH-03, REQ-AUTH-04]\n", ""));
    const got = rules(d);
    assert.ok(got.some(([r, f, , m]) => r === "frontmatter" && f === "tasks/T002.md" && /parallel must be true or false/.test(m)));
    assert.ok(got.some(([r, f, , m]) => r === "frontmatter" && f === "tasks/T002.md" && /unknown frontmatter key "colour"/.test(m)));
    assert.ok(got.some(([r, f, , m]) => r === "frontmatter" && f === "tasks/T002.md" && /merge_policy must be auto or manual/.test(m)));
    assert.ok(got.some(([r, f, , m]) => r === "frontmatter" && f === "tasks/T003.md" && /missing "covers"/.test(m)));
  });

  test("depends_on: unknown key and self-dependency", () => {
    const d = copyFixture("full");
    edit(d, "tasks/T004.md", (t) => t.replace("depends_on: [T002, T003]", "depends_on: [T002, T004, T099]"));
    const got = rules(d).filter(([r]) => r === "frontmatter").map(([, , , m]) => m);
    assert.deepEqual(got.sort(), ["depends_on names the task itself", "depends_on names unknown task T099"]);
  });

  test("tasks: a task without a brief and a brief without a task", () => {
    const d = copyFixture("full");
    fs.renameSync(path.join(d, "tasks/T002.md"), path.join(d, "tasks/T009.md"));
    const got = rules(d).filter(([r]) => r === "tasks");
    assert.deepEqual(got, [["tasks", "tasks.md", 9, "T002 has no brief (tasks/T002.md)"], ["tasks", "tasks/T009.md", 1, "no task T009 in tasks.md"]]);
  });

  test("sections: missing acceptance criteria and target files; H1 must name the key", () => {
    const d = copyFixture("full");
    edit(d, "tasks/T001.md", (t) => t.replace(/## Acceptance criteria[\s\S]*?(?=## Target files)/, "## Acceptance criteria\nNone yet.\n\n").replace("# T001: Session store", "# Session store"));
    edit(d, "tasks/T003.md", (t) => t.replace(/## Target files[\s\S]*?(?=## Contracts)/, "## Target files\n\n"));
    const got = rules(d);
    assert.ok(got.some(([r, f, , m]) => r === "sections" && f === "tasks/T001.md" && /no "## Acceptance criteria" bullets/.test(m)));
    assert.ok(got.some(([r, f, , m]) => r === "h1" && f === "tasks/T001.md" && /H1 must start with "T001:"/.test(m)));
    assert.ok(got.some(([r, f, , m]) => r === "sections" && f === "tasks/T003.md" && /no "## Target files" bullets/.test(m)));
  });

  test("contracts: unresolved name warns; a name that is both a file and a section warns", () => {
    const d = copyFixture("full");
    edit(d, "tasks/T002.md", (t) => t.replace("- TokenCodec (spec.md §Contracts)", "- Nothing (spec.md §Contracts)"));
    write(d, "contracts/SessionStore", "x"); // not .md, so it is not read: still resolves to the section only
    edit(d, "spec.md", (t) => t.replace("### TokenCodec", "### contracts/auth-api.md\nA section with a file's name.\n\n### TokenCodec"));
    const got = rules(d).filter(([r]) => r === "contracts").map(([, f, , m]) => [f, m]);
    assert.deepEqual(got, [
      ["tasks/T002.md", 'contract "contracts/auth-api.md" is both a file and a spec.md section; the section wins'],
      ["tasks/T002.md", 'contract "Nothing" is neither a file in the folder nor a "### Nothing" heading under spec.md "## Contracts"'],
      ["tasks/T003.md", 'contract "contracts/auth-api.md" is both a file and a spec.md section; the section wins'],
      ["tasks/T004.md", 'contract "contracts/auth-api.md" is both a file and a spec.md section; the section wins'],
    ]);
  });

  test("markers: [NEEDS CLARIFICATION and TODO in a brief and a contract; TBD inside a word is not a marker", () => {
    const d = copyFixture("full");
    edit(d, "tasks/T001.md", (t) => t + "\nStill [NEEDS CLARIFICATION: which store?]\nTODO later\nSubTBDword\n");
    edit(d, "contracts/auth-api.md", (t) => t + "\nTODO: rate limits\n");
    const got = rules(d).filter(([r]) => r === "marker").map(([, f, , m]) => [f, m]);
    assert.deepEqual(got, [
      ["tasks/T001.md", 'unresolved marker "NEEDS CLARIFICATION"'],
      ["tasks/T001.md", 'unresolved marker "TODO"'],
      ["contracts/auth-api.md", 'unresolved marker "TODO"'],
    ]);
  });

  test("sizes: brief-size uses --brief-chars; contract-size and total-size warn", () => {
    const d = copyFixture("full");
    const got = rules(d, { briefChars: 2000, contractChars: 1000, totalChars: 4000 });
    assert.ok(got.some(([r, f, l, m]) => r === "brief-size" && f === "tasks/T003.md" && l === 1 && m === "brief is 2222 characters; handoff.briefChars is 2000"));
    assert.ok(got.some(([r, f, , m]) => r === "contract-size" && f === "contracts/auth-api.md" && /1112 characters; handoff.contractChars is 1000/.test(m)));
    assert.ok(got.some(([r, f, l, m]) => r === "total-size" && f === "tasks/T003.md" && l === 1 && /total 4734 characters; keep the total under 4000/.test(m)));
    assert.equal(rules(d).length, 0, "defaults: full is clean");
  });

  test("parallel-overlap: glob prefixes overlap; the brief's parallel wins over [P]; fixtures/ is not a test path", () => {
    const d = copyFixture("full");
    edit(d, "tasks/T003.md", (t) => t.replace("- src/auth/refresh.ts", "- src/auth/pages/*"));
    let got = rules(d).filter(([r]) => r === "parallel-overlap").map(([, f, l, m]) => [f, l, m]);
    assert.deepEqual(got, [["tasks/T003.md", 22, "T002 and T003 are both parallel and T003's src/auth/pages/* overlaps T002's src/auth/pages/login.html"]]);
    edit(d, "tasks/T003.md", (t) => t.replace("parallel: true", "parallel: false"));
    assert.equal(rules(d).filter(([r]) => r === "parallel-overlap").length, 0, "brief parallel: false wins over [P]");
    // T001 owns fixtures + a test: not test-only.
    edit(d, "tasks/T001.md", (t) => t.replace("- src/auth/store.ts\n- src/auth/types.ts\n", ""));
    assert.equal(rules(d).filter(([r]) => r === "test-only").length, 0);
  });

  test("coverage: undefined IDs, a MUST ID cited by no brief, an ID cited but not covered, missing requirements file", () => {
    const d = copyFixture("full");
    edit(d, "spec.md", (t) => t.replace("- REQ-AUTH-04:", "- REQ-AUTH-09: made up\n- REQ-AUTH-04:"));
    edit(d, "tasks/T003.md", (t) => t.replace("covers: [REQ-AUTH-03, REQ-AUTH-04]", "covers: [REQ-AUTH-03, REQ-OPS-01]"));
    edit(d, "tasks/T004.md", (t) => t.replace("covers: [REQ-AUTH-02, REQ-AUTH-04]", "covers: [REQ-AUTH-02]"));
    const got = rules(d).filter(([r]) => r === "coverage").map(([, f, l, m]) => [f, l, m]);
    assert.deepEqual(got, [
      ["spec.md", 10, "REQ-AUTH-09 is not defined in the requirements file"],
      ["spec.md", 10, "REQ-AUTH-09 (MUST) is covered by the feature but cited by no brief"],
      ["spec.md", 11, "REQ-AUTH-04 (MUST) is covered by the feature but cited by no brief"],
      ["tasks/T003.md", 3, 'REQ-OPS-01 is cited here but not listed under spec.md "## Covers"'],
    ]);
    const none = checkFeature(d, { requirements: path.join(d, "nope.md") }).filter((p) => p.rule === "coverage");
    assert.equal(none[0].message, `requirements file not found: ${path.join(d, "nope.md")}`);
    assert.equal(checkFeature(path.join(FIXTURES, "full"), { noRequirements: true }).length, 0);
  });

  test("links: a broken relative link and a missing anchor in a brief", () => {
    const d = copyFixture("full");
    edit(d, "tasks/T002.md", (t) => t + "\nSee [the API](../contracts/auth-api.md#nope) and [plan](../plan.md).\n");
    const got = rules(d).filter(([r]) => r === "link").map(([, f, , m]) => [f, m]);
    assert.deepEqual(got, [["tasks/T002.md", "missing anchor #nope in auth-api.md"], ["tasks/T002.md", "broken link → ../plan.md"]]);
  });
});

describe("scaffold-briefs.mjs (adopt mode, REQ-SPEC-04)", () => {
  test("speckit fixture: four briefs appear, tasks.md is byte-identical, T001 stays ticked, deps are the effective list", () => {
    const d = copyFixture("speckit");
    const before = fs.readFileSync(path.join(d, "tasks.md"));
    const r = run(SCAFFOLD, d);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.out.split("\n"), ["wrote tasks/T001.md", "wrote tasks/T002.md", "wrote tasks/T003.md", "wrote tasks/T004.md"]);
    assert.ok(before.equals(fs.readFileSync(path.join(d, "tasks.md"))), "tasks.md unchanged");
    assert.match(fs.readFileSync(path.join(d, "tasks.md"), "utf8"), /- \[x\] T001 /);
    const fm = (k) => fs.readFileSync(path.join(d, `tasks/${k}.md`), "utf8").split("\n---\n")[0];
    assert.match(fm("T001"), /^---\norch: 1\ncovers: \[\]\ndepends_on: \[\]\nparallel: false\n/);
    assert.match(fm("T002"), /depends_on: \[T001\]\nparallel: false/);
    assert.match(fm("T003"), /depends_on: \[T001\]\nparallel: true/);
    assert.match(fm("T004"), /depends_on: \[T001\]\nparallel: true/);
    assert.match(fs.readFileSync(path.join(d, "tasks/T003.md"), "utf8"), /^# T003: Login and logout endpoints per contracts\/one.md in src\/auth\/routes.ts$/m);
    // A skeleton is not a finished brief: the check fails it on the empty sections and the missing Covers list, nothing else.
    const rules = new Set(checkFeature(d, { noRequirements: true }).map((p) => p.rule));
    assert.deepEqual([...rules].sort(), ["coverage", "sections"]); // coverage: a Spec Kit spec.md has no "## Covers" yet
    // Running again writes nothing and changes nothing.
    assert.equal(run(SCAFFOLD, d).out, "");
  });

  test("--dry-run writes nothing", () => {
    const d = copyFixture("speckit");
    const r = run(SCAFFOLD, d, "--dry-run");
    assert.equal(r.out.split("\n").length, 4);
    assert.equal(fs.existsSync(path.join(d, "tasks")), false);
  });
});

describe("check-project.mjs (project record)", () => {
  test("a minimal project record passes; a broken link, a duplicate ID and an uncovered MUST are reported", () => {
    const d = tmp();
    const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), text); };
    write("AGENTS.md", "# Rules\nSee [requirements](docs/requirements.md#1-objective).\n");
    write("docs/requirements.md", "# Reqs\n## 1. Objective\n| ID | Requirement | Status |\n| :--- | :--- | :--- |\n| REQ-A-01 | It MUST work. | new |\n| REQ-A-02 | It SHOULD be fast. | new |\n");
    write("docs/roadmap.md", "# Roadmap\n| Feature | Covers |\n| :--- | :--- |\n| F01 | REQ-A-01, -02 |\n");
    assert.deepEqual(checkProject(d), []);
    write("docs/roadmap.md", "# Roadmap\n| Feature | Covers |\n| :--- | :--- |\n| F01 | REQ-A-01 |\n| F02 | REQ-A-01, -02 |\n\n## F02\nExtends REQ-A-01 in prose, which is fine.\n");
    assert.deepEqual(checkProject(d).map((p) => `${p.file}:${p.line}: ${p.message}`), ["docs/roadmap.md:5: REQ-A-01 is listed by F01 and F02; one feature owns a requirement, the other extends it with a new ID or a decision"]);
    write("docs/roadmap.md", "# Roadmap\n| Feature | Covers |\n| :--- | :--- |\n| F01 | REQ-A-01, -02 |\n");
    write("docs/requirements.md", "# Reqs\n## 1. Objective\n| ID | Requirement | Status |\n| :--- | :--- | :--- |\n| REQ-A-01 | It MUST work. | new |\n| REQ-A-01 | Again. | new |\n| REQ-A-03 | It MUST also log. | new |\n");
    write("docs/architecture.md", "# Arch\n[missing](nowhere.md) and [bad anchor](requirements.md#nope)\n");
    const got = checkProject(d).map((p) => `${p.file}:${p.line}: ${p.message}`);
    assert.deepEqual(got, [
      "docs/architecture.md:2: broken link → nowhere.md",
      "docs/architecture.md:2: missing anchor #nope in requirements.md",
      "docs/requirements.md:6: REQ-A-01 is defined more than once",
      "docs/requirements.md:7: REQ-A-03 (MUST) is covered by no roadmap feature",
      "docs/roadmap.md:4: REQ-A-02 is not defined in docs/requirements.md",
    ]);
  });
});
