import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Config } from "./config.js";
import { Store } from "./db.js";
import { Git, shell } from "./git.js";
import { runAgent, getAdapter } from "./adapters/index.js";
import type { RoleName } from "./config.js";
import { loadPrompt, render, clip, PKG_ROOT } from "./prompts.js";
import { notify } from "./notify.js";
import { readSpecDir, parseTasksMd, markTaskDoneInFile } from "./speckit.js";
import type { Run, Task, TaskStatus } from "./types.js";
import { freshFeedback, isTrigger, summarizeChecks, formatReviewFeedback, formatCiFeedback } from "./prfeedback.js";

const FINISHED: TaskStatus[] = ["done", "skipped"];
const ACTIVE: TaskStatus[] = ["running", "validating"];
/** Tasks with an open PR that the feedback loop watches. */
const WATCHED: TaskStatus[] = ["pr_checks", "pr_open"];
const nowIso = () => new Date().toISOString();

export class Orchestrator extends EventEmitter {
  store: Store;
  git: Git;
  private procs = new Map<string, ChildProcess>(); // task id -> running agent
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(public cfg: Config) {
    super();
    this.store = new Store(cfg.dbPath);
    this.git = new Git(cfg.repo, cfg.baseBranch, cfg.git.ghCommand);
  }

  // ------------------------------------------------------------------ helpers
  private log(run: Run | string, task: Task | null, kind: string, data: any) {
    const runId = typeof run === "string" ? run : run.id;
    const ev = this.store.addEvent(runId, task?.id ?? null, kind, data);
    this.emit("event", ev);
    return ev;
  }
  private changed(what: string, data: any = {}) {
    this.emit("change", { what, ...data });
  }
  private decide(run: Run, task: Task | null, actor: string, text: string, rationale: string | null) {
    const d = this.store.addDecision(run.id, task?.id ?? null, actor, text, rationale);
    this.log(run, task, "decision", { actor, text, rationale });
    this.changed("decision", { decision: d });
    return d;
  }
  private taskEnv(task: Task, actor: "worker" | "validator" = "worker") {
    // Put the `orch` CLI on the agent's PATH so `orch decide` / `orch ask` work without a global install.
    const PATH = `${path.join(PKG_ROOT, "bin")}${path.delimiter}${process.env.PATH ?? ""}`;
    return { ORCH_URL: `http://127.0.0.1:${this.cfg.port}`, ORCH_TASK_ID: task.id, ORCH_RUN_ID: task.run_id, ORCH_ACTOR: actor, PATH };
  }
  /** Adapter + model for a role, resolved from config. */
  private roleAgent(role: RoleName) {
    const r = this.cfg.agents.roles[role];
    const adapterConfig = this.cfg.agents.adapters[r.adapter];
    return { adapter: getAdapter(adapterConfig.type), adapterConfig, model: r.model || undefined, timeoutMs: this.cfg.agents.timeoutMinutes * 60_000, label: `${adapterConfig.type}${r.model ? ":" + r.model : ""}` };
  }
  private specContext(run: Run): string {
    const spec = readSpecDir(run.spec_dir);
    const parts: string[] = [];
    for (const f of this.cfg.handoff.contextFiles) if (spec.files[f]) parts.push(`### ${f}\n${spec.files[f]}`);
    return clip(parts.join("\n\n"), this.cfg.handoff.specChars);
  }
  private bullets(items: string[]): string {
    return items.length ? items.map((a) => `- ${a}`).join("\n") : "- (none given; use the task description)";
  }
  private deadlineGuard(run: Run) {
    const r = this.store.getRun(run.id);
    return r && r.status === "running";
  }

  // ------------------------------------------------------------------ planning
  /** Import a Spec Kit dir into a new run. With llm=true the planner agent enriches tasks. */
  async plan(specDir: string, opts: { llm: boolean }): Promise<Run> {
    const spec = readSpecDir(specDir);
    const tasksMd = spec.files["tasks.md"];
    if (!tasksMd) throw new Error(`no tasks.md in ${spec.dir}. Run /speckit.tasks first.`);
    const imported = parseTasksMd(tasksMd);
    if (!imported.length) throw new Error(`no tasks found in ${path.join(spec.dir, "tasks.md")}`);

    const run = this.store.createRun(spec.dir, spec.title, this.cfg.baseBranch, opts.llm ? "planning" : "plan_pending");
    this.changed("run", { run });
    this.log(run, null, "state", { message: `imported ${imported.length} tasks from ${path.relative(this.cfg.repo, spec.dir)}` });

    for (const t of imported) {
      this.store.insertTask({
        run_id: run.id, key: t.key, title: t.title, description: t.description, acceptance: [], depends_on: t.depends_on,
        parallel: t.parallel ? 1 : 0, phase: t.phase, order_idx: t.order_idx, status: t.done ? "done" : "pending",
        attempt: 0, max_attempts: this.cfg.scheduler.maxAttempts, merge_policy: this.cfg.git.mergePolicy,
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
    const prompt = render(loadPrompt("planner", this.cfg.repo), { title: run.title, spec_context: clip(specContext, this.cfg.handoff.specChars * 2), tasks_json: tasksJson });

    const planner = this.roleAgent("planner");
    this.log(run, null, "state", { message: `planner started (${planner.label})` });
    const res = await runAgent({
      ...planner, cwd: this.cfg.repo, prompt,
      env: { ORCH_URL: `http://127.0.0.1:${this.cfg.port}`, ORCH_RUN_ID: run.id, ORCH_ACTOR: "planner" },
      onEvent: (kind, data) => this.log(run, null, kind, { role: "planner", ...data }),
    });
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
    await notify(this.cfg, `Plan ready: ${run.title}`, `${tasks.length} tasks. Review and approve in the dashboard.`, { tags: ["clipboard"] });
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
  start(runId?: string) {
    const run = runId ? this.store.getRun(runId) : this.store.activeRun();
    if (!run) throw new Error("no run to start");
    if (run.status === "plan_pending") throw new Error("plan not approved yet");
    if (run.status === "planning") throw new Error("planner still working");
    if (!["ready", "paused", "running", "stopped"].includes(run.status)) throw new Error(`run is ${run.status}`);
    this.store.setRunStatus(run.id, "running");
    this.log(run, null, "state", { message: "run started" });
    this.changed("run", { run: this.store.getRun(run.id) });
    this.ensureTicking();
    void this.tick();
  }
  pause(runId?: string) {
    const run = runId ? this.store.getRun(runId) : this.store.activeRun();
    if (!run) throw new Error("no active run");
    this.store.setRunStatus(run.id, "paused");
    this.log(run, null, "state", { message: "run paused; running tasks will finish, no new tasks start" });
    this.changed("run", { run: this.store.getRun(run.id) });
  }
  stop(runId?: string) {
    const run = runId ? this.store.getRun(runId) : this.store.activeRun();
    if (!run) throw new Error("no active run");
    for (const [taskId, child] of this.procs) {
      child.kill("SIGTERM");
      const t = this.store.getTask(taskId);
      if (t && ACTIVE.includes(t.status)) this.store.updateTask(taskId, { status: "pending" });
    }
    this.procs.clear();
    this.store.setRunStatus(run.id, "stopped");
    this.log(run, null, "state", { message: "run stopped; active agents killed" });
    this.changed("run", { run: this.store.getRun(run.id) });
    this.changed("tasks", { runId: run.id });
  }

  ensureTicking() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.cfg.scheduler.tickSeconds * 1000);
    this.timer.unref();
  }

  /** Scheduler heartbeat: start whatever is ready, resume answered tasks, finish the run. */
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const run = this.store.activeRun();
      if (!run || run.status !== "running") return;
      const tasks = this.store.listTasks(run.id);

      // Resume tasks whose questions have been answered (e.g. answered while paused).
      for (const t of tasks) {
        if (t.status === "needs_input" && this.store.openQuestionsForTask(t.id).length === 0) {
          void this.resumeAfterAnswer(run, t);
        }
      }

      if (this.cfg.git.pr && this.cfg.git.feedback.enabled) this.pollPullRequests(run, tasks);

      const active = tasks.filter((t) => ACTIVE.includes(t.status)).length;
      let slots = this.cfg.scheduler.maxParallel - active;
      if (slots <= 0) return;

      const doneKeys = new Set(tasks.filter((t) => FINISHED.includes(t.status)).map((t) => t.key));
      const ready = tasks.filter((t) => t.status === "pending" && t.depends_on.every((k) => doneKeys.has(k)) && this.store.openQuestionsForTask(t.id).length === 0);

      for (const t of ready) {
        if (slots <= 0) break;
        slots--;
        // Resume on a retry, and on a PR fix round (attempt was reset to give the round a fresh budget).
        const resume = this.cfg.scheduler.resumeOnRetry && !!t.session_id && (t.attempt > 0 || t.fix_rounds > 0);
        void this.runTask(run, t, resume);
      }

      if (!ready.length && active === 0) {
        const unfinished = tasks.filter((t) => !FINISHED.includes(t.status));
        if (!unfinished.length) {
          this.store.setRunStatus(run.id, "done");
          this.log(run, null, "state", { message: "all tasks done" });
          this.changed("run", { run: this.store.getRun(run.id) });
          await notify(this.cfg, `Run complete: ${run.title}`, `${tasks.length} tasks finished.`, { tags: ["tada"], priority: "high" });
        } else if (unfinished.every((t) => ["failed", "needs_input", "pr_open"].includes(t.status) || (t.status === "pending" && !t.depends_on.every((k) => doneKeys.has(k))))) {
          // Nothing can progress without a human. Stay 'running' so answering resumes automatically, but say so once.
          const blocked = unfinished.filter((t) => t.status !== "pending");
          const lastEv = this.store.listEvents({ runId: run.id, limit: 1 })[0];
          if (!(lastEv?.kind === "state" && lastEv.data?.waiting)) {
            this.log(run, null, "state", { message: `waiting on you: ${blocked.map((t) => `${t.key} (${t.status})`).join(", ")}`, waiting: true });
          }
        }
      }
    } catch (e: any) {
      console.error("[tick]", e);
    } finally {
      this.ticking = false;
    }
  }

  // ------------------------------------------------------------------ task lifecycle
  private async runTask(run: Run, task: Task, resume = false) {
    const attempt = task.attempt + 1;
    const branch = task.branch ?? `orch/${task.key.toLowerCase()}-${slug(task.title)}`;
    const worktree = task.worktree ?? path.join(this.cfg.worktreeDir, `${run.id}-${task.key.toLowerCase()}`);
    this.store.updateTask(task.id, { status: "running", attempt, branch, worktree });
    task = this.store.getTask(task.id)!;
    this.changed("tasks", { runId: run.id });
    const workerAgent = this.roleAgent("worker");
    if (resume && !workerAgent.adapter.supportsResume) resume = false;
    this.log(run, task, "state", { message: `worker started (${workerAgent.label}, attempt ${attempt}/${task.max_attempts})${resume ? " — resuming previous session" : ""}` });

    try {
      if (!fs.existsSync(path.join(worktree, ".git"))) {
        await this.git.addWorktree(worktree, branch);
        this.log(run, task, "git", { message: `worktree ${path.relative(this.cfg.repo, worktree)} on ${branch}` });
        for (const f of this.cfg.git.copyFiles) {
          const src = path.join(this.cfg.repo, f);
          if (fs.existsSync(src)) fs.copyFileSync(src, path.join(worktree, f));
        }
        if (this.cfg.git.setupCommand) {
          const r = await shell(this.cfg.git.setupCommand, worktree, { timeoutMs: 15 * 60_000 });
          this.log(run, task, "git", { message: `setup: ${this.cfg.git.setupCommand} → exit ${r.code}`, output: clip(r.stdout + r.stderr, 2000) });
          if (r.code !== 0) {
            // Drop the half-set-up worktree (branch kept) so the next attempt recreates it and reruns setup.
            await this.git.removeWorktree(worktree, false);
            throw new Error(`setup command failed (exit ${r.code}): ${clip((r.stdout + "\n" + r.stderr).trim(), 500)}`);
          }
        }
      }

      const prompt = resume && task.session_id
        ? this.resumePrompt(task)
        : render(loadPrompt("worker", this.cfg.repo), {
            task_key: task.key, task_title: task.title, task_description: task.description,
            acceptance: this.bullets(task.acceptance), spec_context: this.specContext(run),
            handoff: this.handoff(run, task), branch, base_branch: this.cfg.baseBranch,
            validate_hint: this.validateCmd(task) ? ` (\`${this.validateCmd(task)}\` must pass)` : "",
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
        this.store.updateTask(task.id, { status: "needs_input" });
        this.changed("tasks", { runId: run.id });
        const qs = this.store.openQuestionsForTask(task.id);
        await notify(this.cfg, `${task.key} needs your input`, qs.map((q) => q.text).join("\n") || "Worker blocked", { priority: "high", tags: ["question"] });
        return;
      }

      if (!res.ok || out.status === "failed") {
        const reason = out.reason ? String(out.reason) : agentErrors.length ? agentErrors.join("; ") : "agent run failed (see log)";
        await this.failOrRetry(run, task, `Worker reported failure: ${reason}`);
        return;
      }

      // Make sure the work is committed, then validate.
      await this.git.commitAll(worktree, `${task.key}: ${task.title} (orch auto-commit)`).then((c) => { if (c) this.log(run, task, "git", { message: "committed leftover changes" }); });
      await this.validate(run, this.store.getTask(task.id)!);
    } catch (e: any) {
      this.procs.delete(task.id);
      this.log(run, task, "error", { message: e?.message ?? String(e) });
      await this.failOrRetry(run, task, `Error: ${e?.message ?? e}`);
    }
  }

  private validateCmd(task: Task): string {
    return task.validate_cmd || this.cfg.validation.command;
  }

  private async validate(run: Run, task: Task) {
    this.store.updateTask(task.id, { status: "validating" });
    this.changed("tasks", { runId: run.id });
    const worktree = task.worktree!;

    if ((await this.git.commitsAhead(worktree)) === 0) {
      await this.failOrRetry(run, task, "No commits on the task branch; the worker produced no changes.");
      return;
    }

    // 1. Deterministic gate.
    const cmd = this.validateCmd(task);
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
    if (this.cfg.validation.agent) {
      const validatorAgent = this.roleAgent("validator");
      this.log(run, task, "state", { message: `validator started (${validatorAgent.label})` });
      const diff = await this.git.diffFromBase(worktree);
      const prompt = render(loadPrompt("validator", this.cfg.repo), {
        task_key: task.key, task_title: task.title, task_description: task.description, acceptance: this.bullets(task.acceptance),
        worker_summary: task.summary ?? "(none)", diff, branch: task.branch, base_branch: this.cfg.baseBranch,
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

  private async failOrRetry(run: Run, task: Task, feedback: string) {
    task = this.store.getTask(task.id)!;
    this.store.updateTask(task.id, { last_feedback: feedback });
    if (task.attempt < task.max_attempts) {
      this.log(run, task, "state", { message: `attempt ${task.attempt} failed; retrying`, feedback: clip(feedback, 2000) });
      this.decide(run, task, "orchestrator", `Retrying ${task.key} (attempt ${task.attempt + 1}/${task.max_attempts})`, clip(feedback.split("\n")[0], 200));
      this.store.updateTask(task.id, { status: "pending" });
      this.changed("tasks", { runId: run.id });
      // The scheduler picks it up again (resuming the worker's session if configured).
      if (this.deadlineGuard(run)) setTimeout(() => void this.tick(), 50);
      return;
    }
    this.store.updateTask(task.id, { status: "failed" });
    this.log(run, task, "state", { message: `failed after ${task.attempt} attempts; needs a human`, feedback: clip(feedback, 2000) });
    this.changed("tasks", { runId: run.id });
    await notify(this.cfg, `${task.key} failed`, clip(feedback, 300), { priority: "high", tags: ["x"] });
  }

  private async finalize(run: Run, task: Task) {
    const worktree = task.worktree!, branch = task.branch!;
    const title = `${task.key}: ${task.title}`;
    const body = `${task.summary ?? ""}\n\nRun ${run.id} · ${run.title}\nAutomated by orch; validated ${this.cfg.validation.agent ? "by validator agent" : "by command gate"}.`;
    try {
      if (this.cfg.git.pr) {
        const fb = this.cfg.git.feedback;
        const sha = await this.git.branchSha(branch);
        const unchanged = task.fix_rounds > 0 && !!sha && sha === task.pr_head;
        await this.git.push(worktree, branch);
        const url = await this.git.createPr(worktree, branch, title, body);
        const firstPush = !task.pr_pushed_at;
        this.store.updateTask(task.id, { pr_url: url, pr_head: sha, pr_pushed_at: nowIso(), pr_feedback_at: task.pr_feedback_at ?? nowIso(), ci_status: null });
        this.log(run, task, "git", { message: firstPush ? `PR opened: ${url}` : `PR updated (fix round ${task.fix_rounds}): ${url}` });
        if (unchanged) {
          // A fix round that changed nothing would re-run the same CI / ignore the reviewer. A human decides.
          await this.toInbox(run, this.store.getTask(task.id)!, `Fix round ${task.fix_rounds} produced no new commits.\n\n${task.last_feedback ?? ""}`);
          return;
        }
        if (task.merge_policy === "manual") {
          this.store.updateTask(task.id, { status: "pr_open" });
          this.changed("tasks", { runId: run.id });
          await notify(this.cfg, `${task.key} ready for review`, `${title}\n${url}`, { click: url, tags: ["eyes"] });
          return;
        }
        if (fb.enabled && fb.waitForChecks) {
          this.store.updateTask(task.id, { status: "pr_checks" });
          this.log(run, task, "state", { message: "waiting for PR checks before merging" });
          this.changed("tasks", { runId: run.id });
          this.lastPoll.delete(task.id); // poll soon rather than a full interval from now
          return;
        }
        await this.git.mergePr(worktree, branch, this.cfg.git.squash);
        this.log(run, task, "git", { message: "PR merged" });
      } else {
        if (task.merge_policy === "manual") {
          this.store.updateTask(task.id, { status: "pr_open" });
          this.changed("tasks", { runId: run.id });
          await notify(this.cfg, `${task.key} ready for review`, `${title}\nbranch ${branch} (local merge when approved)`, { tags: ["eyes"] });
          return;
        }
        await this.withMergeLock(() => this.git.mergeLocal(worktree, branch, this.cfg.git.squash, title));
        this.log(run, task, "git", { message: `merged ${branch} into ${this.cfg.baseBranch} locally` });
      }
      await this.markDone(run, task);
    } catch (e: any) {
      this.log(run, task, "error", { message: e?.message ?? String(e) });
      // Merge problems are for a human (conflicts, CI, auth); don't burn worker retries on them.
      this.store.updateTask(task.id, { status: "pr_open", last_feedback: `Merge step failed: ${e?.message ?? e}` });
      this.changed("tasks", { runId: run.id });
      await notify(this.cfg, `${task.key}: merge needs you`, clip(String(e?.message ?? e), 300), { priority: "high", tags: ["warning"] });
    }
  }

  /**
   * Tick "- [ ] T001" -> "- [x] T001" in tasks.md after the merge. Done on the base branch
   * (not on task branches) so parallel tasks never conflict over the same lines.
   * Local-merge mode commits it; PR mode leaves it as a working-tree change for you to commit.
   */
  private async tickTasksMd(run: Run, task: Task) {
    if (!this.cfg.git.tickTasksMd) return;
    const tasksPath = path.join(run.spec_dir, "tasks.md");
    const rel = path.relative(this.cfg.repo, tasksPath);
    if (rel.startsWith("..")) return;
    await this.withMergeLock(async () => {
      if (!markTaskDoneInFile(tasksPath, task.key)) return;
      if (!this.cfg.git.pr) {
        const r = await this.git.commitPaths(this.cfg.repo, [rel], `${task.key}: tick in tasks.md`);
        this.log(run, task, "info", { message: r ? "ticked and committed in tasks.md" : "ticked in tasks.md" });
      } else {
        this.log(run, task, "info", { message: `ticked ${rel} in your working tree (commit it when convenient)` });
      }
    });
  }

  private mergeChain: Promise<any> = Promise.resolve();
  /** Serializes operations that touch the main repo's index (local merges). */
  private withMergeLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mergeChain.then(fn, fn);
    this.mergeChain = next.catch(() => {});
    return next;
  }

  private async markDone(run: Run, task: Task) {
    await this.git.removeWorktree(task.worktree!, !this.cfg.git.pr, task.branch!);
    this.store.updateTask(task.id, { status: "done", worktree: null });
    await this.tickTasksMd(run, task);
    this.log(run, task, "state", { message: "done" });
    this.changed("tasks", { runId: run.id });
    void this.tick();
  }

  // ------------------------------------------------------------------ PR feedback loop (R1)
  private polling = new Set<string>();
  private lastPoll = new Map<string, number>();
  private lastPollError = new Map<string, string>();

  /** Called from tick(): poll each watched PR at most every `pollSeconds`, never two polls of one task at once. */
  private pollPullRequests(run: Run, tasks: Task[]) {
    const every = this.cfg.git.feedback.pollSeconds * 1000;
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

  private async pollPr(run: Run, task: Task) {
    const fb = this.cfg.git.feedback;
    const cwd = task.worktree && fs.existsSync(task.worktree) ? task.worktree : this.cfg.repo;
    const pr = await this.git.prStatus(cwd, task.pr_url!);
    task = this.store.getTask(task.id)!; // a human may have acted while gh was running
    if (!WATCHED.includes(task.status)) return;

    if (pr.state === "MERGED") {
      this.decide(run, task, "orchestrator", `${task.key}: PR was merged on GitHub; marking done`, pr.url);
      await this.markDone(run, task);
      return;
    }
    if (pr.state === "CLOSED") {
      this.store.updateTask(task.id, { status: "failed", last_feedback: `PR was closed without merging: ${pr.url}` });
      this.log(run, task, "state", { message: "PR closed without merging; needs a human" });
      this.changed("tasks", { runId: run.id });
      await notify(this.cfg, `${task.key}: PR closed`, pr.url, { click: pr.url, priority: "high", tags: ["x"] });
      return;
    }

    // 1. Review feedback: a "changes requested" review or a `/orch …` comment since the watermark.
    const fresh = freshFeedback(pr.feedback, task.pr_feedback_at, fb.ignoreAuthors);
    const triggers = fresh.filter((i) => isTrigger(i, fb.trigger));
    if (triggers.length) {
      const watermark = new Date(Math.max(...fresh.map((i) => Date.parse(i.ts)))).toISOString();
      this.store.updateTask(task.id, { pr_feedback_at: watermark });
      const authors = [...new Set(triggers.map((i) => i.author))].join(", ");
      // All fresh human feedback goes to the worker, not only the triggering comment: it is the reviewer's full context.
      await this.startFixRound(run, this.store.getTask(task.id)!, "review", formatReviewFeedback(fresh, pr.url, task.fix_rounds + 1, fb.maxRounds), `review feedback from ${authors}`);
      return;
    }

    // 2. Checks, only once GitHub reports them for the commit we pushed.
    const localSha = await this.git.branchSha(task.branch!);
    const current = !localSha || pr.headSha === localSha;
    let summary = current ? summarizeChecks(pr.checks) : "pending";
    const sincePush = Date.now() - Date.parse(task.pr_pushed_at ?? task.updated_at);
    if (summary === "none" && sincePush < fb.noChecksGraceSeconds * 1000) summary = "pending"; // CI may not have registered yet
    if (task.ci_status !== summary) { this.store.updateTask(task.id, { ci_status: summary }); this.changed("tasks", { runId: run.id }); }

    if (summary === "pending") {
      if (task.status === "pr_checks" && sincePush > fb.checksTimeoutMinutes * 60_000) {
        await this.toInbox(run, task, `PR checks did not finish within ${fb.checksTimeoutMinutes} minutes: ${pr.url}`);
      }
      return;
    }

    if (summary === "fail") {
      const failed = pr.checks.filter((c) => c.state === "fail");
      const names = failed.map((c) => c.name).join(", ");
      if (task.ci_head === pr.headSha) {
        // Already acted on this commit's failure; only an auto task still waiting needs moving along.
        if (task.status === "pr_checks") await this.toInbox(run, task, `CI still failing on ${pr.headSha.slice(0, 10)}: ${names}`);
        return;
      }
      this.store.updateTask(task.id, { ci_head: pr.headSha });
      if (task.fix_rounds >= fb.maxRounds) {
        await this.toInbox(run, task, `CI failing (${names}) and all ${fb.maxRounds} fix rounds are used: ${pr.url}`);
        return;
      }
      const logs = await this.git.failedCheckLogs(cwd, failed, fb.logChars);
      await this.startFixRound(run, this.store.getTask(task.id)!, "ci", formatCiFeedback(failed, logs, pr.url, pr.headSha, task.fix_rounds + 1, fb.maxRounds), `failed checks: ${names}`);
      return;
    }

    // pass / none: auto tasks merge now. Manual tasks stay with the human (the inbox shows CI status).
    if (task.status !== "pr_checks") return;
    if (pr.reviewDecision === "CHANGES_REQUESTED") {
      await this.toInbox(run, task, `Checks pass, but a reviewer's "changes requested" is still open on ${pr.url}. Merge once you're satisfied.`);
      return;
    }
    this.decide(run, task, "orchestrator", `Merging ${task.key}: PR checks passed`, summary === "none" ? "no checks configured on the PR" : `${pr.checks.length} checks passed`);
    try {
      await this.git.mergePr(cwd, task.branch!, this.cfg.git.squash);
      this.log(run, task, "git", { message: "PR merged" });
      await this.markDone(run, this.store.getTask(task.id)!);
    } catch (e: any) {
      this.log(run, task, "error", { message: e?.message ?? String(e) });
      await this.toInbox(run, task, `Merge step failed: ${e?.message ?? e}`);
    }
  }

  /** Send PR feedback (CI failure or review) back to the worker: same path as a validation retry, own budget. */
  private async startFixRound(run: Run, task: Task, kind: "ci" | "review", feedback: string, why: string) {
    const fb = this.cfg.git.feedback;
    const round = task.fix_rounds + 1;
    if (round > fb.maxRounds) {
      await this.toInbox(run, task, `New ${kind === "ci" ? "CI failure" : "review feedback"}, but all ${fb.maxRounds} fix rounds are used.\n\n${feedback}`);
      return;
    }
    if (task.worktree && fs.existsSync(task.worktree)) {
      const sync = await this.git.syncFromRemote(task.worktree, task.branch!);
      if (sync === "fast-forwarded") this.log(run, task, "git", { message: "pulled new commits from the PR branch before the fix round" });
      if (sync === "diverged") {
        // Our next push would overwrite someone else's commits. Not our call.
        await this.toInbox(run, task, `The PR branch has commits that conflict with the local branch; resolve before orch continues.\n\n${feedback}`);
        return;
      }
    }
    this.decide(run, task, "orchestrator", `Sending ${kind === "ci" ? "CI failure" : "review feedback"} on ${task.key}'s PR back to the worker (round ${round}/${fb.maxRounds})`, why);
    this.log(run, task, "state", { message: `PR fix round ${round}/${fb.maxRounds}: ${why}`, feedback: clip(feedback, 2000) });
    // attempt resets so validation retries inside the round get the full budget; fix_rounds caps the rounds.
    this.store.updateTask(task.id, { status: "pending", attempt: 0, fix_rounds: round, last_feedback: feedback, ci_status: null });
    this.changed("tasks", { runId: run.id });
    if (this.deadlineGuard(run)) setTimeout(() => void this.tick(), 50);
  }

  /** Park a PR task with a human: inbox + push notification. Idempotent for the same message. */
  private async toInbox(run: Run, task: Task, feedback: string) {
    if (task.status === "pr_open" && task.last_feedback === feedback) return;
    this.store.updateTask(task.id, { status: "pr_open", last_feedback: feedback });
    this.log(run, task, "state", { message: "PR needs a human", feedback: clip(feedback, 2000) });
    this.changed("tasks", { runId: run.id });
    await notify(this.cfg, `${task.key}: PR needs you`, clip(feedback, 300), { click: task.pr_url ?? undefined, priority: "high", tags: ["warning"] });
  }

  // ------------------------------------------------------------------ human actions
  async answerQuestion(questionId: number, answer: string) {
    const q = this.store.getQuestion(questionId);
    if (!q) throw new Error("question not found");
    if (q.answer) throw new Error("already answered");
    this.store.answerQuestion(questionId, answer);
    const run = this.store.getRun(q.run_id)!;
    const task = this.store.getTask(q.task_id)!;
    this.decide(run, task, "human", `Answered: ${clip(q.text, 120)} → ${answer}`, null);
    this.changed("questions", { runId: run.id });
    // Not running (paused/stopped): the task stays needs_input and tick() resumes it on start, so the
    // answer reaches the same session and no attempt is consumed (REQ-SCHED-08, REQ-HITL-03).
    if (task.status === "needs_input" && this.store.openQuestionsForTask(task.id).length === 0 && run.status === "running") {
      await this.resumeAfterAnswer(run, task);
    }
  }
  private async resumeAfterAnswer(run: Run, task: Task) {
    if (ACTIVE.includes(this.store.getTask(task.id)!.status)) return;
    // Resuming does not consume an attempt.
    this.store.updateTask(task.id, { attempt: Math.max(0, task.attempt - 1) });
    await this.runTask(run, this.store.getTask(task.id)!, !!task.session_id);
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
    const run = task ? this.store.getRun(task.run_id) : runId ? this.store.getRun(runId) : this.store.activeRun();
    if (!run) throw new Error("no run");
    return this.decide(run, task ?? null, actor, text, rationale);
  }

  async retryTask(taskId: string) {
    const t = this.store.getTask(taskId);
    if (!t) throw new Error("task not found");
    if (ACTIVE.includes(t.status)) throw new Error("task is active");
    const run = this.store.getRun(t.run_id)!;
    this.store.updateTask(taskId, { status: "pending", attempt: 0, fix_rounds: 0, ci_head: null, ci_status: null });
    this.decide(run, t, "human", `Retry requested for ${t.key}`, null);
    this.changed("tasks", { runId: run.id });
    void this.tick();
  }
  skipTask(taskId: string) {
    const t = this.store.getTask(taskId);
    if (!t) throw new Error("task not found");
    if (ACTIVE.includes(t.status)) throw new Error("task is active; stop it first");
    const run = this.store.getRun(t.run_id)!;
    this.store.updateTask(taskId, { status: "skipped" });
    this.decide(run, t, "human", `Skipped ${t.key}`, null);
    if (t.worktree) void this.git.removeWorktree(t.worktree, !this.cfg.git.pr, t.branch ?? undefined);
    this.store.updateTask(taskId, { worktree: null });
    this.changed("tasks", { runId: run.id });
    void this.tick();
  }
  /** Human approves a pr_open task: merge it now. */
  async mergeTask(taskId: string) {
    const t = this.store.getTask(taskId);
    if (!t) throw new Error("task not found");
    if (!WATCHED.includes(t.status)) throw new Error(`task is ${t.status}, not pr_open`);
    const run = this.store.getRun(t.run_id)!;
    this.decide(run, t, "human", `Approved merge of ${t.key}`, null);
    try {
      if (this.cfg.git.pr) await this.git.mergePr(t.worktree!, t.branch!, this.cfg.git.squash);
      else await this.withMergeLock(() => this.git.mergeLocal(t.worktree!, t.branch!, this.cfg.git.squash, `${t.key}: ${t.title}`));
      this.log(run, t, "git", { message: "merged" });
      await this.markDone(run, t);
    } catch (e: any) {
      this.log(run, t, "error", { message: e?.message ?? String(e) });
      throw e;
    }
  }
  /** Human marks a pr_open task as merged elsewhere (e.g. merged on GitHub by hand). */
  async markMerged(taskId: string) {
    const t = this.store.getTask(taskId);
    if (!t) throw new Error("task not found");
    const run = this.store.getRun(t.run_id)!;
    this.decide(run, t, "human", `Marked ${t.key} as merged externally`, null);
    await this.markDone(run, t);
  }
  stopTask(taskId: string) {
    const child = this.procs.get(taskId);
    const t = this.store.getTask(taskId);
    if (!t) throw new Error("task not found");
    if (child) child.kill("SIGTERM");
    this.procs.delete(taskId);
    const run = this.store.getRun(t.run_id)!;
    this.store.updateTask(taskId, { status: "pending" });
    this.decide(run, t, "human", `Stopped ${t.key}`, null);
    this.changed("tasks", { runId: run.id });
  }

  // ------------------------------------------------------------------ hand-off brief
  private handoff(run: Run, task: Task): string {
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
    return clip(parts.join("\n\n"), this.cfg.handoff.historyChars);
  }

  // ------------------------------------------------------------------ snapshot for UI
  snapshot(runId?: string) {
    const run = runId ? this.store.getRun(runId) : this.store.activeRun() ?? this.store.listRuns()[0];
    if (!run) return { run: null, tasks: [], decisions: [], questions: [], inbox: [], runs: this.store.listRuns(), config: this.publicConfig() };
    const tasks = this.store.listTasks(run.id);
    const questions = this.store.listQuestions(run.id);
    const inbox: any[] = [];
    if (run.status === "plan_pending") inbox.push({ type: "approve_plan", run_id: run.id, title: "Plan awaits approval", detail: `${tasks.length} tasks` });
    for (const q of questions.filter((q) => !q.answer)) {
      const t = tasks.find((x) => x.id === q.task_id);
      inbox.push({ type: "question", id: q.id, task_id: q.task_id, task_key: t?.key, title: q.text, options: q.options, ts: q.ts });
    }
    for (const t of tasks) {
      if (t.status === "failed") inbox.push({ type: "failed", task_id: t.id, task_key: t.key, title: `${t.key} failed after ${t.attempt} attempts`, detail: t.last_feedback, ts: t.updated_at });
      if (t.status === "pr_open") inbox.push({ type: "merge", task_id: t.id, task_key: t.key, title: `${t.key} ready to merge`, detail: t.pr_url ?? t.branch, pr_url: t.pr_url, feedback: t.last_feedback, ci_status: t.ci_status, fix_rounds: t.fix_rounds, ts: t.updated_at });
    }
    return { run, tasks, decisions: this.store.listDecisions(run.id), questions, inbox, runs: this.store.listRuns(), config: this.publicConfig() };
  }
  private publicConfig() {
    const c = this.cfg;
    return { repo: c.repo, baseBranch: c.baseBranch, maxParallel: c.scheduler.maxParallel, maxAttempts: c.scheduler.maxAttempts, pr: c.git.pr, mergePolicy: c.git.mergePolicy, validationCommand: c.validation.command, validatorAgent: c.validation.agent, roles: Object.fromEntries(Object.entries(c.agents.roles).map(([k, v]) => [k, `${c.agents.adapters[v.adapter]?.type ?? v.adapter}${v.model ? ":" + v.model : ""}`])), ntfy: !!c.notify.ntfyUrl, prFeedback: c.git.pr && c.git.feedback.enabled ? { waitForChecks: c.git.feedback.waitForChecks, maxRounds: c.git.feedback.maxRounds, trigger: c.git.feedback.trigger } : null };
  }

  /** On daemon start: anything that was 'running' when we died goes back to pending. */
  recover() {
    for (const run of this.store.listRuns()) {
      if (["done", "stopped", "failed"].includes(run.status)) continue;
      for (const t of this.store.listTasks(run.id)) {
        if (ACTIVE.includes(t.status)) {
          this.store.updateTask(t.id, { status: "pending" });
          this.log(run, t, "state", { message: "daemon restarted while task was active; task reset to pending (worktree kept)" });
        }
      }
      if (run.status === "planning") this.store.setRunStatus(run.id, "plan_pending");
    }
    this.ensureTicking();
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
}
