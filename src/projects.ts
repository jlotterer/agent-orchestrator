/**
 * Project registry (architecture §5.3, §5.4; decision 0011). One daemon manages many repos; each is a
 * `projects` row keyed by a slug of its directory name. Projects are archived, never deleted.
 */
import fs from "node:fs";
import path from "node:path";
import type { Store } from "./db.js";
import type { Project, RunStatus } from "./types.js";
import { sh } from "./git.js";
import { projectSlug } from "./paths.js";
import { writeStarterProjectConfig } from "./config.js";

/** Run states that count as unfinished (REQ-PROJ-07): such a run blocks archiving. */
export const UNFINISHED_RUN_STATUSES: readonly RunStatus[] = ["planning", "plan_pending", "ready", "running", "paused"];

export interface RegisterResult {
  project: Project;
  /** Path of the starter `orch.config.json`, set only when registering created it (REQ-PROJ-02). */
  configCreated?: string;
  /** True when an archived project with this path was restored instead of a new one being added. */
  unarchived?: boolean;
}

/** Same path after symlinks and case are settled, so one repo cannot be registered under two spellings. */
function realpath(p: string): string {
  return fs.realpathSync.native(path.resolve(p));
}

async function gitOut(args: string[], cwd: string): Promise<string | null> {
  const r = await sh("git", args, cwd);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** `origin/HEAD`'s branch, else the current branch, else `main`. */
async function detectBaseBranch(repo: string): Promise<string> {
  const remoteHead = await gitOut(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repo);
  if (remoteHead) return remoteHead.replace(/^origin\//, "");
  return (await gitOut(["branch", "--show-current"], repo)) || "main";
}

/** First free id: the slug, then `<slug>-2`, `<slug>-3`… (archived projects keep their ids). */
function freeId(store: Store, base: string): string {
  if (!store.getProject(base)) return base;
  for (let n = 2; ; n++) if (!store.getProject(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * Register the git repository at `repoPath` (REQ-PROJ-01, -02, -04). The path must be the repo's top
 * level. Re-adding the path of an archived project un-archives it with its history; re-adding an active
 * one throws naming it. Writes a starter `orch.config.json` when the repo has none.
 */
export async function registerProject(store: Store, repoPath: string, opts: { name?: string } = {}): Promise<RegisterResult> {
  let repo: string;
  try {
    repo = realpath(repoPath);
  } catch {
    throw new Error(`${repoPath}: no such directory`);
  }
  if (!fs.statSync(repo).isDirectory()) throw new Error(`${repoPath} is not a directory`);

  const top = await gitOut(["rev-parse", "--show-toplevel"], repo);
  if (top === null) throw new Error(`${repo} is not a git repository`);
  const topReal = realpath(top);
  if (topReal !== repo) throw new Error(`${repo} is not a git repository root (the repository root is ${topReal})`);

  const existing = store.getProjectByPath(repo);
  let project: Project;
  let unarchived = false;
  if (existing && !existing.archived) {
    throw new Error(`${repo} is already registered as project '${existing.id}'`);
  } else if (existing) {
    store.setProjectArchived(existing.id, false);
    project = store.getProject(existing.id)!;
    unarchived = true;
  } else {
    const name = opts.name?.trim() || path.basename(repo);
    project = store.addProject({ id: freeId(store, projectSlug(path.basename(repo))), name, repo_path: repo });
  }

  const starter = writeStarterProjectConfig(repo, { baseBranch: await detectBaseBranch(repo) });
  const result: RegisterResult = { project };
  if (starter.created) result.configCreated = starter.path;
  if (unarchived) result.unarchived = true;
  return result;
}

/**
 * Archive a project (REQ-PROJ-04): hides it from the default list, keeps its rows and its repo.
 * Refused while the project has an unfinished run, naming that run.
 */
export function archiveProject(store: Store, id: string): Project {
  const project = store.getProject(id);
  if (!project) throw new Error(`no project '${id}'`);
  const open = store.listRuns(id).find((r) => UNFINISHED_RUN_STATUSES.includes(r.status));
  if (open) {
    throw new Error(`project '${id}' has an unfinished run ${open.id} (${open.status}, "${open.title}"); stop it before archiving`);
  }
  if (!project.archived) store.setProjectArchived(id, true);
  return store.getProject(id)!;
}

function contains(dir: string, p: string): boolean {
  const rel = path.relative(dir, p);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The non-archived project whose repo contains `cwd`, deepest match first (CLI resolution step 3, §5.4).
 * Undefined when none does.
 */
export function resolveProjectForCwd(projects: Project[], cwd: string): Project | undefined {
  let dir = path.resolve(cwd);
  try { dir = realpath(dir); } catch { /* a cwd that no longer exists still matches by its spelling */ }
  let best: Project | undefined;
  for (const p of projects) {
    if (p.archived || !contains(p.repo_path, dir)) continue;
    if (!best || p.repo_path.length > best.repo_path.length) best = p;
  }
  return best;
}
