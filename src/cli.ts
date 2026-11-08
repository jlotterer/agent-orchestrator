#!/usr/bin/env node
/**
 * orch — orchestrator CLI (architecture §15.2).
 *
 *   orch serve                        start the daemon + dashboard (run this under systemd)
 *   orch project add <path> [--name n] | project list [--archived] | project remove <id>
 *   orch plan <specDir> [--no-llm]    import a Spec Kit feature dir and draft a plan
 *   orch approve [runId]              approve the pending plan
 *   orch run | pause | stop           control the project's current run
 *   orch status                       print the board
 *   orch answer <questionId> <text>   answer a question
 *   orch retry|skip|merge|stop-task <taskKey>   task actions
 *
 * Project commands act on `--project <id>`, else ORCH_PROJECT, else the project whose repo contains the
 * current directory, else the only project (§5.4). Exit codes: 0 ok, 1 error (`error: …` on stderr), 2 usage.
 * Every API call sends `Authorization: Bearer` from ORCH_TOKEN or the settings file's auth.token.
 *
 * Used by agents inside a task (ORCH_URL / ORCH_TASK_ID / ORCH_TOKEN are set for them):
 *   orch decide "<text>" [--why "<rationale>"]
 *   orch ask "<question>" [--options "A,B,C"]
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig, loadServerConfig, writeExampleConfig, CONFIG_FILENAME } from "./config.js";
import { bindGuard, resolveToken } from "./auth.js";
import { orchHome, serverConfigPath, dbPath } from "./paths.js";
import { registerProject, resolveProjectForCwd } from "./projects.js";
import type { Store } from "./db.js";
import type { Project } from "./types.js";

const argv = process.argv.slice(2);
const cmd = argv[0];

/** A usage error: exit code 2 (REQ-UI-08). */
class UsageError extends Error {}

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new UsageError(`--${name} needs a value`);
  return v;
}
function has(name: string) { return argv.includes(`--${name}`); }
const BOOL_FLAGS = new Set(["--no-llm", "--archived", "--help"]);
/** Arguments after the command, without flags and their values. */
function positional(): string[] {
  const out: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { if (!BOOL_FLAGS.has(a)) i++; continue; }
    out.push(a);
  }
  return out;
}

/** Port and token of the local daemon: `$ORCH_HOME/server.json` when it exists, else a legacy orch.config.json. */
function localDaemon(): { port: number; token: string } {
  const home = orchHome();
  if (fs.existsSync(serverConfigPath(home))) {
    const s = loadServerConfig(home);
    return { port: s.port, token: s.auth.token };
  }
  const c = loadConfig().config;
  return { port: c.port, token: c.auth.token };
}

async function api(method: string, p: string, body?: any): Promise<any> {
  // Agents get ORCH_URL and ORCH_TOKEN from the daemon; humans fall back to the settings files.
  const local = (process.env.ORCH_URL && process.env.ORCH_TOKEN) ? null : localDaemon();
  const base = process.env.ORCH_URL ?? `http://127.0.0.1:${local!.port}`;
  const token = resolveToken(local?.token);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  let r: Response;
  try {
    r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error(`cannot reach orch at ${base} (is \`orch serve\` running?)`);
  }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `${r.status} ${r.statusText}`);
  return j;
}

interface ProjectRow { id: string; name: string; repo: string; archived: boolean; error: string | null; run: { id: string; status: string; title: string } | null; inboxCount: number }

function projectTable(rows: ProjectRow[]): string {
  return rows.map((p) => `  ${pad(p.id, 20)} ${pad(p.name, 20)} ${p.repo}`).join("\n");
}

/**
 * The project a command acts on (§5.4): `--project` > ORCH_PROJECT > the project whose repo contains
 * `hint` (a spec dir) or the cwd > the only project. Anything else is a usage error listing the projects.
 */
async function resolveProject(hint?: string): Promise<ProjectRow> {
  const all: ProjectRow[] = await api("GET", "/api/projects?archived=1");
  const active = all.filter((p) => !p.archived);
  const asProjects = active.map((p) => ({ id: p.id, repo_path: p.repo, archived: false }) as Project);
  const explicit = flag("project") ?? (process.env.ORCH_PROJECT || undefined);
  if (explicit) {
    const p = all.find((x) => x.id === explicit);
    if (!p) throw new UsageError(`no project '${explicit}'. Projects:\n${projectTable(active) || "  (none)"}`);
    return p;
  }
  for (const dir of [hint, process.cwd()]) {
    if (!dir) continue;
    const hit = resolveProjectForCwd(asProjects, dir);
    if (hit) return active.find((p) => p.id === hit.id)!;
  }
  if (active.length === 1) return active[0];
  if (!active.length) throw new UsageError("no projects registered. Add one with: orch project add <path>");
  throw new UsageError(`which project? Run inside a project's repo or pass --project <id> (or set ORCH_PROJECT). Projects:\n${projectTable(active)}`);
}

const projectState = async (p: ProjectRow) => api("GET", `/api/projects/${encodeURIComponent(p.id)}/state`);

const HELP = `orch — orchestrator/worker/validator runner

  orch serve                           start daemon + dashboard
  orch project add <path> [--name n]   register a git repository
  orch project list [--archived]       list projects with run status and inbox count
  orch project remove <id>             archive a project (repo and history are kept)
  orch plan <specDir> [--no-llm]       import Spec Kit tasks.md and draft a plan
  orch approve [runId]                 approve the plan
  orch run | pause | stop              control the project's current run
  orch status                          show the board and inbox
  orch answer <qid> <text>             answer a question
  orch retry|skip|merge|stop-task <taskKey>   task actions
  orch decide "<text>" --why "<r>"     (agents) record a decision
  orch ask "<q>" --options "A,B"       (agents) ask a human and stop

Project commands act on --project <id>, else ORCH_PROJECT, else the project whose repo
contains the current directory, else the only project.
Exit codes: 0 ok, 1 error, 2 usage.`;

async function main() {
  if (has("help") && cmd !== "serve") { console.log(HELP); return; }
  switch (cmd) {
    case "init": {
      const p = writeExampleConfig(process.cwd());
      console.log(`wrote ${p}\nEdit it (repo, validation.command, notify.ntfyUrl), then: orch serve`);
      return;
    }
    case "serve": {
      // All state lives under ORCH_HOME (§5.1); a single-repo install is upgraded on its first start (§5.5).
      const home = orchHome();
      const { Store } = await import("./db.js");
      const upgraded = await upgradeLegacyInstall(home, Store);
      const server = loadServerConfig(home);
      const refused = bindGuard({ host: server.host, token: server.auth.token, allowInsecure: server.auth.allowInsecure });
      if (refused) { upgraded?.db.close(); throw new Error(refused); }
      const { Orchestrator } = await import("./orchestrator.js");
      const { startServer } = await import("./server.js");
      const store = upgraded ?? new Store(dbPath(home));
      if (!store.listProjects().length) console.warn(`no projects registered in ${dbPath(home)}. Add one with: orch project add <path>`);
      const orch = new Orchestrator(server, store, { home });
      orch.recover();
      startServer(orch);
      const shutdown = () => { console.log("shutting down"); process.exit(0); };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    }
    case "project": {
      const [sub, arg] = positional();
      switch (sub) {
        case "add": {
          if (!arg) throw new UsageError("usage: orch project add <path> [--name <name>]");
          const p = await api("POST", "/api/projects", { path: path.resolve(arg), name: flag("name") });
          console.log(`${p.unarchived ? "restored archived" : "registered"} project ${p.id} "${p.name}" at ${p.repo_path}`);
          if (p.configCreated) console.log(`created starter settings file ${p.configCreated}; set validation.command there`);
          return;
        }
        case "list": case "ls": {
          const rows: ProjectRow[] = await api("GET", `/api/projects${has("archived") ? "?archived=1" : ""}`);
          if (!rows.length) { console.log("no projects. Add one with: orch project add <path>"); return; }
          for (const p of rows) {
            const run = p.run ? `${p.run.status} (${p.run.id})` : "no runs";
            const tags = [p.archived ? "archived" : "", p.inboxCount ? `inbox ${p.inboxCount}` : "", p.error ? `error: ${p.error}` : ""].filter(Boolean).join("  ");
            console.log(`${pad(p.id, 20)} ${pad(p.name, 20)} ${pad(run, 26)} ${p.repo}${tags ? "  " + tags : ""}`);
          }
          return;
        }
        case "remove": case "archive": {
          if (!arg) throw new UsageError("usage: orch project remove <id>");
          await api("DELETE", `/api/projects/${encodeURIComponent(arg)}`);
          console.log(`archived project ${arg} (the repository and its history are kept; \`orch project add\` restores it)`);
          return;
        }
        default:
          throw new UsageError("usage: orch project add <path> [--name n] | project list [--archived] | project remove <id>");
      }
    }
    case "plan": {
      const dir = positional()[0];
      if (!dir) throw new UsageError("usage: orch plan <specDir> [--no-llm]");
      const specDir = path.resolve(dir);
      const project = await resolveProject(specDir);
      console.log(has("no-llm") ? `importing tasks into ${project.id}…` : `importing tasks into ${project.id} and running the planner (this takes a minute)…`);
      const run = await api("POST", `/api/projects/${encodeURIComponent(project.id)}/plan`, { specDir, llm: !has("no-llm") });
      console.log(`run ${run.id} "${run.title}" → ${run.status}. Review the plan in the dashboard, then: orch approve`);
      return;
    }
    case "approve": {
      let id = positional()[0];
      if (!id) {
        id = (await projectState(await resolveProject())).run?.id;
        if (!id) throw new Error("no run to approve");
      }
      await api("POST", `/api/runs/${encodeURIComponent(id)}/approve`);
      console.log(`run ${id} approved. Start it with: orch run`);
      return;
    }
    case "run": case "start": case "pause": case "stop": {
      const project = await resolveProject();
      const run = (await projectState(project)).run;
      if (!run) throw new Error(`project ${project.id} has no run`);
      const action = cmd === "run" ? "start" : cmd;
      await api("POST", `/api/runs/${encodeURIComponent(run.id)}/${action}`);
      console.log(`${project.id}: run ${run.id} ${{ start: "running", pause: "paused", stop: "stopped" }[action]}`);
      return;
    }
    case "status": {
      const project = await resolveProject();
      const s = await projectState(project);
      console.log(`project ${project.id} "${project.name}" (${project.repo})${project.error ? `\n  error: ${project.error}` : ""}`);
      if (!s.run) { console.log("no runs. Create one with: orch plan <specDir>"); return; }
      console.log(`run ${s.run.id} "${s.run.title}" [${s.run.status}]`);
      for (const t of s.tasks) console.log(`  ${pad(t.status, 11)} ${t.key}  ${t.title}${t.pr_url ? "  " + t.pr_url : ""}`);
      if (s.inbox.length) { console.log("\ninbox:"); for (const i of s.inbox) console.log(`  [${i.type}] ${i.id ? "#" + i.id + " " : ""}${i.title}`); }
      return;
    }
    case "answer": {
      const [id, ...rest] = positional();
      if (!id || !rest.length) throw new UsageError("usage: orch answer <questionId> <answer text>");
      if (!/^\d+$/.test(id)) throw new UsageError(`question id must be a number, got '${id}'`);
      await api("POST", `/api/questions/${id}/answer`, { answer: rest.join(" ") });
      console.log("answered");
      return;
    }
    case "retry": case "skip": case "merge": case "stop-task": {
      const key = positional()[0];
      if (!key) throw new UsageError(`usage: orch ${cmd} <taskKey>`);
      const project = await resolveProject();
      const s = await projectState(project);
      const t = s.tasks.find((x: any) => x.key === key || x.id === key);
      if (!t) throw new Error(`task ${key} not found in ${project.id}${s.run ? ` run ${s.run.id}` : ""}`);
      await api("POST", `/api/tasks/${t.id}/${cmd === "stop-task" ? "stop" : cmd}`);
      console.log(`${cmd} ${t.key}: ok`);
      return;
    }
    // ---- agent-facing ----
    case "decide": {
      const text = positional()[0];
      if (!text) throw new UsageError('usage: orch decide "<decision>" --why "<rationale>"');
      await api("POST", "/api/decide", { taskId: process.env.ORCH_TASK_ID ?? null, runId: process.env.ORCH_RUN_ID ?? null, actor: process.env.ORCH_ACTOR ?? "worker", text, rationale: flag("why") ?? null });
      console.log("decision recorded");
      return;
    }
    case "ask": {
      const text = positional()[0];
      if (!text) throw new UsageError('usage: orch ask "<question>" --options "A,B,C"');
      const taskId = process.env.ORCH_TASK_ID;
      if (!taskId) throw new Error("orch ask must be run inside an orchestrated task (ORCH_TASK_ID not set)");
      const options = (flag("options") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const q = await api("POST", "/api/ask", { taskId, text, options });
      console.log(`Question #${q.id} recorded for a human. STOP working now: end your turn with status "blocked". You will be resumed with the answer.`);
      return;
    }
    case undefined: case "help":
      console.log(HELP);
      return;
    default:
      throw new UsageError(`unknown command '${cmd}'. Run \`orch help\` for the list.`);
  }
}

function pad(s: string, n: number) { return s.padEnd(n); }

// ------------------------------------------------------------------ legacy upgrade (architecture §5.5)
const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
/** A pre-projects settings file names its repo or its agent CLIs. */
const isLegacyConfig = (raw: unknown) => isObj(raw) && ("repo" in raw || "agents" in raw || "agent" in raw);
const readJson = (p: string): unknown => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };

/** `--config`, `ORCH_CONFIG`, or the nearest orch.config.json above cwd that is a legacy file. */
function findLegacyConfig(): string | null {
  const explicit = flag("config") ?? process.env.ORCH_CONFIG;
  if (explicit) return isLegacyConfig(readJson(explicit)) ? path.resolve(explicit) : null;
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    const p = path.join(dir, CONFIG_FILENAME);
    if (fs.existsSync(p) && isLegacyConfig(readJson(p))) return p;
    if (path.dirname(dir) === dir) return null;
  }
}

/** Keys of a legacy file that are not project settings (§5.2): they move to server.json or are dropped. */
const SERVER_ONLY = ["repo", "worktreeDir", "dbPath", "host", "port", "publicUrl", "auth", "notify", "agents", "agent"];

/**
 * Upgrade a single-repo install (REQ-PROJ-10): when `$ORCH_HOME/server.json` does not exist and a legacy
 * orch.config.json is found, split it into server.json and a project file (the original is kept as
 * `.bak`), copy the legacy database into ORCH_HOME, register the repo as a project and give it every
 * existing run. Returns the open Store when it upgraded, else null. server.json is written last, so an
 * upgrade that fails part-way runs again on the next start.
 */
async function upgradeLegacyInstall(home: string, StoreClass: new (p: string) => Store): Promise<Store | null> {
  const serverPath = serverConfigPath(home);
  if (fs.existsSync(serverPath)) return null;
  const legacyPath = findLegacyConfig();
  if (!legacyPath) return null;
  const raw = readJson(legacyPath) as Record<string, any>;
  const { config: legacy } = loadConfig(legacyPath); // validates it, resolves repo/dbPath, maps the pre-0.2 `agent` block
  console.log(`upgrading single-repo install from ${legacyPath} into ${home}`);

  // 1. Server settings; the global agent cap starts at the old per-repo limit.
  const server: Record<string, any> = {};
  for (const k of ["host", "port", "publicUrl", "notify", "auth"]) if (raw[k] !== undefined) server[k] = raw[k];
  if (raw.agents !== undefined || raw.agent !== undefined) server.agents = legacy.agents;
  server.scheduler = { maxAgents: legacy.scheduler.maxParallel };
  if (raw.scheduler?.tickSeconds !== undefined) server.scheduler.tickSeconds = raw.scheduler.tickSeconds;
  if (raw.git?.ghCommand !== undefined) server.git = { ghCommand: raw.git.ghCommand };

  // 2. Project settings: everything else. The original file is kept as .bak.
  const project = structuredClone(raw);
  for (const k of SERVER_ONLY) delete project[k];
  if (isObj(project.scheduler)) delete project.scheduler.tickSeconds;
  if (isObj(project.git)) delete project.git.ghCommand;
  const projectJson = JSON.stringify(project, null, 2) + "\n";
  const backup = legacyPath + ".bak";
  fs.copyFileSync(legacyPath, backup);
  fs.writeFileSync(legacyPath, projectJson);
  const repoFile = path.join(legacy.repo, CONFIG_FILENAME);
  const wroteRepoFile = path.resolve(repoFile) !== path.resolve(legacyPath) && !fs.existsSync(repoFile);
  if (wroteRepoFile) fs.writeFileSync(repoFile, projectJson);

  // 3. Database: copy the legacy one (with its WAL) if ORCH_HOME has none, migrate, register the repo, adopt the runs.
  let store: Store | null = null;
  try {
    fs.mkdirSync(home, { recursive: true });
    const target = dbPath(home);
    const copied = fs.existsSync(legacy.dbPath) && !fs.existsSync(target);
    if (copied) {
      fs.copyFileSync(legacy.dbPath, target);
      if (fs.existsSync(legacy.dbPath + "-wal")) fs.copyFileSync(legacy.dbPath + "-wal", target + "-wal");
    }
    store = new StoreClass(target);
    const repoReal = fs.realpathSync.native(legacy.repo);
    const p = store.getProjectByPath(repoReal) ?? (await registerProject(store, legacy.repo)).project;
    const adopted = store.db.prepare("UPDATE runs SET project_id = ? WHERE project_id IS NULL").run(p.id).changes;

    // 4. server.json marks the upgrade as done; then record the decision.
    fs.writeFileSync(serverPath, JSON.stringify(server, null, 2) + "\n");
    const text = `Upgraded single-repo install to project ${p.id}`;
    const why = `server settings moved to ${serverPath}; ${legacyPath} reduced to project settings (original kept as ${backup})` +
      (copied ? `; database copied from ${legacy.dbPath}` : "") + (adopted ? `; ${adopted} existing run(s) assigned to the project` : "");
    const latest = store.listRuns(p.id)[0];
    if (latest) store.addDecision(latest.id, null, "orchestrator", text, why);
    console.log(`${text}: ${why}`);
    return store;
  } catch (e) {
    // Leave the install as it was so the next start tries again.
    store?.db.close();
    fs.copyFileSync(backup, legacyPath);
    if (wroteRepoFile) fs.rmSync(repoFile, { force: true });
    throw e;
  }
}

main().catch((e) => { console.error(`error: ${e?.message ?? e}`); process.exit(e instanceof UsageError ? 2 : 1); });
