import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Config, ProjectConfig, ServerConfig } from "./config.js";
import { loadProjectConfig, toLegacyConfig, DEFAULT_PROJECT_CONFIG } from "./config.js";
import type { Store } from "./db.js";
import { Git, sh, shell } from "./git.js";
import { runAgent, getAdapter } from "./adapters/index.js";
import type { RoleName, RoleConfig } from "./config.js";
import { loadPrompt, render, clip, PKG_ROOT } from "./prompts.js";
import { notify, type NotifyOptions } from "./notify.js";
import { readSpecDir, importFeature, markTaskDoneInFile, type SpecDir } from "./speckit.js";
import { DEFAULT_BRIEF_CHARS, earlierPhaseKeys, parseBrief, parseFrontmatter, type Conflict, type FeatureTask, type Problem } from "./core/brief.js";
import { assembleSpecContext, extractReqRows, resolveContracts, cutDecision, type ContextBudgets, type ContextCut, type NamedText, type SpecContextInput } from "./core/context.js";
import type { Decision, Phase, Project, Question, Run, Task, TaskStatus } from "./types.js";
import { newPhaseRows, phaseName, phaseLabel, phasesToValidate, planFixup, type PhaseVerdict } from "./core/phases.js";
import { formatReviewFeedback, formatCiFeedback } from "./prfeedback.js";
import { selectReady } from "./core/readiness.js";
import { ownedOverlap, outOfScope } from "./core/ownership.js";
import { findCycle } from "./core/graph.js";
import { nextTaskState, type TaskEvent, type TransitionResult, type Effect } from "./core/transitions.js";
import { decidePrAction } from "./core/prpoll.js";
import { UNFINISHED_RUN_STATUSES, resolveProjectForCwd, registerProject, archiveProject, type RegisterResult } from "./projects.js";
import { orchHome, runDir } from "./paths.js";
import { startApp, killLeftovers, AppStartError, APP_OUTPUT_CHARS, type AppProcess } from "./appserver.js";
import { addRunUsage, addTaskUsage, projectTotals, runTotals } from "./costs.js";

/** What `orch plan --dry-run` prints (§6.3, §6.4). */
export interface PlanPreview {
  dir: string;
  title: string;
  tasks: FeatureTask[];
  hasBriefs: boolean;
  conflicts: Conflict[];
  problems: Problem[];
  cycle: string[] | null;
}

const FINISHED: TaskStatus[] = ["done", "skipped"];
const ACTIVE: TaskStatus[] = ["running", "validating"];
/** Tasks with an open PR that the feedback loop watches. */
const WATCHED: TaskStatus[] = ["pr_checks", "pr_open"];
/** Effects that can fail and must succeed before the transition is applied (§8: failure → T9). */
const MERGE_EFFECTS: Effect[] = ["merge_local", "push_and_pr", "merge_pr"];
const nowIso = () => new Date().toISOString();
/** One folder-check problem as the CLI prints it: `tasks/T001.md:12 unresolved marker "TBD"`. */
const problemLine = (p: Problem) => `${p.file}:${p.line} ${p.message}`;
/** `{{plan_scope}}` of prompts/planner.md: which tasks the planner sees and why (§6.2). */
const PLAN_SCOPE = {
  review: "This is a review of the whole plan (`orch plan --review`). Every task of the feature is below, including the ones planned from their briefs.",
  subset: "Only the tasks below need planning: they have no brief with acceptance criteria. The feature's other tasks are planned from their briefs (`tasks/<key>.md` in the spec files above); do not return them.",
};
type FixRoundKind = "ci" | "review" | "human";

/** An error the HTTP layer answers with 404 (e.g. a diff whose worktree is gone). */
export class NotFoundError extends Error { readonly status = 404; }

interface ApplyOptions {
  /** Merge-effect failure: send `merge_failed` (T9, default) or throw to the caller (T15: stay, surface the error). */
  onEffectError?: "merge_failed" | "throw";
  /** Replaces the notification body the core proposes (e.g. the open questions). */
  notifyBody?: string;
  /** Branch head computed before `validated`; recorded as `pr_head` by `push_and_pr`. */
  sha?: string | null;
}

/** Runs the scheduler no longer acts on (§7.4). A project's newest run outside these is its current run. */
const CLOSED_RUN: ReadonlySet<string> = new Set(["done", "stopped", "failed"]);

/**
 * Everything run-scoped code needs about one project (decision 0011): its effective settings
 * (server.json + the repo's orch.config.json, §5.2) as a `Config`, and a `Git` bound to its repo.
 * Rebuilt when a run is created or started (REQ-PROJ-06), never mid-run.
 */
export interface ProjectContext {
  project: Project;
  cfg: Config;
  git: Git;
  /** Phase validation settings (`validation.phase`, §10.3) and the phase validator's role (defaults to the validator's). */
  phase: { enabled: boolean; command: string; maxFixups: number; role: RoleConfig };
  /** UI validation mode settings (`validation.ui`, §10.4). */
  ui: ProjectConfig["validation"]["ui"];
  /** Unknown settings keys that were ignored; logged to the run's activity when the context is rebuilt. */
  warnings: string[];
}

export class Orchestrator extends EventEmitter {
  private procs = new Map<string, ChildProcess>(); // task id -> running agent
  /** Apps under test of UI-mode validations, by task id (§10.4). Stopped in `finally`, on stop and on shutdown. */
  private apps = new Map<string, AppProcess>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private contexts = new Map<string, ProjectContext>();
  /** Per-project merge locks: operations on one repo's main checkout are serialized (§11). */
  private mergeChains = new Map<string, Promise<unknown>>();
  /** Agents not tied to a task row (planners; phase validators from TASK-15). They use global slots (§7.1). */
  private busyAgents = 0;
  /** Last context error per project, so the tick reports each distinct one once. */
  private contextErrors = new Map<string, string>();
  readonly home: string;

  constructor(public server: ServerConfig, public store: Store, opts: { home?: string } = {}) {
    super();
    this.home = opts.home ?? orchHome();
  }

  // ------------------------------------------------------------------ projects (§5)
  /** Build a project's context from its registry row and settings files. Throws if the repo is missing or the settings are invalid. */
  private buildContext(project: Project): ProjectContext {
    if (!fs.existsSync(project.repo_path)) throw new Error(`project '${project.id}': repository ${project.repo_path} does not exist`);
    let loaded;
    try {
      loaded = loadProjectConfig(project.repo_path, this.server);
    } catch (e: any) {
      throw new Error(`project '${project.id}': ${e?.message ?? e}`);
    }
    const cfg = toLegacyConfig(this.server, loaded.config, project.repo_path, { projectId: project.id, home: this.home });
    const ph = loaded.config.validation.phase;
    const role = loaded.config.roles.phaseValidator ?? loaded.config.roles.validator;
    return {
      project, cfg, git: new Git(cfg.repo, cfg.baseBranch, cfg.git.ghCommand), warnings: loaded.warnings,
      phase: { enabled: ph.enabled, command: ph.command, maxFixups: ph.maxFixups, role: { adapter: role.adapter, model: role.model } },
      ui: loaded.config.validation.ui,
    };
  }
  /** Re-read the project's settings (at run creation and start, REQ-PROJ-06). */
  refreshContext(projectId: string): ProjectContext {
    const project = this.store.getProject(projectId);
    if (!project) throw new NotFoundError(`no project '${projectId}'`);
    const ctx = this.buildContext(project);
    this.contexts.set(projectId, ctx);
    this.contextErrors.delete(projectId);
    return ctx;
  }
  /** The project's context, built on first use (e.g. a run that was running when the daemon restarted). */
  context(projectId: string): ProjectContext {
    return this.contexts.get(projectId) ?? this.refreshContext(projectId);
  }
  private ctxOf(run: Run): ProjectContext {
    if (!run.project_id) throw new Error(`run ${run.id} belongs to no project`);
    return this.context(run.project_id);
  }
  /** Legacy single-project routes act on the first non-archived project (by name, then id). */
  defaultProject(): Project | undefined {
    return this.store.listProjects()[0];
  }
  private requireDefaultProject(): Project {
    const p = this.defaultProject();
    if (!p) throw new Error("no projects registered");
    return p;
  }
  /** Project for a spec dir: the registered repo containing it (deepest match), else the default project. */
  projectForPath(p: string): Project | undefined {
    return resolveProjectForCwd(this.store.listProjects(), p) ?? this.defaultProject();
  }
  /** The run the scheduler acts on for a project: its newest run that is not done, stopped or failed. */
  currentRun(projectId: string): Run | undefined {
    return this.store.listRuns(projectId).find((r) => !CLOSED_RUN.has(r.status));
  }
  /** REQ-PROJ-07: the project's unfinished run other than `exceptRunId`, if any. */
  private unfinishedRun(projectId: string, exceptRunId?: string): Run | undefined {
    return this.store.listRuns(projectId).find((r) => r.id !== exceptRunId && UNFINISHED_RUN_STATUSES.includes(r.status));
  }
  private refusal(projectId: string, open: Run): Error {
    return new Error(`project '${projectId}' already has an unfinished run ${open.id} (${open.status}, "${open.title}"); finish or stop it first`);
  }
  /** The project's id, or 404. */
  private requireProject(projectId: string): Project {
    const p = this.store.getProject(projectId);
    if (!p) throw new NotFoundError(`no project '${projectId}'`);
    return p;
  }
  /** Register a repo (REQ-PROJ-01, -02, -04 re-registration). Errors from the registry are 400s. */
  async addProject(repoPath: string, opts: { name?: string } = {}): Promise<RegisterResult> {
    const r = await registerProject(this.store, repoPath, opts);
    this.contexts.delete(r.project.id);
    this.contextErrors.delete(r.project.id);
    this.changed("projects", { projectId: r.project.id });
    return r;
  }
  /** Archive a project (REQ-PROJ-04): refused while it has an unfinished run; rows and repo are kept. */
  archiveProject(projectId: string): Project {
    this.requireProject(projectId);
    const p = archiveProject(this.store, projectId);
    this.contexts.delete(projectId);
    this.contextErrors.delete(projectId);
    this.changed("projects", { projectId });
    return p;
  }

  // ------------------------------------------------------------------ helpers
  private log(run: Run | string, task: Task | null, kind: string, data: any) {
    const runId = typeof run === "string" ? run : run.id;
    const ev = this.store.addEvent(runId, task?.id ?? null, kind, data);
    this.emit("event", ev);
    return ev;
  }
  /** SSE `change` payload; always carries the `projectId` it concerns when one can be found (§15.1). */
  private changed(what: string, data: any = {}) {
    let projectId: string | null | undefined = data.projectId ?? data.run?.project_id;
    if (projectId === undefined) {
      const runId: string | undefined = data.runId ?? data.decision?.run_id;
      if (runId) projectId = this.store.getRun(runId)?.project_id;
    }
    this.emit("change", { what, ...data, projectId: projectId ?? null });
  }
  private decide(run: Run, task: Task | null, actor: string, text: string, rationale: string | null) {
    const d = this.store.addDecision(run.id, task?.id ?? null, actor, text, rationale);
    this.log(run, task, "decision", { actor, text, rationale });
    this.changed("decision", { decision: d });
    return d;
  }
  /** ntfy notification; the title names the project (REQ-HITL-02). */
  private notify(ctx: ProjectContext, title: string, message: string, opts: NotifyOptions = {}) {
    return notify(this.server, title, message, { ...opts, project: ctx.project.name });
  }
  private taskEnv(task: Task, actor: "worker" | "validator" = "worker") {
    // Put the `orch` CLI on the agent's PATH so `orch decide` / `orch ask` work without a global install.
    const PATH = `${path.join(PKG_ROOT, "bin")}${path.delimiter}${process.env.PATH ?? ""}`;
    return { ...this.apiEnv(), ORCH_TASK_ID: task.id, ORCH_RUN_ID: task.run_id, ORCH_ACTOR: actor, PATH };
  }
  /** How an agent's `orch` CLI reaches this daemon. The token goes in the env only, never in a prompt (§16). */
  private apiEnv(): Record<string, string> {
    const env: Record<string, string> = { ORCH_URL: `http://127.0.0.1:${this.server.port}` };
    if (this.server.auth.token) env.ORCH_TOKEN = this.server.auth.token;
    return env;
  }
  /** Adapter + model for a role from the project's effective config (a project may pick among the server's adapters). */
  private roleAgent(cfg: Config, role: RoleName) {
    return this.agentFor(cfg, cfg.agents.roles[role]);
  }
  private agentFor(cfg: Config, r: RoleConfig) {
    const adapterConfig = cfg.agents.adapters[r.adapter];
    return { adapter: getAdapter(adapterConfig.type), adapterConfig, model: r.model || undefined, timeoutMs: cfg.agents.timeoutMinutes * 60_000, label: `${adapterConfig.type}${r.model ? ":" + r.model : ""}` };
  }
  // ------------------------------------------------------------------ spec context (§6.4, §9; REQ-WORK-09/10/11)
  private budgets(cfg: Config): ContextBudgets {
    const h = cfg.handoff;
    return { briefChars: h.briefChars, reqChars: h.reqChars, contractChars: h.contractChars, rulesChars: h.rulesChars, specChars: h.specChars };
  }
  /** A file of the project repo as committed on the base branch; null when it does not exist there. */
  private async readAtBase(cfg: Config, rel: string): Promise<string | null> {
    const p = rel.replace(/\\/g, "/").replace(/^\.\//, "");
    const r = await sh("git", ["show", `${cfg.baseBranch}:${p}`], cfg.repo);
    return r.code === 0 ? r.stdout : null;
  }
  /** The project rules files (`handoff.projectFiles`) that exist on the base branch; absent ones are skipped (REQ-WORK-11). */
  private async projectRules(cfg: Config): Promise<NamedText[]> {
    const out: NamedText[] = [];
    for (const name of cfg.handoff.projectFiles) {
      const text = await this.readAtBase(cfg, name);
      if (text !== null) out.push({ name, text });
    }
    return out;
  }
  /** The feature folder of a run, or an empty one when it is gone (the run still works without spec context). */
  private specFolder(run: Run): SpecDir {
    try { return readSpecDir(run.spec_dir); } catch { return { dir: run.spec_dir, title: run.title, files: {} }; }
  }
  /**
   * The spec context of a task's worker and task validator (REQ-WORK-09/10, REQ-VAL-10): with a brief, the brief,
   * the requirement rows it cites, its contracts and the rules; without, the spec files and the rules. One decision
   * per cut (deduplicated, since every attempt and every validator builds the same context).
   */
  private async taskSpecContext(cfg: Config, run: Run, task: Task): Promise<string> {
    const files = this.specFolder(run).files;
    const briefName = `tasks/${task.key}.md`;
    const briefText = task.synthetic ? undefined : files[briefName];
    const brief = briefText !== undefined ? parseBrief(task.key, briefText) : null;
    const rules = await this.projectRules(cfg);
    let input: SpecContextInput;
    if (brief?.supported) {
      const reqFile = cfg.handoff.requirementsFile;
      const reqRows = brief.cites.length ? extractReqRows({ name: reqFile, text: (await this.readAtBase(cfg, reqFile)) ?? "" }, brief.cites) : null;
      const contracts = brief.contracts ? resolveContracts({ files }, brief.contracts.map((c) => c.name), briefName).contracts : [];
      input = { brief: { name: briefName, text: briefText! }, reqRows, contracts, rules };
    } else {
      input = { specFiles: files, contextFiles: cfg.handoff.contextFiles, rules };
    }
    return this.sectionedContext(run, task, task.key, input, cfg);
  }
  /**
   * `assembleSpecContext` with a `## ` heading per group (Brief, Requirements covered, Contracts, Project rules, or
   * Project context for a task without a brief). Each group is the assembler's own output for that group, so budgets,
   * headers and cut markers are exactly the core's; the cuts come from one call over the whole input.
   */
  private sectionedContext(run: Run, task: Task | null, label: string, input: SpecContextInput, cfg: Config): string {
    const B = this.budgets(cfg);
    this.recordCuts(run, task, label, assembleSpecContext(input, B).cuts);
    const out: string[] = [];
    const section = (heading: string, text: string) => { if (text) out.push(`## ${heading}\n${text}`); };
    if (input.brief) {
      const brief = assembleSpecContext({ brief: input.brief }, B).text;
      const after = (extra: SpecContextInput) => assembleSpecContext({ brief: input.brief, ...extra }, B).text.slice(brief.length + 2);
      section("Brief", brief);
      section("Requirements covered", after({ reqRows: input.reqRows }));
      section("Contracts", after({ contracts: input.contracts }));
    } else {
      section("Project context (from the spec)", assembleSpecContext({ specFiles: input.specFiles, contextFiles: input.contextFiles }, B).text);
    }
    section("Project rules", assembleSpecContext({ rules: input.rules }, B).text);
    return out.join("\n\n");
  }
  /** One decision per context cut, naming the task (or phase), part and size; a cut already recorded is not repeated. */
  private recordCuts(run: Run, task: Task | null, label: string, cuts: ContextCut[]) {
    if (!cuts.length) return;
    const seen = new Set(this.store.listDecisions(run.id).map((d) => d.text));
    for (const c of cuts) {
      const text = cutDecision(label, c);
      if (!seen.has(text)) { seen.add(text); this.decide(run, task, "orchestrator", text, null); }
    }
  }
  private bullets(items: string[]): string {
    return items.length ? items.map((a) => `- ${a}`).join("\n") : "- (none given; use the task description)";
  }
  private deadlineGuard(run: Run) {
    const r = this.store.getRun(run.id);
    return r && r.status === "running";
  }

  // ------------------------------------------------------------------ state machine shell (§8)
  /** Ask the pure state machine what `event` does to the task's current (stored) state. */
  private transition(taskId: string, event: TaskEvent): { task: Task; result: TransitionResult } {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("task not found");
    const run = this.store.getRun(task.run_id);
    if (!run) throw new Error("run not found");
    // A project whose settings cannot be loaded still gets state-only transitions (e.g. reset on restart) with built-in git defaults.
    let gitCfg: Config["git"] | typeof DEFAULT_PROJECT_CONFIG.git = DEFAULT_PROJECT_CONFIG.git;
    try { gitCfg = this.ctxOf(run).cfg.git; } catch { /* effects that need the project fail later with the reason */ }
    const fb = gitCfg.feedback;
    const result = nextTaskState(task, event, { pr: gitCfg.pr, feedback: { enabled: fb.enabled, waitForChecks: fb.waitForChecks, maxRounds: fb.maxRounds } });
    return { task, result };
  }

  /**
   * Decide and apply a transition: merge effects first (a failure becomes `merge_failed`, T9),
   * then the patch, decision and change event (synchronously when there are no merge effects),
   * then the remaining effects and the notification. Returns the applied result (or the rejection).
   */
  private async fire(run: Run, taskId: string, event: TaskEvent, opts: ApplyOptions = {}): Promise<TransitionResult> {
    const { task, result } = this.transition(taskId, event);
    if (!result.rejected) await this.applyTransition(run, task, result, opts);
    return result;
  }

  private async applyTransition(run: Run, task: Task, r: TransitionResult, opts: ApplyOptions = {}): Promise<TransitionResult> {
    const effects = r.effect ?? [];
    try {
      for (const e of effects) if (MERGE_EFFECTS.includes(e)) await this.performEffect(run, task, e, opts);
    } catch (e: any) {
      const error = e?.message ?? String(e);
      this.log(run, task, "error", { message: error });
      if (opts.onEffectError === "throw") throw e;
      const failed = this.transition(task.id, { type: "merge_failed", error });
      if (failed.result.rejected) return failed.result;
      return this.applyTransition(run, failed.task, failed.result);
    }

    const before = task.status;
    if (before !== r.status || r.patch) {
      this.store.updateTask(task.id, { status: r.status, ...(r.patch ?? {}) });
      this.changed("tasks", { runId: run.id });
    }
    if (r.decision) this.decide(run, task, r.decision.actor, r.decision.text, r.decision.rationale);
    if (r.status === "pr_open" && r.patch?.last_feedback) {
      this.log(run, task, "state", { message: "needs a human", feedback: clip(r.patch.last_feedback, 2000) });
    }

    for (const e of effects) if (!MERGE_EFFECTS.includes(e)) await this.performEffect(run, task, e, opts);

    if (r.notify) {
      const cur = this.store.getTask(task.id)!;
      let body = opts.notifyBody ?? r.notify.body;
      if (cur.pr_url && !body.includes(cur.pr_url)) body = body ? `${body}\n${cur.pr_url}` : cur.pr_url;
      await this.notify(this.ctxOf(run), r.notify.title, clip(body, 300), { priority: r.notify.priority, tags: r.notify.tags, click: cur.pr_url ?? undefined });
    }
    if (r.status === "done" && before !== "done") {
      await this.tickTasksMd(run, task);
      this.log(run, task, "state", { message: "done" });
      void this.tick();
    }
    return r;
  }

  private async performEffect(run: Run, task: Task, effect: Effect, opts: ApplyOptions) {
    const cur = this.store.getTask(task.id)!;
    if (effect === "kill_agent") {
      // Needs no project settings, so stopping works even when the project's context cannot be built.
      this.procs.get(cur.id)?.kill("SIGTERM");
      this.procs.delete(cur.id);
      const app = this.apps.get(cur.id);
      if (app) void this.stopUiApp(run, cur, app); // a UI-mode app under test goes with its validator (§10.4)
      return;
    }
    const ctx = this.ctxOf(run), { cfg, git } = ctx;
    const worktree = cur.worktree, branch = cur.branch!;
    const cwd = worktree && fs.existsSync(worktree) ? worktree : cfg.repo;
    const title = `${cur.key}: ${cur.title}`;
    switch (effect) {
      case "merge_local":
        await this.withMergeLock(ctx, () => git.mergeLocal(worktree!, branch, cfg.git.squash, title));
        this.log(run, cur, "git", { message: `merged ${branch} into ${cfg.baseBranch} locally` });
        return;
      case "push_and_pr": {
        const body = `${cur.summary ?? ""}\n\nRun ${run.id} · ${run.title}\nAutomated by orch; validated ${cfg.validation.agent ? "by validator agent" : "by command gate"}.`;
        const sha = opts.sha !== undefined ? opts.sha : await git.branchSha(branch);
        await git.push(worktree!, branch);
        const url = await git.createPr(worktree!, branch, title, body);
        const firstPush = !cur.pr_pushed_at;
        this.store.updateTask(cur.id, { pr_url: url, pr_head: sha, pr_pushed_at: nowIso(), pr_feedback_at: cur.pr_feedback_at ?? nowIso() });
        this.log(run, cur, "git", { message: firstPush ? `PR opened: ${url}` : `PR updated (fix round ${cur.fix_rounds}): ${url}` });
        return;
      }
      case "merge_pr":
        await git.mergePr(cwd, branch, cfg.git.squash);
        this.log(run, cur, "git", { message: "PR merged" });
        return;
      case "remove_worktree":
        // The state change already cleared `worktree`; use the path from before it.
        if (task.worktree) await git.removeWorktree(task.worktree, !cfg.git.pr, task.branch ?? undefined);
        return;
    }
  }

  // ------------------------------------------------------------------ planning
  /**
   * Import a feature folder into a new run of `projectId` (§6.2, §6.4). Briefs set their tasks' plan values; the
   * folder checks' errors refuse the plan unless `allowOpen` (REQ-INTAKE-13), and the override, the `[P]` conflicts
   * and the warnings become decisions (REQ-INTAKE-11/14). When every open task has criteria from its brief and
   * `review` is not set, no agent is called; otherwise, with `llm`, the planner runs over the tasks without brief
   * criteria, or over every task with `review`, and never removes or rewrites a brief's criteria (REQ-INTAKE-12).
   * Refused while the project has an unfinished run (REQ-PROJ-07). The project's settings are re-read here.
   */
  async plan(projectId: string, specDir: string, opts: { llm: boolean; review?: boolean; allowOpen?: boolean }): Promise<Run> {
    if (this.requireProject(projectId).archived) throw new Error(`project '${projectId}' is archived; register its repo again to use it`);
    const open = this.unfinishedRun(projectId);
    if (open) throw this.refusal(projectId, open);
    if (opts.review && !opts.llm) throw new Error("--review runs the planner; it cannot be combined with --no-llm");
    const ctx = this.refreshContext(projectId), cfg = ctx.cfg;
    const spec = readSpecDir(specDir);
    const { tasks: imported, feature } = importFeature(spec, { briefChars: cfg.handoff.briefChars }); // throws without tasks.md or tasks
    const errors = feature.problems.filter((p) => p.kind === "error");
    if (errors.length && !opts.allowOpen) {
      const n = errors.length, shown = errors.slice(0, 5).map(problemLine).join("; ");
      throw new Error(`${n} error${n === 1 ? "" : "s"} in ${spec.dir}: ${shown}${n > 5 ? "; …" : ""}. Fix ${n === 1 ? "it" : "them"} or pass --allow-open to plan anyway`);
    }
    const planned = feature.tasks;
    // The planner is needed for open tasks whose criteria do not come from a brief, or for everything on review.
    const needCriteria = planned.filter((t) => !t.done && !t.fromBrief.includes("acceptance"));
    const fromBriefs = feature.hasBriefs && !opts.review && needCriteria.length === 0;
    const subset = opts.review ? planned : needCriteria;
    const runPlanner = opts.llm && !fromBriefs && subset.length > 0;

    const run = this.store.createRun(spec.dir, spec.title, cfg.baseBranch, runPlanner ? "planning" : "plan_pending", projectId);
    this.changed("run", { run, projectId });
    this.logWarnings(run, ctx);
    const briefCount = planned.filter((t) => t.brief).length;
    this.log(run, null, "state", { message: `imported ${planned.length} tasks from ${path.relative(cfg.repo, spec.dir)}${briefCount ? ` (${briefCount} with a brief)` : ""}` });

    for (const t of planned) {
      this.store.insertTask({
        run_id: run.id, key: t.key, title: t.title, description: t.description, acceptance: t.acceptance, depends_on: t.depends_on,
        parallel: t.parallel ? 1 : 0, phase: t.phase, order_idx: t.order_idx, status: t.done ? "done" : "pending",
        attempt: 0, max_attempts: cfg.scheduler.maxAttempts, merge_policy: t.merge_policy ?? cfg.git.mergePolicy,
        validate_cmd: t.validate_cmd, validate_mode: t.validate_mode ?? "standard", files_owned: t.files_owned,
        worktree: null, branch: null, pr_url: null, session_id: null, summary: t.done ? "(already complete before this run)" : null,
        files: [], last_feedback: null,
      });
    }
    this.changed("tasks", { runId: run.id });

    // Plan-time decisions (REQ-INTAKE-11/13/14): the override, each [P] conflict, each warning of the folder checks.
    const taskOf = (key: string | undefined) => (key ? this.store.getTaskByKey(run.id, key) ?? null : null);
    const keyOfFile = (file: string) => file.match(/^tasks\/(T\d{2,4})\.md$/)?.[1];
    if (errors.length) {
      this.decide(run, null, "human", `Planned despite ${errors.length} error${errors.length === 1 ? "" : "s"} in the feature folder (--allow-open)`, clip(errors.map(problemLine).join("; "), 1500));
    }
    for (const c of feature.conflicts) this.decide(run, taskOf(c.key), "orchestrator", c.decision, "frontmatter takes precedence over tasks.md marks");
    for (const w of feature.problems.filter((p) => p.kind === "warning")) {
      this.decide(run, taskOf(keyOfFile(w.file)), "orchestrator", `Import warning: ${problemLine(w)}`, `folder check ${w.rule}`);
    }

    if (fromBriefs) {
      const n = planned.filter((t) => !t.done).length;
      this.decide(run, null, "orchestrator", "Plan built from briefs; the planner was not run", `${n} open task${n === 1 ? "" : "s"}, each with acceptance criteria from its brief (orch plan --review runs the planner over the whole plan)`);
      this.changed("run", { run: this.store.getRun(run.id) });
      if (opts.llm) await this.notify(ctx, `Plan ready: ${run.title}`, `${planned.length} tasks, built from their briefs. Review and approve in the dashboard.`, { tags: ["clipboard"] });
      return this.store.getRun(run.id)!;
    }
    if (!runPlanner) return run;

    // Planner agent: the tasks without brief criteria, or the whole plan on review.
    if (opts.review) this.decide(run, null, "orchestrator", "Planner reviews the whole plan (--review)", "it may add criteria and correct dependencies; it never removes or rewrites a brief's criteria");
    else if (feature.hasBriefs) this.decide(run, null, "orchestrator", `Planner runs for ${subset.map((t) => t.key).join(", ")} only`, "no brief with acceptance criteria; the other tasks are planned from their briefs");
    const tasks = this.store.listTasks(run.id);
    const subsetKeys = new Set(subset.map((t) => t.key));
    const tasksJson = JSON.stringify(planned.filter((t) => subsetKeys.has(t.key)).map((t) => ({
      key: t.key, title: t.description, phase: t.phase, parallel: t.parallel, depends_on: t.depends_on, done: t.done,
      ...(t.brief ? { brief: t.brief, from_brief: t.fromBrief } : {}),
      ...(t.fromBrief.includes("acceptance") ? { acceptance: t.acceptance } : {}),
    })), null, 2);
    const specContext = Object.entries(spec.files).filter(([f]) => f !== "tasks.md").map(([f, c]) => `### ${f}\n${c}`).join("\n\n");
    const rules = assembleSpecContext({ rules: await this.projectRules(cfg) }, this.budgets(cfg));
    this.recordCuts(run, null, "planner", rules.cuts);
    const prompt = render(loadPrompt("planner", cfg.repo), {
      title: run.title, spec_context: clip(specContext, cfg.handoff.specChars * 2), tasks_json: tasksJson,
      plan_scope: opts.review ? PLAN_SCOPE.review : feature.hasBriefs ? PLAN_SCOPE.subset : "",
      project_rules: rules.text || "(no project rules file)",
    });

    const planner = this.roleAgent(cfg, "planner");
    this.log(run, null, "state", { message: `planner started (${planner.label})` });
    this.busyAgents++; // a planner takes a global agent slot (§7.1)
    let res;
    try {
      res = await runAgent({
        ...planner, cwd: cfg.repo, prompt,
        env: { ...this.apiEnv(), ORCH_RUN_ID: run.id, ORCH_ACTOR: "planner" },
        onEvent: (kind, data) => this.log(run, null, kind, { role: "planner", ...data }),
      });
    } finally {
      this.busyAgents--;
    }
    addRunUsage(this.store, run.id, res); // §18: planner spend goes on the run row
    const out = res.structured;
    if (!res.ok || !out?.tasks) {
      this.log(run, null, "error", { message: "planner failed or returned no plan; using imported tasks as-is", text: clip(res.text, 2000) });
      this.decide(run, null, "orchestrator", "Planner produced no usable output; proceeding with tasks.md as imported", res.text ? clip(res.text, 300) : null);
    } else {
      const byKey = new Map(planned.map((t) => [t.key, t]));
      for (const pt of out.tasks) {
        if (!pt || !subsetKeys.has(pt.key)) continue; // outside the subset: planned from its brief, untouched
        const t = this.store.getTaskByKey(run.id, pt.key), ft = byKey.get(pt.key);
        if (!t || !ft) continue;
        // A value the brief sets wins; the planner fills only what the brief leaves open (§6.4).
        const free = (field: string) => !ft.fromBrief.includes(field);
        const patch: Partial<Task> = {};
        if (Array.isArray(pt.acceptance)) {
          const proposed: string[] = pt.acceptance.map((a: unknown) => String(a).trim()).filter(Boolean);
          if (free("acceptance")) patch.acceptance = proposed;
          else {
            // REQ-INTAKE-12: brief criteria are kept verbatim; the planner's other criteria are appended and recorded.
            const added = proposed.filter((a) => !ft.acceptance.includes(a));
            if (added.length) {
              patch.acceptance = [...ft.acceptance, ...added];
              this.decide(run, t, "planner", `Added ${added.length} acceptance criteri${added.length === 1 ? "on" : "a"} to ${t.key}; the brief's ${ft.acceptance.length} kept`, clip(added.join("; "), 1000));
            }
          }
        }
        if (Array.isArray(pt.depends_on)) {
          const deps: string[] = [...new Set<string>(pt.depends_on.map(String))].filter((k) => k !== t.key && tasks.some((x) => x.key === k));
          if (free("depends_on")) patch.depends_on = deps;
          else if (opts.review) {
            // REQ-INTAKE-02: the earlier-phase part of a brief task's dependencies is never removed (§6.4).
            const own = imported.find((x) => x.key === t.key)!;
            const kept = [...new Set([...earlierPhaseKeys(imported, own), ...deps])].sort();
            if (kept.join() !== [...ft.depends_on].sort().join()) {
              patch.depends_on = kept;
              this.decide(run, t, "planner", `Changed ${t.key}'s dependencies from [${ft.depends_on.join(", ")}] to [${kept.join(", ")}]`, "planner review (--review); tasks of earlier phases are always kept");
            }
          }
        }
        if (free("merge_policy") && (pt.merge_policy === "manual" || pt.merge_policy === "auto")) patch.merge_policy = pt.merge_policy;
        if (free("validate_cmd") && typeof pt.validate_cmd === "string" && pt.validate_cmd.trim()) patch.validate_cmd = pt.validate_cmd.trim();
        if (free("files_owned") && Array.isArray(pt.files_owned)) patch.files_owned = cleanOwned(pt.files_owned);
        if (free("validate_mode") && (pt.validate_mode === "ui" || pt.validate_mode === "standard")) patch.validate_mode = pt.validate_mode;
        if (Object.keys(patch).length) this.store.updateTask(t.id, patch);
      }
      for (const d of out.decisions ?? []) this.decide(run, null, "planner", String(d.text ?? d), d.rationale ?? null);
      for (const q of out.questions ?? []) {
        // Plan questions belong to no task (REQ-INTAKE-07); while one is open no task of the run starts (§7.1).
        const text = String(q?.text ?? q ?? "").trim();
        if (!text) continue;
        const question = this.store.addQuestion(run.id, null, text, Array.isArray(q?.options) ? q.options.map(String) : []);
        this.log(run, null, "question", { role: "planner", plan: true, text: question.text, options: question.options, id: question.id });
      }
      this.log(run, null, "state", { message: "planner finished", cost_usd: res.costUsd });
    }
    this.store.setRunStatus(run.id, "plan_pending");
    this.changed("run", { run: this.store.getRun(run.id) });
    this.changed("tasks", { runId: run.id });
    await this.notify(ctx, `Plan ready: ${run.title}`, `${tasks.length} tasks. Review and approve in the dashboard.`, { tags: ["clipboard"] });
    return this.store.getRun(run.id)!;
  }

  /**
   * Dry run (REQ-INTAKE-10, REQ-INTAKE-15): read the feature folder as `plan` would, without creating a run,
   * calling an agent or writing anything. Tasks carry their brief fields (§6.4: `brief`, `fromBrief`, effective
   * `depends_on`), `conflicts` the `[P]`-versus-brief differences, `problems` the folder checks (errors and
   * warnings). `cycle` is the first dependency cycle over the effective dependencies (§6.3), else null.
   */
  previewPlan(specDir: string, projectId?: string): PlanPreview {
    let briefChars = DEFAULT_BRIEF_CHARS;
    if (projectId !== undefined) {
      this.requireProject(projectId); // 404 for an unknown project, like the real plan
      briefChars = this.context(projectId).cfg.handoff.briefChars;
    }
    const spec = readSpecDir(specDir);
    const { feature } = importFeature(spec, { briefChars });
    return {
      dir: spec.dir, title: spec.title, tasks: feature.tasks, hasBriefs: feature.hasBriefs,
      conflicts: feature.conflicts, problems: feature.problems,
      cycle: findCycle(feature.tasks.map((t) => ({ key: t.key, dependsOn: t.depends_on }))),
    };
  }

  /** Human edits to the plan before approval (also allowed later for pending tasks). */
  editTask(taskId: string, patch: Partial<Pick<Task, EditableField>>) {
    const t = this.store.getTask(taskId);
    if (!t) throw new Error("task not found");
    const unknown = Object.keys(patch ?? {}).filter((k) => !EDITABLE.includes(k as EditableField));
    if (unknown.length) throw new Error(`cannot edit ${unknown.join(", ")}; editable fields: ${EDITABLE.join(", ")}`);
    if (patch.validate_mode !== undefined && patch.validate_mode !== "standard" && patch.validate_mode !== "ui") {
      throw new Error(`validate_mode must be "standard" or "ui"`);
    }
    if (patch.files_owned !== undefined) {
      if (!Array.isArray(patch.files_owned)) throw new Error("files_owned must be an array of paths or globs");
      patch = { ...patch, files_owned: cleanOwned(patch.files_owned) };
    }
    this.store.updateTask(taskId, patch);
    const run = this.store.getRun(t.run_id)!;
    this.decide(run, t, "human", `Edited task ${t.key}: ${Object.keys(patch).join(", ")}`, null);
    this.changed("tasks", { runId: t.run_id });
  }

  approvePlan(runId: string) {
    const run = this.store.getRun(runId);
    if (!run) throw new Error("run not found");
    if (run.status !== "plan_pending") throw new Error(`run is ${run.status}, not plan_pending`);
    const cycle = findCycle(this.store.listTasks(runId).map((t) => ({ key: t.key, dependsOn: t.depends_on })));
    if (cycle) throw new Error(`dependency cycle: ${cycle.join(" → ")}; edit the dependencies of ${[...new Set(cycle)].join(", ")} and approve again`);
    this.store.setRunStatus(runId, "ready");
    this.decide(run, null, "human", "Plan approved", null);
    this.changed("run", { run: this.store.getRun(runId) });
  }

  // ------------------------------------------------------------------ run control
  /** Run by id, or the default project's current run (legacy routes without an id). */
  private runOrCurrent(runId: string | undefined, what: string): Run {
    const run = runId ? this.store.getRun(runId) : this.currentRun(this.requireDefaultProject().id);
    if (!run) throw new Error(what);
    return run;
  }
  /** Ignored settings keys go to the run's activity stream (§5.2). */
  private logWarnings(run: Run, ctx: ProjectContext) {
    for (const w of ctx.warnings) this.log(run, null, "info", { message: `settings: ${w}` });
  }

  /**
   * Start (or resume) a run. Refused while another run of the project is unfinished (REQ-PROJ-07).
   * The project's settings are re-read, so edits take effect at the next start (REQ-PROJ-06).
   */
  start(runId?: string) {
    const run = this.runOrCurrent(runId, "no run to start");
    if (run.status === "plan_pending") throw new Error("plan not approved yet");
    if (run.status === "planning") throw new Error("planner still working");
    if (!["ready", "paused", "running", "stopped"].includes(run.status)) throw new Error(`run is ${run.status}`);
    if (!run.project_id) throw new Error(`run ${run.id} belongs to no project`);
    const other = this.unfinishedRun(run.project_id, run.id);
    if (other) throw this.refusal(run.project_id, other);
    const ctx = this.refreshContext(run.project_id);
    this.store.setRunStatus(run.id, "running");
    this.logWarnings(run, ctx);
    this.log(run, null, "state", { message: "run started" });
    this.changed("run", { run: this.store.getRun(run.id) });
    this.ensureTicking();
    void this.tick();
  }
  pause(runId?: string) {
    const run = this.runOrCurrent(runId, "no active run");
    this.store.setRunStatus(run.id, "paused");
    this.log(run, null, "state", { message: "run paused; running tasks will finish, no new tasks start" });
    this.changed("run", { run: this.store.getRun(run.id) });
  }
  stop(runId?: string) {
    const run = this.runOrCurrent(runId, "no active run");
    for (const t of this.store.listTasks(run.id)) {
      if (ACTIVE.includes(t.status)) this.fire(run, t.id, { type: "run_stop" }).catch((e) => console.error("[stop]", e)); // T14: state + kill are synchronous
    }
    // A running phase validation is abandoned: its agent is killed and the phase goes back to pending (§10.3).
    for (const [phaseId, job] of this.phaseJobs) {
      if (job.runId !== run.id) continue;
      job.stopped = true;
      job.child?.kill("SIGTERM");
      this.store.updatePhase(phaseId, { status: "pending" });
    }
    this.store.setRunStatus(run.id, "stopped");
    this.log(run, null, "state", { message: "run stopped; active agents killed" });
    this.changed("run", { run: this.store.getRun(run.id) });
    this.changed("tasks", { runId: run.id });
  }

  ensureTicking() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.server.scheduler.tickSeconds * 1000);
    this.timer.unref();
  }

  /** A project whose context cannot be built (repo gone, invalid settings) starts nothing; say why once per distinct error. */
  private reportContextError(projectId: string, e: any) {
    const msg = e?.message ?? String(e);
    if (this.contextErrors.get(projectId) !== msg) console.error(`[tick] ${msg}`);
    this.contextErrors.set(projectId, msg);
  }

  /**
   * Scheduler heartbeat across all projects (§7.3): resume answered tasks, poll PRs, start whatever is
   * ready under the global agent cap with fair shares between projects (§7.1), finish runs.
   */
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      // Each project's current run, if running or paused: a paused run starts nothing, but its active agents use slots.
      const entries: { project: Project; run: Run; ctx: ProjectContext | null }[] = [];
      for (const project of this.store.listProjects()) {
        const run = this.currentRun(project.id);
        if (!run || (run.status !== "running" && run.status !== "paused")) continue;
        let ctx: ProjectContext | null = null;
        try { ctx = this.context(project.id); } catch (e) { this.reportContextError(project.id, e); }
        entries.push({ project, run, ctx });
      }
      const running = entries.filter((e) => e.run.status === "running" && e.ctx);

      for (const { run, ctx } of running) {
        const tasks = this.store.listTasks(run.id);
        // Resume tasks whose questions have been answered (e.g. answered while paused).
        for (const t of tasks) {
          if (t.status === "needs_input" && this.store.openQuestionsForTask(t.id).length === 0) void this.resumeAfterAnswer(run, t);
        }
        if (ctx!.cfg.git.pr && ctx!.cfg.git.feedback.enabled) this.pollPullRequests(run, ctx!, tasks);
      }
      // Phase checks (§10.3): validate finished phases while a global agent slot is free.
      for (const { run, ctx } of running) this.checkPhases(run, ctx!, entries.map((e) => e.run.id));

      // Readiness is decided by src/core (§7.1); tasks are re-read so resumed ones count as active.
      const tasksByRun = new Map(entries.map((e) => [e.run.id, this.store.listTasks(e.run.id)]));
      const { start, heldForOverlap } = selectReady({
        maxAgents: this.server.scheduler.maxAgents,
        busyAgents: this.busyAgents,
        projects: entries.map(({ project, run, ctx }) => ({
          id: project.id, runId: run.id, runStatus: ctx ? run.status : null, maxParallel: ctx?.cfg.scheduler.maxParallel ?? 0,
          lastStartAt: project.last_start_at, planQuestionsOpen: this.openPlanQuestions(run.id).length, resumeOnRetry: ctx?.cfg.scheduler.resumeOnRetry ?? false,
          phases: ctx?.phase.enabled ? this.store.listPhases(run.id).map((p) => ({ name: p.name, idx: p.idx, status: p.status })) : undefined,
        })),
        tasks: entries.flatMap(({ project, run, ctx }) => {
          const supportsResume = ctx ? this.roleAgent(ctx.cfg, "worker").adapter.supportsResume : false;
          return tasksByRun.get(run.id)!.map((t) => ({
            id: t.id, projectId: project.id, runId: t.run_id, key: t.key, orderIdx: t.order_idx, status: t.status, dependsOn: t.depends_on, filesOwned: t.files_owned,
            openQuestions: t.status === "pending" ? this.store.openQuestionsForTask(t.id).length : 0,
            attempt: t.attempt, fixRounds: t.fix_rounds, hasSession: !!t.session_id, adapterSupportsResume: supportsResume, phase: t.phase,
          }));
        }),
      });
      const taskById = new Map([...tasksByRun.values()].flat().map((t) => [t.id, t]));
      const runById = new Map(entries.map((e) => [e.run.id, e]));
      // REQ-SCHED-02 / REQ-HITL-06: one orchestrator decision per held-back pair per run.
      for (const h of heldForOverlap) {
        const task = taskById.get(h.taskId)!, blocker = taskById.get(h.blockedByTaskId)!;
        this.decideOverlapHold(runById.get(task.run_id)!.run, task, blocker);
      }
      const startedAt = nowIso();
      for (const s of start) {
        const task = taskById.get(s.taskId)!;
        const { project, run } = runById.get(task.run_id)!;
        this.store.touchProjectStart(project.id, startedAt); // fairness input for the next tick (REQ-PROJ-09)
        void this.runTask(run, task, s.resume);
      }

      for (const { run, ctx } of running) await this.checkRunProgress(run, ctx!);
    } catch (e: any) {
      console.error("[tick]", e);
    } finally {
      this.ticking = false;
    }
  }

  /** With no agent active in the run: finish it when every task is done, or say once that it waits on the owner. */
  private async checkRunProgress(run: Run, ctx: ProjectContext) {
    const tasks = this.store.listTasks(run.id);
    if (tasks.some((t) => ACTIVE.includes(t.status))) return;
    if (this.phaseJobOf(run.id) !== undefined) return; // a phase validation is running
    const doneKeys = new Set(tasks.filter((t) => FINISHED.includes(t.status)).map((t) => t.key));
    const unfinished = tasks.filter((t) => !FINISHED.includes(t.status));
    // With phase validation on, the run is done only when every phase passed (§7.3 step 5).
    const phases = ctx.phase.enabled ? this.store.listPhases(run.id) : [];
    const waitingPhase = phases.find((p) => p.status === "needs_human" || p.status === "failed");
    if (waitingPhase) {
      const lastEv = this.store.listEvents({ runId: run.id, limit: 1 })[0];
      if (!(lastEv?.kind === "state" && lastEv.data?.waiting)) {
        this.log(run, null, "state", { message: `waiting on you: phase "${phaseLabel(waitingPhase.name)}" failed validation; re-run it or accept it in the inbox`, waiting: true });
      }
      return;
    }
    if (!unfinished.length && phases.some((p) => p.status !== "passed")) return; // the next phase check validates it
    if (!unfinished.length) {
      this.store.setRunStatus(run.id, "done");
      this.log(run, null, "state", { message: "all tasks done" });
      this.changed("run", { run: this.store.getRun(run.id) });
      await this.notify(ctx, `Run complete: ${run.title}`, `${tasks.length} tasks finished.`, { tags: ["tada"], priority: "high" });
    } else if (this.openPlanQuestions(run.id).length) {
      // An open plan question holds every start (§7.1); say so once.
      const lastEv = this.store.listEvents({ runId: run.id, limit: 1 })[0];
      if (!(lastEv?.kind === "state" && lastEv.data?.waiting)) {
        this.log(run, null, "state", { message: "waiting on you: answer the plan questions in the inbox before tasks start", waiting: true });
      }
    } else if (unfinished.every((t) => ["failed", "needs_input", "pr_open"].includes(t.status) || (t.status === "pending" && !t.depends_on.every((k) => doneKeys.has(k))))) {
      // Nothing can progress without a human. Stay 'running' so answering resumes automatically, but say so once.
      const blocked = unfinished.filter((t) => t.status !== "pending");
      const lastEv = this.store.listEvents({ runId: run.id, limit: 1 })[0];
      if (!(lastEv?.kind === "state" && lastEv.data?.waiting)) {
        this.log(run, null, "state", { message: `waiting on you: ${blocked.map((t) => `${t.key} (${t.status})`).join(", ")}`, waiting: true });
      }
    }
  }

  // ------------------------------------------------------------------ task lifecycle
  /**
   * Run the worker for a task: T1 `start` first, unless `started` (T10 `answered` already set it running
   * without consuming an attempt). The state change happens synchronously, before the first await.
   */
  private async runTask(run: Run, task: Task, resume = false, started = false) {
    if (!started && (await this.fire(run, task.id, { type: "start" })).rejected) return;
    task = this.store.getTask(task.id)!;
    const { cfg, git } = this.ctxOf(run);
    // Values produced by starting are the shell's (§8 T1: branch/worktree assigned if null).
    const branch = task.branch ?? `orch/${task.key.toLowerCase()}-${slug(task.title)}`;
    const worktree = task.worktree ?? path.join(cfg.worktreeDir, `${run.id}-${task.key.toLowerCase()}`);
    if (task.branch !== branch || task.worktree !== worktree) this.store.updateTask(task.id, { branch, worktree });
    task = this.store.getTask(task.id)!;
    const attempt = task.attempt;
    const workerAgent = this.roleAgent(cfg, "worker");
    if (resume && !workerAgent.adapter.supportsResume) resume = false;
    this.log(run, task, "state", { message: `worker started (${workerAgent.label}, attempt ${attempt}/${task.max_attempts})${resume ? " — resuming previous session" : ""}` });

    try {
      if (!fs.existsSync(path.join(worktree, ".git"))) {
        await git.addWorktree(worktree, branch);
        this.log(run, task, "git", { message: `worktree ${worktree} on ${branch}` });
        for (const f of cfg.git.copyFiles) {
          const src = path.join(cfg.repo, f);
          if (fs.existsSync(src)) fs.copyFileSync(src, path.join(worktree, f));
        }
        if (cfg.git.setupCommand) {
          const r = await shell(cfg.git.setupCommand, worktree, { timeoutMs: 15 * 60_000 });
          this.log(run, task, "git", { message: `setup: ${cfg.git.setupCommand} → exit ${r.code}`, output: clip(r.stdout + r.stderr, 2000) });
          if (r.code !== 0) {
            // Drop the half-set-up worktree (branch kept) so the next attempt recreates it and reruns setup.
            await git.removeWorktree(worktree, false);
            throw new Error(`setup command failed (exit ${r.code}): ${clip((r.stdout + "\n" + r.stderr).trim(), 500)}`);
          }
        }
      }

      const prompt = resume && task.session_id
        ? this.resumePrompt(task)
        : render(loadPrompt("worker", cfg.repo), {
            task_key: task.key, task_title: task.title, task_description: task.description,
            acceptance: this.bullets(task.acceptance), spec_context: await this.taskSpecContext(cfg, run, task),
            handoff: this.handoff(cfg, run, task), branch, base_branch: cfg.baseBranch,
            validate_hint: validateCmd(cfg, task) ? ` (\`${validateCmd(cfg, task)}\` must pass)` : "",
            files_owned: ownedSection(task.files_owned),
            feedback_section: task.last_feedback ? `## Feedback from the previous attempt (fix these)\n${task.last_feedback}` : "",
          });

      const agentErrors: string[] = []; // timeout / exit code / spawn failure, for the attempt's feedback
      const res = await runAgent({
        ...workerAgent, cwd: worktree, prompt,
        resumeSessionId: resume ? task.session_id : null, env: this.taskEnv(task),
        onSpawn: (c) => this.procs.set(task.id, c),
        onEvent: (kind, data) => {
          if (kind === "error" && data?.message) agentErrors.push(String(data.message));
          this.log(run, task, kind, { role: "worker", ...data });
        },
      });
      this.procs.delete(task.id);
      addTaskUsage(this.store, task.id, res); // §18: counted even when the task was stopped meanwhile
      if (res.sessionId) this.store.updateTask(task.id, { session_id: res.sessionId });

      // Stopped by a human while running: leave as reset by stop().
      const cur = this.store.getTask(task.id)!;
      if (cur.status !== "running") return;

      const out = res.structured ?? {};
      for (const d of out.decisions ?? []) this.decide(run, task, "worker", String(d.text ?? d), d.rationale ?? null);
      if (out.summary) this.store.updateTask(task.id, { summary: String(out.summary) });
      if (Array.isArray(out.files)) this.store.updateTask(task.id, { files: out.files.map(String) });

      // Worker asked a question (via `orch ask`) and stopped.
      if (this.store.openQuestionsForTask(task.id).length > 0 || out.status === "blocked") {
        if (this.store.openQuestionsForTask(task.id).length === 0 && out.question?.text) {
          const q = this.store.addQuestion(run.id, task.id, String(out.question.text), out.question.options ?? []);
          this.log(run, task, "question", { id: q.id, text: q.text, options: q.options });
        }
        const qs = this.store.openQuestionsForTask(task.id);
        await this.fire(run, task.id, { type: "worker_blocked" }, { notifyBody: qs.map((q) => q.text).join("\n") || "Worker blocked" }); // T2
        return;
      }

      if (!res.ok || out.status === "failed") {
        const reason = out.reason ? String(out.reason) : agentErrors.length ? agentErrors.join("; ") : "agent run failed (see log)";
        await this.failOrRetry(run, task, `Worker reported failure: ${reason}`);
        return;
      }

      // Make sure the work is committed, then validate.
      await git.commitAll(worktree, `${task.key}: ${task.title} (orch auto-commit)`).then((c) => { if (c) this.log(run, task, "git", { message: "committed leftover changes" }); });
      if ((await this.fire(run, task.id, { type: "worker_done" })).rejected) return; // T5
      await this.validate(run, this.store.getTask(task.id)!);
    } catch (e: any) {
      this.procs.delete(task.id);
      this.log(run, task, "error", { message: e?.message ?? String(e) });
      await this.failOrRetry(run, task, `Error: ${e?.message ?? e}`);
    }
  }

  private async validate(run: Run, task: Task) {
    const worktree = task.worktree!;
    const ctx = this.ctxOf(run), { cfg, git } = ctx;

    if ((await git.commitsAhead(worktree)) === 0) {
      await this.failOrRetry(run, task, "No commits on the task branch; the worker produced no changes.");
      return;
    }

    // 1. Deterministic gate. Its output goes to the validator too (REQ-VAL-02).
    const cmd = validateCmd(cfg, task);
    let gateOutput = "";
    if (cmd) {
      this.log(run, task, "state", { message: `validation gate: ${cmd}` });
      const r = await shell(cmd, worktree, { timeoutMs: 20 * 60_000 });
      this.log(run, task, "tool", { role: "gate", name: "shell", input: { command: cmd }, exit: r.code, output: clip(r.stdout + r.stderr, 3000) });
      gateOutput = clip((r.stdout + "\n" + r.stderr).trim(), 4000);
      if (r.code !== 0) {
        await this.failOrRetry(run, task, `Validation command failed (exit ${r.code}): \`${cmd}\`\n\n${gateOutput}`);
        return;
      }
    }

    // 2. Independent validator agent; in UI mode against the running app (§10.4).
    if (cfg.validation.agent) {
      const ui = task.validate_mode === "ui";
      if (ui && !ctx.ui.startCommand.trim()) {
        await this.blocked(run, task, "validation.ui.startCommand is not set in the project's orch.config.json, so orch cannot start the app");
        return;
      }
      let app: AppProcess | null = null;
      try {
        if (ui) {
          this.log(run, task, "state", { message: `starting app: ${ctx.ui.startCommand}` });
          try {
            app = await startApp({
              cwd: worktree, startCommand: ctx.ui.startCommand, urlTemplate: ctx.ui.url, env: ctx.ui.env,
              readyTimeoutSeconds: ctx.ui.readyTimeoutSeconds, pidDir: runDir(this.home), taskId: task.id,
              onSpawn: (a) => this.apps.set(task.id, a),
            });
          } catch (e: any) {
            if (this.store.getTask(task.id)!.status !== "validating") return; // stopped while the app started
            const output = e instanceof AppStartError ? e.output : "";
            this.log(run, task, "tool", { role: "app", name: "shell", input: { command: ctx.ui.startCommand }, exit: null, output: clip(output, 3000) });
            await this.failOrRetry(run, task, `${e?.message ?? e}\n\nApp output (last ${APP_OUTPUT_CHARS} chars):\n${output.trim() || "(no output)"}`);
            return;
          }
          this.log(run, task, "state", { message: `app ready at ${app.url} (pid ${app.pid})` });
          if (this.store.getTask(task.id)!.status !== "validating") return; // stopped meanwhile; finally stops the app
        }
        await this.runValidator(run, task, cmd, gateOutput, app);
      } finally {
        if (ui) {
          if (app) await this.stopUiApp(run, task, app); // no-op when runValidator already stopped it
          else await this.stopApp(task.id);
        }
      }
      return;
    }

    await this.finalize(run, this.store.getTask(task.id)!);
  }

  /** The validator agent (§10.2) and its verdict: PASS → finalize; BLOCKED in UI mode → T19; anything else → T3/T4. */
  private async runValidator(run: Run, task: Task, cmd: string, gateOutput: string, app: AppProcess | null) {
    const worktree = task.worktree!;
    const { cfg, git } = this.ctxOf(run);
    const validatorAgent = this.roleAgent(cfg, "validator");
    this.log(run, task, "state", { message: `validator started (${validatorAgent.label}${app ? `, UI mode at ${app.url}` : ""})` });
    const diff = await git.diffFromBase(worktree);
    // REQ-VAL-05: orch lists edits outside the owned files; the validator reports them as findings, never a FAIL.
    const changed = task.files_owned.length ? (await git.diffFiles(worktree, 0)).files.map((f) => f.path) : [];
    const scope = outOfScope(changed, task.files_owned);
    // REQ-VAL-10: the same brief, requirement rows, contracts and rules as the worker; never the worker's transcript.
    const specContext = await this.taskSpecContext(cfg, run, task);
    const prompt = render(loadPrompt(app ? "validator-ui" : "validator", cfg.repo), {
      spec_context: specContext,
      files_owned: ownedSection(task.files_owned),
      out_of_scope: task.files_owned.length ? (scope.length ? scope.map((f) => `- ${f}`).join("\n") : "(none)") : "(the task declares no owned files)",
      task_key: task.key, task_title: task.title, task_description: task.description, acceptance: this.bullets(task.acceptance),
      worker_summary: task.summary ?? "(none)", diff, branch: task.branch, base_branch: cfg.baseBranch,
      validate_hint: cmd ? ` (\`${cmd}\` already passed; re-run or extend it)` : "",
      gate_output: cmd ? `\`${cmd}\` passed. Its output:\n\n\`\`\`\n${gateOutput || "(no output)"}\n\`\`\`` : "(no test command is configured for this task or project)",
      app_url: app?.url ?? "",
    });
    const res = await runAgent({
      ...validatorAgent, cwd: worktree, prompt, env: this.taskEnv(task, "validator"),
      onSpawn: (c) => this.procs.set(task.id, c),
      onEvent: (kind, data) => this.log(run, task, kind, { role: "validator", ...data }),
    });
    this.procs.delete(task.id);
    addTaskUsage(this.store, task.id, res); // §18
    // The app under test is done once its validator is (§10.4): stop it before acting on the verdict, so a
    // PASS never merges (and finishes the run) while the app is still up.
    if (app) await this.stopUiApp(run, task, app);
    const cur = this.store.getTask(task.id)!;
    if (cur.status !== "validating") return; // stopped
    const v = res.structured ?? {};
    const verdict = String(v.verdict ?? "").toUpperCase();
    this.log(run, task, "verdict", { verdict: verdict || "NONE", reasons: v.reasons ?? [], criteria: v.criteria ?? [], suggestions: v.suggestions ?? [], findings: Array.isArray(v.findings) ? v.findings.map(String) : [], out_of_scope: scope, ...(app ? { app_url: app.url } : {}), cost_usd: res.costUsd });
    const reasonList: string[] = Array.isArray(v.reasons) ? v.reasons.map(String).filter(Boolean) : [];
    // BLOCKED is only meaningful in UI mode (no browser tool); elsewhere it is a non-PASS like any other.
    if (verdict === "BLOCKED" && app) {
      await this.blocked(run, task, reasonList.join("; ") || "the validator could not drive a browser");
      return;
    }
    if (verdict !== "PASS") {
      const reasons = reasonList.length ? reasonList.map((r) => `- ${r}`).join("\n") : clip(res.text, 1500) || "validator gave no verdict";
      const unmet = Array.isArray(v.criteria) ? v.criteria.filter((c: any) => c && c.met === false).map((c: any) => `- UNMET: ${c.criterion} (${c.evidence ?? "no evidence"})`).join("\n") : "";
      await this.failOrRetry(run, task, `Validator verdict: ${verdict || "NONE"}\n${reasons}\n${unmet}`);
      return;
    }
    this.decide(run, task, "validator", `${task.key} passed validation`, Array.isArray(v.criteria) ? `${v.criteria.filter((c: any) => c.met).length}/${v.criteria.length} criteria met` : null);
    await this.finalize(run, this.store.getTask(task.id)!);
  }

  /** T19: UI validation cannot run; the task fails without retries and goes to the inbox (REQ-VAL-09). */
  private async blocked(run: Run, task: Task, reason: string) {
    const r = await this.fire(run, task.id, { type: "validator_blocked", reason });
    if (r.rejected) return;
    this.log(run, task, "state", { message: "UI validation blocked; failed without retrying; needs a human", feedback: clip(r.patch?.last_feedback ?? reason, 2000) });
  }

  /** T3/T4: retry with feedback, or fail and notify when the attempt budget is used. */
  private async failOrRetry(run: Run, task: Task, feedback: string) {
    const attempt = this.store.getTask(task.id)!.attempt;
    const r = await this.fire(run, task.id, { type: "attempt_failed", feedback });
    if (r.rejected) return; // e.g. stopped by the owner meanwhile
    if (r.status === "pending") {
      this.log(run, task, "state", { message: `attempt ${attempt} failed; retrying`, feedback: clip(feedback, 2000) });
      // The scheduler picks it up again (resuming the worker's session if configured).
      if (this.deadlineGuard(run)) setTimeout(() => void this.tick(), 50);
      return;
    }
    this.log(run, task, "state", { message: `failed after ${attempt} attempts; needs a human`, feedback: clip(feedback, 2000) });
  }

  /** T6–T8a: merge locally, open/update the PR, wait for checks or the owner. Merge errors → T9. */
  private async finalize(run: Run, task: Task) {
    // The head is read before pushing: it decides T8a (fix round without new commits) and becomes pr_head.
    const { cfg, git } = this.ctxOf(run);
    const sha = cfg.git.pr ? await git.branchSha(task.branch!) : null;
    const r = await this.fire(run, task.id, { type: "validated", branchSha: sha }, { sha });
    if (r.status === "pr_checks" && !r.rejected) {
      this.log(run, task, "state", { message: "waiting for PR checks before merging" });
      this.lastPoll.delete(task.id); // poll soon rather than a full interval from now
    }
  }

  /**
   * Tick "- [ ] T001" -> "- [x] T001" in tasks.md after the merge. Done on the base branch
   * (not on task branches) so parallel tasks never conflict over the same lines.
   * Local-merge mode commits it; PR mode leaves it as a working-tree change for you to commit.
   */
  private async tickTasksMd(run: Run, task: Task) {
    const ctx = this.ctxOf(run), { cfg, git } = ctx;
    if (!cfg.git.tickTasksMd || task.synthetic) return; // fix-up tasks are not in tasks.md (§10.3)
    const tasksPath = path.join(run.spec_dir, "tasks.md");
    const rel = path.relative(cfg.repo, tasksPath);
    if (rel.startsWith("..")) return;
    await this.withMergeLock(ctx, async () => {
      if (!markTaskDoneInFile(tasksPath, task.key)) return;
      if (!cfg.git.pr) {
        const r = await git.commitPaths(cfg.repo, [rel], `${task.key}: tick in tasks.md`);
        this.log(run, task, "info", { message: r ? "ticked and committed in tasks.md" : "ticked in tasks.md" });
      } else {
        this.log(run, task, "info", { message: `ticked ${rel} in your working tree (commit it when convenient)` });
      }
    });
  }

  /** Serializes operations that touch a project's main checkout (local merges, tasks.md ticks); projects do not wait on each other. */
  private withMergeLock<T>(ctx: ProjectContext, fn: () => Promise<T>): Promise<T> {
    const id = ctx.project.id;
    const next = (this.mergeChains.get(id) ?? Promise.resolve()).then(fn, fn);
    this.mergeChains.set(id, next.catch(() => {}));
    return next;
  }

  // ------------------------------------------------------------------ PR feedback loop (R1)
  private polling = new Set<string>();
  private lastPoll = new Map<string, number>();
  private lastPollError = new Map<string, string>();

  /** Called from tick(): poll each watched PR at most every `pollSeconds`, never two polls of one task at once. */
  private pollPullRequests(run: Run, ctx: ProjectContext, tasks: Task[]) {
    const every = ctx.cfg.git.feedback.pollSeconds * 1000;
    for (const t of tasks) {
      if (!WATCHED.includes(t.status) || !t.pr_url || !t.branch) continue;
      if (this.polling.has(t.id) || Date.now() - (this.lastPoll.get(t.id) ?? 0) < every) continue;
      this.polling.add(t.id);
      this.lastPoll.set(t.id, Date.now());
      this.pollPr(run, t)
        .then(() => this.lastPollError.delete(t.id))
        .catch((e) => {
          const msg = `PR poll failed: ${e?.message ?? e}`;
          if (this.lastPollError.get(t.id) !== msg) this.log(run, t, "error", { message: msg }); // log once per distinct error
          this.lastPollError.set(t.id, msg);
        })
        .finally(() => this.polling.delete(t.id));
    }
  }

  /** Gather the PR facts, let src/core decide (§12.2), then perform the action through the state machine (T18). */
  private async pollPr(run: Run, task: Task) {
    const { cfg, git } = this.ctxOf(run);
    const fb = cfg.git.feedback;
    const cwd = task.worktree && fs.existsSync(task.worktree) ? task.worktree : cfg.repo;
    const pr = await git.prStatus(cwd, task.pr_url!);
    const localSha = await git.branchSha(task.branch!);
    task = this.store.getTask(task.id)!; // a human may have acted while gh was running
    if (!WATCHED.includes(task.status)) return;

    const a = decidePrAction({
      task, pr, localSha, now: nowIso(),
      config: { trigger: fb.trigger, ignoreAuthors: fb.ignoreAuthors, maxRounds: fb.maxRounds, noChecksGraceSeconds: fb.noChecksGraceSeconds, checksTimeoutMinutes: fb.checksTimeoutMinutes },
    });
    if (a.patch) { this.store.updateTask(task.id, a.patch); this.changed("tasks", { runId: run.id }); }

    switch (a.action) {
      case "wait":
        return;
      case "mark_done":
        await this.fire(run, task.id, { type: "pr_action", action: "mark_done", reason: a.reason });
        return;
      case "mark_failed":
        if (!(await this.fire(run, task.id, { type: "pr_action", action: "mark_failed", feedback: a.reason })).rejected) {
          this.log(run, task, "state", { message: "PR closed without merging; needs a human" });
        }
        return;
      case "inbox":
        await this.fire(run, task.id, { type: "pr_action", action: "inbox", feedback: a.reason });
        return;
      case "merge":
        await this.fire(run, task.id, { type: "pr_action", action: "merge", reason: a.reason });
        return;
      case "fix_round": {
        const round = task.fix_rounds + 1;
        const feedback = a.kind === "ci"
          ? formatCiFeedback(a.failedChecks ?? [], await git.failedCheckLogs(cwd, a.failedChecks ?? [], fb.logChars), pr.url, pr.headSha, round, fb.maxRounds)
          : formatReviewFeedback(a.items ?? [], pr.url, round, fb.maxRounds);
        await this.startFixRound(run, this.store.getTask(task.id)!, a.kind ?? "review", feedback, a.reason);
        return;
      }
    }
  }

  /**
   * Send feedback back to the worker (§12.3): same path as a validation retry, own budget.
   * Kinds ci/review come from the PR poll (T18, capped at maxRounds); kind human is the owner's
   * "Send back" (T17, no cap). Before the round, commits pushed to the PR branch are pulled in;
   * in local mode (no PR) that step is skipped.
   */
  private async startFixRound(run: Run, task: Task, kind: FixRoundKind, feedback: string, why: string) {
    const { cfg, git } = this.ctxOf(run);
    const fb = cfg.git.feedback;
    const human = kind === "human";
    const round = task.fix_rounds + 1;
    const event: TaskEvent = human
      ? { type: "human_request_changes", feedback }
      : { type: "pr_action", action: "fix_round", kind, feedback, reason: why };
    const decided = this.transition(task.id, event).result;
    if (human && decided.rejected) throw new Error(decided.reason ?? `cannot send ${task.key} back`);
    // When the transition would start the round, first bring in commits pushed to the PR branch.
    if (decided.status === "pending" && cfg.git.pr && task.pr_url && task.worktree && fs.existsSync(task.worktree)) {
      const sync = await git.syncFromRemote(task.worktree, task.branch!);
      if (sync === "fast-forwarded") this.log(run, task, "git", { message: "pulled new commits from the PR branch before the fix round" });
      if (sync === "diverged") {
        // Our next push would overwrite someone else's commits. Not our call.
        const conflict = "The PR branch has commits that conflict with the local branch; resolve before orch continues.";
        await this.fire(run, task.id, { type: "pr_action", action: "inbox", feedback: `${conflict}\n\n${feedback}` });
        if (human) throw new Error(conflict);
        return;
      }
    }
    const r = human
      ? await this.applyTransition(run, this.store.getTask(task.id)!, decided)
      : await this.fire(run, task.id, event);
    if (r.rejected || r.status !== "pending") return;
    const label = human ? `Owner feedback round ${round}` : `PR fix round ${round}/${fb.maxRounds}`;
    this.log(run, task, "state", { message: `${label}: ${why}`, feedback: clip(r.patch?.last_feedback ?? feedback, 2000) });
    if (this.deadlineGuard(run)) setTimeout(() => void this.tick(), 50);
  }

  // ------------------------------------------------------------------ phase validation (§10.3)
  /** Phase validations in flight by phase id; `child` is the phase validator while it runs, so stop can kill it. */
  private phaseJobs = new Map<number, { runId: string; child: ChildProcess | null; stopped: boolean }>();
  private phaseJobOf(runId: string): number | undefined {
    for (const [id, j] of this.phaseJobs) if (j.runId === runId) return id;
    return undefined;
  }

  /**
   * The run's phase rows, created from its tasks' phases when missing (`newPhaseRows`). A phase already
   * finished at that point (tasks ticked before the run, or a run in flight across the upgrade) starts
   * `passed` without validation, recorded as a decision when validation is on.
   */
  private ensurePhases(run: Run, tasks: Task[], enabled: boolean): Phase[] {
    const have = this.store.listPhases(run.id);
    const facts = tasks.map((t) => ({ key: t.key, phase: t.phase, status: t.status, orderIdx: t.order_idx }));
    const rows = newPhaseRows(facts, have.map((p) => p.name));
    if (!rows.length) return have;
    for (const r of rows) {
      const p = this.store.upsertPhase(run.id, r.name, r.idx);
      if (r.status !== "passed") continue;
      this.store.updatePhase(p.id, { status: "passed" });
      if (enabled) this.decide(run, null, "orchestrator", `Phase "${phaseLabel(r.name)}" passed without validation: ${r.reason}`, null);
    }
    this.changed("phases", { runId: run.id });
    return this.store.listPhases(run.id);
  }

  /**
   * Called from tick() for a running run (§7.3 step 3). Disabled: every pending phase passes at once.
   * Enabled: phases with nothing to validate pass; the next due phase starts validating when a global
   * agent slot is free (a phase validator counts as one busy agent, §7.1).
   */
  private checkPhases(run: Run, ctx: ProjectContext, runIds: string[]) {
    const tasks = this.store.listTasks(run.id);
    const phases = this.ensurePhases(run, tasks, ctx.phase.enabled);
    if (!ctx.phase.enabled) {
      const open = phases.filter((p) => p.status === "pending");
      for (const p of open) this.store.updatePhase(p.id, { status: "passed" });
      if (open.length) this.changed("phases", { runId: run.id });
      return;
    }
    if (this.phaseJobOf(run.id) !== undefined) return;
    const facts = tasks.map((t) => ({ key: t.key, phase: t.phase, status: t.status, orderIdx: t.order_idx }));
    for (const due of phasesToValidate(facts, phases)) {
      if (due.action === "pass") {
        this.store.updatePhase(due.phaseId, { status: "passed" });
        this.decide(run, null, "orchestrator", `Phase "${phaseLabel(due.name)}" passed without validation: ${due.reason}`, null);
        this.changed("phases", { runId: run.id });
        continue;
      }
      const active = runIds.reduce((n, id) => n + this.store.listTasks(id).filter((t) => ACTIVE.includes(t.status)).length, 0);
      if (this.server.scheduler.maxAgents - active - this.busyAgents <= 0) return; // wait for a free slot
      // Claim the slot and the phase synchronously, before the first await.
      this.busyAgents++;
      this.phaseJobs.set(due.phaseId, { runId: run.id, child: null, stopped: false });
      this.store.updatePhase(due.phaseId, { status: "validating" });
      this.changed("phases", { runId: run.id });
      void this.validatePhase(run, ctx, due.phaseId)
        .catch((e) => console.error("[phase]", e))
        .finally(() => {
          this.busyAgents--;
          this.phaseJobs.delete(due.phaseId);
          void this.tick();
        });
      return;
    }
  }

  /**
   * Validate one phase on the base branch: detached worktree at the base ref, setup, the phase command
   * (`validation.phase.command`, else `validation.command`), then the phase validator agent. The worktree
   * is always removed. An error of orch itself (e.g. the worktree cannot be created) goes to the owner.
   */
  private async validatePhase(run: Run, ctx: ProjectContext, phaseId: number) {
    const { cfg, git } = ctx;
    const phase = this.store.getPhase(phaseId)!;
    const job = this.phaseJobs.get(phaseId)!;
    const label = phaseLabel(phase.name);
    const dir = path.join(cfg.worktreeDir, `${run.id}-phase-${phase.idx}`);
    const tasks = this.store.listTasks(run.id);
    const own = tasks.filter((t) => phaseName(t.phase) === phase.name);
    const agent = this.agentFor(cfg, ctx.phase.role);
    this.log(run, null, "state", { message: `phase validation started: "${label}" (${own.length} tasks${cfg.validation.agent ? `, ${agent.label}` : ""})`, phase: phase.name });

    let verdict: PhaseVerdict;
    let actor = "orchestrator";
    try {
      const ref = await git.baseRef();
      await git.addDetachedWorktree(dir, ref);
      this.log(run, null, "git", { message: `phase worktree ${dir} at ${ref} (detached)` });
      for (const f of cfg.git.copyFiles) {
        const src = path.join(cfg.repo, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
      }
      const fail = (failure: string): PhaseVerdict => ({ verdict: "FAIL", failure, reasons: [], unmet: [], suggestions: [] });
      const setup = cfg.git.setupCommand ? await shell(cfg.git.setupCommand, dir, { timeoutMs: 15 * 60_000 }) : null;
      if (setup) this.log(run, null, "git", { message: `setup: ${cfg.git.setupCommand} → exit ${setup.code}`, output: clip(setup.stdout + setup.stderr, 2000) });
      const cmd = ctx.phase.command || cfg.validation.command;
      let gateOutput = "";
      if (setup && setup.code !== 0) {
        verdict = fail(`Setup command failed on ${cfg.baseBranch} (exit ${setup.code}): \`${cfg.git.setupCommand}\`\n\n${clip((setup.stdout + "\n" + setup.stderr).trim(), 4000)}`);
      } else {
        let gateFailed: PhaseVerdict | null = null;
        if (cmd) {
          this.log(run, null, "state", { message: `phase gate: ${cmd}`, phase: phase.name });
          const r = await shell(cmd, dir, { timeoutMs: 20 * 60_000 });
          gateOutput = clip((r.stdout + "\n" + r.stderr).trim(), 4000);
          this.log(run, null, "tool", { role: "phase gate", name: "shell", input: { command: cmd }, exit: r.code, output: clip(r.stdout + r.stderr, 3000) });
          if (r.code !== 0) gateFailed = fail(`Phase command failed on ${cfg.baseBranch} (exit ${r.code}): \`${cmd}\`\n\n${gateOutput}`);
        }
        if (gateFailed) verdict = gateFailed;
        else if (!cfg.validation.agent) verdict = { verdict: "PASS", failure: "", reasons: [], unmet: [], suggestions: [] };
        else {
          actor = "phase_validator";
          verdict = await this.runPhaseValidator(run, ctx, phase, own, dir, cmd, gateOutput, job);
        }
      }
    } catch (e: any) {
      const message = e?.message ?? String(e);
      this.log(run, null, "error", { message: `phase validation of "${label}" failed to run: ${message}` });
      if (!job.stopped) await this.phaseNeedsOwner(run, ctx, this.store.getPhase(phaseId)!, `Phase validation could not run: ${message}`);
      return;
    } finally {
      await git.removeWorktree(dir, false).catch(() => {});
    }
    if (job.stopped || this.store.getPhase(phaseId)?.status !== "validating") return; // run stopped meanwhile
    await this.applyPhaseVerdict(run, ctx, this.store.getPhase(phaseId)!, verdict, actor);
  }

  /** The phase validator agent (role `phaseValidator`) in the phase worktree; its JSON verdict per §13.2. */
  private async runPhaseValidator(run: Run, ctx: ProjectContext, phase: Phase, own: Task[], dir: string, cmd: string, gateOutput: string, job: { child: ChildProcess | null }): Promise<PhaseVerdict> {
    const { cfg } = ctx;
    const agent = this.agentFor(cfg, ctx.phase.role);
    const count = this.store.listPhases(run.id).length;
    const files = this.specFolder(run).files;
    const taskLines = own.map((t) => {
      const head = `### ${t.key}${t.synthetic ? " (fix-up)" : ""}: ${t.title} (${t.status})`;
      // §6.4: each task's brief frontmatter (its plan values as the owner wrote them), then its criteria.
      const brief = t.synthetic ? undefined : files[`tasks/${t.key}.md`];
      const fm = brief !== undefined ? parseFrontmatter(brief) : null;
      const front = fm?.present ? `Brief tasks/${t.key}.md frontmatter:\n${brief!.replace(/\r\n/g, "\n").split("\n").slice(0, fm.length).join("\n")}` : "";
      const crit = t.acceptance.length ? `Acceptance criteria:\n${t.acceptance.map((a) => `- ${a}`).join("\n")}` : "";
      return [head, front, crit, `Summary: ${t.summary ?? "(none)"}`].filter(Boolean).join("\n");
    });
    // spec.md in full (within specChars, cut recorded) and the rules; a folder without spec.md gives its context files.
    const specFiles = files["spec.md"] !== undefined ? { "spec.md": files["spec.md"] } : files;
    const contextFiles = files["spec.md"] !== undefined ? ["spec.md"] : cfg.handoff.contextFiles.filter((f) => files[f] !== undefined);
    const specContext = this.sectionedContext(run, null, `Phase "${phaseLabel(phase.name)}"`, { specFiles: Object.fromEntries(contextFiles.map((f) => [f, specFiles[f]])), rules: await this.projectRules(cfg) }, cfg);
    const prompt = render(loadPrompt("phase-validator", cfg.repo), {
      phase_label: phaseLabel(phase.name), phase_idx: phase.idx, phase_count: count, base_branch: cfg.baseBranch,
      phase_tasks: clip(taskLines.join("\n\n"), cfg.handoff.historyChars * 2),
      spec_context: specContext,
      command_section: cmd ? `\`${cmd}\` passed on ${cfg.baseBranch}. Its output:\n\n\`\`\`\n${gateOutput || "(no output)"}\n\`\`\`` : "(none configured; run the project's checks yourself)",
      fixup_section: phase.fixup_rounds ? `## Earlier rounds\nThis phase failed validation ${phase.fixup_rounds} time${phase.fixup_rounds > 1 ? "s" : ""} before; the fix-up tasks above were meant to fix that. Check that they did.` : "",
    });
    this.log(run, null, "state", { message: `phase validator started (${agent.label})`, phase: phase.name });
    const res = await runAgent({
      ...agent, cwd: dir, prompt,
      env: { ...this.apiEnv(), ORCH_RUN_ID: run.id, ORCH_ACTOR: "phase_validator", PATH: `${path.join(PKG_ROOT, "bin")}${path.delimiter}${process.env.PATH ?? ""}` },
      onSpawn: (c) => { job.child = c; },
      onEvent: (kind, data) => this.log(run, null, kind, { role: "phase_validator", phase: phase.name, ...data }),
    });
    job.child = null;
    addRunUsage(this.store, run.id, res); // §18: phase validator spend goes on the run row
    const v = res.structured ?? {};
    const strs = (x: any): string[] => (Array.isArray(x) ? x.map(String).filter((s) => s.trim()) : []);
    const word = String(v.verdict ?? "").toUpperCase();
    const reasons = strs(v.reasons), unmet = strs(v.unmet), suggestions = strs(v.suggestions);
    this.log(run, null, "verdict", { role: "phase_validator", phase: phase.name, verdict: word || "NONE", reasons, unmet, suggestions, cost_usd: res.costUsd });
    if (word === "PASS") return { verdict: "PASS", failure: "", reasons, unmet, suggestions };
    return {
      verdict: "FAIL", failure: `Phase validator verdict: ${word || "NONE"}`,
      reasons: reasons.length ? reasons : [clip(res.text, 1500) || "phase validator gave no verdict"], unmet, suggestions,
    };
  }

  /** PASS → passed. FAIL → a fix-up task while rounds remain (REQ-VAL-07), else the owner's inbox. */
  private async applyPhaseVerdict(run: Run, ctx: ProjectContext, phase: Phase, v: PhaseVerdict, actor: string) {
    const label = phaseLabel(phase.name);
    if (v.verdict === "PASS") {
      this.store.updatePhase(phase.id, { status: "passed" });
      this.decide(run, null, actor, `Phase "${label}" passed validation`, phase.fixup_rounds ? `after ${phase.fixup_rounds} fix-up round${phase.fixup_rounds > 1 ? "s" : ""}` : null);
      this.log(run, null, "state", { message: `phase "${label}" passed validation`, phase: phase.name });
      this.changed("phases", { runId: run.id });
      return;
    }
    const summary = clip([v.failure, ...v.reasons.map((r) => `- ${r}`), ...v.unmet.map((u) => `- UNMET: ${u}`)].filter(Boolean).join("\n"), 1500);
    this.decide(run, null, actor, `Phase "${label}" failed validation`, summary);
    const max = ctx.phase.maxFixups;
    if (phase.fixup_rounds >= max) {
      await this.phaseNeedsOwner(run, ctx, phase, `${max ? `${phase.fixup_rounds} fix-up round${phase.fixup_rounds === 1 ? "" : "s"} used (validation.phase.maxFixups = ${max})` : "fix-up tasks are off (validation.phase.maxFixups = 0)"}`, summary);
      return;
    }
    const round = phase.fixup_rounds + 1;
    const tasks = this.store.listTasks(run.id);
    const phases = this.store.listPhases(run.id);
    const idxOf = new Map(phases.map((p) => [p.name, p.idx]));
    const own = tasks.filter((t) => phaseName(t.phase) === phase.name);
    const later = tasks.filter((t) => (idxOf.get(phaseName(t.phase)) ?? 0) > phase.idx);
    const plan = planFixup(
      { name: phase.name, idx: phase.idx, lastOrderIdx: Math.max(...own.map((t) => t.order_idx)) },
      round, v,
      later.map((t) => ({ key: t.key, orderIdx: t.order_idx, status: t.status, dependsOn: t.depends_on })),
    );
    const byKey = new Map(tasks.map((t) => [t.key, t]));
    // Later tasks move down first so the fix-up's order_idx is free.
    for (const r of plan.reorder) this.store.updateTask(byKey.get(r.taskKey)!.id, { order_idx: r.orderIdx });
    const fix = this.store.insertTask({
      run_id: run.id, key: plan.task.key, title: plan.task.title, description: plan.task.description, acceptance: plan.task.acceptance,
      depends_on: plan.task.dependsOn, parallel: 0, phase: plan.task.phase, order_idx: plan.task.orderIdx, status: "pending",
      attempt: 0, max_attempts: ctx.cfg.scheduler.maxAttempts, merge_policy: plan.task.mergePolicy, validate_cmd: null,
      worktree: null, branch: null, pr_url: null, session_id: null, summary: null, files: [], last_feedback: null, synthetic: true,
    });
    for (const e of plan.edges) {
      const t = byKey.get(e.taskKey)!;
      this.store.updateTask(t.id, { depends_on: [...t.depends_on, e.dependsOn] });
    }
    this.store.updatePhase(phase.id, { status: "pending", fixup_rounds: round });
    this.decide(run, fix, "orchestrator", `Created fix-up task ${fix.key} for phase "${label}" (round ${round}/${max}); later phases wait for it`, clip(v.reasons.join("; ") || v.failure, 300));
    this.log(run, fix, "state", { message: `fix-up task ${fix.key} created from the phase validation failure`, feedback: clip(fix.description, 2000) });
    this.changed("tasks", { runId: run.id });
    this.changed("phases", { runId: run.id });
  }

  /** The phase waits for the owner (inbox item with Re-run and Accept) and a notification goes out (REQ-HITL-01). */
  private async phaseNeedsOwner(run: Run, ctx: ProjectContext, phase: Phase, why: string, detail: string | null = null) {
    const label = phaseLabel(phase.name);
    this.store.updatePhase(phase.id, { status: "needs_human" });
    this.decide(run, null, "orchestrator", `Phase "${label}" needs the owner: ${why}`, detail);
    this.changed("phases", { runId: run.id });
    await this.notify(ctx, `Phase needs you: ${label}`, clip(`${why}. Re-run the phase validation or accept the phase in the inbox.`, 300), { priority: "high", tags: ["warning"] });
  }

  /** The phase row for an owner action, which must be waiting on the owner. */
  private ownerPhase(phaseId: number, action: string): { phase: Phase; run: Run } {
    const phase = this.store.getPhase(phaseId);
    if (!phase) throw new NotFoundError(`no phase ${phaseId}`);
    const run = this.store.getRun(phase.run_id);
    if (!run) throw new NotFoundError(`no run '${phase.run_id}'`);
    if (phase.status !== "needs_human" && phase.status !== "failed") throw new Error(`phase "${phaseLabel(phase.name)}" is ${phase.status}; only a phase waiting on you can be ${action}`);
    return { phase, run };
  }
  /** Owner: validate the phase again (e.g. after fixing it by hand). The fix-up round count is kept. */
  revalidatePhase(phaseId: number) {
    const { phase, run } = this.ownerPhase(phaseId, "re-run");
    this.store.updatePhase(phase.id, { status: "pending" });
    this.decide(run, null, "human", `Re-running validation of phase "${phaseLabel(phase.name)}"`, null);
    this.changed("phases", { runId: run.id });
    void this.tick();
  }
  /** Owner: accept the phase as it is; later phases proceed. */
  acceptPhase(phaseId: number) {
    const { phase, run } = this.ownerPhase(phaseId, "accepted");
    this.store.updatePhase(phase.id, { status: "passed" });
    this.decide(run, null, "human", `Accepted phase "${phaseLabel(phase.name)}" without passing validation`, null);
    this.changed("phases", { runId: run.id });
    void this.tick();
  }

  // ------------------------------------------------------------------ human actions
  async answerQuestion(questionId: number, answer: string) {
    const q = this.store.getQuestion(questionId);
    if (!q) throw new Error("question not found");
    if (q.answer) throw new Error("already answered");
    this.store.answerQuestion(questionId, answer);
    const run = this.store.getRun(q.run_id)!;
    const task = q.task_id ? this.store.getTask(q.task_id) ?? null : null; // null task_id = plan question
    this.decide(run, task, "human", `Answered${task ? "" : " plan question"}: ${clip(q.text, 120)} → ${answer}`, null);
    this.changed("questions", { runId: run.id });
    if (task?.status === "needs_input") await this.resumeAfterAnswer(run, task);
    // The last plan question answered: tasks may start now rather than at the next timer tick.
    if (!task && run.status === "running" && !this.openPlanQuestions(run.id).length) setTimeout(() => void this.tick(), 50);
  }
  /** Unanswered questions of the run that belong to no task (plan questions, REQ-INTAKE-07). */
  private openPlanQuestions(runId: string): Question[] {
    return this.store.listQuestions(runId, true).filter((q) => !q.task_id);
  }
  /**
   * T10/T11: once every question is answered, continue the worker without consuming an attempt
   * (run running) or put the task back to pending (run not running).
   */
  private async resumeAfterAnswer(run: Run, task: Task) {
    // A resume skips readiness, but must still not run beside a task that owns overlapping files (REQ-SCHED-02);
    // the next tick retries it.
    const blocker = this.store.listTasks(run.id).find((o) => o.id !== task.id && ACTIVE.includes(o.status) && ownedOverlap(task.files_owned, o.files_owned));
    if (blocker) { this.decideOverlapHold(run, task, blocker); return; }
    const r = await this.fire(run, task.id, { type: "answered", openQuestions: this.store.openQuestionsForTask(task.id).length, runStatus: run.status });
    if (r.rejected || r.status !== "running") return;
    await this.runTask(run, this.store.getTask(task.id)!, !!task.session_id, true);
  }
  /** "Holding X until Y finishes", recorded once per pair per run (also across restarts, via the stored decisions). */
  private decideOverlapHold(run: Run, task: Task, blocker: Task) {
    const text = `Holding ${task.key} until ${blocker.key} finishes: their owned files overlap`;
    if (this.store.listDecisions(run.id).some((d) => d.actor === "orchestrator" && d.text === text)) return;
    this.decide(run, task, "orchestrator", text, `${task.key} owns ${task.files_owned.join(", ")}; ${blocker.key} owns ${blocker.files_owned.join(", ")}`);
  }
  private resumePrompt(task: Task): string {
    const answered = this.store.listQuestions(task.run_id).filter((q) => q.task_id === task.id && q.answer);
    const qa = answered.map((q) => `Q: ${q.text}\nA: ${q.answer}`).join("\n\n");
    const qaSection = qa ? `\n\n## Answers to your questions\n${qa}` : "";
    const fb = task.last_feedback ? `\n\n## Feedback to address\n${task.last_feedback}` : "";
    return `You are being resumed by the orchestrator on task ${task.key}.${qaSection}${fb}\n\nContinue the task from where you left off. Commit your work. Finish with the same JSON block as before (status "done").`;
  }

  /** `orch ask` from a worker: record and let the worker end its turn. */
  recordQuestion(taskId: string, text: string, options: string[]) {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("task not found");
    const run = this.store.getRun(task.run_id)!;
    const q = this.store.addQuestion(run.id, task.id, text, options);
    this.log(run, task, "question", { id: q.id, text, options });
    this.changed("questions", { runId: run.id });
    return q;
  }
  /** `orch decide` from an agent. */
  recordDecision(taskId: string | null, runId: string | null, actor: string, text: string, rationale: string | null) {
    const task = taskId ? this.store.getTask(taskId) : undefined;
    const fallback = () => { const p = this.defaultProject(); return p ? this.currentRun(p.id) : undefined; };
    const run = task ? this.store.getRun(task.run_id) : runId ? this.store.getRun(runId) : fallback();
    if (!run) throw new Error("no run");
    return this.decide(run, task ?? null, actor, text, rationale);
  }

  /**
   * An owner action: decide synchronously (a rejected event throws, so the API answers with the reason),
   * then apply. The state change is synchronous; only effects such as merges and worktree removal are awaited.
   */
  private human(taskId: string, event: TaskEvent, opts: ApplyOptions = {}): Promise<TransitionResult> {
    const { task, result } = this.transition(taskId, event);
    if (result.rejected) throw new Error(result.reason ?? `${event.type} is not allowed for a ${task.status} task`);
    return this.applyTransition(this.store.getRun(task.run_id)!, task, result, opts);
  }

  /** T12: budgets reset, the scheduler picks the task up again. */
  async retryTask(taskId: string) {
    await this.human(taskId, { type: "human_retry" });
    void this.tick();
  }
  /** T13. */
  skipTask(taskId: string) {
    void this.human(taskId, { type: "human_skip" }).then(() => this.tick(), (e) => console.error("[skip]", e));
  }
  /** T15: the owner approves a pr_open/pr_checks task; merge errors are thrown back to the owner. */
  async mergeTask(taskId: string) {
    await this.human(taskId, { type: "human_merge" }, { onEffectError: "throw" });
  }
  /** T16: the owner marks a task as merged elsewhere (e.g. merged on GitHub by hand). */
  async markMerged(taskId: string) {
    await this.human(taskId, { type: "human_mark_merged" });
  }
  /**
   * T17: the owner sends a task awaiting review (pr_open/pr_checks) back to the worker with written
   * feedback. Fix round of kind human: the round cap does not apply; recorded as a human decision.
   */
  async requestChanges(taskId: string, feedback: string) {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("task not found");
    const text = String(feedback ?? "").trim();
    if (!text) throw new Error("feedback is required");
    await this.startFixRound(this.store.getRun(task.run_id)!, task, "human", text, clip(text.split("\n")[0], 200));
  }

  /** The task's changes against its base for the review view (§11). Throws NotFound when there is no worktree. */
  async taskDiff(taskId: string) {
    const task = this.store.getTask(taskId);
    if (!task) throw new NotFoundError("task not found");
    if (!task.worktree || !fs.existsSync(task.worktree)) {
      const why = task.status === "done" ? "the task is merged and its worktree was removed"
        : task.status === "pending" && task.attempt === 0 ? "the task has not started yet"
        : "the task has no worktree";
      throw new NotFoundError(`diff unavailable: ${why}`);
    }
    return this.ctxOf(this.store.getRun(task.run_id)!).git.diffFiles(task.worktree);
  }

  /** Stop the UI-mode app of a task, if one is running. */
  private async stopApp(taskId: string) {
    const app = this.apps.get(taskId);
    if (!app) return;
    this.apps.delete(taskId);
    await app.stop();
  }
  /** Stop a task's started UI-mode app and log it, once: later calls (or an app already gone) do nothing. */
  private async stopUiApp(run: Run, task: Task, app: AppProcess) {
    if (this.apps.get(task.id) !== app) return;
    await this.stopApp(task.id);
    this.log(run, task, "state", { message: `app stopped (pid ${app.pid})` });
  }
  /** Daemon shutdown (SIGINT/SIGTERM): stop every UI-mode app so none outlives orch (REQ-VAL-08). */
  async shutdown() {
    await Promise.all([...this.apps.keys()].map((id) => this.stopApp(id).catch((e) => console.error("[shutdown]", e))));
  }

  /** T14: only active tasks can be stopped. */
  stopTask(taskId: string) {
    void this.human(taskId, { type: "human_stop" }).catch((e) => console.error("[stop]", e));
  }

  // ------------------------------------------------------------------ hand-off brief
  private handoff(cfg: Config, run: Run, task: Task): string {
    const tasks = this.store.listTasks(run.id);
    const done = tasks.filter((t) => t.status === "done" && t.order_idx < task.order_idx);
    const depKeys = new Set(task.depends_on);
    const lines: string[] = [];
    // Direct dependencies first and in full; others summarized briefly.
    for (const t of done) {
      const direct = depKeys.has(t.key);
      const files = t.files.length ? ` Files: ${t.files.slice(0, 8).join(", ")}${t.files.length > 8 ? ", …" : ""}` : "";
      lines.push(`- **${t.key}** ${t.title}${direct ? " (direct dependency)" : ""}: ${direct ? (t.summary ?? "(no summary)") : clip(t.summary ?? "(no summary)", 200)}${files}`);
    }
    const decisions = this.store.listDecisions(run.id).filter((d) => d.actor !== "human" || true).slice(-25);
    const decLines = decisions.map((d) => `- [${d.actor}] ${d.text}${d.rationale ? ` — ${d.rationale}` : ""}`);
    const answered = this.store.listQuestions(run.id).filter((q) => q.answer);
    const qaLines = answered.map((q) => `- Q: ${q.text} → A: ${q.answer}`);
    const parts = [
      lines.length ? `### Completed tasks\n${lines.join("\n")}` : "### Completed tasks\n(none yet — you are first)",
      decLines.length ? `### Decisions so far\n${decLines.join("\n")}` : "",
      qaLines.length ? `### Human answers so far\n${qaLines.join("\n")}` : "",
    ].filter(Boolean);
    return clip(parts.join("\n\n"), cfg.handoff.historyChars);
  }

  // ------------------------------------------------------------------ snapshot for UI
  /** The run a project's views show by default: its current run, else its newest. */
  private shownRun(projectId: string): Run | undefined {
    return this.currentRun(projectId) ?? this.store.listRuns(projectId)[0];
  }
  /**
   * Inbox items of one run (§14), derived from its tasks and questions; never from the events table.
   * Pass `tasks`/`questions` when the caller already loaded them.
   */
  private runInbox(run: Run, tasks: Task[] = this.store.listTasks(run.id), questions: Question[] = this.store.listQuestions(run.id, true), decisions?: Decision[]): any[] {
    const inbox: any[] = [];
    if (run.status === "plan_pending") inbox.push({ type: "approve_plan", run_id: run.id, title: "Plan awaits approval", detail: `${tasks.length} tasks`, ts: run.updated_at });
    for (const q of questions.filter((q) => !q.answer)) {
      const t = tasks.find((x) => x.id === q.task_id);
      inbox.push({ type: "question", id: q.id, run_id: run.id, task_id: q.task_id, task_key: t?.key, plan: !q.task_id, title: q.text, options: q.options, ts: q.ts });
    }
    for (const t of tasks) {
      if (t.status === "failed") inbox.push({ type: "failed", run_id: run.id, task_id: t.id, task_key: t.key, title: `${t.key} failed after ${t.attempt} attempts`, detail: t.last_feedback, ts: t.updated_at });
      if (t.status === "pr_open") inbox.push({ type: "merge", run_id: run.id, task_id: t.id, task_key: t.key, title: `${t.key} ready to merge`, detail: t.pr_url ?? t.branch, pr_url: t.pr_url, feedback: t.last_feedback, ci_status: t.ci_status, fix_rounds: t.fix_rounds, ts: t.updated_at });
    }
    // Phases whose validation failed after the fix-up rounds (§10.3); the detail is the latest failure.
    const waiting = this.store.listPhases(run.id).filter((p) => p.status === "needs_human" || p.status === "failed");
    if (waiting.length) {
      const decs = decisions ?? this.store.listDecisions(run.id);
      for (const p of waiting) {
        const last = lastPhaseFailure(decs, p);
        inbox.push({ type: "phase", run_id: run.id, phase_id: p.id, phase_name: p.name, title: `Phase "${phaseLabel(p.name)}" failed validation`, detail: last?.rationale ?? null, fixup_rounds: p.fixup_rounds, ts: p.updated_at });
      }
    }
    return inbox;
  }

  /**
   * Snapshot of a project (§15.1): the run `runId` (which must belong to the project), else its current
   * (or newest) run. Without a project: the run `runId`'s project, else the default project (legacy routes).
   * `runs` and `config` are the project's. Reads tasks, questions and decisions only, never the events
   * table, so its cost does not grow with the event log (REQ-NFR-06).
   */
  snapshot(projectId?: string, runId?: string) {
    let run: Run | undefined;
    let project: Project | undefined;
    if (projectId) project = this.requireProject(projectId);
    if (runId) {
      run = this.store.getRun(runId);
      if (!run) throw new NotFoundError(`no run '${runId}'`);
      if (project && run.project_id !== project.id) throw new NotFoundError(`run ${runId} is not in project '${project.id}'`);
      if (!project && run.project_id) project = this.store.getProject(run.project_id);
    } else {
      project ??= this.defaultProject();
      if (project) run = this.shownRun(project.id);
    }
    const runs = project ? this.store.listRuns(project.id) : [];
    const common = {
      project: project ? { id: project.id, name: project.name, repo: project.repo_path, archived: project.archived } : null,
      runs, config: this.publicConfig(project),
    };
    const projectTotal = project ? projectTotals(this.store, project.id) : null;
    if (!run) return { ...common, totals: { run: null, project: projectTotal }, run: null, tasks: [], decisions: [], questions: [], phases: [], inbox: [], inboxCount: 0 };
    const tasks = this.store.listTasks(run.id);
    const questions = this.store.listQuestions(run.id);
    const decisions = this.store.listDecisions(run.id);
    const inbox = this.runInbox(run, tasks, questions, decisions);
    // §18: cost and agent time, from rows only. A legacy run without a project counts as its own project.
    const totals = { run: runTotals(this.store, run.id), project: projectTotal ?? runTotals(this.store, run.id) };
    return { ...common, totals, run, tasks, decisions, questions, phases: this.store.listPhases(run.id), inbox, inboxCount: inbox.length };
  }

  /**
   * Every registered project for the project list (§15.1): `{id, name, repo, archived, error, run, inboxCount}`.
   * `error` is why the project cannot be used (missing repo, invalid settings), else null.
   */
  listProjectSummaries(opts: { archived?: boolean } = {}) {
    return this.store.listProjects(opts).map((p) => {
      const run = this.shownRun(p.id);
      return {
        id: p.id, name: p.name, repo: p.repo_path, archived: p.archived,
        error: this.projectError(p),
        run: run ? { id: run.id, status: run.status, title: run.title } : null,
        inboxCount: run && !p.archived ? this.runInbox(run).length : 0,
      };
    });
  }
  private projectError(p: Project): string | null {
    if (!fs.existsSync(p.repo_path)) return `repository ${p.repo_path} does not exist`;
    if (p.archived) return null;
    try { this.context(p.id); return null; } catch (e: any) { return e?.message ?? String(e); }
  }

  /** Global inbox (REQ-HITL-01, §14): the items of every non-archived project's shown run, each labelled with its project. */
  globalInbox() {
    const items: any[] = [];
    for (const p of this.store.listProjects()) {
      const run = this.shownRun(p.id);
      if (!run) continue;
      for (const item of this.runInbox(run)) items.push({ ...item, project_id: p.id, project_name: p.name });
    }
    return items;
  }
  /** Settings the dashboard may show: secrets only as booleans (§16). A project whose settings fail to load shows the error. */
  private publicConfig(project?: Project) {
    const s = this.server;
    const server = { maxAgents: s.scheduler.maxAgents, ntfy: !!s.notify.ntfyUrl, ntfyToken: !!s.notify.ntfyToken, auth: !!s.auth.token };
    if (!project) return { repo: null, ...server };
    let c: Config, ph: ProjectContext["phase"], ui: ProjectContext["ui"];
    try {
      ({ cfg: c, phase: ph, ui } = this.context(project.id));
    } catch (e: any) {
      return { repo: project.repo_path, error: e?.message ?? String(e), ...server };
    }
    return { repo: c.repo, baseBranch: c.baseBranch, maxParallel: c.scheduler.maxParallel, maxAttempts: c.scheduler.maxAttempts, pr: c.git.pr, mergePolicy: c.git.mergePolicy, validationCommand: c.validation.command, validatorAgent: c.validation.agent, roles: Object.fromEntries(Object.entries({ ...c.agents.roles, phaseValidator: ph.role }).map(([k, v]) => [k, `${c.agents.adapters[v.adapter]?.type ?? v.adapter}${v.model ? ":" + v.model : ""}`])), phaseValidation: { enabled: ph.enabled, command: ph.command, maxFixups: ph.maxFixups }, uiValidation: { startCommand: ui.startCommand, url: ui.url, readyTimeoutSeconds: ui.readyTimeoutSeconds }, ...server, prFeedback: c.git.pr && c.git.feedback.enabled ? { waitForChecks: c.git.feedback.waitForChecks, maxRounds: c.git.feedback.maxRounds, trigger: c.git.feedback.trigger } : null };
  }

  /** On daemon start: anything that was 'running' when we died goes back to pending. */
  recover() {
    // UI-mode apps a crashed daemon left running (§10.4): their pidfiles name the task.
    const leftovers = killLeftovers(runDir(this.home));
    for (const l of leftovers.found) {
      const task = this.store.getTask(l.taskId);
      const message = l.alive ? `daemon restarted: stopped the leftover UI app (pid ${l.pid})` : `daemon restarted: removed the pidfile of UI app pid ${l.pid} (already gone)`;
      if (task) this.log(task.run_id, task, "state", { message });
      else console.warn(`[recover] ${message} for unknown task ${l.taskId}`);
    }
    leftovers.done.catch((e) => console.error("[recover] leftover apps:", e));
    for (const run of this.store.listRuns()) {
      if (CLOSED_RUN.has(run.status)) continue;
      for (const t of this.store.listTasks(run.id)) {
        if (ACTIVE.includes(t.status)) {
          // T14: no effects, applied synchronously.
          this.fire(run, t.id, { type: "daemon_restart" }).catch((e) => console.error("[recover]", e));
          this.log(run, t, "state", { message: "daemon restarted while task was active; task reset to pending (worktree kept)" });
        }
      }
      for (const p of this.store.listPhases(run.id)) {
        if (p.status !== "validating") continue;
        this.store.updatePhase(p.id, { status: "pending" }); // validated again by the next phase check
        this.log(run, null, "state", { message: `daemon restarted during validation of phase "${phaseLabel(p.name)}"; it runs again` });
      }
      if (run.status === "planning") this.store.setRunStatus(run.id, "plan_pending");
    }
    this.ensureTicking();
  }
}

/** Task fields the owner may edit (REQ-INTAKE-09). */
const EDITABLE = ["title", "description", "acceptance", "depends_on", "merge_policy", "validate_cmd", "validate_mode", "max_attempts", "files_owned"] as const;
type EditableField = (typeof EDITABLE)[number];

/** Planner/owner `files_owned`: trimmed non-empty strings, no duplicates. */
function cleanOwned(v: unknown[]): string[] {
  return [...new Set(v.map((x) => String(x).trim()).filter(Boolean))];
}
/** The owned-files section of the worker and validator prompts. */
function ownedSection(owned: string[]): string {
  return owned.length ? owned.map((f) => `- \`${f}\``).join("\n") : "(none declared: any file may change)";
}

/** The task's gate command: its own, else the project's `validation.command` (§10.1). */
function validateCmd(cfg: Config, task: Task): string {
  return task.validate_cmd || cfg.validation.command;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
}

/** Why a phase waits on the owner: the newest hand-over decision's failure summary, else its text. */
function lastPhaseFailure(decisions: Decision[], phase: Phase): { rationale: string | null } | undefined {
  const label = phaseLabel(phase.name);
  for (let i = decisions.length - 1; i >= 0; i--) {
    const d = decisions[i];
    if (d.text.startsWith(`Phase "${label}" needs the owner: `)) return { rationale: d.rationale ?? d.text };
  }
  return undefined;
}
