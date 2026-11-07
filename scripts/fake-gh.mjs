#!/usr/bin/env node
/**
 * A stand-in for the GitHub CLI used by scripts/e2e-pr.mjs. State lives in FAKE_GH_DIR, one JSON
 * file per PR (so the test and concurrent gh calls don't overwrite each other's PRs).
 * The PR head is whatever was pushed to the real `origin` remote (a local bare repo).
 * CI: one check, "ci / test", which fails if any impl/*.txt in the head commit contains CIFAIL.
 * Supported: pr view, pr create, pr merge, run view --job --log-failed, api …/pulls/N/comments.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const dir = process.env.FAKE_GH_DIR;
if (!dir) { console.error("fake gh: FAKE_GH_DIR not set"); process.exit(2); }
fs.mkdirSync(dir, { recursive: true });
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const git = (...a) => { try { return execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
const fileFor = (branch) => path.join(dir, branch.replace(/[^\w.-]+/g, "_") + ".json");
const all = () => fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
const save = (pr) => { const f = fileFor(pr.branch); fs.writeFileSync(f + ".tmp", JSON.stringify(pr, null, 2)); fs.renameSync(f + ".tmp", f); };
const find = (ref) => all().find((p) => p.url === ref || p.branch === ref || String(p.number) === ref);
const die = (msg, code = 1) => { console.error(msg); process.exit(code); };

function head(pr) {
  const line = git("ls-remote", "origin", `refs/heads/${pr.branch}`);
  return line.split(/\s+/)[0] || pr.mergedHead || "";
}
function checks(sha) {
  if (!sha) return [];
  // The pushed commit is already in the local object store (worktrees share the repo's objects).
  const files = git("ls-tree", "-r", "--name-only", sha, "--", "impl").split("\n").filter(Boolean);
  const bad = files.some((f) => git("show", `${sha}:${f}`).includes("CIFAIL"));
  return [{ __typename: "CheckRun", name: "test", workflowName: "ci", status: "COMPLETED", conclusion: bad ? "FAILURE" : "SUCCESS", detailsUrl: "https://github.com/acme/demo/actions/runs/7/job/77" }];
}

const [cmd, sub] = args;
if (cmd === "pr" && sub === "view") {
  const pr = find(args[2]);
  if (!pr) die(`no pull requests found for branch "${args[2]}"`);
  const fields = flag("--json").split(",");
  if (flag("-q")) { if (pr.state === "OPEN") console.log(pr.url); process.exit(0); } // createPr's "existing open PR" probe
  const sha = head(pr);
  const full = {
    number: pr.number, url: pr.url, state: pr.state, headRefOid: sha, reviewDecision: pr.reviewDecision ?? "",
    reviews: pr.reviews ?? [], comments: pr.comments ?? [], statusCheckRollup: pr.state === "OPEN" ? checks(sha) : [],
  };
  console.log(JSON.stringify(Object.fromEntries(fields.map((f) => [f, full[f]]))));
} else if (cmd === "pr" && sub === "create") {
  const branch = flag("--head");
  const existing = find(branch);
  if (existing && existing.state === "OPEN") die("a pull request already exists");
  const number = 100 + Math.floor(Math.random() * 9000);
  const pr = { number, url: `https://github.com/acme/demo/pull/${number}`, branch, base: flag("--base"), title: flag("--title"), state: "OPEN", reviews: [], comments: [], inline: [], created: new Date().toISOString() };
  save(pr);
  console.log(pr.url);
} else if (cmd === "pr" && sub === "merge") {
  const pr = find(args[2]);
  if (!pr || pr.state !== "OPEN") die("no open pull request");
  pr.mergedHead = head(pr);
  pr.state = "MERGED";
  pr.mergedBy = "orch";
  save(pr);
  if (args.includes("--delete-branch")) git("push", "-q", "origin", "--delete", pr.branch);
} else if (cmd === "run" && sub === "view") {
  console.log(`test\tRun tests\t2026-01-01T00:00:00Z impl file contains CIFAIL marker\ntest\tRun tests\t2026-01-01T00:00:01Z Error: Process completed with exit code 1.`);
} else if (cmd === "api") {
  const n = (args[1].match(/pulls\/(\d+)\/comments/) || [])[1];
  const pr = n && find(n);
  console.log(JSON.stringify(pr ? pr.inline ?? [] : []));
} else {
  die(`fake gh: unsupported: ${args.join(" ")}`, 3);
}
