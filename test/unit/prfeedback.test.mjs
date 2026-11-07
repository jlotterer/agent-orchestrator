/** Unit tests for the PR feedback helpers (run after `npm run build`): npm run test:unit */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeChecks, summarizeChecks, collectFeedback, freshFeedback, isTrigger, formatReviewFeedback, tail } from "../../dist/prfeedback.js";

// Shapes as returned by gh 2.83 (`gh pr view --json statusCheckRollup,reviews,comments` and the REST comments API).
const rollup = [
  { __typename: "CheckRun", name: "lint", workflowName: "Lint", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/o/r/actions/runs/1/job/11" },
  { __typename: "CheckRun", name: "build (ubuntu-latest)", workflowName: "Tests", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/o/r/actions/runs/2/job/22" },
  { __typename: "CheckRun", name: "e2e", workflowName: "Tests", status: "IN_PROGRESS", conclusion: "", detailsUrl: "https://github.com/o/r/actions/runs/2/job/23" },
  { __typename: "StatusContext", context: "ci/external", state: "PENDING", targetUrl: "https://ci.example/1" },
];

test("normalizeChecks maps CheckRun and StatusContext", () => {
  const c = normalizeChecks(rollup);
  assert.deepEqual(c.map((x) => x.state), ["pass", "fail", "pending", "pending"]);
  assert.equal(c[1].name, "Tests / build (ubuntu-latest)");
  assert.equal(c[1].jobId, "22");
  assert.equal(c[3].jobId, null);
  assert.equal(normalizeChecks([{ __typename: "CheckRun", name: "x", status: "COMPLETED", conclusion: "SKIPPED" }])[0].state, "pass");
  assert.equal(normalizeChecks([{ __typename: "StatusContext", context: "x", state: "ERROR" }])[0].state, "fail");
});

test("summarizeChecks: fail beats pending, empty is none", () => {
  assert.equal(summarizeChecks(normalizeChecks(rollup)), "fail");
  assert.equal(summarizeChecks(normalizeChecks(rollup.filter((r) => r.conclusion !== "FAILURE"))), "pending");
  assert.equal(summarizeChecks(normalizeChecks([rollup[0]])), "pass");
  assert.equal(summarizeChecks([]), "none");
});

const view = {
  reviews: [
    { author: { login: "copilot-pull-request-reviewer" }, body: "### Changes recommended", submittedAt: "2026-11-07T00:23:11Z", state: "COMMENTED" },
    { author: { login: "alice" }, body: "", submittedAt: "2026-11-07T01:00:00Z", state: "CHANGES_REQUESTED" },
    { author: { login: "bob" }, body: "", submittedAt: "2026-11-07T01:27:26Z", state: "APPROVED" },
  ],
  comments: [{ author: { login: "jeff" }, body: "thanks\n/orch also handle empty input", createdAt: "2026-11-07T02:00:00Z" }],
};
const inline = [
  { user: { login: "Copilot", type: "Bot" }, body: "🛑 Requirement", path: "a.cjs", line: null, original_line: 314, created_at: "2026-11-07T00:23:10Z" },
  { user: { login: "alice", type: "User" }, body: "rename this", path: "src/x.ts", line: 42, created_at: "2026-11-07T00:59:59Z" },
];

test("collectFeedback flattens and sorts; freshFeedback filters by watermark, bots, empty bodies", () => {
  const all = collectFeedback(view, inline);
  assert.equal(all.length, 6);
  assert.equal(all[0].author, "Copilot");
  const fresh = freshFeedback(all, "2026-11-07T00:30:00.000Z", []);
  assert.deepEqual(fresh.map((i) => i.author), ["alice", "alice", "jeff"]); // bob's empty approval dropped, Copilot is older + bot
  assert.deepEqual(freshFeedback(all, null, ["jeff"]).map((i) => i.author), ["copilot-pull-request-reviewer", "alice", "alice"]);
});

test("isTrigger: changes requested or a line starting with the trigger", () => {
  const all = collectFeedback(view, inline);
  assert.equal(isTrigger(all.find((i) => i.state === "CHANGES_REQUESTED"), "/orch"), true);
  assert.equal(isTrigger(all.find((i) => i.author === "jeff"), "/orch"), true);
  assert.equal(isTrigger(all.find((i) => i.author === "jeff"), ""), false);
  assert.equal(isTrigger({ kind: "comment", author: "x", body: "see /orch docs", ts: "x" }, "/orch"), false);
  assert.equal(isTrigger({ kind: "comment", author: "x", body: "/orchestrate", ts: "x" }, "/orch"), false);
});

test("formatReviewFeedback includes file:line and round", () => {
  const txt = formatReviewFeedback(collectFeedback({}, [inline[1]]), "https://pr/1", 2, 3);
  assert.match(txt, /round 2\/3/);
  assert.match(txt, /`src\/x.ts:42`/);
  assert.match(txt, /rename this/);
});

test("tail keeps the end", () => {
  assert.equal(tail("abcdef", 10), "abcdef");
  assert.match(tail("abcdefghij", 3), /hij$/);
});
