/**
 * The "Update project docs" item of a finished run (TASK-23, REQ-HITL-08): `buildDocsUpdate` and the plain
 * text `/orch-spec` fold-back reads. The run uses the briefs of the `full` fixture (test/fixtures/spec-dir/full).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALREADY_COMPLETE_SUMMARY, buildDocsUpdate, docsUpdateText, docsUpdateTitle, mergedInRun } from "../../dist/core/docsUpdate.js";

const FULL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/spec-dir/full");
const brief = (key) => fs.readFileSync(path.join(FULL, "tasks", `${key}.md`), "utf8");

const task = (id, key, status, extra = {}) => ({ id, key, status, summary: `${key} done`, acceptance: [], brief: null, ...extra });
const dec = (id, actor, task_id, text, rationale = null) => ({ id, run_id: "r1", task_id, ts: `2026-11-09T00:00:0${id}Z`, actor, text, rationale });

const run = { spec_dir: "specs/002-auth" };
const tasks = [
  // Ticked in tasks.md before the run: not merged by it, so its REQ is not listed.
  task("t0", "T000", "done", { summary: ALREADY_COMPLETE_SUMMARY, acceptance: ["REQ-AUTH-07 holds"] }),
  task("t1", "T001", "done", { brief: brief("T001") }),
  task("t2", "T002", "done", { brief: brief("T002") }),
  task("t3", "T003", "done", { brief: brief("T003") }),
  task("t4", "T004", "skipped", { brief: brief("T004") }),
  // No brief: REQ IDs come from the criteria.
  task("t5", "T005", "done", { acceptance: ["Given REQ-AUTH-09, When x, Then y", "also REQ-AUTH-09 again"] }),
];
const decisions = [
  dec(1, "planner", null, "Split auth into two phases", "the session store comes first"),
  dec(2, "human", "t2", "Edited task T002: merge_policy", 'merge_policy = "manual"'),
  dec(3, "human", null, "Plan approved"),
  dec(4, "worker", "t1", "Used a plain text file for T001", "the spec does not require a format"),
  dec(5, "orchestrator", "t1", "Retrying T001 (attempt 2/2)"),
  dec(6, "validator", "t1", "T001 passed validation", "4/4 criteria met"),
  dec(7, "worker", "t3", "Kept tokens opaque"),
];
const humanEdits = decisions.filter((d) => d.actor === "human" && d.text.startsWith("Edited task "));

test("buildDocsUpdate: the four lists of a fixture run", () => {
  const u = buildDocsUpdate(run, tasks, decisions, humanEdits);
  assert.deepEqual(u, {
    feature: "specs/002-auth",
    reqs: [
      { id: "REQ-AUTH-01", tasks: ["T001"], notMerged: [] },
      { id: "REQ-AUTH-02", tasks: ["T002"], notMerged: [{ task: "T004", status: "skipped" }] },
      { id: "REQ-AUTH-03", tasks: ["T003"], notMerged: [] },
      { id: "REQ-AUTH-04", tasks: ["T003"], notMerged: [{ task: "T004", status: "skipped" }] },
      { id: "REQ-AUTH-09", tasks: ["T005"], notMerged: [] },
    ],
    decisions: [
      { actor: "planner", task: null, text: "Split auth into two phases", rationale: "the session store comes first" },
      { actor: "worker", task: "T001", text: "Used a plain text file for T001", rationale: "the spec does not require a format" },
      { actor: "worker", task: "T003", text: "Kept tokens opaque", rationale: null },
    ],
    planEdits: [{ task: "T002", text: "Edited task T002: merge_policy", detail: 'merge_policy = "manual"' }],
    contracts: [
      { name: "SessionStore", tasks: ["T001", "T003"] },
      { name: "TokenCodec", tasks: ["T001", "T002", "T003"] },
      { name: "contracts/auth-api.md", tasks: ["T002", "T003"] },
    ],
  });
});

test("buildDocsUpdate: null for an all-skipped run, and for a run whose only done tasks were ticked before it", () => {
  const skipped = tasks.map((t) => ({ ...t, status: "skipped" }));
  assert.equal(buildDocsUpdate(run, skipped, decisions, humanEdits), null);
  assert.equal(buildDocsUpdate(run, [tasks[0], { ...tasks[4] }], [], []), null);
  assert.equal(mergedInRun(tasks[0]), false);
  assert.equal(mergedInRun(tasks[1]), true);
});

test("buildDocsUpdate: a brief with an unsupported orch version falls back to the criteria", () => {
  const t = task("t9", "T009", "done", { brief: "---\norch: 99\ncovers: [REQ-X-01]\n---\n# T009: x\n", acceptance: ["REQ-Y-02 works"] });
  assert.deepEqual(buildDocsUpdate(run, [t], [], []).reqs, [{ id: "REQ-Y-02", tasks: ["T009"], notMerged: [] }]);
});

test("docsUpdateText: title line, feature folder, one heading per list, one item per line, `none` when empty", () => {
  const u = buildDocsUpdate(run, tasks, decisions, humanEdits);
  assert.equal(docsUpdateTitle("shop", "Auth"), "Update project docs: shop Auth");
  assert.equal(docsUpdateText("shop", "Auth", u), [
    "Update project docs: shop Auth",
    "Feature folder: specs/002-auth",
    "",
    "## REQ IDs",
    "- REQ-AUTH-01 (T001)",
    "- REQ-AUTH-02 (T002; not merged: T004 skipped)",
    "- REQ-AUTH-03 (T003)",
    "- REQ-AUTH-04 (T003; not merged: T004 skipped)",
    "- REQ-AUTH-09 (T005)",
    "",
    "## Decisions",
    "- planner: Split auth into two phases — why: the session store comes first",
    "- worker T001: Used a plain text file for T001 — why: the spec does not require a format",
    "- worker T003: Kept tokens opaque",
    "",
    "## Plan edits",
    '- T002: merge_policy = "manual"',
    "",
    "## Contracts",
    "- SessionStore (T001, T003)",
    "- TokenCodec (T001, T002, T003)",
    "- contracts/auth-api.md (T002, T003)",
    "",
  ].join("\n"));
  const empty = docsUpdateText("shop", "Auth", { feature: "specs/x", reqs: [], decisions: [{ actor: "worker", task: "T1", text: "two\nlines", rationale: null }], planEdits: [], contracts: [] });
  assert.match(empty, /## REQ IDs\nnone\n\n## Decisions\n- worker T1: two lines\n\n## Plan edits\nnone\n\n## Contracts\nnone\n$/);
});
