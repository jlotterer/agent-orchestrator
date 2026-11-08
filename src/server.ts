import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import type { Orchestrator } from "./orchestrator.js";
import { PKG_ROOT } from "./prompts.js";
import { isAuthorized, loginCookie, tokenMatches } from "./auth.js";

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

  // ---- read ----
  route("GET", "/api/state", (_r, _s, _p, _b) => orch.snapshot());
  route("GET", "/api/runs/:id", (_r, _s, p) => orch.snapshot(p.id));
  route("GET", "/api/tasks/:id/events", (req, _s, p) => {
    const u = new URL(req.url!, "http://x");
    return orch.store.listEvents({ taskId: p.id, afterId: Number(u.searchParams.get("after") ?? 0) || undefined, limit: Number(u.searchParams.get("limit") ?? 400) });
  });
  route("GET", "/api/tasks/:id/diff", (_r, _s, p) => orch.taskDiff(p.id));
  route("GET", "/api/runs/:id/events", (req, _s, p) => {
    const u = new URL(req.url!, "http://x");
    return orch.store.listEvents({ runId: p.id, afterId: Number(u.searchParams.get("after") ?? 0) || undefined, limit: Number(u.searchParams.get("limit") ?? 200) });
  });

  // ---- run control ----
  route("POST", "/api/plan", async (_r, _s, _p, b) => orch.plan(String(b.specDir), { llm: b.llm !== false }));
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

  const token = orch.cfg.auth.token;
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

  server.listen(orch.cfg.port, orch.cfg.host, () => {
    console.log(`orch dashboard: http://${orch.cfg.host === "0.0.0.0" ? "localhost" : orch.cfg.host}:${orch.cfg.port}  (repo: ${orch.cfg.repo}; auth ${token ? "on" : "off"})`);
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
