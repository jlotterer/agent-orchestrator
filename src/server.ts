import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import type { Orchestrator } from "./orchestrator.js";
import { PKG_ROOT } from "./prompts.js";
import { isAuthorized, loginCookie, tokenMatches } from "./auth.js";
import { archivedLogEvent } from "./archive.js";

const VERSION: string = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")).version ?? "unknown"; } catch { return "unknown"; }
})();
const STARTED = Date.now();

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>, body: any) => Promise<any> | any;

export function startServer(orch: Orchestrator) {
  const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
  const route = (method: string, p: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp("^" + p.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
    routes.push({ method, pattern, keys, handler });
  };

  const query = (req: http.IncomingMessage) => new URL(req.url!, "http://x").searchParams;

  // ---- projects (§15.1) ----
  route("GET", "/api/projects", (req) => orch.listProjectSummaries({ archived: ["1", "true"].includes(query(req).get("archived") ?? "") }));
  route("POST", "/api/projects", async (_r, _s, _p, b) => {
    if (typeof b.path !== "string" || !b.path.trim()) throw new Error("path is required");
    const r = await orch.addProject(b.path, { name: typeof b.name === "string" ? b.name : undefined });
    return { ...r.project, ...(r.configCreated ? { configCreated: r.configCreated } : {}), ...(r.unarchived ? { unarchived: true } : {}) };
  });
  route("DELETE", "/api/projects/:id", (_r, _s, p) => { orch.archiveProject(p.id); return { ok: true }; });
  route("GET", "/api/projects/:id/state", (req, _s, p) => orch.snapshot(p.id, query(req).get("run") ?? undefined));
  route("POST", "/api/projects/:id/plan", async (_r, _s, p, b) => {
    if (typeof b.specDir !== "string" || !b.specDir) throw new Error("specDir is required");
    if (b.dryRun) return orch.previewPlan(b.specDir, p.id); // REQ-INTAKE-10: no run, no agent, nothing written
    return orch.plan(p.id, b.specDir, { llm: b.llm !== false });
  });
  route("GET", "/api/inbox", () => orch.globalInbox());

  // ---- read ----
  route("GET", "/api/state", (req) => orch.snapshot(query(req).get("project") ?? undefined));
  route("GET", "/api/runs/:id", (_r, _s, p) => orch.snapshot(undefined, p.id));
  // An archived run's log is one synthetic info event naming the archive file (§17).
  const archivedLog = (runId: string | undefined, taskId: string | null, afterId: number) => {
    const run = runId ? orch.store.getRun(runId) : undefined;
    if (!run?.archived_at) return null;
    const ev = archivedLogEvent(path.join(orch.home, "archive"), run, taskId);
    return ev.id > afterId ? [ev] : [];
  };
  route("GET", "/api/tasks/:id/events", (req, _s, p) => {
    const u = new URL(req.url!, "http://x");
    const afterId = Number(u.searchParams.get("after") ?? 0) || 0;
    return archivedLog(orch.store.getTask(p.id)?.run_id, p.id, afterId)
      ?? orch.store.listEvents({ taskId: p.id, afterId: afterId || undefined, limit: Number(u.searchParams.get("limit") ?? 400) });
  });
  route("GET", "/api/tasks/:id/diff", (_r, _s, p) => orch.taskDiff(p.id));
  route("GET", "/api/runs/:id/events", (req, _s, p) => {
    const u = new URL(req.url!, "http://x");
    const afterId = Number(u.searchParams.get("after") ?? 0) || 0;
    return archivedLog(p.id, null, afterId)
      ?? orch.store.listEvents({ runId: p.id, afterId: afterId || undefined, limit: Number(u.searchParams.get("limit") ?? 200) });
  });

  // ---- run control ----
  // Legacy plan route: `project` in the body, else the registered repo containing specDir, else the default project.
  route("POST", "/api/plan", async (_r, _s, _p, b) => {
    const specDir = String(b.specDir ?? "");
    if (b.dryRun) return orch.previewPlan(specDir);
    const project = b.project ? String(b.project) : orch.projectForPath(path.resolve(specDir))?.id;
    if (!project) throw new Error("no projects registered");
    return orch.plan(project, specDir, { llm: b.llm !== false });
  });
  route("POST", "/api/runs/:id/approve", (_r, _s, p) => { orch.approvePlan(p.id); return { ok: true }; });
  route("POST", "/api/runs/:id/start", (_r, _s, p) => { orch.start(p.id); return { ok: true }; });
  route("POST", "/api/runs/:id/pause", (_r, _s, p) => { orch.pause(p.id); return { ok: true }; });
  route("POST", "/api/runs/:id/stop", (_r, _s, p) => { orch.stop(p.id); return { ok: true }; });
  route("POST", "/api/start", () => { orch.start(); return { ok: true }; });
  route("POST", "/api/pause", () => { orch.pause(); return { ok: true }; });
  route("POST", "/api/stop", () => { orch.stop(); return { ok: true }; });

  // ---- task control ----
  route("POST", "/api/tasks/:id/retry", async (_r, _s, p) => { await orch.retryTask(p.id); return { ok: true }; });
  route("POST", "/api/tasks/:id/skip", (_r, _s, p) => { orch.skipTask(p.id); return { ok: true }; });
  route("POST", "/api/tasks/:id/stop", (_r, _s, p) => { orch.stopTask(p.id); return { ok: true }; });
  route("POST", "/api/tasks/:id/merge", async (_r, _s, p) => { await orch.mergeTask(p.id); return { ok: true }; });
  route("POST", "/api/tasks/:id/mark-merged", async (_r, _s, p) => { await orch.markMerged(p.id); return { ok: true }; });
  route("POST", "/api/tasks/:id/request-changes", async (_r, _s, p, b) => { await orch.requestChanges(p.id, String(b.feedback ?? "")); return { ok: true }; });
  route("POST", "/api/tasks/:id/edit", (_r, _s, p, b) => { orch.editTask(p.id, b); return { ok: true }; });

  // ---- phase validation (§10.3): owner actions on a phase waiting in the inbox ----
  route("POST", "/api/phases/:id/revalidate", (_r, _s, p) => { orch.revalidatePhase(Number(p.id)); return { ok: true }; });
  route("POST", "/api/phases/:id/accept", (_r, _s, p) => { orch.acceptPhase(Number(p.id)); return { ok: true }; });

  // ---- questions & decisions (dashboard + agent CLI) ----
  route("POST", "/api/questions/:id/answer", async (_r, _s, p, b) => { await orch.answerQuestion(Number(p.id), String(b.answer)); return { ok: true }; });
  route("POST", "/api/ask", (_r, _s, _p, b) => orch.recordQuestion(String(b.taskId), String(b.text), Array.isArray(b.options) ? b.options.map(String) : []));
  route("POST", "/api/decide", (_r, _s, _p, b) => orch.recordDecision(b.taskId ?? null, b.runId ?? null, String(b.actor ?? "worker"), String(b.text), b.rationale ? String(b.rationale) : null));

  // ---- SSE ----
  const clients = new Set<http.ServerResponse>();
  const send = (type: string, payload: any) => {
    const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const c of clients) c.write(msg);
  };
  orch.on("event", (ev) => send("event", ev));
  orch.on("change", (ch) => send("change", ch));
  const keepalive = setInterval(() => { for (const c of clients) c.write(": ping\n\n"); }, 25000);
  keepalive.unref();

  const dashboardHtml = () => fs.readFileSync(path.join(PKG_ROOT, "dashboard", "index.html"), "utf8");

  const token = orch.server.auth.token;
  const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    try {
      // ---- open routes (§16): dashboard shell, health check, login ----
      if (req.method === "GET" && (p === "/" || p === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(dashboardHtml());
        return;
      }
      if (req.method === "GET" && p === "/api/health") {
        return json(res, 200, { ok: true, version: VERSION, uptimeSec: Math.floor((Date.now() - STARTED) / 1000) });
      }
      if (req.method === "POST" && p === "/api/login") {
        const b = await readJson(req).catch(() => ({}));
        const given = typeof b?.token === "string" ? b.token.trim() : "";
        if (!token) return json(res, 200, { ok: true, auth: false });
        if (!given || !tokenMatches(given, token)) return json(res, 401, { error: "unauthorized" });
        return json(res, 200, { ok: true, auth: true }, { "set-cookie": loginCookie(token) });
      }
      // ---- everything else needs the token when one is set ----
      if (!isAuthorized(req, token)) return json(res, 401, { error: "unauthorized" });
      if (req.method === "GET" && p === "/api/events/stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
        res.write(": connected\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = p.match(r.pattern);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        const body = req.method === "POST" ? await readJson(req) : null;
        const out = await r.handler(req, res, params, body ?? {});
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
        res.end(JSON.stringify(out ?? { ok: true }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    } catch (e: any) {
      res.writeHead(e?.status === 404 ? 404 : 400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e?.message ?? String(e) }));
    }
  });

  const { host, port } = orch.server;
  server.listen(port, host, () => {
    const projects = orch.store.listProjects().map((p) => p.id);
    console.log(`orch dashboard: http://${host === "0.0.0.0" ? "localhost" : host}:${port}  (data: ${orch.home}; projects: ${projects.join(", ") || "none"}; auth ${token ? "on" : "off"})`);
  });
  return server;
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => { if (!data.trim()) return resolve({}); try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("invalid JSON body")); } });
    req.on("error", reject);
  });
}
