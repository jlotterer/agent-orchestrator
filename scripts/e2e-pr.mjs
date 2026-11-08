#!/usr/bin/env node
/**
 * End-to-end test of PR mode and the PR feedback loop (roadmap R1), with a fake `gh`
 * (scripts/fake-gh.mjs) and a local bare repo as `origin`:
 *   T101 auto   : CI fails on the first push -> CI log goes back to the worker -> fixed -> auto-merged
 *   T102 manual : reviewer comments "/orch …" (+ an inline comment, + a bot comment that must be ignored)
 *                 -> worker fix round -> back in the inbox -> human merges
 *   T103 manual : merged on GitHub by hand -> orch notices and marks it done
 *   node scripts/e2e-pr.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { makeRepo, writeConfig, startDaemon, api as apiFor, waitFor, cleanup, FAKE_AGENT, FAKE_GH } from "./lib/e2e.mjs";

const PORT = 4812;
const CHECK_SH = "#!/bin/sh\nfor f in impl/*.txt; do [ -f \"$f\" ] || continue; grep -q OK \"$f\" || { echo \"$f is not OK\"; exit 1; }; done\necho checks passed\n";
const { tmp, repo, home, sh } = makeRepo({
  prefix: "orch-e2e-pr-",
  origin: true,
  files: {
    "README.md": "# demo\n",
    "check.sh": CHECK_SH,
    "specs/002-pr/spec.md": "# Feature Specification: PR loop\n\nFiles in impl/.\n",
    "specs/002-pr/tasks.md": `# Tasks

## Phase 1: Core
- [ ] T101 [P] Create greeting file CI_TRAP
- [ ] T102 [P] Add farewell file (manual)
- [ ] T103 [P] Add docs file (manual)
`,
    ".gitignore": ".orch/\norch.config.json\n",
  },
});
const ghDir = path.join(tmp, "gh");
writeConfig(repo, {
  repo: ".", baseBranch: "main", worktreeDir: "../wt", dbPath: ".orch/orch.db", port: PORT, publicUrl: `http://localhost:${PORT}`,
  agents: {
    timeoutMinutes: 2,
    adapters: { claude: { type: "claude", command: FAKE_AGENT, extraArgs: [], env: {} } },
    roles: { planner: { adapter: "claude", model: "" }, worker: { adapter: "claude", model: "" }, validator: { adapter: "claude", model: "" } },
  },
  scheduler: { maxParallel: 3, tickSeconds: 1, maxAttempts: 2, resumeOnRetry: true },
  validation: { command: "sh check.sh", agent: true },
  git: {
    pr: true, mergePolicy: "auto", squash: true, ghCommand: FAKE_GH,
    feedback: { enabled: true, waitForChecks: true, pollSeconds: 1, maxRounds: 2, noChecksGraceSeconds: 0, trigger: "/orch" },
  },
});

const api = apiFor(PORT);
const prFile = (branch) => path.join(ghDir, branch.replace(/[^\w.-]+/g, "_") + ".json");
const editPr = (branch, fn) => { const f = prFile(branch); const pr = JSON.parse(fs.readFileSync(f, "utf8")); fn(pr); fs.writeFileSync(f + ".tmp", JSON.stringify(pr, null, 2)); fs.renameSync(f + ".tmp", f); };
const readPr = (branch) => JSON.parse(fs.readFileSync(prFile(branch), "utf8"));

let ok = false;
try {
  await startDaemon({ cwd: repo, port: PORT, env: { FAKE_GH_DIR: ghDir, ORCH_HOME: home } });
  const run = await api("POST", "/api/plan", { specDir: path.join(repo, "specs/002-pr"), llm: true });
  let s = await api("GET", "/api/state");
  const policy = Object.fromEntries(s.tasks.map((t) => [t.key, t.merge_policy]));
  if (policy.T101 !== "auto" || policy.T102 !== "manual" || policy.T103 !== "manual") throw new Error("unexpected merge policies " + JSON.stringify(policy));
  await api("POST", `/api/runs/${run.id}/approve`);
  await api("POST", `/api/runs/${run.id}/start`);

  const handled = new Set();
  let sawChecksLane = false;
  await waitFor(async () => {
    s = await api("GET", "/api/state");
    if (s.tasks.some((t) => t.status === "pr_checks")) sawChecksLane = true;
    for (const i of s.inbox) {
      const t = s.tasks.find((x) => x.id === i.task_id);
      if (i.type === "failed") throw new Error(`task failed: ${i.title}\n${i.detail}`);
      if (i.type !== "merge") continue;
      const k = `${t.key}:${t.fix_rounds}`;
      if (handled.has(k)) continue;
      handled.add(k);
      if (t.key === "T101") throw new Error(`T101 should auto-merge, but landed in the inbox: ${i.feedback}`);
      if (t.key === "T102" && t.fix_rounds === 0) {
        console.log("reviewing T102 on the fake PR");
        const ts = new Date(Date.now() + 1000).toISOString();
        editPr(t.branch, (pr) => {
          pr.comments.push({ author: { login: "jeff" }, body: "Looks close.\n/orch please mention the reviewer", createdAt: ts });
          pr.comments.push({ author: { login: "lint-helper[bot]" }, body: "/orch ignore me", createdAt: ts });
          pr.inline.push({ user: { login: "jeff", type: "User" }, body: "nit: wording here", path: "impl/T102.txt", line: 1, created_at: ts });
        });
      } else if (t.key === "T102") {
        if (!/nit: wording here/.test(t.last_feedback) || /ignore me/.test(t.last_feedback)) throw new Error("review feedback not passed through correctly:\n" + t.last_feedback);
        if (!sh(`git show ${t.branch}:impl/T102.txt`).includes("reviewed")) throw new Error("worker did not act on review feedback");
        console.log("merging T102 after its fix round");
        await api("POST", `/api/tasks/${t.id}/merge`);
      } else if (t.key === "T103") {
        console.log("merging T103 by hand on 'GitHub'");
        editPr(t.branch, (pr) => { pr.state = "MERGED"; pr.mergedBy = "human"; });
      }
    }
    return s.run.status === "done";
  }, { timeoutMs: 120_000, intervalMs: 500, label: "run to finish" }).catch((e) => { if (!/^timed out/.test(e.message)) throw e; });
  s = await api("GET", "/api/state");
  console.log("final:", s.run.status, s.tasks.map((t) => `${t.key}=${t.status}(attempt ${t.attempt}, rounds ${t.fix_rounds})`).join(" "));
  if (s.run.status !== "done") throw new Error("run did not finish");
  const byKey = Object.fromEntries(s.tasks.map((t) => [t.key, t]));
  if (!sawChecksLane) throw new Error("T101 never waited in pr_checks");
  if (byKey.T101.fix_rounds !== 1) throw new Error("T101 should have needed exactly 1 CI fix round");
  if (byKey.T102.fix_rounds !== 1) throw new Error("T102 should have needed exactly 1 review fix round");
  if (byKey.T103.fix_rounds !== 0) throw new Error("T103 should not have had a fix round");
  const prs = Object.fromEntries(["T101", "T102", "T103"].map((k) => [k, readPr(byKey[k].branch)]));
  if (prs.T101.state !== "MERGED" || prs.T101.mergedBy !== "orch") throw new Error("T101 PR not merged by orch");
  if (prs.T102.state !== "MERGED" || prs.T102.mergedBy !== "orch") throw new Error("T102 PR not merged via the dashboard");
  if (prs.T103.mergedBy !== "human") throw new Error("T103 should have been merged by hand");
  const decisions = s.decisions.map((d) => `${d.actor}:${d.text}`);
  for (const must of [
    "orchestrator:Sending CI failure on T101's PR back to the worker (round 1/2)",
    "orchestrator:Merging T101: PR checks passed",
    "orchestrator:Sending review feedback on T102's PR back to the worker (round 1/2)",
    "human:Approved merge of T102",
    "orchestrator:T103: PR was merged on GitHub",
  ]) {
    if (!decisions.some((d) => d.startsWith(must))) throw new Error(`missing decision: ${must}\n${decisions.join("\n")}`);
  }
  const evs = await api("GET", `/api/runs/${run.id}/events?limit=2000`);
  const t001Resume = evs.find((e) => e.task_id === byKey.T101.id && e.kind === "state" && /resuming previous session/.test(e.data.message ?? ""));
  if (!t001Resume) throw new Error("T101's CI fix round did not resume the worker session");
  const ciFb = evs.find((e) => e.task_id === byKey.T101.id && e.kind === "state" && /PR fix round 1\/2/.test(e.data.message ?? ""));
  if (!ciFb || !/CIFAIL marker/.test(ciFb.data.feedback)) throw new Error("CI log excerpt did not reach the worker feedback");
  console.log("decisions:\n  " + decisions.join("\n  "));
  ok = true;
} catch (e) {
  console.error("E2E-PR FAILED:", e.message);
} finally {
  await cleanup({ ok });
  if (ok) console.log("E2E-PR PASSED");
  process.exit(ok ? 0 : 1);
}
