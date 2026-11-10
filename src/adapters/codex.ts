/**
 * OpenAI Codex CLI adapter:
 *   codex exec [resume <id>] --json [extraArgs] [--model m] -
 *
 * `-` reads the prompt from stdin (also on resume), so there is no OS argument-length limit. Headless runs
 * need `--dangerously-bypass-approvals-and-sandbox` (default in config): orch's worktree is the boundary,
 * as with Claude Code's bypassPermissions. Never pass `--ephemeral`: resume needs the persisted session.
 *
 * Stream shape (`--json`, one JSON object per line, top-level `type`); contract: specs/001-orch-roadmap/contracts/codex-cli.md,
 * recorded in test/fixtures/adapters/codex.jsonl:
 *   {type:"thread.started", thread_id}                       // session id; the CLI reports no model here
 *   {type:"turn.started"}
 *   {type:"item.started"|"item.updated"|"item.completed", item:{id, type, ...}}
 *     item.type "command_execution": command, status, exit_code, aggregated_output   → tool + tool_result
 *     item.type "mcp_tool_call": server, tool, arguments, result|error                → tool + tool_result
 *     item.type "file_change": changes:[{path, kind}], status                          → tool "file_change" + tool_result
 *     item.type "agent_message": text                                                  → text (the last one is finalText)
 *     item.type "error": message                                                       → error event (final status comes from the turn)
 *     item.type "reasoning", "plan_update", "web_search", unknown                     → skipped
 *   {type:"turn.completed", usage:{input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}}
 *   {type:"turn.failed", error:{message}}
 *   {type:"error", message}
 * Top-level `error` lines also appear for transient reconnects, so an `error` marks the run failed until a
 * later `turn.completed` clears it. No cost is reported (tokens only): costUsd stays null, the dashboard shows n/a.
 */
import type { AdapterConfig, AgentAdapter, LaunchOptions, LaunchSpec, NormalizedEvent, StreamState } from "./types.js";
import { summarizeInput } from "./runner.js";

/** Item types that become a `tool` event (on item.started) and a `tool_result` (on item.completed). */
const TOOL_ITEMS = new Set(["command_execution", "mcp_tool_call", "file_change"]);

interface Scratch {
  /** Ids of tool items whose `tool` event has been emitted (item.started may be missing). */
  started: Set<string>;
  /** Text of the last agent_message. */
  lastText: string;
}
const scratch = new WeakMap<StreamState, Scratch>();
const s = (state: StreamState): Scratch => {
  let v = scratch.get(state);
  if (!v) { v = { started: new Set(), lastText: "" }; scratch.set(state, v); }
  return v;
};

function toolName(item: any): string {
  if (item.type === "mcp_tool_call") return [item.server, item.tool].filter(Boolean).join(".") || "mcp_tool_call";
  return item.type;
}

function toolInput(item: any): any {
  switch (item.type) {
    case "command_execution": return summarizeInput({ command: item.command });
    case "mcp_tool_call": return summarizeInput(item.arguments ?? {});
    case "file_change": return { changes: (item.changes ?? []).map((c: any) => `${c.kind ?? "update"} ${c.path}`).join(", ") };
    default: return summarizeInput(item);
  }
}

function toolResult(item: any): { is_error: boolean; output: string } {
  const failed = item.status === "failed" || item.status === "declined" || !!item.error;
  switch (item.type) {
    case "command_execution": {
      const exit = typeof item.exit_code === "number" ? item.exit_code : null;
      const out = String(item.aggregated_output ?? "");
      return { is_error: failed || (exit !== null && exit !== 0), output: exit !== null && exit !== 0 ? `${out}\n[exit ${exit}]`.trim() : out };
    }
    case "mcp_tool_call": {
      const body = item.error ? (item.error.message ?? JSON.stringify(item.error)) : item.result ?? item.output ?? "";
      return { is_error: failed, output: typeof body === "string" ? body : JSON.stringify(body) };
    }
    case "file_change":
      return { is_error: failed, output: (item.changes ?? []).map((c: any) => `${c.kind ?? "update"} ${c.path}`).join("\n") };
    default:
      return { is_error: failed, output: "" };
  }
}

export const codexAdapter: AgentAdapter = {
  name: "codex",
  supportsResume: true,

  launch(cfg: AdapterConfig, opts: LaunchOptions): LaunchSpec {
    const args = ["exec"];
    if (opts.resumeSessionId) args.push("resume", opts.resumeSessionId);
    args.push("--json", ...cfg.extraArgs);
    if (opts.model) args.push("--model", opts.model);
    args.push("-");
    return { command: cfg.command, args, stdin: opts.prompt };
  },

  parseLine(msg: any, state: StreamState): NormalizedEvent[] {
    if (msg._raw !== undefined) return [{ kind: "text", data: { text: msg._raw } }];
    const out: NormalizedEvent[] = [];
    const item = msg.item ?? {};
    switch (msg.type) {
      case "thread.started":
        if (msg.thread_id) state.sessionId = msg.thread_id;
        out.push({ kind: "info", data: { subtype: "init", model: msg.model, session_id: msg.thread_id } });
        break;
      case "item.started":
        if (TOOL_ITEMS.has(item.type)) {
          s(state).started.add(item.id);
          out.push({ kind: "tool", data: { name: toolName(item), input: toolInput(item), id: item.id } });
        }
        break;
      case "item.completed":
        if (item.type === "agent_message") {
          const text = String(item.text ?? "");
          state.currentText = text;
          s(state).lastText = text;
          if (text.trim()) out.push({ kind: "text", data: { text } });
        } else if (TOOL_ITEMS.has(item.type)) {
          const sc = s(state);
          if (!sc.started.has(item.id)) out.push({ kind: "tool", data: { name: toolName(item), input: toolInput(item), id: item.id } });
          sc.started.delete(item.id);
          const r = toolResult(item);
          out.push({ kind: "agent", data: { kind: "tool_result", id: item.id, is_error: r.is_error, output: r.output.slice(0, 1500) } });
        } else if (item.type === "error") {
          out.push({ kind: "error", data: { message: String(item.message ?? "codex reported an error") } });
        }
        break;
      case "turn.completed":
        state.sawResult = true;
        state.isError = false;
        state.finalText = s(state).lastText || state.currentText;
        out.push({ kind: "info", data: { subtype: "turn.completed", is_error: false, usage: msg.usage } });
        break;
      case "turn.failed":
        state.sawResult = true;
        state.isError = true;
        state.finalText = s(state).lastText || state.currentText;
        out.push({ kind: "error", data: { message: String(msg.error?.message ?? "codex turn failed") } });
        break;
      case "error":
        state.isError = true;
        out.push({ kind: "error", data: { message: String(msg.message ?? "codex error") } });
        break;
    }
    return out;
  },

  finish(state: StreamState): void {
    if (!state.finalText) state.finalText = s(state).lastText || state.currentText;
  },
};
