/**
 * Fixture-driven tests for the pure core (TASK-03). Every case in test/fixtures/ runs here;
 * cases with a `pending` field are skipped until the named task removes the marker.
 * Field semantics: test/fixtures/README.md. Run after `npm run build`: npm run test:unit
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTasksMd } from "../../dist/speckit.js";
import { extractJson } from "../../dist/adapters/runner.js";
import { selectReady } from "../../dist/core/readiness.js";
import { nextTaskState } from "../../dist/core/transitions.js";
import { decidePrAction } from "../../dist/core/prpoll.js";
import { ownedOverlap, outOfScope } from "../../dist/core/ownership.js";
import { phasesToValidate, planFixup, phaseList } from "../../dist/core/phases.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");
const load = (f) => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), "utf8"));
const opts = (c) => (c.pending ? { skip: `pending: ${c.pending}` } : {});

function uniqueNames(cases, file) {
  const names = cases.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, `${file}: case names must be unique`);
}

describe("tasks-md fixtures (parseTasksMd)", () => {
  const dir = path.join(FIXTURES, "tasks-md");
  const cases = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
  test("there are fixture cases", () => assert.ok(cases.length >= 15));
  for (const name of cases) {
    test(name, () => {
      const md = fs.readFileSync(path.join(dir, `${name}.md`), "utf8");
      const expected = JSON.parse(fs.readFileSync(path.join(dir, `${name}.expected.json`), "utf8"));
      const got = parseTasksMd(md).map((t) => ({ key: t.key, phase: t.phase, parallel: t.parallel, done: t.done, depends_on: [...t.depends_on].sort() }));
      assert.deepStrictEqual(got, expected);
    });
  }
  test("crlf-line-endings.md keeps its CRLF line endings", () => {
    assert.match(fs.readFileSync(path.join(dir, "crlf-line-endings.md"), "utf8"), /\r\n/);
  });
});

describe("extract-json fixtures (extractJson)", () => {
  const cases = load("extract-json.json");
  uniqueNames(cases, "extract-json.json");
  for (const c of cases) test(c.name, opts(c), () => assert.deepStrictEqual(extractJson(c.input), c.expected));
});

describe("readiness fixtures (selectReady)", () => {
  const cases = load("readiness.json");
  uniqueNames(cases, "readiness.json");
  for (const c of cases) test(c.name, opts(c), () => assert.deepStrictEqual(selectReady(c.input), c.expected));
});

describe("transitions fixtures (nextTaskState)", () => {
  const cases = load("transitions.json");
  uniqueNames(cases, "transitions.json");
  for (const c of cases) {
    test(`${c.name}`, opts(c), () => {
      const r = nextTaskState(c.task, c.event, c.config);
      const e = c.expected;
      assert.equal(r.status, e.status, "status");
      assert.equal(!!r.rejected, !!e.rejected, "rejected");
      if (e.rejected) {
        assert.equal(r.patch, undefined, "a rejected event changes nothing");
        assert.equal(r.effect, undefined, "a rejected event has no effects");
      }
      assert.deepStrictEqual(r.patch ?? {}, e.patch ?? {}, "patch");
      if (e.decisionPrefix) {
        assert.ok(r.decision, "a decision is expected");
        assert.ok(r.decision.text.startsWith(e.decisionPrefix), `decision "${r.decision.text}" starts with "${e.decisionPrefix}"`);
      } else {
        assert.equal(r.decision, undefined, "no decision is expected");
      }
      assert.equal(!!r.notify, !!e.notify, "notify");
      assert.deepStrictEqual(r.effect ?? [], e.effect ?? [], "effect");
    });
  }
  test("every non-pending row of architecture §8 has a case", () => {
    const rows = new Set(cases.filter((c) => !c.pending).map((c) => c.row));
    for (const r of ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T8a", "T9", "T10", "T11", "T12", "T13", "T14", "T15", "T16", "T17", "T18"]) assert.ok(rows.has(r), r);
  });
});

describe("pr-poll fixtures (decidePrAction)", () => {
  const cases = load("pr-poll.json");
  uniqueNames(cases, "pr-poll.json");
  for (const c of cases) {
    test(c.name, opts(c), () => {
      const r = decidePrAction({ task: c.task, pr: c.pr, localSha: c.localSha, now: c.now, config: c.config });
      const e = c.expected;
      assert.equal(r.action, e.action, "action");
      assert.equal(r.kind, e.kind, "kind");
      if (e.reasonContains) assert.ok(r.reason.includes(e.reasonContains), `reason "${r.reason}" contains "${e.reasonContains}"`);
      assert.deepStrictEqual(r.patch ?? {}, e.patch ?? {}, "patch");
      if (e.itemBodies) assert.deepStrictEqual((r.items ?? []).map((i) => i.body), e.itemBodies, "itemBodies");
      if (e.failedChecks) assert.deepStrictEqual((r.failedChecks ?? []).map((ch) => ch.name), e.failedChecks, "failedChecks");
    });
  }
  test("every step of architecture §12.2 has a case", () => {
    const steps = new Set(cases.filter((c) => !c.pending).map((c) => c.step));
    for (let s = 1; s <= 7; s++) assert.ok(steps.has(s), `step ${s}`);
  });
});

describe("ownership fixtures (ownedOverlap, outOfScope)", () => {
  const { overlap, outOfScope: scope } = load("ownership.json");
  uniqueNames(overlap, "ownership.json overlap");
  uniqueNames(scope, "ownership.json outOfScope");
  test("there are at least 10 overlap cases", () => assert.ok(overlap.length >= 10));
  for (const c of overlap) {
    test(`overlap: ${c.name}`, opts(c), () => {
      assert.equal(ownedOverlap(c.a, c.b), c.expected);
      assert.equal(ownedOverlap(c.b, c.a), c.expected, "symmetric");
    });
  }
  for (const c of scope) test(`outOfScope: ${c.name}`, opts(c), () => assert.deepStrictEqual(outOfScope(c.files, c.owned), c.expected));
  test('outOfScope(["src/a.ts","README.md"], ["src/**"]) returns ["README.md"]', () => {
    assert.deepStrictEqual(outOfScope(["src/a.ts", "README.md"], ["src/**"]), ["README.md"]);
  });
});

describe("phases fixtures (phasesToValidate, planFixup)", () => {
  const { toValidate, fixup } = load("phases.json");
  uniqueNames(toValidate, "phases.json toValidate");
  uniqueNames(fixup, "phases.json fixup");
  test("there are at least 8 cases", () => assert.ok(toValidate.length + fixup.length >= 8));
  for (const c of toValidate) test(`toValidate: ${c.name}`, opts(c), () => assert.deepStrictEqual(phasesToValidate(c.tasks, c.phases), c.expected));
  for (const c of fixup) test(`fixup: ${c.name}`, opts(c), () => assert.deepStrictEqual(planFixup(c.phase, c.round, c.verdict, c.laterTasks), c.expected));
  test("phaseList numbers phases from 1 in plan order; tasks before any heading are the phase named ''", () => {
    const tasks = [{ key: "T003", phase: "B", status: "pending", orderIdx: 2 }, { key: "T001", phase: null, status: "done", orderIdx: 0 }, { key: "T002", phase: "A", status: "done", orderIdx: 1 }, { key: "FIX-2.1", phase: "A", status: "pending", orderIdx: 3 }];
    assert.deepStrictEqual(phaseList(tasks), [{ name: "", idx: 1 }, { name: "A", idx: 2 }, { name: "B", idx: 3 }]);
  });
});
