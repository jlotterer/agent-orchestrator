/**
 * Spawns an agent CLI through its adapter and turns the output stream into normalized events.
 * This is the only place that touches child processes for agents.
 */
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { AgentResult } from "../types.js";
import type { AdapterConfig, AgentAdapter, LaunchOptions, NormalizedKind, StreamState } from "./types.js";

export interface RunOptions extends LaunchOptions {
  adapter: AgentAdapter;
  adapterConfig: AdapterConfig;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  onEvent: (kind: NormalizedKind, data: any) => void;
  onSpawn?: (child: ChildProcess) => void;
}

/**
 * Fenced code blocks tagged `json` or untagged, in order. Line-based so that a block in another
 * language (```ts) is skipped as a whole and fences may be indented (e.g. inside a list item).
 */
function jsonFences(text: string): string[] {
  const blocks: string[] = [];
  let open: { lang: string; lines: string[] } | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!open) {
      const m = line.match(/^\s*```\s*([\w+-]*)\s*$/);
      if (m) open = { lang: m[1].toLowerCase(), lines: [] };
    } else if (/^\s*```\s*$/.test(line)) {
      if (open.lang === "" || open.lang === "json") blocks.push(open.lines.join("\n"));
      open = null;
    } else {
      open.lines.push(line);
    }
  }
  return blocks;
}

/** Extract the last parseable fenced ```json block (or trailing JSON object) from text. */
export function extractJson(text: string): any | null {
  const fences = jsonFences(text);
  for (let i = fences.length - 1; i >= 0; i--) {
    try { return JSON.parse(fences[i]); } catch { /* try next */ }
  }
  const last = text.lastIndexOf("{");
  if (last >= 0) {
    for (let start = last; start >= 0; start = text.lastIndexOf("{", start - 1)) {
      try { return JSON.parse(text.slice(start).trim()); } catch { /* keep walking back */ }
      if (start === 0) break;
    }
  }
  return null;
}

export function runAgent(opts: RunOptions): Promise<AgentResult> {
  return new Promise((resolve) => {
    const { adapter, adapterConfig } = opts;
    const spec = adapter.launch(adapterConfig, { prompt: opts.prompt, model: opts.model, resumeSessionId: opts.resumeSessionId });
    const state: StreamState = { sessionId: opts.resumeSessionId ?? null, finalText: "", currentText: "", isError: false, costUsd: null, sawResult: false };
    const started = Date.now();
    let stderr = "";
    let settled = false;

    const child = spawn(spec.command, spec.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...adapterConfig.env, ...(opts.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    opts.onSpawn?.(child);

    const timer = setTimeout(() => {
      opts.onEvent("error", { message: `${adapter.name} timed out after ${Math.round(opts.timeoutMs / 60000)} min; killing` });
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, opts.timeoutMs);

    child.stdin.on("error", () => { /* agent may exit before we finish writing */ });
    if (spec.stdin !== null) child.stdin.write(spec.stdin);
    child.stdin.end();

    child.stderr.on("data", (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      line = line.trim();
      if (!line) return;
      let msg: any;
      try { msg = JSON.parse(line); } catch { msg = { _raw: line }; }
      let events;
      try { events = adapter.parseLine(msg, state); } catch (e: any) { events = [{ kind: "error" as const, data: { message: `adapter parse error: ${e?.message ?? e}` } }]; }
      for (const ev of events) opts.onEvent(ev.kind, ev.data);
    });

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      adapter.finish(state, code);
      if (code !== 0 && !state.isError) {
        state.isError = true;
        opts.onEvent("error", { message: `${adapter.name} exited with code ${code}${signal ? ` (${signal})` : ""}`, stderr: stderr.slice(-3000) });
      }
      resolve({
        ok: !state.isError,
        text: state.finalText,
        sessionId: state.sessionId,
        isError: state.isError,
        costUsd: state.costUsd,
        durationMs: Date.now() - started,
        structured: extractJson(state.finalText),
      });
    };
    child.on("error", (err) => {
      opts.onEvent("error", { message: `failed to start '${spec.command}': ${err.message}` });
      state.isError = true;
      finish(-1, null);
    });
    child.on("close", finish);
  });
}

/** Trim long string fields in tool inputs for the log. */
export function summarizeInput(input: any): any {
  if (!input || typeof input !== "object") return input;
  const out: any = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = typeof v === "string" && v.length > 400 ? v.slice(0, 400) + `… (${v.length} chars)` : v;
  }
  return out;
}
