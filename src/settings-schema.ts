/**
 * The one description of every setting (T029, decision 0026; architecture §19): key, scope, type, default,
 * description, form group, and whether it is a secret or needs a restart. Three things read it:
 *   - `src/config.ts` builds `DEFAULT_SERVER_CONFIG` and `DEFAULT_PROJECT_CONFIG` from it (`buildDefaults`),
 *   - the dashboard Settings tab renders its forms from `GET /api/settings/schema`,
 *   - `test/unit/settings.test.mjs` checks that the §19 table of docs/architecture.md names the same keys.
 * The loaders in `src/config.ts` stay the validators; the helpers here only check shape (known keys, types)
 * and merge a PUT body over the stored file. Pure: no file system, no clock.
 *
 * A key may carry a placeholder segment: `<name>` (any adapter name), `<role>` (planner, worker, validator,
 * phaseValidator) or a trailing `*` (any subtree, edited as raw JSON).
 */

export type SettingScope = "server" | "project";
export type SettingType = "string" | "int" | "bool" | "enum" | "list" | "map";

export interface SettingEntry {
  /** Dotted path in the settings file, e.g. `scheduler.maxAgents`. */
  key: string;
  scope: SettingScope;
  type: SettingType;
  /** Built-in default. Absent = none (the value is filled per project, or the setting is optional). */
  default?: unknown;
  /** Allowed values of an `enum`. */
  enum?: string[];
  /** Bounds of an `int`. */
  min?: number;
  max?: number;
  description: string;
  /** The form section the entry appears in. */
  group: string;
  /** Write-only: the API returns `{set: boolean}` and never the value. */
  secret?: boolean;
  /** A change is written at once but only takes effect after the daemon restarts. */
  restart?: boolean;
  /** Hidden in the form behind the Advanced toggle. */
  advanced?: boolean;
}

export const ROLE_NAMES = ["planner", "worker", "validator", "phaseValidator"] as const;

// Built-in adapters. Vendor names live here and in src/adapters/ only (scripts/check-invariants.mjs).
const DEFAULT_ADAPTERS = {
  claude: {
    type: "claude",
    command: "claude",
    // Headless runs need permissions resolved up front. Scope this down with
    // --allowedTools if you don't want full autonomy inside the worktree.
    extraArgs: ["--permission-mode", "bypassPermissions"],
    env: {},
  },
  antigravity: {
    type: "antigravity",
    command: "agy",
    // Auto-approves every tool call; without it a tool needing approval is soft-denied and the
    // run still exits 0 with nothing done. The worktree is the boundary (decision 0024).
    extraArgs: ["--dangerously-skip-permissions"],
    env: {},
  },
  codex: {
    type: "codex",
    command: "codex",
    // No approvals and no sandbox: orch's worktree is the boundary, as with the other adapters.
    extraArgs: ["--dangerously-bypass-approvals-and-sandbox"],
    env: {},
  },
};

const DEFAULT_ROLES = {
  planner: { adapter: "claude", model: "" },
  worker: { adapter: "claude", model: "" },
  validator: { adapter: "claude", model: "" },
};

type Extra = Partial<Pick<SettingEntry, "enum" | "min" | "max" | "secret" | "restart" | "advanced">>;
const server = (group: string, key: string, type: SettingType, def: unknown, description: string, extra: Extra = {}): SettingEntry =>
  ({ key, scope: "server", type, ...(def === undefined ? {} : { default: def }), description, group, ...extra });
const project = (group: string, key: string, type: SettingType, def: unknown, description: string, extra: Extra = {}): SettingEntry =>
  ({ key, scope: "project", type, ...(def === undefined ? {} : { default: def }), description, group, ...extra });

const ADV = { advanced: true } as const;

export const settingsSchema: readonly SettingEntry[] = [
  // ---- server.json: Server (read-only in the form; edit the file and restart) ----
  server("Server", "host", "string", "127.0.0.1", "Address the dashboard and API listen on. A non-local address needs an access token.", { restart: true }),
  server("Server", "port", "int", 4800, "Port the dashboard and API listen on.", { restart: true, min: 1, max: 65535 }),
  server("Server", "publicUrl", "string", "http://localhost:4800", "Public URL of the dashboard, used in notifications.", { restart: true }),
  server("Server", "auth.token", "string", "", "Access token. Empty = no authentication. Write-only; edit server.json to change it.", { secret: true, restart: true }),
  server("Server", "auth.allowInsecure", "bool", false, "Allow listening on a non-local address without a token.", { restart: true }),
  server("Server", "retention.eventDays", "int", 30, "Days after a run finishes before its event log is archived. 0 = never.", { restart: true, min: 0 }),

  // ---- server.json: Notifications ----
  server("Notifications", "notify.ntfyUrl", "string", "", "ntfy topic URL, for example https://ntfy.sh/my-orch-topic. Empty = notifications off."),
  server("Notifications", "notify.ntfyToken", "string", "", "ntfy access token, if the topic needs one. Write-only.", { secret: true }),

  // ---- server.json: Agents ----
  server("Agents", "agents.timeoutMinutes", "int", 90, "Hard timeout for one agent invocation, in minutes.", { min: 1 }),
  server("Agents", "agents.adapters.<name>", "map", DEFAULT_ADAPTERS, "A named agent CLI configuration. Projects pick adapters by name."),
  server("Agents", "agents.adapters.<name>.type", "string", undefined, "Which adapter implementation runs this CLI."),
  server("Agents", "agents.adapters.<name>.command", "string", undefined, "The CLI executable."),
  server("Agents", "agents.adapters.<name>.extraArgs", "list", undefined, "Extra arguments passed to the CLI on every run."),
  server("Agents", "agents.adapters.<name>.env", "map", undefined, "Environment variables for the CLI. Values are write-only.", { secret: true }),
  server("Agents", "agents.roles.<role>", "map", DEFAULT_ROLES, "Default adapter and model for a role. Different adapters per role give independent judgement."),
  server("Agents", "agents.roles.<role>.adapter", "string", undefined, "Key of an entry in agents.adapters."),
  server("Agents", "agents.roles.<role>.model", "string", undefined, "Model passed to the adapter. Empty = the CLI's default."),
  server("Agents", "scheduler.maxAgents", "int", 2, "Most agent processes running at once across all projects.", { min: 1 }),
  server("Agents", "scheduler.tickSeconds", "int", 5, "How often the scheduler ticks, in seconds.", { restart: true, min: 1 }),
  server("Agents", "git.ghCommand", "string", "gh", "The GitHub CLI executable."),
  server("Agents", "defaults.*", "map", {}, "Project settings applied under every project's own file (same shape as orch.config.json).", ADV),

  // ---- orch.config.json: Project ----
  project("Project", "name", "string", undefined, "Display name. Defaults to the repository directory name."),
  project("Project", "baseBranch", "string", "main", "Branch that tasks branch from and merge into."),

  // ---- orch.config.json: Scheduler ----
  project("Scheduler", "scheduler.maxParallel", "int", 1, "Most tasks of this project running at once. 1 = sequential.", { min: 1 }),
  project("Scheduler", "scheduler.maxAttempts", "int", 2, "Worker attempts before a task is marked failed.", { min: 1 }),
  project("Scheduler", "scheduler.resumeOnRetry", "bool", true, "On retry, resume the worker's previous session instead of starting fresh."),

  // ---- orch.config.json: Validation ----
  project("Validation", "validation.command", "string", "", "Gate command run in the worktree before the validator agent. Empty = skip."),
  project("Validation", "validation.agent", "bool", true, "Run the validator agent."),
  project("Validation", "validation.phase.enabled", "bool", true, "Validate each phase once all its tasks have merged."),
  project("Validation", "validation.phase.command", "string", "", "Gate command for phase validation. Empty = skip."),
  project("Validation", "validation.phase.maxFixups", "int", 2, "Fix-up rounds after a failed phase check, before it goes to the inbox.", { min: 0 }),
  project("Validation", "validation.ui.startCommand", "string", "", "Command that starts the app under test, for tasks validated in UI mode."),
  project("Validation", "validation.ui.url", "string", "http://127.0.0.1:{port}/", "URL the validator opens; {port} is replaced with a free port."),
  project("Validation", "validation.ui.readyTimeoutSeconds", "int", 120, "Seconds to wait for the app to answer.", { min: 1 }),
  project("Validation", "validation.ui.env", "map", {}, "Environment variables for the app under test."),

  // ---- orch.config.json: Git ----
  project("Git", "git.pr", "bool", true, "Open pull requests with gh. Off = merge locally with git."),
  project("Git", "git.mergePolicy", "enum", "auto", "Default merge policy for tasks.", { enum: ["auto", "manual"] }),
  project("Git", "git.squash", "bool", true, "Squash on merge."),
  project("Git", "git.copyFiles", "list", [], "Files copied from the repository root into every new worktree, for example .env."),
  project("Git", "git.setupCommand", "string", "", "Command run in a fresh worktree after creation, for example npm ci."),
  project("Git", "git.tickTasksMd", "bool", true, "After a task merges, tick it in the spec's tasks.md."),
  project("Git", "git.feedback.enabled", "bool", true, "Watch open pull requests for CI results and review comments.", ADV),
  project("Git", "git.feedback.waitForChecks", "bool", true, "Auto-merge tasks wait for the pull request's checks to pass.", ADV),
  project("Git", "git.feedback.pollSeconds", "int", 60, "How often each open pull request is polled, in seconds.", { ...ADV, min: 1 }),
  project("Git", "git.feedback.maxRounds", "int", 3, "Fix rounds per task driven by CI failures or review comments.", { ...ADV, min: 0 }),
  project("Git", "git.feedback.checksTimeoutMinutes", "int", 60, "Checks pending longer than this send the task to the inbox.", { ...ADV, min: 1 }),
  project("Git", "git.feedback.noChecksGraceSeconds", "int", 90, "Seconds to wait after a push before treating a pull request with no checks as having no CI.", { ...ADV, min: 0 }),
  project("Git", "git.feedback.trigger", "string", "/orch", "A comment line starting with this sends review feedback to the worker. Empty = only 'changes requested' reviews.", ADV),
  project("Git", "git.feedback.ignoreAuthors", "list", [], "Comment authors whose comments never trigger a round.", ADV),
  project("Git", "git.feedback.logChars", "int", 6000, "Most characters of a failed CI log passed to the worker.", { ...ADV, min: 1 }),

  // ---- orch.config.json: Roles ----
  project("Roles", "roles.<role>.adapter", "string", undefined, "Adapter for this role. Must be defined in the server's agents.adapters. Empty = the server default."),
  project("Roles", "roles.<role>.model", "string", undefined, "Model for this role. Empty = the CLI's default."),

  // ---- orch.config.json: Handoff (advanced) ----
  project("Handoff", "handoff.specChars", "int", 12000, "Most characters of each spec file given to a worker without a brief.", { ...ADV, min: 1 }),
  project("Handoff", "handoff.historyChars", "int", 6000, "Most characters of earlier task summaries, decisions and answers given to each worker.", { ...ADV, min: 1 }),
  project("Handoff", "handoff.contextFiles", "list", ["spec.md", "data-model.md", "plan.md"], "Spec files that come first, in this order, when a task has no brief.", ADV),
  project("Handoff", "handoff.briefChars", "int", 8000, "Most characters of a task's brief.", { ...ADV, min: 1 }),
  project("Handoff", "handoff.reqChars", "int", 4000, "Most characters of the requirement rows a brief cites.", { ...ADV, min: 1 }),
  project("Handoff", "handoff.contractChars", "int", 6000, "Most characters of each contract a brief names.", { ...ADV, min: 1 }),
  project("Handoff", "handoff.rulesChars", "int", 6000, "Most characters of each project rules file.", { ...ADV, min: 1 }),
  project("Handoff", "handoff.requirementsFile", "string", "docs/requirements.md", "The project's requirements file, relative to the repository.", ADV),
  project("Handoff", "handoff.projectFiles", "list", ["AGENTS.md"], "Project rules files, relative to the repository, given to every agent when present.", ADV),
];

/** Entries of one scope, in schema order. */
export const entriesOf = (scope: SettingScope): SettingEntry[] => settingsSchema.filter((e) => e.scope === scope);

// ---------------------------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------------------------

export const isPlain = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const isPlaceholder = (seg: string) => seg === "*" || /^<[a-z]+>$/.test(seg);

/** The built-in settings of one scope as a nested object (a fresh copy on every call). */
export function buildDefaults(scope: SettingScope): any {
  const out: Record<string, any> = {};
  for (const e of entriesOf(scope)) {
    if (e.default === undefined) continue;
    const segs = e.key.split(".");
    if (isPlaceholder(segs[segs.length - 1])) segs.pop(); // `agents.adapters.<name>` holds the whole record
    let node = out;
    for (const s of segs.slice(0, -1)) node = (node[s] ??= {});
    node[segs[segs.length - 1]] = structuredClone(e.default);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/** Whether `path` names the entry `key` ("exact") or a parent of it ("prefix"); placeholders match one segment. */
function matchKey(key: string, path: string): "exact" | "prefix" | null {
  const k = key.split("."), p = path.split(".");
  for (let i = 0; i < p.length; i++) {
    if (i >= k.length) return null;
    if (k[i] === "*") return "exact";
    if (k[i] === "<role>") { if (!(ROLE_NAMES as readonly string[]).includes(p[i])) return null; }
    else if (!isPlaceholder(k[i]) && k[i] !== p[i]) return null;
  }
  return p.length === k.length ? "exact" : "prefix";
}

export type PathKind = "leaf" | "map" | "group" | "unknown";

/** What a dotted path in a settings document is: a value, a free-form map, a group of entries, or not in the schema. */
export function classify(scope: SettingScope, path: string): { kind: PathKind; entry?: SettingEntry } {
  const entries = entriesOf(scope);
  let group = false;
  for (const e of entries) {
    if (e.key.endsWith(".*")) {
      const root = e.key.slice(0, -2);
      if (path === root || path.startsWith(root + ".")) return { kind: "map", entry: e };
      continue;
    }
    const m = matchKey(e.key, path);
    if (m === "exact") {
      if (entries.some((o) => o !== e && o.key.startsWith(e.key + "."))) group = true; // a record with field entries
      else return { kind: e.type === "map" ? "map" : "leaf", entry: e };
    } else if (m === "prefix") group = true;
  }
  return group ? { kind: "group" } : { kind: "unknown" };
}

/** Entries whose key has no placeholder: the ones a form shows as a single field. */
export const isPlainKey = (e: SettingEntry) => !e.key.split(".").some(isPlaceholder);

/** Value at a dotted path, or undefined. */
export function getPath(obj: unknown, path: string): unknown {
  let node: any = obj;
  for (const s of path.split(".")) {
    if (!isPlain(node)) return undefined;
    node = node[s];
  }
  return node;
}

// ---------------------------------------------------------------------------------------------
// Checking a document
// ---------------------------------------------------------------------------------------------

/** Error for one value against its entry, or null. */
function checkValue(path: string, v: unknown, e: SettingEntry): string | null {
  switch (e.type) {
    case "string": return typeof v === "string" ? null : `${path} must be a string`;
    case "bool": return typeof v === "boolean" ? null : `${path} must be true or false`;
    case "int":
      if (typeof v !== "number" || !Number.isInteger(v)) return `${path} must be a whole number`;
      if (e.min !== undefined && v < e.min) return `${path} must be at least ${e.min}`;
      if (e.max !== undefined && v > e.max) return `${path} must be at most ${e.max}`;
      return null;
    case "enum": return typeof v === "string" && (e.enum ?? []).includes(v) ? null : `${path} must be one of ${(e.enum ?? []).join(", ")}`;
    case "list": return Array.isArray(v) && v.every((x) => typeof x === "string") ? null : `${path} must be a list of strings`;
    case "map":
      if (!isPlain(v)) return `${path} must be an object`;
      if (e.key.endsWith(".env") && !Object.values(v).every((x) => typeof x === "string")) return `${path} values must be strings`;
      return null;
  }
}

/**
 * Problems in `doc` against the schema of `scope`. `strict` (server settings) reports a key outside the schema;
 * project documents may carry unknown keys, which the loader ignores with a warning. `null` values are delete
 * markers of a PUT patch and are not checked.
 */
export function checkSettings(scope: SettingScope, doc: unknown, opts: { strict: boolean }): string[] {
  const problems: string[] = [];
  if (!isPlain(doc)) return ["settings must be a JSON object"];
  const walk = (node: Record<string, any>, prefix: string) => {
    for (const [k, v] of Object.entries(node)) {
      const path = prefix + k;
      if (v === null) continue;
      const c = classify(scope, path);
      if (c.kind === "unknown") { if (opts.strict) problems.push(`'${path}' is not a ${scope} setting`); continue; }
      if (c.kind === "group") {
        if (!isPlain(v)) problems.push(`${path} must be an object`);
        else walk(v, path + ".");
      } else {
        const msg = checkValue(path, v, c.entry!);
        if (msg) problems.push(msg);
      }
    }
  };
  walk(doc, "");
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Secrets: mask on read, merge on write
// ---------------------------------------------------------------------------------------------

/** A masked secret as the API returns it, and as a PUT body may send it back to mean "keep". */
export interface Masked { set: boolean }
export const isMasked = (v: unknown): v is Masked => isPlain(v) && Object.keys(v).length === 1 && typeof v.set === "boolean";

/** Copy of a server settings object with every secret replaced by `{set}`: the token, the ntfy token and each adapter env value. */
export function maskServerSettings(settings: any): any {
  const out = structuredClone(settings);
  const mask = (o: any, k: string) => { if (isPlain(o) && k in o) o[k] = { set: typeof o[k] === "string" && o[k] !== "" }; };
  mask(out.auth, "token");
  mask(out.notify, "ntfyToken");
  for (const a of Object.values<any>(out.agents?.adapters ?? {})) {
    if (isPlain(a?.env)) for (const k of Object.keys(a.env)) a.env[k] = { set: typeof a.env[k] === "string" && a.env[k] !== "" };
  }
  return out;
}

/**
 * Resolve the masked values of a PUT patch against the stored file: `{set}` (or an omitted secret) keeps the
 * stored value; a string replaces it. An env map in the patch replaces the stored one, so a key left out is removed.
 */
export function resolveSecrets(patch: any, stored: any): any {
  const out = structuredClone(patch);
  for (const [group, key] of [["auth", "token"], ["notify", "ntfyToken"]] as const) {
    if (isPlain(out[group]) && isMasked(out[group][key])) delete out[group][key];
  }
  for (const [name, a] of Object.entries<any>(out.agents?.adapters ?? {})) {
    if (!isPlain(a) || !isPlain(a.env)) continue;
    const old = getPath(stored, `agents.adapters.${name}.env`);
    const env: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(a.env)) {
      if (isMasked(v)) { if (isPlain(old) && typeof old[k] === "string") env[k] = old[k]; } // masked: keep, or drop an unknown key
      else if (v !== null) env[k] = v;
    }
    a.env = env;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------------------------

/**
 * JSON merge patch (RFC 7386) over `base`, schema-aware: arrays and free-form maps are replaced whole,
 * objects merge key by key, and `null` removes a key.
 */
export function applyPatch(scope: SettingScope, base: any, patch: any, prefix = ""): any {
  const out: Record<string, any> = isPlain(base) ? { ...base } : {};
  for (const [k, v] of Object.entries<any>(patch)) {
    const path = prefix + k;
    if (v === null) { delete out[k]; continue; }
    const wholesale = !isPlain(v) || classify(scope, path).kind === "map";
    out[k] = wholesale ? structuredClone(v) : applyPatch(scope, out[k], v, path + ".");
  }
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * `doc` without the values that equal the built-in default, unless the stored file already had the key.
 * Saving a form then writes what the owner changed, not a copy of every default (which would pin them).
 */
export function pruneDefaults(doc: any, defaults: any, stored: any): any {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries<any>(doc)) {
    const d = isPlain(defaults) ? defaults[k] : undefined, s = isPlain(stored) ? stored[k] : undefined;
    if (isPlain(v)) {
      const sub = pruneDefaults(v, d, s);
      if (Object.keys(sub).length > 0 || s !== undefined) out[k] = sub;
    } else if (s !== undefined || !same(v, d)) out[k] = v;
  }
  return out;
}

/** Keys of the entries with `restart: true` whose value differs between two settings documents (merged over the defaults). */
export function restartKeysChanged(scope: SettingScope, before: any, after: any): string[] {
  return entriesOf(scope).filter((e) => e.restart && isPlainKey(e) && !same(getPath(before, e.key), getPath(after, e.key))).map((e) => e.key);
}
