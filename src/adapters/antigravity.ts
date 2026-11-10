/**
 * Antigravity CLI adapter (`agy`, Google):
 *   agy --output-format stream-json --input-format stream-json [extraArgs] [--model m] [--conversation id]
 *
 * The prompt goes in on stdin as one NDJSON line `{"event":"user","message":{"content":"<prompt>"}}`
 * (no OS argument-length limit; `-p` text would be dropped in stream-json input mode). Headless runs
 * need `--dangerously-skip-permissions` (default in config): without it a tool needing approval is
 * soft-denied and the run still exits 0.
 *
 * Stream shape (one JSON object per line, top-level `event`); contract: specs/001-orch-roadmap/contracts/antigravity-cli.md,
 * recorded in test/fixtures/adapters/antigravity.jsonl:
 *   {event:"init", conversation_id, init:{cwd, tools, permission_mode, model}}
 *   {event:"step_update", step_update:{conversation_id, step_index, state:"ACTIVE"|"DONE", step_type, ...}}
 *     step_type "agent_response": text_delta per line; the step's deltas concatenate into one message
 *     step_type "tool": call and result together: tool_name, tool_info:{name, parameters, output, error?:{type,message}}
 *     other step types (user_input, checkpoint, subagent_info, …) are skipped
 *   {event:"result", result:{conversation_id, status:"SUCCESS"|"ERROR"|"CANCELED"|"INTERRUPTED"|"INVALID", response, error?, duration_seconds, num_turns, usage}}
 * No cost is reported (tokens only), so costUsd stays null and the dashboard shows n/a.
 */
import type { AdapterConfig, AgentAdapter, LaunchOptions, LaunchSpec, NormalizedEvent, StreamState } from "./types.js";
import { summarizeInput } from "./runner.js";

interface Scratch {
  /** Text deltas of the agent_response step in flight, keyed by step_index. */
  steps: Map<number, string>;
  /** Text of the last completed agent_response step (fallback for finalText). */
  lastText: string;
}
const scratch = new WeakMap<StreamState, Scratch>();
const s = (state: StreamState): Scratch => {
  let v = scratch.get(state);
  if (!v) { v = { steps: new Map(), lastText: "" }; scratch.set(state, v); }
  return v;
};

/** Close every agent_response step still open (no DONE line seen) as one text event each. */
function flushOpenSteps(state: StreamState, out: NormalizedEvent[]) {
  const sc = s(state);
  for (const [, text] of sc.steps) {
    if (text.trim()) { out.push({ kind: "text", data: { text } }); sc.lastText = text; }
  }
  sc.steps.clear();
  state.currentText = "";
}

export const antigravityAdapter: AgentAdapter = {
  name: "antigravity",
  supportsResume: true,

  launch(cfg: AdapterConfig, opts: LaunchOptions): LaunchSpec {
    const args = ["--output-format", "stream-json", "--input-format", "stream-json", ...cfg.extraArgs];
    if (opts.model) args.push("--model", opts.model);
    if (opts.resumeSessionId) args.push("--conversation", opts.resumeSessionId);
    const stdin = JSON.stringify({ event: "user", message: { content: opts.prompt } }) + "\n";
    return { command: cfg.command, args, stdin };
  },

  parseLine(msg: any, state: StreamState): NormalizedEvent[] {
    if (msg._raw !== undefined) return [{ kind: "text", data: { text: msg._raw } }];
    const out: NormalizedEvent[] = [];
    switch (msg.event) {
      case "init": {
        if (msg.conversation_id) state.sessionId = msg.conversation_id;
        out.push({ kind: "info", data: { subtype: "init", model: msg.init?.model, session_id: msg.conversation_id, permission_mode: msg.init?.permission_mode } });
        break;
      }
      case "step_update": {
        const su = msg.step_update ?? {};
        if (su.conversation_id) state.sessionId = su.conversation_id;
        const idx = typeof su.step_index === "number" ? su.step_index : -1;
        if (su.step_type === "agent_response") {
          const sc = s(state);
          const text = (sc.steps.get(idx) ?? "") + (su.text_delta ?? "");
          if (su.state === "DONE") {
            sc.steps.delete(idx);
            if (text.trim()) { out.push({ kind: "text", data: { text } }); sc.lastText = text; }
            state.currentText = "";
          } else {
            sc.steps.set(idx, text);
            state.currentText = text;
          }
        } else if (su.step_type === "tool" && su.state === "DONE") {
          const info = su.tool_info ?? {};
          const id = `step-${idx}`;
          const isError = !!info.error;
          out.push({ kind: "tool", data: { name: info.name ?? su.tool_name, input: summarizeInput(info.parameters), id } });
          const output = info.output ?? (isError ? `${info.error.type ? info.error.type + ": " : ""}${info.error.message ?? ""}` : "");
          out.push({ kind: "agent", data: { kind: "tool_result", id, is_error: isError, output: String(output).slice(0, 1500) } });
        }
        break;
      }
      case "result": {
        const r = msg.result ?? {};
        flushOpenSteps(state, out);
        if (r.conversation_id) state.sessionId = r.conversation_id;
        state.sawResult = true;
        state.finalText = (typeof r.response === "string" && r.response) || s(state).lastText;
        const status = String(r.status ?? "");
        if (status !== "SUCCESS") {
          state.isError = true;
          out.push({ kind: "error", data: { message: r.error ? `${status}: ${r.error}` : `agy finished with status ${status || "unknown"}` } });
        }
        out.push({
          kind: "info",
          data: {
            subtype: status.toLowerCase() || "result",
            is_error: state.isError,
            duration_ms: typeof r.duration_seconds === "number" ? Math.round(r.duration_seconds * 1000) : undefined,
            num_turns: r.num_turns,
            usage: r.usage,
          },
        });
        break;
      }
    }
    return out;
  },

  finish(state: StreamState): void {
    if (!state.finalText) {
      const sc = s(state);
      const open = [...sc.steps.values()].find((t) => t.trim());
      state.finalText = open ?? sc.lastText ?? state.currentText;
    }
  },
};
