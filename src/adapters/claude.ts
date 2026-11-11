/**
 * Claude Code adapter: `claude -p --output-format stream-json --verbose [--model m] [--resume id]`
 * Prompt goes in on stdin.
 *
 * Stream shape (one JSON object per line):
 *   {type:"system", subtype:"init", session_id, model, ...}
 *   {type:"assistant", message:{content:[{type:"text",text}|{type:"tool_use",id,name,input}]}}
 *   {type:"user", message:{content:[{type:"tool_result",tool_use_id,content,is_error}]}}
 *   {type:"result", subtype:"success"|..., is_error, result, total_cost_usd, session_id}
 *   (plus stream_event / autocompact_state lines, ignored)
 */
import type { AccountStatus, AdapterConfig, AgentAdapter, LaunchOptions, LaunchSpec, NormalizedEvent, StreamState } from "./types.js";
import { summarizeInput } from "./runner.js";

export const claudeAdapter: AgentAdapter = {
  name: "claude",
  supportsResume: true,

  launch(cfg: AdapterConfig, opts: LaunchOptions): LaunchSpec {
    const args = ["-p", "--output-format", "stream-json", "--verbose", ...cfg.extraArgs];
    if (opts.model) args.push("--model", opts.model);
    if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
    return { command: cfg.command, args, stdin: opts.prompt };
  },

  parseLine(msg: any, state: StreamState): NormalizedEvent[] {
    if (msg._raw !== undefined) return [{ kind: "text", data: { text: msg._raw } }];
    if (msg.session_id) state.sessionId = msg.session_id;
    const out: NormalizedEvent[] = [];
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") out.push({ kind: "info", data: { subtype: "init", model: msg.model, session_id: msg.session_id } });
        break;
      case "assistant":
        for (const block of msg.message?.content ?? []) {
          if (block.type === "text" && block.text) {
            state.currentText = block.text;
            out.push({ kind: "text", data: { text: block.text } });
          } else if (block.type === "tool_use") {
            out.push({ kind: "tool", data: { name: block.name, input: summarizeInput(block.input), id: block.id } });
          }
        }
        break;
      case "user":
        for (const block of msg.message?.content ?? []) {
          if (block.type === "tool_result") {
            const raw = typeof block.content === "string" ? block.content
              : Array.isArray(block.content) ? block.content.map((c: any) => c.text ?? "").join("\n") : "";
            out.push({ kind: "agent", data: { kind: "tool_result", id: block.tool_use_id, is_error: !!block.is_error, output: raw.slice(0, 1500) } });
          }
        }
        break;
      case "result":
        state.sawResult = true;
        state.finalText = msg.result ?? state.currentText;
        state.isError = !!msg.is_error || (msg.subtype && msg.subtype !== "success");
        state.costUsd = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null;
        out.push({ kind: "info", data: { subtype: msg.subtype, is_error: state.isError, cost_usd: state.costUsd, duration_ms: msg.duration_ms, num_turns: msg.num_turns } });
        break;
    }
    return out;
  },

  finish(state: StreamState): void {
    if (!state.finalText) state.finalText = state.currentText;
  },

  // Sign-in (T028; contract sign-in-flows.md). `claude auth login` defaults to the subscription (--claudeai);
  // headless it prints a URL and then waits for the code shown after sign-in to be pasted back.
  account: {
    status: (cfg: AdapterConfig): LaunchSpec => ({ command: cfg.command, args: ["auth", "status", "--json"], stdin: null }),
    parseStatus(output: string, exitCode: number | null): AccountStatus {
      const i = output.indexOf("{");
      if (i >= 0) {
        try {
          const j = JSON.parse(output.slice(i, output.lastIndexOf("}") + 1));
          if (j.loggedIn === true) return { signedIn: true, detail: String(j.authMethod ?? j.apiProvider ?? "signed in") };
          if (j.loggedIn === false) return { signedIn: false, detail: "not signed in" };
        } catch { /* fall through */ }
      }
      return { signedIn: false, detail: exitCode === null ? "status check timed out" : "not signed in" };
    },
    login: (cfg: AdapterConfig): LaunchSpec => ({ command: cfg.command, args: ["auth", "login"], stdin: null }),
    failureHint: "Run `claude auth login` by hand, or `claude setup-token` and set the token in the adapter's env.",
  },
};
