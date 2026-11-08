import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Config, ServerConfig } from "./config.js";
import { loadProjectConfig, toLegacyConfig, DEFAULT_PROJECT_CONFIG } from "./config.js";
import type { Store } from "./db.js";
import { Git, shell } from "./git.js";
import { runAgent, getAdapter } from "./adapters/index.js";
import type { RoleName } from "./config.js";
import { loadPrompt, render, clip, PKG_ROOT } from "./prompts.js";
import { notify, type NotifyOptions } from "./notify.js";
import { readSpecDir, parseTasksMd, markTaskDoneInFile } from "./speckit.js";
import type { Project, Question, Run, Task, TaskStatus } from "./types.js";
import { formatReviewFeedback, formatCiFeedback } from "./prfeedback.js";
import { selectReady } from "./core/readiness.js";
import { nextTaskState, type TaskEvent, type TransitionResult, type Effect } from "./core/transitions.js";
import { decidePrAction } from "./core/prpoll.js";
import { UNFINISHED_RUN_STATUSES, resolveProjectForCwd, registerProject, archiveProject, type RegisterResult } from "./projects.js";
import { orchHome } from "./paths.js";

const FINISHED: TaskStatus[] = ["done", "skipped"];
const ACTIVE: TaskStatus[] = ["running", "validating"];
/** Tasks with an open PR that the feedback loop watches. */
const WATCHED: TaskStatus[] = ["pr_checks", "pr_open"];
/** Effects that can fail and must succeed before the transition is applied (§8: failure → T9). */
const MERGE_EFFECTS: Effect[] = ["merge_local", "push_and_pr", "merge_pr"];
const nowIso = () => new Date().toISOString();
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
  /** Unknown settings keys that were ignored; logged to the run's activity when the context is rebuilt. */
  warnings: string[];
}

export class Orchestrator extends EventEmitter {
  private procs = new Map<string, ChildProcess>(); // task id -> running agent
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
    return { project, cfg, git: new Git(cfg.repo, cfg.baseBranch, cfg.git.ghCommand), warnings: loaded.warnings };
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
    const r = cfg.agents.roles[role];
    const adapterConfig = cfg.agents.adapters[r.adapter];
    return { adapter: getAdapter(adapterConfig.type), adapterConfig, model: r.model || undefined, timeoutMs: cfg.agents.timeoutMinutes * 60_000, label: `${adapterConfig.type}${r.model ? ":" + r.model : ""}` };
  }
  private specContext(cfg: Config, run: Run): string {
    const spec = readSpecDir(run.spec_dir);
    const parts: string[] = [];
    for (const f of cfg.handoff.contextFiles) if (spec.files[f]) parts.push(`### ${f}\n${spec.files[f]}`);
    return clip(parts.join("\n\n"), cfg.handoff.specChars);
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
   * Import a Spec Kit dir into a new run of `projectId`. With llm=true the planner agent enriches tasks.
   * Refused while the project has an unfinished run (REQ-PROJ-07). The project's settings are re-read here.
   */
  async plan(projectId: string, specDir: string, opts: { llm: boolean }): Promise<Run> {
    if (this.requireProject(projectId).archived) throw new Error(`project '${projectId}' is archived; register its repo again to use it`);
    const open = this.unfinishedRun(projectId);
    if (open) throw this.refusal(projectId, open);
    const ctx = this.refreshContext(projectId), cfg = ctx.cfg;
    const spec = readSpecDir(specDir);
    const tasksMd = spec.files["tasks.md"];
    if (!tasksMd) throw new Error(`no tasks.md in ${spec.dir}. Run /speckit.tasks first.`);
    const imported = parseTasksMd(tasksMd);
    if (!imported.length) throw new Error(`no tasks found in ${path.join(spec.dir, "tasks.md")}`);

    const run = this.store.createRun(spec.dir, spec.title, cfg.baseBranch, opts.llm ? "planning" : "plan_pending", projectId);
    this.changed("run", { run, projectId });
    this.logWarnings(run, ctx);
    this.log(run, null, "state", { message: `imported ${imported.length} tasks from ${path.relative(cfg.repo, spec.dir)}` });

    for (const t of imported) {
      this.store.insertTask({
        run_id: run.id, key: t.key, title: t.title, description: t.description, acceptance: [], depends_on: t.depends_on,
        parallel: t.parallel ? 1 : 0, phase: t.phase, order_idx: t.order_idx, status: t.done ? "done" : "pending",
        attempt: 0, max_attempts: cfg.scheduler.maxAttempts, merge_policy: cfg.git.mergePolicy,
        validate_cmd: null, worktree: null, branch: null, pr_url: null, session_id: null, summary: t.done ? "(already complete before this run)" : null,
        files: [], last_feedback: null,
      });
    }
    this.changed("tasks", { runId: run.id });
    if (!opts.llm) return run;

    // Planner agent enriches the plan.
    const tasks = this.store.listTasks(run.id);
    const tasksJson = JSON.stringify(tasks.map((t) => ({ key: t.key, title: t.description, phase: t.phase, parallel: !!t.parallel, depends_on: t.depends_on, done: t.status === "done" })), null, 2);
    const specContext = Object.entries(spec.files).filter(([f]) => f !== "tasks.md").map(([f, c]) => `### ${f}\n${c}`).join("\n\n");
    const prompt = render(loadPrompt("planner", cfg.repo), { title: run.title, spec_context: clip(specContext, cfg.handoff.specChars * 2), tasks_json: tasksJson });

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
    const out = res.structured;
    if (!res.ok || !out?.tasks) {
      this.log(run, null, "error", { message: "planner failed or returned no plan; using imported tasks as-is", text: clip(res.text, 2000) });
      this.decide(run, null, "orchestrator", "Planner produced no usable output; proceeding with tasks.md as imported", res.text ? clip(res.text, 300) : null);
    } else {
      for (const pt of out.tasks) {
        const t = this.store.getTaskByKey(run.id, pt.key);
        if (!t) continue;
        const patch: Partial<Task> = {};
        if (Array.isArray(pt.acceptance)) patch.acceptance = pt.acceptance.map(String);
        if (Array.isArray(pt.depends_on)) patch.depends_on = pt.depends_on.map(String).filter((k: string) => k !== t.key && tasks.some((x) => x.key === k));
        if (pt.merge_policy === "manual" || pt.merge_policy === "auto") patch.merge_policy = pt.merge_policy;
        if (typeof pt.validate_cmd === "string" && pt.validate_cmd.trim()) patch.validate_cmd = pt.validate_cmd.trim();
        this.store.updateTask(t.id, patch);
      }
      for (const d of out.decisions ?? []) this.decide(run, null, "planner", String(d.text ?? d), d.rationale ?? null);
      for (const q of out.questions ?? []) {
        // Plan-level questions attach to the first pending task so they surface in the inbox.
        const first = tasks.find((t) => t.status === "pending");
        if (first) {
          const question = this.store.addQuestion(run.id, first.id, `[plan] ${q.text}`, Array.isArray(q.options) ? q.options.map(String) : []);
          this.log(run, first, "question", { text: question.text, options: question.options, id: question.id });
        }
      }
      this.log(run, null, "state", { message: "planner finished", cost_usd: res.costUsd });
    }
    this.store.setRunStatus(run.id, "plan_pending");
    this.changed("run", { run: this.store.getRun(run.id) });
    this.changed("tasks", { runId: run.id });
    await this.notify(ctx, `Plan ready: ${run.title}`, `${tasks.length} tasks. Review and approve in the dashboard.`, { tags: ["clipboard"] });
    return this.store.getRun(run.id)!;
  }

  /** Human edits to the plan before approval (also allowed later for pending tasks). */
  editTask(taskId: string, patch: Partial<Pick<Task, "title" | "description" | "acceptance" | "depends_on" | "merge_policy" | "validate_cmd" | "max_attempts">>) {
    const t = this.store.getTask(taskId);
    if (!t) throw new Error("task not found");
    this.store.updateTask(taskId, patch);
    const run = this.store.getRun(t.run_id)!;
    this.decide(run, t, "human", `Edited task ${t.key}: ${Object.keys(patch).join(", ")}`, null);
    this.changed("tasks", { runId: t.run_id });
  }

  approvePlan(runId: string) {
    const run = this.store.getRun(runId);
    if (!run) throw new Error("run not found");
    if (run.status !== "plan_pending") throw new Error(`run is ${run.status}, not plan_pending`);
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

      // Readiness is decided by src/core (§7.1); tasks are re-read so resumed ones count as active.
      const tasksByRun = new Map(entries.map((e) => [e.run.id, this.store.listTasks(e.run.id)]));
      const { start } = selectReady({
        maxAgents: this.server.scheduler.maxAgents,
        busyAgents: this.busyAgents,
        projects: entries.map(({ project, run, ctx }) => ({
          id: project.id, runId: run.id, runStatus: ctx ? run.status : null, maxParallel: ctx?.cfg.scheduler.maxParallel ?? 0,
          lastStartAt: project.last_start_at, planQuestionsOpen: 0, resumeOnRetry: ctx?.cfg.scheduler.resumeOnRetry ?? false,
        })),
        tasks: entries.flatMap(({ project, run, ctx }) => {
          const supportsResume = ctx ? this.roleAgent(ctx.cfg, "worker").adapter.supportsResume : false;
          return tasksByRun.get(run.id)!.map((t) => ({
            id: t.id, projectId: project.id, runId: t.run_id, key: t.key, orderIdx: t.order_idx, status: t.status, dependsOn: t.depends_on, filesOwned: [],
            openQuestions: t.status === "pending" ? this.store.openQuestionsForTask(t.id).length : 0,
            attempt: t.attempt, fixRounds: t.fix_rounds, hasSession: !!t.session_id, adapterSupportsResume: supportsResume,
          }));
        }),
      });
      const taskById = new Map([...tasksByRun.values()].flat().map((t) => [t.id, t]));
      const runById = new Map(entries.map((e) => [e.run.id, e]));
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
    const doneKeys = new Set(tasks.filter((t) => FINISHED.includes(t.status)).map((t) => t.key));
    const unfinished = tasks.filter((t) => !FINISHED.includes(t.status));
    if (!unfinished.length) {
      this.store.setRunStatus(run.id, "done");
      this.log(run, null, "state", { message: "all tasks done" });
      this.changed("run", { run: this.store.getRun(run.id) });
      await this.notify(ctx, `Run complete: ${run.title}`, `${tasks.length} tasks finished.`, { tags: ["tada"], priority: "high" });
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
            acceptance: this.bullets(task.acceptance), spec_context: this.specContext(cfg, run),
            handoff: this.handoff(cfg, run, task), branch, base_branch: cfg.baseBranch,
            validate_hint: validateCmd(cfg, task) ? ` (\`${validateCmd(cfg, task)}\` must pass)` : "",
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
    const { cfg, git } = this.ctxOf(run);

    if ((await git.commitsAhead(worktree)) === 0) {
      await this.failOrRetry(run, task, "No commits on the task branch; the worker produced no changes.");
      return;
    }

    // 1. Deterministic gate.
    const cmd = validateCmd(cfg, task);
    if (cmd) {
      this.log(run, task, "state", { message: `validation gate: ${cmd}` });
      const r = await shell(cmd, worktree, { timeoutMs: 20 * 60_000 });
      this.log(run, task, "tool", { role: "gate", name: "shell", input: { command: cmd }, exit: r.code, output: clip(r.stdout + r.stderr, 3000) });
      if (r.code !== 0) {
        await this.failOrRetry(run, task, `Validation command failed (exit ${r.code}): \`${cmd}\`\n\n${clip(r.stdout + "\n" + r.stderr, 4000)}`);
        return;
      }
    }

    // 2. Independent validator agent.
    if (cfg.validation.agent) {
      const validatorAgent = this.roleAgent(cfg, "validator");
      this.log(run, task, "state", { message: `validator started (${validatorAgent.label})` });
      const diff = await git.diffFromBase(worktree);
      const prompt = render(loadPrompt("validator", cfg.repo), {
        task_key: task.key, task_title: task.title, task_description: task.description, acceptance: this.bullets(task.acceptance),
        worker_summary: task.summary ?? "(none)", diff, branch: task.branch, base_branch: cfg.baseBranch,
        validate_hint: cmd ? ` (\`${cmd}\` already passed; re-run or extend it)` : "",
      });
      const res = await runAgent({
        ...validatorAgent, cwd: worktree, prompt, env: this.taskEnv(task, "validator"),
        onSpawn: (c) => this.procs.set(task.id, c),
        onEvent: (kind, data) => this.log(run, task, kind, { role: "validator", ...data }),
      });
      this.procs.delete(task.id);
      const cur = this.store.getTask(task.id)!;
      if (cur.status !== "validating") return; // stopped
      const v = res.structured ?? {};
      const verdict = String(v.verdict ?? "").toUpperCase();
      this.log(run, task, "verdict", { verdict: verdict || "NONE", reasons: v.reasons ?? [], criteria: v.criteria ?? [], suggestions: v.suggestions ?? [], cost_usd: res.costUsd });
      if (verdict !== "PASS") {
        const reasons = Array.isArray(v.reasons) && v.reasons.length ? v.reasons.map((r: any) => `- ${r}`).join("\n") : clip(res.text, 1500) || "validator gave no verdict";
        const unmet = Array.isArray(v.criteria) ? v.criteria.filter((c: any) => c && c.met === false).map((c: any) => `- UNMET: ${c.criterion} (${c.evidence ?? "no evidence"})`).join("\n") : "";
        await this.failOrRetry(run, task, `Validator verdict: ${verdict || "NONE"}\n${reasons}\n${unmet}`);
        return;
      }
      this.decide(run, task, "validator", `${task.key} passed validation`, Array.isArray(v.criteria) ? `${v.criteria.filter((c: any) => c.met).length}/${v.criteria.length} criteria met` : null);
    }

    await this.finalize(run, this.store.getTask(task.id)!);
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
    if (!cfg.git.tickTasksMd) return;
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

  // ------------------------------------------------------------------ human actions
  async answerQuestion(questionId: number, answer: string) {
    const q = this.store.getQuestion(questionId);
    if (!q) throw new Error("question not found");
    if (q.answer) throw new Error("already answered");
    this.store.answerQuestion(questionId, answer);
    const run = this.store.getRun(q.run_id)!;
    const task = q.task_id ? this.store.getTask(q.task_id) ?? null : null; // null task_id = plan question (TASK-13)
    this.decide(run, task, "human", `Answered: ${clip(q.text, 120)} → ${answer}`, null);
    this.changed("questions", { runId: run.id });
    if (task?.status === "needs_input") await this.resumeAfterAnswer(run, task);
  }
  /**
   * T10/T11: once every question is answered, continue the worker without consuming an attempt
   * (run running) or put the task back to pending (run not running).
   */
  private async resumeAfterAnswer(run: Run, task: Task) {
    const r = await this.fire(run, task.id, { type: "answered", openQuestions: this.store.openQuestionsForTask(task.id).length, runStatus: run.status });
    if (r.rejected || r.status !== "running") return;
    await this.runTask(run, this.store.getTask(task.id)!, !!task.session_id, true);
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
  private runInbox(run: Run, tasks: Task[] = this.store.listTasks(run.id), questions: Question[] = this.store.listQuestions(run.id, true)): any[] {
    const inbox: any[] = [];
    if (run.status === "plan_pending") inbox.push({ type: "approve_plan", run_id: run.id, title: "Plan awaits approval", detail: `${tasks.length} tasks`, ts: run.updated_at });
    for (const q of questions.filter((q) => !q.answer)) {
      const t = tasks.find((x) => x.id === q.task_id);
      inbox.push({ type: "question", id: q.id, run_id: run.id, task_id: q.task_id, task_key: t?.key, title: q.text, options: q.options, ts: q.ts });
    }
    for (const t of tasks) {
      if (t.status === "failed") inbox.push({ type: "failed", run_id: run.id, task_id: t.id, task_key: t.key, title: `${t.key} failed after ${t.attempt} attempts`, detail: t.last_feedback, ts: t.updated_at });
      if (t.status === "pr_open") inbox.push({ type: "merge", run_id: run.id, task_id: t.id, task_key: t.key, title: `${t.key} ready to merge`, detail: t.pr_url ?? t.branch, pr_url: t.pr_url, feedback: t.last_feedback, ci_status: t.ci_status, fix_rounds: t.fix_rounds, ts: t.updated_at });
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
    if (!run) return { ...common, run: null, tasks: [], decisions: [], questions: [], inbox: [], inboxCount: 0 };
    const tasks = this.store.listTasks(run.id);
    const questions = this.store.listQuestions(run.id);
    const inbox = this.runInbox(run, tasks, questions);
    return { ...common, run, tasks, decisions: this.store.listDecisions(run.id), questions, inbox, inboxCount: inbox.length };
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
    let c: Config;
    try {
      c = this.context(project.id).cfg;
    } catch (e: any) {
      return { repo: project.repo_path, error: e?.message ?? String(e), ...server };
    }
    return { repo: c.repo, baseBranch: c.baseBranch, maxParallel: c.scheduler.maxParallel, maxAttempts: c.scheduler.maxAttempts, pr: c.git.pr, mergePolicy: c.git.mergePolicy, validationCommand: c.validation.command, validatorAgent: c.validation.agent, roles: Object.fromEntries(Object.entries(c.agents.roles).map(([k, v]) => [k, `${c.agents.adapters[v.adapter]?.type ?? v.adapter}${v.model ? ":" + v.model : ""}`])), ...server, prFeedback: c.git.pr && c.git.feedback.enabled ? { waitForChecks: c.git.feedback.waitForChecks, maxRounds: c.git.feedback.maxRounds, trigger: c.git.feedback.trigger } : null };
  }

  /** On daemon start: anything that was 'running' when we died goes back to pending. */
  recover() {
    for (const run of this.store.listRuns()) {
      if (CLOSED_RUN.has(run.status)) continue;
      for (const t of this.store.listTasks(run.id)) {
        if (ACTIVE.includes(t.status)) {
          // T14: no effects, applied synchronously.
          this.fire(run, t.id, { type: "daemon_restart" }).catch((e) => console.error("[recover]", e));
          this.log(run, t, "state", { message: "daemon restarted while task was active; task reset to pending (worktree kept)" });
        }
      }
      if (run.status === "planning") this.store.setRunStatus(run.id, "plan_pending");
    }
    this.ensureTicking();
  }
}

/** The task's gate command: its own, else the project's `validation.command` (§10.1). */
function validateCmd(cfg: Config, task: Task): string {
  return task.validate_cmd || cfg.validation.command;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
}
