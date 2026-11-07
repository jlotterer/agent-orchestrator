#!/usr/bin/env node
/**
 * orch — orchestrator CLI.
 *
 *   orch init                         write orch.config.json in the current directory
 *   orch serve                        start the daemon + dashboard (run this under systemd)
 *   orch plan <specDir> [--no-llm]    import a Spec Kit feature dir and draft a plan
 *   orch approve [runId]              approve the pending plan
 *   orch run | pause | stop           control the active run
 *   orch status                       print the board
 *   orch answer <questionId> <text>   answer a question
 *   orch retry|skip|merge <taskKey>   task actions
 *
 * Used by agents inside a task (ORCH_URL / ORCH_TASK_ID are set for them):
 *   orch decide "<text>" [--why "<rationale>"]
 *   orch ask "<question>" [--options "A,B,C"]
 */
import path from "node:path";
import { loadConfig, writeExampleConfig, CONFIG_FILENAME } from "./config.js";

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function has(name: string) { return argv.includes(`--${name}`); }
const BOOL_FLAGS = new Set(["--no-llm"]);
function positional(): string[] {
  const out: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { if (!BOOL_FLAGS.has(a)) i++; continue; }
    out.push(a);
  }
  return out;
}

async function api(method: string, p: string, body?: any): Promise<any> {
  const base = process.env.ORCH_URL ?? `http://127.0.0.1:${loadConfig().config.port}`;
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `${r.status} ${r.statusText}`);
  return j;
}

async function main() {
  switch (cmd) {
    case "init": {
      const p = writeExampleConfig(process.cwd());
      console.log(`wrote ${p}\nEdit it (repo, validation.command, notify.ntfyUrl), then: orch serve`);
      return;
    }
    case "serve": {
      const { config, path: cfgPath } = loadConfig(flag("config"));
      if (!cfgPath) console.warn(`no ${CONFIG_FILENAME} found; using defaults with repo=${config.repo}`);
      const { Orchestrator } = await import("./orchestrator.js");
      const { startServer } = await import("./server.js");
      const orch = new Orchestrator(config);
      orch.recover();
      startServer(orch);
      const shutdown = () => { console.log("shutting down"); process.exit(0); };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    }
    case "plan": {
      const dir = positional()[0];
      if (!dir) throw new Error("usage: orch plan <specDir> [--no-llm]");
      console.log(has("no-llm") ? "importing tasks…" : "importing tasks and running the planner (this takes a minute)…");
      const run = await api("POST", "/api/plan", { specDir: path.resolve(dir), llm: !has("no-llm") });
      console.log(`run ${run.id} "${run.title}" → ${run.status}. Review the plan in the dashboard, then: orch approve`);
      return;
    }
    case "approve": {
      const id = positional()[0] ?? (await api("GET", "/api/state")).run?.id;
      if (!id) throw new Error("no run");
      await api("POST", `/api/runs/${id}/approve`);
      console.log(`run ${id} approved. Start it with: orch run`);
      return;
    }
    case "run": case "start": await api("POST", "/api/start"); console.log("running"); return;
    case "pause": await api("POST", "/api/pause"); console.log("paused"); return;
    case "stop": await api("POST", "/api/stop"); console.log("stopped"); return;
    case "status": {
      const s = await api("GET", "/api/state");
      if (!s.run) { console.log("no runs. Create one with: orch plan <specDir>"); return; }
      console.log(`run ${s.run.id} "${s.run.title}" [${s.run.status}]`);
      for (const t of s.tasks) console.log(`  ${pad(t.status, 11)} ${t.key}  ${t.title}${t.pr_url ? "  " + t.pr_url : ""}`);
      if (s.inbox.length) { console.log("\ninbox:"); for (const i of s.inbox) console.log(`  [${i.type}] ${i.id ? "#" + i.id + " " : ""}${i.title}`); }
      return;
    }
    case "answer": {
      const [id, ...rest] = positional();
      if (!id || !rest.length) throw new Error("usage: orch answer <questionId> <answer text>");
      await api("POST", `/api/questions/${id}/answer`, { answer: rest.join(" ") });
      console.log("answered");
      return;
    }
    case "retry": case "skip": case "merge": case "stop-task": {
      const key = positional()[0];
      if (!key) throw new Error(`usage: orch ${cmd} <taskKey>`);
      const s = await api("GET", "/api/state");
      const t = s.tasks.find((x: any) => x.key === key || x.id === key);
      if (!t) throw new Error(`task ${key} not found`);
      await api("POST", `/api/tasks/${t.id}/${cmd === "stop-task" ? "stop" : cmd}`);
      console.log(`${cmd} ${t.key}: ok`);
      return;
    }
    // ---- agent-facing ----
    case "decide": {
      const text = positional()[0];
      if (!text) throw new Error('usage: orch decide "<decision>" --why "<rationale>"');
      await api("POST", "/api/decide", { taskId: process.env.ORCH_TASK_ID ?? null, runId: process.env.ORCH_RUN_ID ?? null, actor: process.env.ORCH_ACTOR ?? "worker", text, rationale: flag("why") ?? null });
      console.log("decision recorded");
      return;
    }
    case "ask": {
      const text = positional()[0];
      if (!text) throw new Error('usage: orch ask "<question>" --options "A,B,C"');
      const taskId = process.env.ORCH_TASK_ID;
      if (!taskId) throw new Error("orch ask must be run inside an orchestrated task (ORCH_TASK_ID not set)");
      const options = (flag("options") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const q = await api("POST", "/api/ask", { taskId, text, options });
      console.log(`Question #${q.id} recorded for a human. STOP working now: end your turn with status "blocked". You will be resumed with the answer.`);
      return;
    }
    default:
      console.log(`orch — orchestrator/worker/validator runner

  orch init                          write ${CONFIG_FILENAME}
  orch serve                         start daemon + dashboard
  orch plan <specDir> [--no-llm]     import Spec Kit tasks.md and draft a plan
  orch approve [runId]               approve the plan
  orch run | pause | stop            control the run
  orch status                        show the board and inbox
  orch answer <qid> <text>           answer a question
  orch retry|skip|merge <taskKey>    task actions
  orch decide "<text>" --why "<r>"   (agents) record a decision
  orch ask "<q>" --options "A,B"     (agents) ask a human and stop`);
  }
}

function pad(s: string, n: number) { return (s + " ".repeat(n)).slice(0, n); }

main().catch((e) => { console.error(`error: ${e.message ?? e}`); process.exit(1); });
