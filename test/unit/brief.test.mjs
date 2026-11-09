/**
 * Authored briefs and feature-folder checks (src/core/brief.ts, architecture §6.4; TASK-20). Every
 * test/fixtures/spec-dir/<folder>.expected.json drives readFeature through readSpecDir + importFeature; the
 * `context` field belongs to context.test.mjs (TASK-21). Run after `npm run build`: npm run test:unit
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSpecDir, parseTasksMd, importFeature } from "../../dist/speckit.js";
import {
  parseFrontmatter, parseBrief, mergeBriefIntoTask, checkFeature, readFeature, resolveContract, isTestPath, earlierPhaseKeys,
} from "../../dist/core/brief.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/spec-dir");
const load = (f) => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), "utf8"));
const FIELDS = [
  "key", "title", "phase", "done", "brief", "briefChars", "orch", "depends_on", "parallel", "merge_policy", "validate_mode",
  "validate_cmd", "files_owned", "acceptance", "cites", "contracts", "fromBrief", "tasksMd",
];
const project = (t) => Object.fromEntries(FIELDS.map((k) => [k, t[k]]));

/** A feature folder in memory, as readFeature sees it. */
function folder(files, tasksMd) {
  const all = { "tasks.md": tasksMd, ...files };
  return { files: all, tasks: parseTasksMd(tasksMd) };
}
const brief = (fm, body) => `---\n${fm}\n---\n${body}`;
const BODY = `# T001: Thing\n\n## Goal\nDo the thing.\n\n## Acceptance criteria\n- Given a, When b, Then c.\n- Second.\n\n## Target files\n- \`src/a.ts\`\n- test/a.test.ts\n\n## Contracts\n- Store (spec.md §Contracts)\n- contracts/api.md\n`;

describe("spec-dir fixtures (readSpecDir + importFeature)", () => {
  const folders = fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".expected.json")).map((f) => f.replace(/\.expected\.json$/, "")).sort();
  test("there are fixture folders", () => assert.deepStrictEqual(folders, ["bad", "full", "nocriteria", "speckit", "version"]));
  const results = {};
  for (const name of folders) {
    test(name, () => {
      const expected = load(`${name}.expected.json`);
      assert.equal(expected.folder, name);
      const spec = readSpecDir(path.join(FIXTURES, name));
      const { tasks, feature } = importFeature(spec, { briefChars: 8000 });
      results[name] = feature;
      assert.deepStrictEqual(feature.tasks.map(project), expected.tasks, "tasks");
      assert.deepStrictEqual(feature.conflicts, expected.conflicts, "conflicts");
      assert.deepStrictEqual(feature.problems, expected.problems, "problems");
      // Each imported task carries its parsed brief when it has one.
      for (const t of tasks) assert.equal(t.brief?.file ?? null, expected.tasks.find((x) => x.key === t.key).brief, `${t.key}.brief`);
    });
  }
  test("full: every task has a brief, nothing warns, one conflict", () => {
    const f = results.full;
    assert.ok(f.hasBriefs);
    assert.ok(f.tasks.every((t) => t.brief));
    assert.deepStrictEqual(f.problems, []);
    assert.equal(f.conflicts.length, 1);
    assert.equal(f.conflicts[0].decision, "T004: tasks.md marks [P] but the brief says parallel: false; the brief wins");
  });
  test("bad: exactly four problems, one error and three warnings, in §6.4 order", () => {
    const f = results.bad;
    assert.equal(f.problems.length, 4);
    assert.deepStrictEqual(f.problems.map((p) => p.kind), ["error", "warning", "warning", "warning"]);
    assert.deepStrictEqual(f.problems.map((p) => p.rule), ["marker", "parallel-overlap", "brief-size", "test-only"]);
    assert.deepStrictEqual(f.problems.map((p) => `${p.file}:${p.line}`), ["spec.md:15", "tasks/T003.md:22", "tasks/T004.md:1", "tasks/T005.md:9"]);
  });
  test("version: an unsupported orch version is an error naming the file; nothing else is applied", () => {
    const f = results.version;
    assert.equal(f.problems.length, 1);
    assert.equal(f.problems[0].kind, "error");
    assert.equal(f.problems[0].file, "tasks/T001.md");
    assert.match(f.problems[0].message, /orch: 2; this orch reads orch: 1/);
    assert.deepStrictEqual(f.tasks[0].fromBrief, []);
    assert.equal(f.tasks[0].orch, 2);
    assert.equal(f.briefs.get("T001").supported, false);
  });
  test("speckit: a plain Spec Kit folder has no briefs and no problems", () => {
    const f = results.speckit;
    assert.equal(f.hasBriefs, false);
    assert.ok(f.tasks.every((t) => t.brief === null && t.fromBrief.length === 0));
    assert.deepStrictEqual(f.problems, []);
    assert.deepStrictEqual(f.conflicts, []);
  });
  test("nocriteria: a brief without the acceptance section keeps its other fields", () => {
    const t = results.nocriteria.tasks[0];
    assert.deepStrictEqual(t.acceptance, []);
    assert.ok(!t.fromBrief.includes("acceptance"));
    assert.ok(t.fromBrief.includes("files_owned"));
    assert.equal(results.nocriteria.briefs.get("T001").criteria, null);
    assert.deepStrictEqual(results.nocriteria.problems, []);
  });
  test("readSpecDir keeps relative paths for one level of subfolders", () => {
    const spec = readSpecDir(path.join(FIXTURES, "full"));
    assert.deepStrictEqual(Object.keys(spec.files).sort(), ["contracts/auth-api.md", "spec.md", "tasks.md", "tasks/T001.md", "tasks/T002.md", "tasks/T003.md", "tasks/T004.md"]);
  });
  test("the brief files of bad are measured after CRLF→LF normalization", () => {
    const text = fs.readFileSync(path.join(FIXTURES, "bad/tasks/T004.md"), "utf8");
    assert.equal(parseBrief("T004", text.replace(/\n/g, "\r\n")).chars, 8265);
  });
});

describe("parseFrontmatter", () => {
  test("scalars, flow lists, quotes and comments", () => {
    const fm = parseFrontmatter(`---\n# a comment line\norch: 1 # trailing comment\ncovers: [REQ-A-01, "REQ-A-02", 'REQ-A-03']\ndepends_on: []\nparallel: true\nmerge_policy: "manual"\nvalidate_command: npm test -- a#b\nnote: 'it''s # not a comment'\n---\nbody\n`);
    assert.deepStrictEqual(fm.errors, []);
    assert.deepStrictEqual(fm.data, {
      orch: 1, covers: ["REQ-A-01", "REQ-A-02", "REQ-A-03"], depends_on: [], parallel: true, merge_policy: "manual",
      validate_command: "npm test -- a#b", note: "it's # not a comment",
    });
    assert.equal(fm.lines.orch, 3);
    assert.equal(fm.length, 10);
  });
  test("no frontmatter", () => {
    const fm = parseFrontmatter("# T001: Title\n");
    assert.equal(fm.present, false);
    assert.deepStrictEqual(fm.data, {});
    assert.equal(fm.length, 0);
  });
  test("block lists, maps, indentation, bare words, duplicates and an unclosed block are errors with lines", () => {
    const fm = parseFrontmatter(`---\norch: 1\ndepends_on:\n  - T001\nmeta: {a: 1}\nparallel\norch: 2\n`);
    assert.deepStrictEqual(fm.errors.map((e) => e.line), [4, 5, 6, 7, 1]);
    assert.match(fm.errors[0].message, /indented/);
    assert.match(fm.errors[1].message, /maps/);
    assert.match(fm.errors[2].message, /key: value/);
    assert.match(fm.errors[3].message, /duplicate key orch/);
    assert.match(fm.errors[4].message, /not closed/);
    assert.equal(fm.data.orch, 1, "the first value is kept");
  });
  test("nested lists and unclosed quotes are errors", () => {
    const fm = parseFrontmatter(`---\ncovers: [[a]]\nx: "open\ny: [a, "b]\n---\n`);
    assert.deepStrictEqual(fm.errors.map((e) => e.line), [2, 3, 4]);
  });
});

describe("parseBrief", () => {
  test("fields, criteria, target files (backticks stripped), contract names (text before ' (')", () => {
    const b = parseBrief("T001", brief("orch: 1\ncovers: [REQ-A-01, REQ-A-01, REQ-B-02]\ndepends_on: [T002]\nparallel: false\nmerge_policy: manual\nvalidate: ui\nvalidate_command: npm test", BODY));
    assert.equal(b.file, "tasks/T001.md");
    assert.equal(b.supported, true);
    assert.equal(b.version, 1);
    assert.deepStrictEqual(b.fields, { depends_on: ["T002"], parallel: false, merge_policy: "manual", validate_mode: "ui", validate_cmd: "npm test" });
    assert.deepStrictEqual(b.cites, ["REQ-A-01", "REQ-B-02"], "covers deduplicated, order kept");
    assert.deepStrictEqual(b.criteria, ["Given a, When b, Then c.", "Second."]);
    assert.deepStrictEqual(b.targetFiles.map((t) => t.path), ["src/a.ts", "test/a.test.ts"]);
    assert.deepStrictEqual(b.contracts.map((c) => c.name), ["Store", "contracts/api.md"]);
    assert.equal(b.h1Line, 10);
    assert.deepStrictEqual(b.errors, []);
    assert.deepStrictEqual(b.warnings, []);
  });
  test("missing orch is a version error at line 1", () => {
    const b = parseBrief("T001", brief("covers: [REQ-A-01]", BODY));
    assert.equal(b.supported, false);
    assert.deepStrictEqual(b.errors.map((e) => [e.rule, e.line]), [["version", 1]]);
    assert.match(b.errors[0].message, /orch: \(missing\); this orch reads orch: 1/);
    assert.equal(b.criteria, null, "nothing else is applied");
    assert.deepStrictEqual(b.cites, []);
  });
  test("no frontmatter at all is a version error at line 1", () => {
    const b = parseBrief("T001", BODY);
    assert.deepStrictEqual(b.errors.map((e) => [e.rule, e.line]), [["version", 1]]);
  });
  test("orch: 2 names the file and the orch line", () => {
    const b = parseBrief("T009", brief("covers: []\norch: 2", BODY));
    assert.deepStrictEqual(b.errors, [{ kind: "error", rule: "version", file: "tasks/T009.md", line: 3, message: "unsupported brief format orch: 2; this orch reads orch: 1" }]);
  });
  test("unknown keys are kept and warned about; wrong types are errors and the field is not applied", () => {
    const b = parseBrief("T001", brief("orch: 1\nowner: jeff\nparallel: yes\nmerge_policy: later\nvalidate: fast\ndepends_on: [1, T002]\ncovers: REQ-A-01\nvalidate_command: ''", BODY));
    assert.deepStrictEqual(b.unknownKeys, ["owner"]);
    assert.deepStrictEqual(b.warnings.map((w) => [w.rule, w.line]), [["unknown-key", 3]]);
    assert.deepStrictEqual(b.errors.map((e) => [e.rule, e.line]), [["frontmatter", 4], ["frontmatter", 5], ["frontmatter", 6], ["frontmatter", 7], ["frontmatter", 8], ["frontmatter", 9]]);
    assert.deepStrictEqual(b.fields, {});
    assert.deepStrictEqual(b.cites, []);
    assert.deepStrictEqual(b.criteria, ["Given a, When b, Then c.", "Second."], "sections still apply");
  });
  test("section names are case-insensitive; `###` headings inside a section do not end it; fenced `##` is text", () => {
    const b = parseBrief("T001", brief("orch: 1", "# T001: X\n\n## acceptance Criteria\n- one\n### sub\n- two\n\n## Notes for the worker\n```md\n## Target files\n- not/a/file\n```\n\n## Target files\n- real.ts\n"));
    assert.deepStrictEqual(b.criteria, ["one", "two"]);
    assert.deepStrictEqual(b.targetFiles.map((t) => t.path), ["real.ts"]);
  });
  test("a section with only prose names nothing; an absent section is null", () => {
    const b = parseBrief("T001", brief("orch: 1", "# T001: X\n\n## Contracts\nNone.\n\n## Target files\n- a.ts\n"));
    assert.deepStrictEqual(b.contracts, []);
    assert.equal(b.criteria, null);
  });
});

describe("mergeBriefIntoTask", () => {
  const TASKS = "## P1\n- [ ] T001 a\n\n## P2\n- [ ] T002 [P] b\n- [ ] T003 [P] c\n- [ ] T004 d (depends on T002)\n\n## P3\n- [ ] T005 e\n";
  test("without a brief the task keeps its tasks.md values and sets nothing", () => {
    const f = folder({}, TASKS);
    const r = mergeBriefIntoTask(f.tasks[3], null, f);
    assert.deepStrictEqual(r.task.depends_on, ["T001", "T002", "T003"]);
    assert.equal(r.task.parallel, false);
    assert.equal(r.task.brief, null);
    assert.deepStrictEqual(r.task.fromBrief, []);
    assert.deepStrictEqual(r.task.tasksMd, { parallel: false, depends_on: ["T001", "T002", "T003"] });
    assert.deepStrictEqual(r.conflicts, []);
  });
  test("depends_on = earlier phases ∪ the brief's list; unknown and self keys dropped; within-phase rule replaced", () => {
    const f = folder({}, TASKS);
    assert.deepStrictEqual(earlierPhaseKeys(f.tasks, f.tasks[3]), ["T001"]);
    assert.deepStrictEqual(earlierPhaseKeys(f.tasks, f.tasks[4]), ["T001", "T002", "T003", "T004"]);
    const b = parseBrief("T004", brief("orch: 1\ndepends_on: [T003, T999, T004]", "# T004: d\n"));
    const r = mergeBriefIntoTask(f.tasks[3], b, f);
    assert.deepStrictEqual(r.task.depends_on, ["T001", "T003"], "T002 (the within-phase previous task) is gone; T003 added");
    assert.deepStrictEqual(r.task.fromBrief, ["depends_on"]);
  });
  test("an empty depends_on list still keeps the earlier-phase tasks (REQ-INTAKE-02)", () => {
    const f = folder({}, TASKS);
    const r = mergeBriefIntoTask(f.tasks[4], parseBrief("T005", brief("orch: 1\ndepends_on: []", "# T005: e\n")), f);
    assert.deepStrictEqual(r.task.depends_on, ["T001", "T002", "T003", "T004"]);
  });
  test("parallel differences are conflicts in both directions; the brief wins", () => {
    const f = folder({}, TASKS);
    const a = mergeBriefIntoTask(f.tasks[1], parseBrief("T002", brief("orch: 1\nparallel: false", "# T002: b\n")), f);
    assert.equal(a.task.parallel, false);
    assert.deepStrictEqual(a.conflicts, [{ key: "T002", field: "parallel", tasksMd: true, brief: false, decision: "T002: tasks.md marks [P] but the brief says parallel: false; the brief wins" }]);
    const b = mergeBriefIntoTask(f.tasks[3], parseBrief("T004", brief("orch: 1\nparallel: true", "# T004: d\n")), f);
    assert.equal(b.task.parallel, true);
    assert.deepStrictEqual(b.conflicts, [{ key: "T004", field: "parallel", tasksMd: false, brief: true, decision: "T004: tasks.md does not mark [P] but the brief says parallel: true; the brief wins" }]);
    const same = mergeBriefIntoTask(f.tasks[1], parseBrief("T002", brief("orch: 1\nparallel: true", "# T002: b\n")), f);
    assert.deepStrictEqual(same.conflicts, []);
  });
  test("cites is the covers list only; a REQ ID in the body is not cited", () => {
    const f = folder({}, TASKS);
    const r = mergeBriefIntoTask(f.tasks[0], parseBrief("T001", brief("orch: 1\ncovers: [REQ-A-01]", "# T001: a\n\n## Out of scope\n- REQ-B-09 is for later.\n")), f);
    assert.deepStrictEqual(r.task.cites, ["REQ-A-01"]);
  });
  test("an unsupported brief applies nothing but is still named", () => {
    const f = folder({}, TASKS);
    const r = mergeBriefIntoTask(f.tasks[0], parseBrief("T001", brief("orch: 3\nparallel: true", BODY)), f);
    assert.equal(r.task.brief, "tasks/T001.md");
    assert.equal(r.task.orch, 3);
    assert.equal(r.task.parallel, false);
    assert.deepStrictEqual(r.task.acceptance, []);
    assert.deepStrictEqual(r.task.fromBrief, []);
  });
});

describe("contracts", () => {
  const SPEC = "# F\n\n## Contracts\n\n### Store\ntext\n\n### Codec\n```ts\n## not a heading\n```\n\n### contracts/api.md\nalso here\n\n## Risky logic\n### NotAContract\n";
  test("a spec.md section, a file, both (section wins with a warning), neither (warning)", () => {
    const files = { "spec.md": SPEC, "contracts/api.md": "x", "contracts/Store": "y" };
    const at = { file: "tasks/T001.md", line: 20 };
    assert.deepStrictEqual(resolveContract(files, "Store", at), { resolved: "spec.md#Store" }, "a file named Store under contracts/ is not the path 'Store'");
    assert.deepStrictEqual(resolveContract(files, "Codec", at), { resolved: "spec.md#Codec" });
    assert.deepStrictEqual(resolveContract({ "spec.md": "# F\n", "contracts/api.md": "x" }, "contracts/api.md", at), { resolved: "contracts/api.md" });
    const both = resolveContract(files, "contracts/api.md", at);
    assert.equal(both.resolved, "spec.md#contracts/api.md");
    assert.equal(both.warning.rule, "contract");
    assert.match(both.warning.message, /both a section of spec.md and the file contracts\/api.md/);
    const none = resolveContract(files, "NotAContract", at);
    assert.equal(none.resolved, null);
    assert.deepStrictEqual([none.warning.kind, none.warning.rule, none.warning.file, none.warning.line], ["warning", "contract", "tasks/T001.md", 20]);
    assert.match(none.warning.message, /NotAContract named in tasks\/T001.md/);
  });
  test("readFeature reports an unresolved contract as a warning on the brief's line", () => {
    const f = folder({ "spec.md": SPEC, "tasks/T001.md": brief("orch: 1", "# T001: a\n\n## Contracts\n- Missing (spec.md)\n- Store\n") }, "## P1\n- [ ] T001 a\n");
    const r = readFeature(f.files, f.tasks);
    assert.deepStrictEqual(r.tasks[0].contracts, [{ name: "Missing", resolved: null }, { name: "Store", resolved: "spec.md#Store" }]);
    assert.deepStrictEqual(r.problems.map((p) => [p.rule, p.file, p.line]), [["contract", "tasks/T001.md", 7]]);
  });
});

describe("checkFeature", () => {
  const T = "## P1\n- [ ] T001 [P] a\n- [ ] T002 [P] b\n- [ ] T003 c\n";
  test("markers: [NEEDS CLARIFICATION, TBD and TODO as whole words, case-sensitive, in spec.md, briefs and contracts only", () => {
    const f = folder({
      "spec.md": "# F\nok\n[NEEDS CLARIFICATION: which?]\nTODOs are fine, todo too, but TODO is not\n",
      "plan.md": "TBD\n",
      "research.md": "TODO\n",
      "contracts/b.md": "fine\nTBD\n",
      "contracts/a.md": "TBD\n",
      "tasks/T002.md": brief("orch: 1", "# T002: b\n\nTBD\n"),
      "tasks/T001.md": brief("orch: 1", "# T001: a\n\n## Notes for the worker\nTODO: later\n"),
      "tasks/README.md": "TODO not a brief\n",
    }, T);
    const r = readFeature(f.files, f.tasks);
    assert.deepStrictEqual(r.problems.map((p) => [p.file, p.line, p.message]), [
      ["spec.md", 3, 'unresolved marker "[NEEDS CLARIFICATION"'],
      ["spec.md", 4, 'unresolved marker "TODO"'],
      ["tasks/T001.md", 7, 'unresolved marker "TODO"'],
      ["tasks/T002.md", 6, 'unresolved marker "TBD"'],
      ["contracts/a.md", 1, 'unresolved marker "TBD"'],
      ["contracts/b.md", 2, 'unresolved marker "TBD"'],
    ]);
    assert.ok(r.problems.every((p) => p.kind === "error" && p.rule === "marker"));
  });
  test("parallel overlap: both parallel after the brief, neither depending on the other, at the later task's entry", () => {
    const f = folder({
      "tasks/T001.md": brief("orch: 1\nparallel: true", "# T001: a\n\n## Target files\n- src/x.ts\n- src/auth/\n"),
      "tasks/T002.md": brief("orch: 1\nparallel: true", "# T002: b\n\n## Target files\n- src/y.ts\n- src/x.ts\n- src/auth/session.ts\n"),
    }, T);
    const r = readFeature(f.files, f.tasks);
    assert.deepStrictEqual(r.problems, [
      { kind: "warning", rule: "parallel-overlap", file: "tasks/T002.md", line: 9, message: "T001 and T002 are both parallel and both list src/x.ts", tasks: ["T001", "T002"], path: "src/x.ts" },
      { kind: "warning", rule: "parallel-overlap", file: "tasks/T002.md", line: 10, message: "T001 and T002 are both parallel and T001's src/auth/ overlaps src/auth/session.ts", tasks: ["T001", "T002"], path: "src/auth/session.ts" },
    ]);
  });
  test("no overlap warning when the brief turns [P] off, or when one task depends on the other", () => {
    const f = folder({
      "tasks/T001.md": brief("orch: 1", "# T001: a\n\n## Target files\n- src/x.ts\n"),
      "tasks/T002.md": brief("orch: 1\nparallel: false", "# T002: b\n\n## Target files\n- src/x.ts\n"),
      "tasks/T003.md": brief("orch: 1\nparallel: true\ndepends_on: [T001]", "# T003: c\n\n## Target files\n- src/x.ts\n"),
    }, T);
    assert.deepStrictEqual(readFeature(f.files, f.tasks).problems, []);
  });
  test("brief-size uses handoff.briefChars; the default is 8000", () => {
    const text = brief("orch: 1", "# T001: a\n" + "x".repeat(100));
    const f = folder({ "tasks/T001.md": text }, "## P1\n- [ ] T001 a\n");
    assert.deepStrictEqual(readFeature(f.files, f.tasks).problems, []);
    const r = readFeature(f.files, f.tasks, { briefChars: 50 });
    assert.deepStrictEqual(r.problems, [{ kind: "warning", rule: "brief-size", file: "tasks/T001.md", line: 1, message: `brief is ${text.length} characters; handoff.briefChars is 50`, chars: text.length, limit: 50 }]);
  });
  test("test-only: every target file is a test path; fixtures are not test paths; no target files → no warning", () => {
    for (const [p, expected] of [
      ["test/a.ts", true], ["tests/a.ts", true], ["src/__tests__/a.ts", true], ["spec/a.rb", true], ["src/a.test.ts", true], ["src/a.spec.js", true],
      ["test/fixtures/a.json", false], ["src/fixtures/test/a.ts", false], ["src/a.ts", false], ["testing/a.ts", false], ["src/attest.ts", false], ["", false],
    ]) assert.equal(isTestPath(p), expected, p);
    const mk = (files) => folder({ "tasks/T001.md": brief("orch: 1", `# T001: a\n\n## Target files\n${files.map((x) => `- ${x}`).join("\n")}\n`) }, "## P1\n- [ ] T001 a\n");
    let f = mk(["test/a.test.ts", "tests/b.ts"]);
    assert.deepStrictEqual(readFeature(f.files, f.tasks).problems, [{ kind: "warning", rule: "test-only", file: "tasks/T001.md", line: 4, message: "task appears to add only tests: every target file is a test path" }]);
    f = mk(["test/a.test.ts", "test/fixtures/a.json"]);
    assert.deepStrictEqual(readFeature(f.files, f.tasks).problems, []);
    f = mk([]);
    assert.deepStrictEqual(readFeature(f.files, f.tasks).problems, []);
  });
  test("checkFeature alone takes merged tasks and briefs; problems are ordered spec.md, briefs by key, contracts, line", () => {
    const f = folder({
      "spec.md": "TBD\n",
      "contracts/z.md": "TODO\n",
      "tasks/T003.md": brief("orch: 1", "# T003: c\n\nTBD\n"),
      "tasks/T001.md": brief("orch: 7", "# T001: a\n"),
    }, T);
    const r = readFeature(f.files, f.tasks);
    const again = checkFeature(f, r.tasks, r.briefs);
    assert.deepStrictEqual(again, r.problems);
    assert.deepStrictEqual(r.problems.map((p) => `${p.rule} ${p.file}:${p.line}`), ["marker spec.md:1", "version tasks/T001.md:2", "marker tasks/T003.md:6", "marker contracts/z.md:1"]);
  });
  test("a brief for a key that is not in tasks.md is ignored", () => {
    const f = folder({ "tasks/T009.md": brief("orch: 2", "# T009: x\n") }, "## P1\n- [ ] T001 a\n");
    const r = readFeature(f.files, f.tasks);
    assert.equal(r.hasBriefs, false);
    assert.deepStrictEqual(r.problems, []);
  });
});
