/**
 * Gemini CLI adapter: `gemini -p "<trailer>" --output-format stream-json [-m model] [--resume id]`
 *
 * The prompt is written to stdin; Gemini CLI appends the -p text to whatever arrives on stdin,
 * so we keep -p to a one-line trailer. This avoids OS argument-length limits on big diffs.
 *
 * Headless gotchas handled via extraArgs defaults in config: `--yolo` (otherwise tools that
 * need approval are silently denied and the run still exits 0) and `--skip-trust` (otherwise
 * a fresh worktree is an untrusted folder and the CLI exits 55).
 *
 * Stream shape (one JSON object per line), from the CLI source:
 *   {type:"init", timestamp, session_id, model}
 *   {type:"message", role:"user"|"assistant", content, delta?:true}   // assistant text arrives as deltas
 *   {type:"tool_use", tool_name, tool_id, parameters}
 *   {type:"tool_result", tool_id, status:"success"|"error", output, error?:{type,message}}
 *   {type:"error", severity, message}
 *   {type:"result", status:"success"|"error", error?, stats}
 */
import type { AdapterConfig, AgentAdapter, LaunchOptions, LaunchSpec, NormalizedEvent, StreamState } from "./types.js";
import { summarizeInput } from "./runner.js";

/** Per-run scratch: assistant text is segmented by tool calls; the last segment is the final message. */
const scratch = new WeakMap<StreamState, { lastSegment: string }>();
const s = (state: StreamState) => { let v = scratch.get(state); if (!v) { v = { lastSegment: "" }; scratch.set(state, v); } return v; };

function endSegment(state: StreamState, out: NormalizedEvent[]) {
  if (state.currentText.trim()) {
    out.push({ kind: "text", data: { text: state.currentText } });
    s(state).lastSegment = state.currentText;
  }
  state.currentText = "";
}

export const geminiAdapter: AgentAdapter = {
  name: "gemini",
  supportsResume: true,

  launch(cfg: AdapterConfig, opts: LaunchOptions): LaunchSpec {
    const args = ["-p", "The instructions above are your task. Follow them exactly, including the final JSON block.", "--output-format", "stream-json", ...cfg.extraArgs];
    if (opts.model) args.push("-m", opts.model);
    if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
    return { command: cfg.command, args, stdin: opts.prompt };
  },

  parseLine(msg: any, state: StreamState): NormalizedEvent[] {
    if (msg._raw !== undefined) return [{ kind: "text", data: { text: msg._raw } }];
    const out: NormalizedEvent[] = [];
    switch (msg.type) {
      case "init":
        if (msg.session_id) state.sessionId = msg.session_id;
        out.push({ kind: "info", data: { subtype: "init", model: msg.model, session_id: msg.session_id } });
        break;
      case "message":
        if (msg.role === "assistant" && typeof msg.content === "string") {
          state.currentText = msg.delta ? state.currentText + msg.content : msg.content;
        }
        break;
      case "tool_use":
        endSegment(state, out);
        out.push({ kind: "tool", data: { name: msg.tool_name, input: summarizeInput(msg.parameters), id: msg.tool_id } });
        break;
      case "tool_result":
        out.push({ kind: "agent", data: { kind: "tool_result", id: msg.tool_id, is_error: msg.status === "error", output: String(msg.output ?? msg.error?.message ?? "").slice(0, 1500) } });
        break;
      case "error":
        out.push({ kind: "error", data: { message: `${msg.severity ?? "error"}: ${msg.message}` } });
        if (msg.severity === "error") state.isError = true;
        break;
      case "result":
        endSegment(state, out);
        state.sawResult = true;
        state.finalText = s(state).lastSegment;
        if (msg.status !== "success") {
          state.isError = true;
          if (msg.error?.message) out.push({ kind: "error", data: { message: msg.error.message } });
        }
        out.push({ kind: "info", data: { subtype: msg.status, is_error: state.isError, duration_ms: msg.stats?.duration_ms ?? msg.stats?.durationMs } });
        break;
    }
    return out;
  },

  finish(state: StreamState): void {
    if (!state.finalText) {
      if (state.currentText.trim()) s(state).lastSegment = state.currentText;
      state.finalText = s(state).lastSegment;
    }
  },
};
