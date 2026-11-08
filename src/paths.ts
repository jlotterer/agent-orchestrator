/**
 * ORCH_HOME layout (architecture §5.1). Every path orch owns derives from `ORCH_HOME`
 * (default `~/.orch`), read on each call so tests and the CLI can override it.
 *
 *   $ORCH_HOME/
 *     server.json                 server settings (§19)
 *     orch.db                     SQLite, all projects
 *     worktrees/<project-id>/     task and phase worktrees
 *     archive/<project-id>/       <runId>-events.jsonl.gz
 *     run/                        pidfiles for UI-mode apps
 */
import os from "node:os";
import path from "node:path";

/** Absolute ORCH_HOME. A relative `ORCH_HOME` resolves against the current directory. */
export function orchHome(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.ORCH_HOME?.trim();
  return v ? path.resolve(v) : path.join(os.homedir(), ".orch");
}

export function serverConfigPath(home = orchHome()): string {
  return path.join(home, "server.json");
}

export function dbPath(home = orchHome()): string {
  return path.join(home, "orch.db");
}

export function worktreesDir(projectId: string, home = orchHome()): string {
  return path.join(home, "worktrees", checkId(projectId));
}

export function archiveDir(projectId: string, home = orchHome()): string {
  return path.join(home, "archive", checkId(projectId));
}

export function runDir(home = orchHome()): string {
  return path.join(home, "run");
}

/** Project id from a directory name (§5.3): lowercase, runs of other characters become `-`. */
export function projectSlug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "project";
}

/** A project id becomes a path segment: refuse anything that could escape its parent directory. */
function checkId(id: string): string {
  if (!id || id === "." || id === ".." || /[\\/]/.test(id)) throw new Error(`invalid project id '${id}'`);
  return id;
}
