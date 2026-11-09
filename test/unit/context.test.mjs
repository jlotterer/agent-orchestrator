/**
 * Context assembly (TASK-21): the spec-dir fixtures' `context` expectations (architecture §6.4,
 * REQ-WORK-09/10) plus the edge cases the brief lists. Field semantics: test/fixtures/README.md.
 * Run after `npm run build`: npm run test:unit
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assembleSpecContext, extractReqRows, resolveContracts, contractSection, specFileOrder, cutDecision, clip,
} from "../../dist/core/context.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");
const ROOT = path.resolve(FIXTURES, "..", "..");
const SPEC_DIR = path.join(FIXTURES, "spec-dir");
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const MARKER = /… \(truncated, \d+ more chars\)/g;
const markers = (text) => (text.match(MARKER) ?? []).length;
const BUDGETS = { briefChars: 8000, reqChars: 4000, contractChars: 6000, rulesChars: 6000, specChars: 12000 };

/** Every file under a feature folder, keyed by its `/`-separated relative path. */
function readFolder(dir) {
  const files = {};
  const walk = (sub) => {
    for (const e of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else files[rel] = read(path.join(dir, rel));
    }
  };
  walk("");
  return files;
}

/** Builds the fixture's context exactly as the runner in test/fixtures/README.md describes. */
function buildFixtureContext(folder) {
  const expected = JSON.parse(read(path.join(SPEC_DIR, `${folder}.expected.json`)));
  const ctx = expected.context;
  const files = readFolder(path.join(SPEC_DIR, folder));
  const task = expected.tasks.find((t) => t.key === ctx.task);
  const rules = (ctx.inputs.projectFiles ?? []).map((name, i) => ({ name, text: read(path.join(ROOT, ctx.inputs.projectFilesFixture[i])) }));
  let input;
  let reqRows = null;
  if (task.brief) {
    const requirements = { name: ctx.inputs.requirementsFile, text: read(path.join(ROOT, ctx.inputs.requirementsFixture)) };
    reqRows = extractReqRows(requirements, task.cites);
    const { contracts, warnings } = resolveContracts({ files }, task.contracts.map((c) => c.name), task.brief);
    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(contracts.map((c) => ({ name: c.name, resolved: c.source })), task.contracts);
    input = { brief: { name: task.brief, text: files[task.brief] }, reqRows, contracts, rules, specFiles: files };
  } else {
    input = { specFiles: files, contextFiles: ctx.inputs.contextFiles, rules };
  }
  return { expected, ctx, task, files, reqRows, result: assembleSpecContext(input, ctx.budgets) };
}

/** A result part in the fixture's shape (a cut part adds kept/dropped/marker; requirements add ids/lines). */
function shape(p, reqRows) {
  const o = { part: p.part, header: p.header, source: p.source, budget: p.budget, chars: p.chars, cut: p.cut };
  if (p.cut) Object.assign(o, { kept: p.kept, dropped: p.dropped, marker: `… (truncated, ${p.dropped} more chars)` });
  if (p.part === "requirements") Object.assign(o, { ids: reqRows.ids, lines: reqRows.lines });
  return o;
}

describe("spec-dir fixtures: context expectations (§6.4)", () => {
  const folders = fs.readdirSync(SPEC_DIR).filter((f) => f.endsWith(".expected.json")).map((f) => f.replace(/\.expected\.json$/, "")).sort();
  test("the fixture set is complete", () => assert.deepStrictEqual(folders, ["bad", "full", "nocriteria", "speckit", "version"]));
  test("version: no context when the folder cannot be planned", () => {
    assert.equal(JSON.parse(read(path.join(SPEC_DIR, "version.expected.json"))).context, null);
  });
  // `nocriteria` (TASK-20) has no context expectation either; folders with `context: null` are skipped below.
  const withContext = folders.filter((f) => JSON.parse(read(path.join(SPEC_DIR, `${f}.expected.json`))).context !== null);

  for (const folder of withContext) {
    describe(folder, () => {
      const { ctx, task, files, reqRows, result } = buildFixtureContext(folder);
      const expectedParts = ctx.parts.filter((p) => p.part !== "handoff");

      test("parts, in order, with headers, sizes and cuts", () => {
        assert.deepStrictEqual(result.parts.map((p) => shape(p, reqRows)), expectedParts);
      });
      test("cuts and their decisions", () => {
        assert.deepStrictEqual(result.cuts, ctx.cuts);
        assert.deepStrictEqual(result.cuts.map((c) => cutDecision(task.key, c)), ctx.decisions);
      });
      test("the text carries every header in order and one marker per cut", () => {
        let pos = -1;
        for (const p of expectedParts) {
          const at = result.text.indexOf(`${p.header}\n`, pos + 1);
          assert.ok(at > pos, `${p.header} appears after the previous part`);
          pos = at;
        }
        assert.equal(markers(result.text), ctx.cuts.length);
        for (const p of expectedParts.filter((p) => p.cut)) assert.ok(result.text.includes(`\n${p.marker}`));
      });
      test("the hand-off part is the caller's and comes last in the fixture", () => {
        assert.equal(ctx.parts[ctx.parts.length - 1].part, "handoff");
        assert.ok(!result.parts.some((p) => p.part === "handoff"));
      });
      if (task.brief) {
        test("the brief comes first; in full when under budget", () => {
          const brief = result.parts[0];
          assert.equal(brief.part, "brief");
          assert.equal(brief.chars, task.briefChars);
          if (!brief.cut) assert.ok(result.text.startsWith(`### Brief: ${task.brief}\n${files[task.brief]}\n\n### Requirements:`));
        });
        test("spec files are not used when the task has a brief", () => {
          assert.ok(!result.text.includes("### spec.md\n"));
          assert.ok(!result.parts.some((p) => p.part === "spec"));
        });
      } else {
        test("tasks.md is never part of the context", () => {
          assert.ok(!result.text.includes("### tasks.md"));
          assert.ok(!result.parts.some((p) => p.source === "tasks.md" || p.source.startsWith("tasks/")));
        });
        test("the configured files come first, then the rest, each under its own budget (REQ-WORK-10)", () => {
          assert.deepStrictEqual(result.parts.filter((p) => p.part === "spec").map((p) => p.source), ctx.parts.filter((p) => p.part === "spec").map((p) => p.source));
          const spec = result.parts.find((p) => p.source === "spec.md");
          assert.equal(spec.cut, false, "a long plan.md never cuts spec.md");
        });
      }
    });
  }
});

describe("assembleSpecContext: budgets and cuts (REQ-WORK-09)", () => {
  test("a 20,000-character brief with briefChars 8000: one cut, one marker", () => {
    const brief = { name: "tasks/T001.md", text: "x".repeat(20_000) };
    const r = assembleSpecContext({ brief }, BUDGETS);
    assert.deepStrictEqual(r.cuts, [{ part: "brief", source: "tasks/T001.md", from: 20_000, to: 8000 }]);
    assert.equal(markers(r.text), 1);
    assert.ok(r.text.startsWith("### Brief: tasks/T001.md\n" + "x".repeat(8000) + "\n… (truncated, 12000 more chars)"));
    assert.equal(r.parts[0].kept, 8000);
    assert.equal(r.parts[0].dropped, 12_000);
    assert.equal(cutDecision("T001", r.cuts[0]), "T001: brief cut from 20000 to 8000 characters (handoff.briefChars)");
  });

  test("a brief exactly at the budget is not cut", () => {
    const r = assembleSpecContext({ brief: { name: "tasks/T001.md", text: "y".repeat(8000) } }, BUDGETS);
    assert.deepStrictEqual(r.cuts, []);
    assert.equal(markers(r.text), 0);
  });

  test("every part has its own budget: a cut in one never touches another", () => {
    const r = assembleSpecContext({
      brief: { name: "tasks/T002.md", text: "b".repeat(100) },
      reqRows: { name: "docs/requirements.md", ids: ["REQ-A-01"], lines: ["r".repeat(5000)] },
      contracts: [{ name: "Big", source: "spec.md#Big", text: "c".repeat(7000) }, { name: "contracts/small.md", source: "contracts/small.md", text: "s" }],
      rules: [{ name: "AGENTS.md", text: "a".repeat(6001) }],
    }, BUDGETS);
    assert.deepStrictEqual(r.cuts, [
      { part: "requirements", source: "docs/requirements.md", from: 5000, to: 4000 },
      { part: "contract", source: "spec.md#Big", from: 7000, to: 6000 },
      { part: "rules", source: "AGENTS.md", from: 6001, to: 6000 },
    ]);
    assert.equal(markers(r.text), 3);
    assert.deepStrictEqual(r.parts.map((p) => [p.header, p.cut]), [
      ["### Brief: tasks/T002.md", false],
      ["### Requirements: REQ-A-01 (docs/requirements.md)", true],
      ["### Contract: Big (spec.md)", true],
      ["### Contract: contracts/small.md", false],
      ["### Rules: AGENTS.md", true],
    ]);
    assert.equal(cutDecision("T002", r.cuts[1]), "T002: contract spec.md#Big cut from 7000 to 6000 characters (handoff.contractChars)");
    assert.equal(cutDecision("T002", r.cuts[2]), "T002: AGENTS.md cut from 6001 to 6000 characters (handoff.rulesChars)");
  });

  test("REQ-WORK-10: a 15,000-character plan.md and a 3,000-character spec.md with specChars 12000 keep all of spec.md", () => {
    const r = assembleSpecContext({ specFiles: { "plan.md": "p".repeat(15_000), "spec.md": "s".repeat(3000), "tasks.md": "- [ ] T001 x" }, contextFiles: ["spec.md", "data-model.md", "plan.md"] }, BUDGETS);
    assert.deepStrictEqual(r.parts.map((p) => [p.source, p.cut]), [["spec.md", false], ["plan.md", true]]);
    assert.ok(r.text.startsWith("### spec.md\n" + "s".repeat(3000) + "\n\n### plan.md\n"));
    assert.deepStrictEqual(r.cuts, [{ part: "spec", source: "plan.md", from: 15_000, to: 12_000 }]);
    assert.equal(cutDecision("T002", r.cuts[0]), "T002: plan.md cut from 15000 to 12000 characters (handoff.specChars)");
  });

  test("sizes count characters after CRLF normalization", () => {
    const r = assembleSpecContext({ brief: { name: "tasks/T001.md", text: "ab\r\ncd\r\n" } }, BUDGETS);
    assert.equal(r.parts[0].chars, 6);
    assert.equal(r.text, "### Brief: tasks/T001.md\nab\ncd\n");
  });

  test("a brief without cites has no requirements part; an empty input has empty text", () => {
    const r = assembleSpecContext({ brief: { name: "tasks/T001.md", text: "hi" }, reqRows: { name: "docs/requirements.md", ids: [], lines: [] } }, BUDGETS);
    assert.deepStrictEqual(r.parts.map((p) => p.part), ["brief"]);
    assert.deepStrictEqual(assembleSpecContext({}, BUDGETS), { text: "", parts: [], cuts: [] });
  });

  test("an absent rules file is simply not passed: no Rules part, no error", () => {
    const withRules = assembleSpecContext({ brief: { name: "tasks/T001.md", text: "hi" }, rules: [{ name: "AGENTS.md", text: "be nice" }] }, BUDGETS);
    assert.ok(withRules.text.endsWith("\n\n### Rules: AGENTS.md\nbe nice"));
    const without = assembleSpecContext({ brief: { name: "tasks/T001.md", text: "hi" }, rules: [] }, BUDGETS);
    assert.equal(without.text, "### Brief: tasks/T001.md\nhi");
    assert.ok(!without.parts.some((p) => p.part === "rules"));
    const several = assembleSpecContext({ specFiles: { "spec.md": "s" }, rules: [{ name: "AGENTS.md", text: "a" }, { name: "docs/rules.md", text: "b" }] }, BUDGETS);
    assert.deepStrictEqual(several.parts.map((p) => p.header), ["### spec.md", "### Rules: AGENTS.md", "### Rules: docs/rules.md"]);
  });

  test("a contract that resolved to nothing is noted, not dropped", () => {
    const { contracts } = resolveContracts({ files: { "spec.md": "# F" } }, ["Ghost"], "tasks/T001.md");
    const r = assembleSpecContext({ brief: { name: "tasks/T001.md", text: "hi" }, contracts }, BUDGETS);
    assert.equal(r.parts[1].header, "### Contract: Ghost");
    assert.ok(r.text.includes("\n### Contract: Ghost\nGhost: not found"));
  });

  test("clip matches the prompts module's marker", () => {
    assert.equal(clip("abc", 3), "abc");
    assert.equal(clip("abcd", 3), "abc\n… (truncated, 1 more chars)");
  });
});

describe("extractReqRows (§6.4 requirement rows)", () => {
  const REQ = { name: "docs/requirements.md", text: read(path.join(FIXTURES, "requirements.sample.md")) };

  test("rows first, then bullets, in file order; IDs in cites order", () => {
    const r = extractReqRows(REQ, ["REQ-AUTH-04", "REQ-AUTH-01"]);
    assert.deepStrictEqual(r.ids, ["REQ-AUTH-04", "REQ-AUTH-01"]);
    assert.equal(r.lines.length, 6);
    assert.ok(r.lines[0].startsWith("| REQ-AUTH-04 |"));
    assert.ok(r.lines[1].startsWith("- A cookie whose signature"));
    assert.ok(r.lines[2].startsWith("- `REQ-AUTH-04`:"));
    assert.ok(r.lines[3].startsWith("| REQ-AUTH-01 |"));
    assert.ok(r.lines[4].startsWith("- A request exactly at the expiry instant"));
    assert.ok(r.lines[5].startsWith("- `REQ-AUTH-01`:"));
  });

  test("a missing ID gives a not-found line naming the configured file and is not an error", () => {
    const r = extractReqRows(REQ, ["REQ-AUTH-03", "REQ-AUTH-99", "REQ-NOPE-01"]);
    assert.equal(r.lines.length, 4);
    assert.deepStrictEqual(r.lines.slice(2), ["REQ-AUTH-99: not found in docs/requirements.md", "REQ-NOPE-01: not found in docs/requirements.md"]);
    const ctx = assembleSpecContext({ brief: { name: "tasks/T001.md", text: "hi" }, reqRows: r }, BUDGETS);
    assert.ok(ctx.text.includes("### Requirements: REQ-AUTH-03, REQ-AUTH-99, REQ-NOPE-01 (docs/requirements.md)\n| REQ-AUTH-03 |"));
    assert.ok(ctx.text.includes("\nREQ-AUTH-99: not found in docs/requirements.md\n"));
  });

  test("a missing requirements file (empty text) gives one not-found line per ID", () => {
    const r = extractReqRows({ name: "docs/requirements.md", text: "" }, ["REQ-AUTH-01", "REQ-AUTH-02"]);
    assert.deepStrictEqual(r.lines, ["REQ-AUTH-01: not found in docs/requirements.md", "REQ-AUTH-02: not found in docs/requirements.md"]);
  });

  test("whole-word matching and deduplication", () => {
    const text = [
      "| REQ-X-1 | one | new |",
      "| REQ-X-10 | ten | new |",
      "|REQ-X-2|two (no padding)|new|",
      "- bullet for REQ-X-10 only",
      "- `REQ-X-1`: criterion one",
      "* star bullet mentions REQ-X-1.",
      "- REQ-X-1a is a different id",
      "prose mentioning REQ-X-1 is not a bullet",
      "  - indented bullet with REQ-X-2",
    ].join("\n");
    const r = extractReqRows({ name: "r.md", text }, ["REQ-X-1", "REQ-X-2", "REQ-X-1"]);
    assert.deepStrictEqual(r.ids, ["REQ-X-1", "REQ-X-2"]);
    assert.deepStrictEqual(r.lines, [
      "| REQ-X-1 | one | new |",
      "- `REQ-X-1`: criterion one",
      "* star bullet mentions REQ-X-1.",
      "|REQ-X-2|two (no padding)|new|",
      "  - indented bullet with REQ-X-2",
    ]);
  });
});

describe("resolveContracts (§6.4 contracts)", () => {
  const spec = [
    "# Feature",
    "",
    "### SessionStore",
    "not a contract: outside ## Contracts",
    "",
    "## Contracts",
    "",
    "### Foo",
    "foo body",
    "",
    "```ts",
    "export interface Foo {}",
    "```",
    "",
    "",
    "### Bar",
    "bar body",
    "",
    "## Risky logic",
    "### Foo",
    "not a contract either",
  ].join("\n");

  test("a section runs from its heading to the next ##/### heading, trailing blank lines removed", () => {
    assert.equal(contractSection(spec, "Foo"), "### Foo\nfoo body\n\n```ts\nexport interface Foo {}\n```");
    assert.equal(contractSection(spec, "Bar"), "### Bar\nbar body");
    assert.equal(contractSection(spec, "SessionStore"), null);
    assert.equal(contractSection("## Contracts\n### Last\nbody\n\n", "Last"), "### Last\nbody");
    assert.equal(contractSection("## Contracts\r\n### Crlf\r\nline\r\n", "Crlf"), "### Crlf\nline");
  });

  test("section only, file only, both (section wins with a warning), neither (warning)", () => {
    const files = { "spec.md": spec, "contracts/Foo.md": "file foo", "contracts/auth-api.md": "api", "contracts/baz.md": "baz" };
    const { contracts, warnings } = resolveContracts({ files }, ["Foo", "Bar", "contracts/auth-api.md", "baz", "Ghost"], "tasks/T003.md");
    assert.deepStrictEqual(contracts, [
      { name: "Foo", source: "spec.md#Foo", text: "### Foo\nfoo body\n\n```ts\nexport interface Foo {}\n```" },
      { name: "Bar", source: "spec.md#Bar", text: "### Bar\nbar body" },
      { name: "contracts/auth-api.md", source: "contracts/auth-api.md", text: "api" },
      { name: "baz", source: "contracts/baz.md", text: "baz" },
      { name: "Ghost", source: null, text: null },
    ]);
    assert.deepStrictEqual(warnings, [
      "tasks/T003.md: contract Foo is both a spec.md section and contracts/Foo.md; the section is used",
      'tasks/T003.md: contract Ghost is neither a section under spec.md "## Contracts" nor a file in the folder',
    ]);
  });

  test("contract headers in the assembled text", () => {
    const files = { "spec.md": spec, "contracts/auth-api.md": "api" };
    const { contracts } = resolveContracts({ files }, ["Foo", "contracts/auth-api.md"]);
    const r = assembleSpecContext({ brief: { name: "tasks/T001.md", text: "b" }, contracts }, BUDGETS);
    assert.deepStrictEqual(r.parts.map((p) => [p.header, p.source]), [
      ["### Brief: tasks/T001.md", "tasks/T001.md"],
      ["### Contract: Foo (spec.md)", "spec.md#Foo"],
      ["### Contract: contracts/auth-api.md", "contracts/auth-api.md"],
    ]);
  });

  test("no spec.md: only files resolve", () => {
    const { contracts, warnings } = resolveContracts({ files: { "contracts/x.md": "x" } }, ["x", "Y"]);
    assert.deepStrictEqual(contracts.map((c) => c.source), ["contracts/x.md", null]);
    assert.equal(warnings.length, 1);
  });
});

describe("specFileOrder (REQ-WORK-10 order without a brief)", () => {
  const files = Object.fromEntries(["plan.md", "spec.md", "data-model.md", "research.md", "tasks.md", "tasks/T001.md", "contracts/b.md", "contracts/a.json", "notes.txt", "quickstart.md"].map((f) => [f, f]));

  test("configured files in order, other root *.md alphabetically, then contracts/*; never tasks.md or tasks/*", () => {
    assert.deepStrictEqual(specFileOrder(files, ["spec.md", "data-model.md", "plan.md"]), ["spec.md", "data-model.md", "plan.md", "quickstart.md", "research.md", "contracts/a.json", "contracts/b.md"]);
  });
  test("missing configured files are skipped; duplicates and tasks.md in the setting are ignored; the old default still works", () => {
    assert.deepStrictEqual(specFileOrder(files, ["missing.md", "plan.md", "plan.md", "tasks.md", "tasks/T001.md"]), ["plan.md", "data-model.md", "quickstart.md", "research.md", "spec.md", "contracts/a.json", "contracts/b.md"]);
    assert.deepStrictEqual(specFileOrder(files, ["plan.md", "spec.md"]).slice(0, 2), ["plan.md", "spec.md"]);
    assert.deepStrictEqual(specFileOrder({}, ["spec.md"]), []);
  });
});
