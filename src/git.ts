import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { normalizeChecks, collectFeedback, tail, type Check, type PrStatus } from "./prfeedback.js";

export interface ShResult { code: number; stdout: string; stderr: string }

/** One changed file of a task branch (§11 "Diff for review"). `patch` is null for binary files and past the size cap. */
export interface DiffFile { path: string; status: string; additions: number; deletions: number; binary: boolean; patch: string | null }
export interface DiffResult { base: string; head: string; files: DiffFile[]; truncated: boolean }

export function sh(cmd: string, args: string[], cwd: string, opts: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<ShResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...(opts.env ?? {}) }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const t = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : null;
    child.on("error", (e) => { if (t) clearTimeout(t); resolve({ code: -1, stdout, stderr: stderr + e.message }); });
    child.on("close", (code) => { if (t) clearTimeout(t); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

/** Run a shell command line (via sh -c) in cwd. */
export function shell(cmdline: string, cwd: string, opts: { env?: Record<string, string>; timeoutMs?: number } = {}) {
  return sh("sh", ["-c", cmdline], cwd, opts);
}

async function git(args: string[], cwd: string): Promise<ShResult> {
  return sh("git", args, cwd);
}

async function must(p: Promise<ShResult>, what: string): Promise<string> {
  const r = await p;
  if (r.code !== 0) throw new Error(`${what} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

export class Git {
  constructor(public repo: string, public baseBranch: string, public gh = "gh") {}

  async hasRemote(): Promise<boolean> {
    const r = await git(["remote"], this.repo);
    return r.code === 0 && r.stdout.trim().length > 0;
  }

  /** The ref new work should branch from: origin/<base> if a remote exists, else <base>. */
  async baseRef(): Promise<string> {
    if (await this.hasRemote()) {
      await git(["fetch", "--prune", "origin"], this.repo);
      const r = await git(["rev-parse", "--verify", `origin/${this.baseBranch}`], this.repo);
      if (r.code === 0) return `origin/${this.baseBranch}`;
    }
    return this.baseBranch;
  }

  async addWorktree(dir: string, branch: string): Promise<void> {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const base = await this.baseRef();
    // If the branch already exists (retry after crash), reuse it.
    const exists = (await git(["rev-parse", "--verify", `refs/heads/${branch}`], this.repo)).code === 0;
    if (fs.existsSync(dir)) await this.removeWorktree(dir, false);
    if (exists) await must(git(["worktree", "add", dir, branch], this.repo), "git worktree add");
    else await must(git(["worktree", "add", "-b", branch, dir, base], this.repo), "git worktree add -b");
  }

  /** A worktree on a detached HEAD at `ref` (phase validation, §10.3): no branch is created. A leftover dir is replaced. */
  async addDetachedWorktree(dir: string, ref: string): Promise<void> {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    if (fs.existsSync(dir)) await this.removeWorktree(dir, false);
    await git(["worktree", "prune"], this.repo);
    await must(git(["worktree", "add", "--detach", dir, ref], this.repo), "git worktree add --detach");
  }

  async removeWorktree(dir: string, deleteBranch: boolean, branch?: string): Promise<void> {
    await git(["worktree", "remove", "--force", dir], this.repo);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    await git(["worktree", "prune"], this.repo);
    if (deleteBranch && branch) await git(["branch", "-D", branch], this.repo);
  }

  async commitAll(worktree: string, message: string): Promise<boolean> {
    const status = await must(git(["status", "--porcelain"], worktree), "git status");
    if (!status.trim()) return false;
    await must(git(["add", "-A"], worktree), "git add");
    await must(git(["-c", "user.name=orch", "-c", "user.email=orch@localhost", "commit", "-q", "-m", message], worktree), "git commit");
    return true;
  }

  /** Commit specific paths in a working tree (used for tasks.md ticks on the base branch). */
  async commitPaths(cwd: string, paths: string[], message: string): Promise<boolean> {
    const cur = (await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).stdout.trim();
    if (cur !== this.baseBranch) return false;
    await must(git(["add", "--", ...paths], cwd), "git add");
    const staged = (await git(["diff", "--cached", "--quiet", "--", ...paths], cwd)).code !== 0;
    if (!staged) return false;
    await must(git(["-c", "user.name=orch", "-c", "user.email=orch@localhost", "commit", "-q", "-m", message, "--", ...paths], cwd), "git commit");
    return true;
  }

  async diffFromBase(worktree: string, maxChars = 60000): Promise<string> {
    const base = await this.baseRef();
    const stat = (await git(["diff", "--stat", `${base}...HEAD`], worktree)).stdout;
    const full = (await git(["diff", `${base}...HEAD`], worktree)).stdout;
    const body = full.length > maxChars ? full.slice(0, maxChars) + `\n\n… diff truncated (${full.length} chars total)` : full;
    return `${stat}\n\n${body}`;
  }

  /**
   * Structured diff of a task branch against its base, for the dashboard's review view (§11).
   * Per-file patches come from `git diff <base>...HEAD -- <file>`; binary files have no patch.
   * Patch text is capped at `maxChars` in total; files past the cap keep their counts but no patch.
   */
  async diffFiles(worktree: string, maxChars = 200_000): Promise<DiffResult> {
    const base = await this.baseRef();
    const range = `${base}...HEAD`;
    const head = (await must(git(["rev-parse", "HEAD"], worktree), "git rev-parse")).trim();
    // -z keeps paths with spaces/unicode intact; no rename detection so each entry is one path.
    const numstat = await must(git(["diff", "--no-renames", "-z", "--numstat", range], worktree), "git diff --numstat");
    const names = await must(git(["diff", "--no-renames", "-z", "--name-status", range], worktree), "git diff --name-status");

    const status = new Map<string, string>();
    const ns = names.split("\0");
    for (let i = 0; i + 1 < ns.length; i += 2) if (ns[i]) status.set(ns[i + 1], ns[i]);

    const files: DiffFile[] = [];
    for (const rec of numstat.split("\0")) {
      if (!rec) continue;
      const [a, d, ...rest] = rec.split("\t");
      const p = rest.join("\t");
      const binary = a === "-" && d === "-";
      files.push({ path: p, status: status.get(p) ?? "M", additions: binary ? 0 : Number(a) || 0, deletions: binary ? 0 : Number(d) || 0, binary, patch: null });
    }

    let used = 0, truncated = false;
    for (const f of files) {
      if (f.binary) continue;
      if (used >= maxChars) { truncated = true; continue; }
      const p = (await git(["diff", "--no-renames", range, "--", f.path], worktree)).stdout;
      // Drop the header lines before the first hunk; the UI shows path/status itself.
      const at = p.indexOf("\n@@");
      let body = at >= 0 ? p.slice(at + 1) : "";
      if (used + body.length > maxChars) { body = body.slice(0, maxChars - used); truncated = true; }
      used += body.length;
      f.patch = body;
    }
    return { base, head, files, truncated };
  }

  async commitsAhead(worktree: string): Promise<number> {
    const base = await this.baseRef();
    const r = await git(["rev-list", "--count", `${base}..HEAD`], worktree);
    return r.code === 0 ? parseInt(r.stdout.trim() || "0", 10) : 0;
  }

  async push(worktree: string, branch: string): Promise<void> {
    await must(git(["push", "-u", "--force-with-lease", "origin", branch], worktree), "git push");
  }

  async createPr(worktree: string, branch: string, title: string, body: string): Promise<string> {
    const existing = await sh(this.gh, ["pr", "view", branch, "--json", "url,state", "-q", 'select(.state == "OPEN") | .url'], worktree);
    if (existing.code === 0 && existing.stdout.trim()) return existing.stdout.trim();
    const r = await sh(this.gh, ["pr", "create", "--base", this.baseBranch, "--head", branch, "--title", title, "--body", body], worktree);
    if (r.code !== 0) throw new Error(`gh pr create failed: ${(r.stderr || r.stdout).trim()}`);
    const url = r.stdout.trim().split("\n").pop() ?? "";
    return url;
  }

  async mergePr(worktree: string, branch: string, squash: boolean): Promise<void> {
    const args = ["pr", "merge", branch, squash ? "--squash" : "--merge", "--delete-branch"];
    const r = await sh(this.gh, args, worktree);
    if (r.code !== 0) throw new Error(`gh pr merge failed: ${(r.stderr || r.stdout).trim()}`);
  }

  /** State, head, checks and all review feedback of a PR, in one normalized object. */
  async prStatus(cwd: string, prRef: string): Promise<PrStatus> {
    const fields = "number,url,state,headRefOid,reviewDecision,reviews,comments,statusCheckRollup";
    const r = await sh(this.gh, ["pr", "view", prRef, "--json", fields], cwd, { timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(`gh pr view failed: ${(r.stderr || r.stdout).trim()}`);
    const v = JSON.parse(r.stdout);
    // Inline (diff) comments are only on the REST API. Best effort: a failure here must not stop CI handling.
    let inline: any[] = [];
    const ir = await sh(this.gh, ["api", `repos/{owner}/{repo}/pulls/${v.number}/comments?per_page=100`], cwd, { timeoutMs: 60_000 });
    if (ir.code === 0) { try { const j = JSON.parse(ir.stdout); if (Array.isArray(j)) inline = j; } catch {} }
    return {
      number: v.number, url: v.url, state: v.state, headSha: v.headRefOid ?? "", reviewDecision: v.reviewDecision ?? "",
      checks: normalizeChecks(v.statusCheckRollup), feedback: collectFeedback(v, inline),
    };
  }

  /** Tail of the failed-step log for each failed GitHub Actions job (other CI providers: none). */
  async failedCheckLogs(cwd: string, checks: Check[], maxChars: number): Promise<Record<string, string>> {
    const jobs = checks.filter((c) => c.jobId).slice(0, 3);
    const out: Record<string, string> = {};
    for (const c of jobs) {
      const r = await sh(this.gh, ["run", "view", "--job", c.jobId!, "--log-failed"], cwd, { timeoutMs: 120_000 });
      if (r.code === 0 && r.stdout.trim()) out[c.name] = tail(r.stdout.trim(), Math.floor(maxChars / jobs.length));
    }
    return out;
  }

  /** Full sha of a local branch (works from the main repo regardless of which worktree has it). */
  async branchSha(branch: string): Promise<string | null> {
    const r = await git(["rev-parse", "--verify", `refs/heads/${branch}`], this.repo);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /**
   * Before a fix round: bring in commits someone pushed to the PR branch (e.g. applied review
   * suggestions) so our next force-with-lease push doesn't drop them.
   */
  async syncFromRemote(worktree: string, branch: string): Promise<"same" | "ahead" | "fast-forwarded" | "diverged" | "no-remote"> {
    const f = await git(["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], worktree);
    if (f.code !== 0) return "no-remote";
    const local = (await git(["rev-parse", "HEAD"], worktree)).stdout.trim();
    const remote = (await git(["rev-parse", `refs/remotes/origin/${branch}`], worktree)).stdout.trim();
    if (!remote || local === remote) return "same";
    if ((await git(["merge-base", "--is-ancestor", remote, local], worktree)).code === 0) return "ahead";
    if ((await git(["merge-base", "--is-ancestor", local, remote], worktree)).code === 0) {
      await must(git(["merge", "--ff-only", "-q", remote], worktree), "git merge --ff-only");
      return "fast-forwarded";
    }
    return "diverged";
  }

  /**
   * Local merge (no GitHub): fast-forward or squash the task branch into the base branch.
   * Requires the base branch to be checked out and clean in the main repo.
   */
  async mergeLocal(worktree: string, branch: string, squash: boolean, message: string): Promise<void> {
    const cur = (await must(git(["rev-parse", "--abbrev-ref", "HEAD"], this.repo), "git rev-parse")).trim();
    if (cur !== this.baseBranch) throw new Error(`local merge needs '${this.baseBranch}' checked out in ${this.repo} (currently '${cur}')`);
    const dirty = (await must(git(["status", "--porcelain", "--untracked-files=no"], this.repo), "git status")).trim();
    if (dirty) throw new Error(`local merge needs a clean working tree in ${this.repo}`);
    // Rebase the branch onto base first so the merge is a clean fast-forward / squash.
    const rb = await git(["rebase", this.baseBranch], worktree);
    if (rb.code !== 0) { await git(["rebase", "--abort"], worktree); throw new Error(`rebase onto ${this.baseBranch} failed: ${rb.stderr.trim()}`); }
    if (squash) {
      await must(git(["merge", "--squash", branch], this.repo), "git merge --squash");
      await must(git(["-c", "user.name=orch", "-c", "user.email=orch@localhost", "commit", "-q", "-m", message], this.repo), "git commit");
    } else {
      await must(git(["merge", "--ff-only", branch], this.repo), "git merge --ff-only");
    }
  }

  async currentSha(cwd: string): Promise<string> {
    return (await must(git(["rev-parse", "--short", "HEAD"], cwd), "git rev-parse")).trim();
  }
}
