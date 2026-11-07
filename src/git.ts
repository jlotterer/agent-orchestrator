import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface ShResult { code: number; stdout: string; stderr: string }

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
  constructor(public repo: string, public baseBranch: string) {}

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

  async commitsAhead(worktree: string): Promise<number> {
    const base = await this.baseRef();
    const r = await git(["rev-list", "--count", `${base}..HEAD`], worktree);
    return r.code === 0 ? parseInt(r.stdout.trim() || "0", 10) : 0;
  }

  async push(worktree: string, branch: string): Promise<void> {
    await must(git(["push", "-u", "--force-with-lease", "origin", branch], worktree), "git push");
  }

  async createPr(worktree: string, branch: string, title: string, body: string): Promise<string> {
    const existing = await sh("gh", ["pr", "view", branch, "--json", "url", "-q", ".url"], worktree);
    if (existing.code === 0 && existing.stdout.trim()) return existing.stdout.trim();
    const r = await sh("gh", ["pr", "create", "--base", this.baseBranch, "--head", branch, "--title", title, "--body", body], worktree);
    if (r.code !== 0) throw new Error(`gh pr create failed: ${(r.stderr || r.stdout).trim()}`);
    const url = r.stdout.trim().split("\n").pop() ?? "";
    return url;
  }

  async mergePr(worktree: string, branch: string, squash: boolean): Promise<void> {
    const args = ["pr", "merge", branch, squash ? "--squash" : "--merge", "--delete-branch"];
    const r = await sh("gh", args, worktree);
    if (r.code !== 0) throw new Error(`gh pr merge failed: ${(r.stderr || r.stdout).trim()}`);
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
