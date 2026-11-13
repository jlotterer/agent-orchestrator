import fs from "node:fs";
import path from "node:path";
import { orchHome, serverConfigPath, dbPath, worktreesDir, projectSlug } from "./paths.js";
import { resolveToken } from "./auth.js";
import { buildDefaults } from "./settings-schema.js";

export interface RoleConfig {
  /** Key into agents.adapters. */
  adapter: string;
  /** Model passed to the adapter (empty = the CLI's default). */
  model: string;
}

export type RoleName = "planner" | "worker" | "validator";

export interface Config {
  /** Absolute path to the git repo the agents work on. */
  repo: string;
  /** Branch that tasks branch from and merge into. */
  baseBranch: string;
  /** Where worktrees are created (outside the repo). */
  worktreeDir: string;
  /** Where the SQLite database lives. */
  dbPath: string;
  /** Dashboard/API bind. */
  host: string;
  port: number;
  /** Public URL of the dashboard (used in notifications and agent env). */
  publicUrl: string;
  /**
   * Access token (§16). `ORCH_TOKEN` overrides `token`; empty = auth off. A non-loopback `host`
   * without a token is refused at startup unless `allowInsecure` is true.
   */
  auth: { token: string; allowInsecure: boolean };

  agents: {
    /** Hard timeout for one agent invocation, minutes. */
    timeoutMinutes: number;
    /** Named adapter configurations. `type` picks the implementation (claude, antigravity, codex). */
    adapters: Record<string, { type: string; command: string; extraArgs: string[]; env: Record<string, string> }>;
    /** Which adapter (and model) each role uses. Different adapters per role = independent judgement. */
    roles: {
      planner: RoleConfig;
      worker: RoleConfig;
      validator: RoleConfig;
    };
  };

  scheduler: {
    /** Max tasks running at once (worker+validator each count as one). 1 = sequential. */
    maxParallel: number;
    /** How often the scheduler ticks, seconds. */
    tickSeconds: number;
    /** Worker attempts before a task is marked failed. */
    maxAttempts: number;
    /** On retry, resume the worker's previous session (keeps context) instead of starting fresh. */
    resumeOnRetry: boolean;
  };

  validation: {
    /** Deterministic gate run in the worktree before the validator agent. Empty = skip. */
    command: string;
    /** Run the validator agent at all. */
    agent: boolean;
  };

  git: {
    /** Open PRs via gh. If false, merge locally with git (no GitHub needed). */
    pr: boolean;
    /** Default merge policy for tasks. */
    mergePolicy: "auto" | "manual";
    /** Squash on merge. */
    squash: boolean;
    /** Files copied from the repo root into every new worktree (e.g. .env). */
    copyFiles: string[];
    /** Command run inside a fresh worktree after creation (e.g. npm ci). */
    setupCommand: string;
    /** After a task merges, tick it in the spec's tasks.md ("- [x] T001"). */
    tickTasksMd: boolean;
    /** The GitHub CLI executable (overridable for tests). */
    ghCommand: string;
    /** PR feedback loop (PR mode only): watch open PRs for CI results and review comments. */
    feedback: {
      /** Poll open PRs at all. Off = the pre-R1 behaviour (merge right after PR creation). */
      enabled: boolean;
      /** Auto-merge tasks wait for the PR's checks to pass before merging. */
      waitForChecks: boolean;
      /** How often each open PR is polled, seconds. */
      pollSeconds: number;
      /** Fix rounds per task driven by CI failures or review comments. Separate from maxAttempts. */
      maxRounds: number;
      /** Pending checks longer than this send the task to the inbox. */
      checksTimeoutMinutes: number;
      /** If a PR reports no checks at all, wait this long after a push before treating it as "no CI". */
      noChecksGraceSeconds: number;
      /**
       * A comment line starting with this sends review feedback to the worker (e.g. "/orch rename the flag").
       * Needed because GitHub won't let you "Request changes" on a PR opened with your own account.
       * "Changes requested" reviews always trigger. Empty = only those reviews trigger.
       */
      trigger: string;
      /** Comment authors whose comments never trigger a round (bots ending in "[bot]" are always ignored). */
      ignoreAuthors: string[];
      /** Max characters of failed CI log passed to the worker. */
      logChars: number;
    };
  };

  /** Budgets and sources of the context each agent receives (architecture §6.4, §9). Every part is clipped on its own. */
  handoff: {
    /** Max characters of each spec file given to a worker without a brief (one budget per file, so a long plan.md never cuts spec.md). */
    specChars: number;
    /** Max characters of prior-task summaries, decisions and answers given to each worker. */
    historyChars: number;
    /** Spec files that come first, in this order, when a task has no brief; the folder's other *.md and contracts/* follow. */
    contextFiles: string[];
    /** Max characters of a task's brief (tasks/<key>.md). Over budget: clipped with a marker, and a decision records the cut. */
    briefChars: number;
    /** Max characters of the requirement rows and acceptance criteria for the REQ IDs a brief cites. */
    reqChars: number;
    /** Max characters of each contract a brief names (a spec.md section or a contracts/* file). */
    contractChars: number;
    /** Max characters of each project rules file. */
    rulesChars: number;
    /** The project's requirements file, relative to the repo; cited REQ rows are taken from it. Missing rows are noted, not errors. */
    requirementsFile: string;
    /** Project rules files, relative to the repo, given to every agent when present. Absent files are skipped. */
    projectFiles: string[];
  };

  notify: {
    /** ntfy topic URL, e.g. https://ntfy.sh/my-orch-topic. Empty = off. */
    ntfyUrl: string;
    /** Optional ntfy auth token. */
    ntfyToken: string;
  };
}

export const CONFIG_FILENAME = "orch.config.json";

function deepMerge<T>(base: T, over: any): T {
  if (over === undefined || over === null) return base;
  if (Array.isArray(base) || typeof base !== "object") return over as T;
  const out: any = { ...base };
  for (const k of Object.keys(over)) {
    const b = (base as any)[k];
    out[k] = b !== undefined && typeof b === "object" && !Array.isArray(b) ? deepMerge(b, over[k]) : over[k];
  }
  return out;
}

export function findConfigPath(start = process.cwd()): string | null {
  let dir = path.resolve(start);
  for (;;) {
    const p = path.join(dir, CONFIG_FILENAME);
    if (fs.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadConfig(explicit?: string): { config: Config; path: string | null } {
  const p = explicit ?? process.env.ORCH_CONFIG ?? findConfigPath();
  if (!p) return { config: { ...DEFAULT_CONFIG, auth: { token: resolveToken(""), allowInsecure: false } }, path: null };
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const root = path.dirname(p);
  migrateLegacyAgentBlock(raw);
  const cfg = deepMerge(DEFAULT_CONFIG, raw);
  for (const role of ["planner", "worker", "validator"] as const) {
    const r = cfg.agents.roles[role];
    if (!cfg.agents.adapters[r.adapter]) throw new Error(`config: agents.roles.${role}.adapter '${r.adapter}' is not defined in agents.adapters`);
  }
  // Resolve relative paths against the config file's directory.
  cfg.repo = path.resolve(root, cfg.repo);
  cfg.worktreeDir = path.resolve(root, cfg.worktreeDir);
  cfg.dbPath = path.resolve(root, cfg.dbPath);
  cfg.auth = { token: resolveToken(cfg.auth.token), allowInsecure: cfg.auth.allowInsecure === true };
  return { config: cfg, path: p };
}

/** Pre-0.2 configs had a single `agent` block. Map it onto agents.adapters.claude + roles. */
function migrateLegacyAgentBlock(raw: any) {
  const a = raw?.agent;
  if (!a || raw.agents) return;
  raw.agents = {
    timeoutMinutes: a.timeoutMinutes,
    adapters: { claude: { type: "claude", command: a.command ?? "claude", extraArgs: a.extraArgs, env: {} } },
    roles: {
      planner: { adapter: "claude", model: a.plannerModel ?? "" },
      worker: { adapter: "claude", model: a.workerModel ?? "" },
      validator: { adapter: "claude", model: a.validatorModel ?? "" },
    },
  };
  delete raw.agent;
}

export function writeExampleConfig(dir: string): string {
  const p = path.join(dir, CONFIG_FILENAME);
  const example = {
    ...DEFAULT_CONFIG,
    repo: ".",
    worktreeDir: "../orch-worktrees",
    dbPath: ".orch/orch.db",
    publicUrl: "http://YOUR-SERVER:4800",
    validation: { command: "npm test", agent: true },
    notify: { ntfyUrl: "https://ntfy.sh/CHANGE-ME", ntfyToken: "" },
  };
  fs.writeFileSync(p, JSON.stringify(example, null, 2) + "\n");
  return p;
}

// ---------------------------------------------------------------------------------------------
// Two-level configuration (architecture §5.1, §5.2, §19; decision 0013).
// Server settings live in $ORCH_HOME/server.json; project settings in <repo>/orch.config.json.
// The daemon maps each project's pair onto a `Config` with toLegacyConfig() (its ProjectContext, §5).
// ---------------------------------------------------------------------------------------------

export interface AdapterConfig {
  type: string;
  command: string;
  extraArgs: string[];
  env: Record<string, string>;
}

export type ProjectRoleName = RoleName | "phaseValidator";

export type FeedbackConfig = Config["git"]["feedback"];

/** Settings a project may carry (and `server.json` may default under `defaults`). */
export interface ProjectConfig {
  /** Display name; defaults to the repo directory name. */
  name: string;
  baseBranch: string;
  scheduler: {
    maxParallel: number;
    maxAttempts: number;
    resumeOnRetry: boolean;
  };
  validation: {
    command: string;
    agent: boolean;
    phase: { enabled: boolean; command: string; maxFixups: number };
    ui: { startCommand: string; url: string; readyTimeoutSeconds: number; env: Record<string, string> };
  };
  git: {
    pr: boolean;
    mergePolicy: "auto" | "manual";
    squash: boolean;
    copyFiles: string[];
    setupCommand: string;
    tickTasksMd: boolean;
    feedback: FeedbackConfig;
  };
  handoff: Config["handoff"];
  /** Role → adapter + model. Adapters must be defined in server.json. */
  roles: Record<ProjectRoleName, RoleConfig>;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface ServerConfig {
  host: string;
  port: number;
  publicUrl: string;
  auth: { token: string; allowInsecure: boolean };
  notify: Config["notify"];
  agents: {
    timeoutMinutes: number;
    adapters: Record<string, AdapterConfig>;
    /** Default role mapping for every project. `phaseValidator` falls back to `validator`. */
    roles: Record<RoleName, RoleConfig> & { phaseValidator?: RoleConfig };
  };
  scheduler: {
    /** Max agent processes across all projects. */
    maxAgents: number;
    tickSeconds: number;
  };
  retention: { eventDays: number };
  git: { ghCommand: string };
  /** Project-key defaults applied under every project's own file (same shape as ProjectConfig). */
  defaults: DeepPartial<ProjectConfig>;
}

export const SERVER_CONFIG_FILENAME = "server.json";

/**
 * The Gemini CLI adapter was retired by T027 (decision 0024): Google ended its Google-account sign-in for
 * individuals on 2026-06-18. A server.json that still names it gets an upgrade error instead of a silent
 * remap (a wrong default would spend the owner's money without a decision).
 */
const RETIRED_ADAPTER_TYPE = "gemini";
const RETIRED_ADAPTER_MESSAGE = 'has type "gemini", retired in T027 (decision 0024); use type "antigravity" (command agy) or "codex", or remove it and point roles at claude';

/** Built-in server settings (§19), derived from `src/settings-schema.ts` (decision 0026). */
export const DEFAULT_SERVER_CONFIG: ServerConfig = buildDefaults("server");

/** Built-in project defaults (§19), derived from the schema. `name` and `roles` are filled per project at load time. */
export const DEFAULT_PROJECT_CONFIG: Omit<ProjectConfig, "name" | "roles"> = buildDefaults("project");

/** The pre-split single-file settings (legacy `orch.config.json`, §5.5): the typed defaults above joined into one `Config`. */
export const DEFAULT_CONFIG: Config = {
  repo: process.cwd(),
  baseBranch: DEFAULT_PROJECT_CONFIG.baseBranch,
  worktreeDir: path.join(process.cwd(), "..", "orch-worktrees"),
  dbPath: path.join(process.cwd(), ".orch", "orch.db"),
  host: DEFAULT_SERVER_CONFIG.host,
  port: DEFAULT_SERVER_CONFIG.port,
  publicUrl: DEFAULT_SERVER_CONFIG.publicUrl,
  auth: DEFAULT_SERVER_CONFIG.auth,
  agents: {
    timeoutMinutes: DEFAULT_SERVER_CONFIG.agents.timeoutMinutes,
    adapters: DEFAULT_SERVER_CONFIG.agents.adapters,
    roles: DEFAULT_SERVER_CONFIG.agents.roles as Config["agents"]["roles"],
  },
  scheduler: {
    maxParallel: DEFAULT_PROJECT_CONFIG.scheduler.maxParallel,
    tickSeconds: DEFAULT_SERVER_CONFIG.scheduler.tickSeconds,
    maxAttempts: DEFAULT_PROJECT_CONFIG.scheduler.maxAttempts,
    resumeOnRetry: DEFAULT_PROJECT_CONFIG.scheduler.resumeOnRetry,
  },
  validation: { command: DEFAULT_PROJECT_CONFIG.validation.command, agent: DEFAULT_PROJECT_CONFIG.validation.agent },
  git: {
    pr: DEFAULT_PROJECT_CONFIG.git.pr,
    mergePolicy: DEFAULT_PROJECT_CONFIG.git.mergePolicy,
    squash: DEFAULT_PROJECT_CONFIG.git.squash,
    copyFiles: DEFAULT_PROJECT_CONFIG.git.copyFiles,
    setupCommand: DEFAULT_PROJECT_CONFIG.git.setupCommand,
    tickTasksMd: DEFAULT_PROJECT_CONFIG.git.tickTasksMd,
    ghCommand: DEFAULT_SERVER_CONFIG.git.ghCommand,
    feedback: DEFAULT_PROJECT_CONFIG.git.feedback,
  },
  handoff: DEFAULT_PROJECT_CONFIG.handoff,
  notify: DEFAULT_SERVER_CONFIG.notify,
};

/**
 * Keys a project file may not set (§5.2): they change how agent CLIs launch, which credentials
 * they get, or where orch keeps its state. Any of them makes the project unusable until removed.
 */
export const FORBIDDEN_PROJECT_KEYS = [
  "agents", "host", "port", "publicUrl", "auth", "notify", "dbPath", "worktreeDir", "repo", "git.ghCommand",
] as const;

/** Allowed project keys. `true` = leaf (any value); an object = nested keys; `"map"` = free-form keys. */
type Schema = { [k: string]: true | "map" | Schema };
const ROLE_SCHEMA: Schema = { adapter: true, model: true };
const leaves = (o: object): Schema => Object.fromEntries(Object.keys(o).map((k) => [k, true]));
const PROJECT_SCHEMA: Schema = {
  name: true,
  baseBranch: true,
  scheduler: { maxParallel: true, maxAttempts: true, resumeOnRetry: true },
  validation: {
    command: true,
    agent: true,
    phase: { enabled: true, command: true, maxFixups: true },
    ui: { startCommand: true, url: true, readyTimeoutSeconds: true, env: "map" },
  },
  git: {
    pr: true, mergePolicy: true, squash: true, copyFiles: true, setupCommand: true, tickTasksMd: true,
    feedback: leaves(DEFAULT_CONFIG.git.feedback),
  },
  handoff: leaves(DEFAULT_CONFIG.handoff),
  roles: { planner: ROLE_SCHEMA, worker: ROLE_SCHEMA, validator: ROLE_SCHEMA, phaseValidator: ROLE_SCHEMA },
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => structuredClone(v);

/** Dotted paths of the forbidden keys present in `raw`. */
function forbiddenKeysIn(raw: Record<string, unknown>): string[] {
  return FORBIDDEN_PROJECT_KEYS.filter((k) => {
    const [head, tail] = k.split(".");
    if (!(head in raw)) return false;
    return tail === undefined || (isPlainObject(raw[head]) && tail in raw[head]);
  });
}

/** Throws, naming every server-only key found in `raw`. `where` labels the source file. */
function assertNoForbiddenKeys(raw: Record<string, unknown>, where: string, prefix = "") {
  const bad = forbiddenKeysIn(raw);
  if (bad.length === 0) return;
  const keys = bad.map((k) => `'${prefix}${k}'`).join(", ");
  const one = bad.length === 1;
  throw new Error(
    `${where}: ${keys} ${one ? "is a server setting and is" : "are server settings and are"} not allowed in project settings; ` +
    `set ${one ? "it" : "them"} in ${SERVER_CONFIG_FILENAME} instead (decision 0013)`,
  );
}

/** Copy of `raw` with only schema keys; every dropped key becomes a warning. */
function pickKnown(raw: Record<string, unknown>, schema: Schema, prefix: string, warnings: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = prefix + k;
    const s = schema[k];
    if (s === undefined) warnings.push(`unknown key '${key}' ignored`);
    else if (s === true) out[k] = v;
    else if (!isPlainObject(v)) warnings.push(`key '${key}' must be an object; ignored`);
    else out[k] = s === "map" ? v : pickKnown(v, s, key + ".", warnings);
  }
  return out;
}

function readJsonObject(p: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`${p}: ${(e as Error).message}`);
  }
  if (!isPlainObject(raw)) throw new Error(`${p}: expected a JSON object`);
  return raw;
}

/** Read `<home>/server.json` as a JSON object without applying defaults; a missing file is `{}`. */
export function readServerFile(home: string = orchHome()): Record<string, unknown> {
  const p = serverConfigPath(home);
  return fs.existsSync(p) ? readJsonObject(p) : {};
}

/**
 * Load `<home>/server.json` over the built-in server defaults; a missing file yields the defaults.
 * Throws if a role names an undefined adapter or `defaults` holds a server-only key.
 */
export function loadServerConfig(home: string = orchHome()): ServerConfig {
  return buildServerConfig(readServerFile(home), serverConfigPath(home));
}

/**
 * The rules of `loadServerConfig` applied to a settings document, so the dashboard can validate a candidate
 * before it writes it (T029). `where` labels the source in error messages.
 */
export function buildServerConfig(raw: Record<string, unknown>, where: string): ServerConfig {
  const p = where;
  if (raw.defaults !== undefined) {
    if (!isPlainObject(raw.defaults)) throw new Error(`${p}: 'defaults' must be an object`);
    assertNoForbiddenKeys(raw.defaults, p, "defaults.");
  }
  const cfg = clone(deepMerge(DEFAULT_SERVER_CONFIG, raw));
  cfg.auth = { token: resolveToken(cfg.auth.token), allowInsecure: cfg.auth.allowInsecure === true };
  for (const [name, a] of Object.entries(cfg.agents.adapters)) {
    if (a?.type === RETIRED_ADAPTER_TYPE) throw new Error(`${p}: agents.adapters.${name} ${RETIRED_ADAPTER_MESSAGE}`);
  }
  for (const [role, r] of Object.entries(cfg.agents.roles)) {
    if (r && !cfg.agents.adapters[r.adapter]) throw new Error(`${p}: agents.roles.${role}.adapter '${r.adapter}' is not defined in agents.adapters`);
  }
  return cfg;
}

/** `raw` merged over the built-in defaults, with no environment applied: what the settings file means. */
export function mergeServerDefaults(raw: Record<string, unknown>): ServerConfig {
  return clone(deepMerge(DEFAULT_SERVER_CONFIG, raw));
}

export interface LoadedProjectConfig {
  config: ProjectConfig;
  /** Unknown or malformed keys that were ignored (for the activity stream). */
  warnings: string[];
  /** The project settings file, or null if the repo has none. */
  path: string | null;
}

/**
 * Effective settings for the project at `repoPath` (§5.2). Precedence: the repo's orch.config.json
 * > server.json `defaults` > built-in defaults; roles start from server.json `agents.roles`, and
 * `phaseValidator` falls back to the effective `validator`. Throws on server-only keys (the message
 * names each) and on a role whose adapter server.json does not define. Unknown keys are ignored and
 * returned as warnings.
 */
export function loadProjectConfig(repoPath: string, server: ServerConfig): LoadedProjectConfig {
  const file = path.join(path.resolve(repoPath), CONFIG_FILENAME);
  const exists = fs.existsSync(file);
  return buildProjectConfig(repoPath, exists ? readJsonObject(file) : null, server);
}

/** Read `<repo>/orch.config.json` as a JSON object without applying defaults; a missing file is `{}`. */
export function readProjectFile(repoPath: string): Record<string, unknown> {
  const file = path.join(path.resolve(repoPath), CONFIG_FILENAME);
  return fs.existsSync(file) ? readJsonObject(file) : {};
}

/**
 * The rules of `loadProjectConfig` applied to a settings document (`null` = the repo has no file), so the
 * dashboard can validate a candidate before it writes it (T029).
 */
export function buildProjectConfig(repoPath: string, rawFile: Record<string, unknown> | null, server: ServerConfig): LoadedProjectConfig {
  const repo = path.resolve(repoPath);
  const file = path.join(repo, CONFIG_FILENAME);
  const warnings: string[] = [];

  const dw: string[] = [];
  const defaults = pickKnown(clone(server.defaults) as Record<string, unknown>, PROJECT_SCHEMA, "", dw);
  warnings.push(...dw.map((w) => `${SERVER_CONFIG_FILENAME} defaults: ${w}`));

  const exists = rawFile !== null;
  let own: Record<string, unknown> = {};
  if (rawFile) {
    assertNoForbiddenKeys(rawFile, file);
    const pw: string[] = [];
    own = pickKnown(rawFile, PROJECT_SCHEMA, "", pw);
    warnings.push(...pw.map((w) => `${CONFIG_FILENAME}: ${w}`));
  }

  const { phaseValidator: serverPhase, ...serverRoles } = server.agents.roles;
  const base = { ...clone(DEFAULT_PROJECT_CONFIG), name: path.basename(repo), roles: clone(serverRoles) as Partial<ProjectConfig["roles"]> };
  if (serverPhase) base.roles.phaseValidator = clone(serverPhase);
  const cfg = clone(deepMerge(deepMerge(base, defaults), own)) as ProjectConfig;
  if (!cfg.roles.phaseValidator) cfg.roles.phaseValidator = { ...cfg.roles.validator };

  for (const role of Object.keys(cfg.roles) as ProjectRoleName[]) {
    const adapter = cfg.roles[role]?.adapter;
    if (!adapter || !server.agents.adapters[adapter]) {
      throw new Error(`${exists ? file : repo}: roles.${role}.adapter '${adapter}' is not defined in ${SERVER_CONFIG_FILENAME} agents.adapters`);
    }
  }
  return { config: cfg, warnings, path: exists ? file : null };
}

/**
 * Write a settings file as 2-space JSON through a temp file and a rename, so a reader never sees half a file.
 * A new file is created owner-only (it may hold tokens); an existing file keeps its permissions.
 */
export function writeSettingsFile(file: string, doc: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* new file */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Write a starter orch.config.json into `repoPath` if it has none (§5.3). An existing file is
 * never touched; `created` says which happened.
 */
export function writeStarterProjectConfig(repoPath: string, opts: { baseBranch: string }): { path: string; created: boolean } {
  const p = path.join(path.resolve(repoPath), CONFIG_FILENAME);
  if (fs.existsSync(p)) return { path: p, created: false };
  const starter = { baseBranch: opts.baseBranch, validation: { command: "" } };
  fs.writeFileSync(p, JSON.stringify(starter, null, 2) + "\n", { flag: "wx" });
  return { path: p, created: true };
}

/**
 * A project's effective settings: the server + project pair as one `Config`, which the orchestrator
 * keeps per project (ProjectContext, §5). Worktrees and the DB live under ORCH_HOME (§5.1).
 */
export function toLegacyConfig(
  server: ServerConfig,
  project: ProjectConfig,
  repoPath: string,
  opts: { projectId?: string; home?: string } = {},
): Config {
  const repo = path.resolve(repoPath);
  const home = opts.home ?? orchHome();
  const id = opts.projectId ?? projectSlug(path.basename(repo));
  const role = (r: RoleConfig): RoleConfig => ({ adapter: r.adapter, model: r.model });
  return clone({
    repo,
    baseBranch: project.baseBranch,
    worktreeDir: worktreesDir(id, home),
    dbPath: dbPath(home),
    host: server.host,
    port: server.port,
    publicUrl: server.publicUrl,
    auth: { ...server.auth },
    agents: {
      timeoutMinutes: server.agents.timeoutMinutes,
      adapters: server.agents.adapters,
      roles: { planner: role(project.roles.planner), worker: role(project.roles.worker), validator: role(project.roles.validator) },
    },
    scheduler: {
      maxParallel: project.scheduler.maxParallel,
      tickSeconds: server.scheduler.tickSeconds,
      maxAttempts: project.scheduler.maxAttempts,
      resumeOnRetry: project.scheduler.resumeOnRetry,
    },
    validation: { command: project.validation.command, agent: project.validation.agent },
    git: {
      pr: project.git.pr,
      mergePolicy: project.git.mergePolicy,
      squash: project.git.squash,
      copyFiles: project.git.copyFiles,
      setupCommand: project.git.setupCommand,
      tickTasksMd: project.git.tickTasksMd,
      ghCommand: server.git.ghCommand,
      feedback: project.git.feedback,
    },
    handoff: project.handoff,
    notify: server.notify,
  });
}
