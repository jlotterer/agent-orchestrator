import fs from "node:fs";
import path from "node:path";

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

  agents: {
    /** Hard timeout for one agent invocation, minutes. */
    timeoutMinutes: number;
    /** Named adapter configurations. `type` picks the implementation (claude, gemini). */
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
  };

  handoff: {
    /** Max characters of the spec/plan excerpt given to each worker. */
    specChars: number;
    /** Max characters of prior-task summaries given to each worker. */
    historyChars: number;
    /** Files from the spec dir to include in worker context, in order. */
    contextFiles: string[];
  };

  notify: {
    /** ntfy topic URL, e.g. https://ntfy.sh/my-orch-topic. Empty = off. */
    ntfyUrl: string;
    /** Optional ntfy auth token. */
    ntfyToken: string;
  };
}

export const DEFAULT_CONFIG: Config = {
  repo: process.cwd(),
  baseBranch: "main",
  worktreeDir: path.join(process.cwd(), "..", "orch-worktrees"),
  dbPath: path.join(process.cwd(), ".orch", "orch.db"),
  host: "0.0.0.0",
  port: 4800,
  publicUrl: "http://localhost:4800",
  agents: {
    timeoutMinutes: 90,
    adapters: {
      claude: {
        type: "claude",
        command: "claude",
        // Headless runs need permissions resolved up front. Scope this down with
        // --allowedTools if you don't want full autonomy inside the worktree.
        extraArgs: ["--permission-mode", "bypassPermissions"],
        env: {},
      },
      gemini: {
        type: "gemini",
        command: "gemini",
        // --yolo: otherwise tools needing approval are silently denied (exit 0, nothing done).
        // --skip-trust: a fresh worktree is an untrusted folder; without this the CLI exits 55.
        extraArgs: ["--yolo", "--skip-trust"],
        env: {},
      },
    },
    roles: {
      planner: { adapter: "claude", model: "" },
      worker: { adapter: "claude", model: "" },
      validator: { adapter: "claude", model: "" },
    },
  },
  scheduler: {
    maxParallel: 1,
    tickSeconds: 5,
    maxAttempts: 2,
    resumeOnRetry: true,
  },
  validation: {
    command: "",
    agent: true,
  },
  git: {
    pr: true,
    mergePolicy: "auto",
    squash: true,
    copyFiles: [],
    setupCommand: "",
    tickTasksMd: true,
  },
  handoff: {
    specChars: 12000,
    historyChars: 6000,
    contextFiles: ["plan.md", "spec.md"],
  },
  notify: {
    ntfyUrl: "",
    ntfyToken: "",
  },
};

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
  if (!p) return { config: DEFAULT_CONFIG, path: null };
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
