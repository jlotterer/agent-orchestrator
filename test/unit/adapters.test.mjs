/**
 * Antigravity CLI and Codex CLI adapters (T027; REQ-ADAPT-02, REQ-ADAPT-03, REQ-NFR-04; decision 0024):
 * launch args, stream parsing against the recorded fixtures in test/fixtures/adapters/, the runner's
 * optional stdin hold, and the retired Gemini adapter. Run after `npm run build`: npm run test:unit
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ADAPTERS, getAdapter, runAgent } from "../../dist/adapters/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = path.join(ROOT, "test", "fixtures", "adapters");
const lines = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));

/** Feed every fixture line through the adapter, as the runner does, then finish; return events and state. */
function parse(adapter, fixture, exitCode = 0) {
  const state = { sessionId: null, finalText: "", currentText: "", isError: false, costUsd: null, sawResult: false };
  const events = [];
  for (const msg of lines(fixture)) events.push(...adapter.parseLine(msg, state));
  adapter.finish(state, exitCode);
  return { events, state };
}
const ofKind = (events, kind) => events.filter((e) => e.kind === kind);
const toolResults = (events) => events.filter((e) => e.kind === "agent" && e.data.kind === "tool_result");

describe("adapter registry", () => {
  test("antigravity and codex are registered; gemini is retired", () => {
    assert.deepEqual(Object.keys(ADAPTERS).sort(), ["antigravity", "claude", "codex"]);
    assert.equal(getAdapter("antigravity").name, "antigravity");
    assert.equal(getAdapter("codex").name, "codex");
    assert.throws(() => getAdapter("gemini"), /unknown adapter type 'gemini'/);
    assert.ok(!fs.existsSync(path.join(ROOT, "src", "adapters", "gemini.ts")), "src/adapters/gemini.ts must be gone");
  });
  test("both new adapters support resume", () => {
    assert.equal(ADAPTERS.antigravity.supportsResume, true);
    assert.equal(ADAPTERS.codex.supportsResume, true);
  });
});

describe("antigravity adapter", () => {
  const cfg = { type: "antigravity", command: "agy", extraArgs: ["--dangerously-skip-permissions"], env: {} };
  const adapter = ADAPTERS.antigravity;

  test("launch: stream-json in and out, prompt as one NDJSON user event", () => {
    const spec = adapter.launch(cfg, { prompt: "Do the task.\nLine 2", model: "m" });
    assert.equal(spec.command, "agy");
    assert.deepEqual(spec.args, ["--output-format", "stream-json", "--input-format", "stream-json", "--dangerously-skip-permissions", "--model", "m"]);
    assert.equal(spec.stdin, JSON.stringify({ event: "user", message: { content: "Do the task.\nLine 2" } }) + "\n");
    assert.equal(spec.stdin.trim().split("\n").length, 1, "exactly one line on stdin");
  });
  test("launch: resume adds --conversation <id>; no model adds no --model", () => {
    const spec = adapter.launch(cfg, { prompt: "p", resumeSessionId: "c1" });
    assert.ok(spec.args.includes("--conversation") && spec.args[spec.args.indexOf("--conversation") + 1] === "c1");
    assert.ok(!spec.args.includes("--model"));
  });

  test("recorded stream: init, tools, text, result", () => {
    const { events, state } = parse(adapter, "antigravity.jsonl");
    const fixture = lines("antigravity.jsonl");
    const init = fixture[0], result = fixture.at(-1).result;

    assert.equal(events[0].kind, "info");
    assert.equal(events[0].data.subtype, "init");
    assert.equal(events[0].data.session_id, init.conversation_id);
    assert.equal(events[0].data.model, init.init.model);
    assert.equal(state.sessionId, init.conversation_id);

    // A tool step is one ACTIVE line (the call) and one DONE line (call + result); the adapter emits on DONE only.
    const toolSteps = fixture.filter((m) => m.event === "step_update" && m.step_update.step_type === "tool" && m.step_update.state === "DONE");
    assert.ok(fixture.some((m) => m.event === "step_update" && m.step_update.step_type === "tool" && m.step_update.state === "ACTIVE"), "the recording has ACTIVE tool lines");
    const tools = ofKind(events, "tool"), results = toolResults(events);
    assert.equal(tools.length, toolSteps.length, "one tool event per tool step");
    assert.equal(results.length, toolSteps.length, "one tool_result per tool step");
    toolSteps.forEach((step, i) => {
      const info = step.step_update.tool_info;
      assert.equal(tools[i].data.name, info.name);
      assert.deepEqual(tools[i].data.input, info.parameters);
      assert.equal(tools[i].data.id, results[i].data.id, "call and result share an id");
      // is_error from tool_info.error, or from a non-zero "Command exited with code N." in the output (how agy 1.5.3 reports a failed command).
      const failed = !!info.error || /^Command exited with code [1-9]/.test(info.output ?? "");
      assert.equal(results[i].data.is_error, failed, `step ${step.step_update.step_index}`);
      assert.equal(results[i].data.output, info.output);
    });
    assert.deepEqual(results.map((r) => r.data.is_error), [false, true], "cat of a missing file is the failed one");

    // agent_response steps: deltas of one step become one text event; thinking-only steps (no text_delta) yield none.
    const byStep = new Map();
    for (const m of fixture) if (m.event === "step_update" && m.step_update.step_type === "agent_response" && m.step_update.text_delta) byStep.set(m.step_update.step_index, (byStep.get(m.step_update.step_index) ?? "") + m.step_update.text_delta);
    const texts = ofKind(events, "text");
    assert.deepEqual(texts.map((t) => t.data.text), [...byStep.values()], "one text event per agent_response step with text, deltas concatenated");
    assert.equal(texts.at(-1).data.text, result.response, "the recorded response equals the concatenated deltas of the last step");

    assert.equal(state.sawResult, true);
    assert.equal(state.finalText, result.response);
    assert.equal(state.isError, false);
    assert.equal(state.costUsd, null);
    assert.equal(ofKind(events, "error").length, 0);
    const last = events.at(-1);
    assert.equal(last.kind, "info");
    assert.equal(last.data.subtype, "success");
    assert.deepEqual(last.data.usage, result.usage);
  });

  test("a tool_info.error marks the result failed and its message is the output", () => {
    const state = { sessionId: null, finalText: "", currentText: "", isError: false, costUsd: null, sawResult: false };
    const ev = adapter.parseLine({ event: "step_update", step_update: { step_index: 6, state: "DONE", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file", parameters: { AbsolutePath: "/x" }, error: { type: "NOT_FOUND", message: "no such file: /x" } } } }, state);
    assert.deepEqual(ev.map((e) => e.kind), ["tool", "agent"]);
    assert.equal(ev[1].data.is_error, true);
    assert.equal(ev[1].data.output, "NOT_FOUND: no such file: /x");
    assert.equal(state.isError, false, "a failed tool does not fail the run");
  });

  test("recorded ERROR result sets isError and yields an error event with result.error", () => {
    const { events, state } = parse(adapter, "antigravity-error.jsonl", 1);
    assert.equal(state.isError, true);
    assert.equal(state.sawResult, true);
    const errs = ofKind(events, "error");
    assert.equal(errs.length, 1);
    assert.match(errs[0].data.message, /authentication failed or timed out/);
    assert.equal(state.costUsd, null);
  });

  test("summarizes long tool parameters", () => {
    const state = { sessionId: null, finalText: "", currentText: "", isError: false, costUsd: null, sawResult: false };
    const big = "x".repeat(1000);
    const ev = adapter.parseLine({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "tool", tool_info: { name: "write_to_file", parameters: { CodeContent: big }, output: "" } } }, state);
    assert.equal(ev[0].kind, "tool");
    assert.ok(ev[0].data.input.CodeContent.length < 500 && ev[0].data.input.CodeContent.includes("(1000 chars)"));
  });

  test("an agent_response step still open at exit becomes finalText", () => {
    const state = { sessionId: null, finalText: "", currentText: "", isError: false, costUsd: null, sawResult: false };
    adapter.parseLine({ event: "step_update", step_update: { step_index: 3, state: "ACTIVE", step_type: "agent_response", text_delta: "partial" } }, state);
    adapter.finish(state, 1);
    assert.equal(state.finalText, "partial");
  });
});

describe("codex adapter", () => {
  const cfg = { type: "codex", command: "codex", extraArgs: ["--dangerously-bypass-approvals-and-sandbox"], env: {} };
  const adapter = ADAPTERS.codex;

  test("launch: exec --json … --model m -, prompt on stdin", () => {
    const spec = adapter.launch(cfg, { prompt: "Do the task.", model: "m" });
    assert.equal(spec.command, "codex");
    assert.deepEqual(spec.args, ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--model", "m", "-"]);
    assert.equal(spec.stdin, "Do the task.");
  });
  test("launch: resume starts `exec resume <id>` and still reads the prompt from stdin", () => {
    const spec = adapter.launch(cfg, { prompt: "Continue.", model: "m", resumeSessionId: "t1" });
    assert.deepEqual(spec.args.slice(0, 3), ["exec", "resume", "t1"]);
    assert.equal(spec.args.at(-1), "-");
    assert.equal(spec.stdin, "Continue.");
    assert.ok(!spec.args.includes("--ephemeral"));
  });

  test("recorded stream: thread, command items, messages, usage", () => {
    const { events, state } = parse(adapter, "codex.jsonl");
    const fixture = lines("codex.jsonl");
    assert.equal(state.sessionId, fixture[0].thread_id);
    assert.equal(events[0].kind, "info");
    assert.equal(events[0].data.subtype, "init");
    assert.equal(events[0].data.session_id, fixture[0].thread_id);

    const started = fixture.filter((m) => m.type === "item.started" && m.item.type === "command_execution");
    const completed = fixture.filter((m) => m.type === "item.completed" && m.item.type === "command_execution");
    const tools = ofKind(events, "tool"), results = toolResults(events);
    assert.equal(tools.length, started.length, "a tool event per command_execution item.started");
    assert.equal(results.length, completed.length, "a tool_result per command_execution item.completed");
    started.forEach((m, i) => {
      assert.equal(tools[i].data.id, m.item.id);
      assert.equal(tools[i].data.name, "command_execution");
      assert.equal(tools[i].data.input.command, m.item.command);
    });
    completed.forEach((m, i) => {
      assert.equal(results[i].data.id, m.item.id);
      assert.equal(results[i].data.is_error, m.item.exit_code !== 0);
      assert.ok(results[i].data.output.startsWith(m.item.aggregated_output.trimEnd()));
    });

    const messages = fixture.filter((m) => m.type === "item.completed" && m.item.type === "agent_message");
    assert.equal(ofKind(events, "text").length, messages.length);
    assert.equal(state.finalText, messages.at(-1).item.text, "the last agent_message is finalText");
    assert.ok(!JSON.stringify(events).includes("Reading the task**"), "reasoning items are skipped");

    const usage = fixture.at(-1).usage;
    const infos = ofKind(events, "info");
    assert.deepEqual(infos.at(-1).data.usage, usage, "turn.completed.usage appears in an info event");
    assert.equal(state.sawResult, true);
    assert.equal(state.isError, false);
    assert.equal(state.costUsd, null);
    assert.equal(ofKind(events, "error").length, 0);
  });

  test("recorded failure: error and turn.failed lines set isError with error events", () => {
    const { events, state } = parse(adapter, "codex-error.jsonl", 1);
    assert.equal(state.isError, true);
    assert.equal(state.sawResult, true);
    const errs = ofKind(events, "error");
    assert.ok(errs.length >= 2);
    assert.match(errs.at(-1).data.message, /401 Unauthorized/);
    assert.equal(state.costUsd, null);
  });
  test("a lone error line sets isError; a lone turn.failed sets isError", () => {
    for (const line of [{ type: "error", message: "boom" }, { type: "turn.failed", error: { message: "boom" } }]) {
      const state = { sessionId: null, finalText: "", currentText: "", isError: false, costUsd: null, sawResult: false };
      const ev = adapter.parseLine(line, state);
      assert.equal(state.isError, true, JSON.stringify(line));
      assert.equal(ev[0].kind, "error");
      assert.equal(ev[0].data.message, "boom");
    }
  });
  test("a transient error followed by turn.completed is not a failed run", () => {
    const state = { sessionId: null, finalText: "", currentText: "", isError: false, costUsd: null, sawResult: false };
    adapter.parseLine({ type: "error", message: "Reconnecting... 1/5" }, state);
    adapter.parseLine({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "done" } }, state);
    adapter.parseLine({ type: "turn.completed", usage: {} }, state);
    adapter.finish(state, 0);
    assert.equal(state.isError, false);
    assert.equal(state.finalText, "done");
  });
  test("mcp_tool_call and file_change items are tools; a completed item without a start still gets a tool event", () => {
    const state = { sessionId: null, finalText: "", currentText: "", isError: false, costUsd: null, sawResult: false };
    const ev = [
      ...adapter.parseLine({ type: "item.started", item: { id: "m1", type: "mcp_tool_call", server: "gh", tool: "pr_view", arguments: { number: 1 } } }, state),
      ...adapter.parseLine({ type: "item.completed", item: { id: "m1", type: "mcp_tool_call", server: "gh", tool: "pr_view", status: "completed", result: { ok: true } } }, state),
      ...adapter.parseLine({ type: "item.completed", item: { id: "f1", type: "file_change", status: "completed", changes: [{ path: "impl/T001.txt", kind: "add" }] } }, state),
    ];
    assert.deepEqual(ev.map((e) => e.kind), ["tool", "agent", "tool", "agent"]);
    assert.equal(ev[0].data.name, "gh.pr_view");
    assert.equal(ev[1].data.output, '{"ok":true}');
    assert.equal(ev[2].data.name, "file_change");
    assert.equal(ev[3].data.output, "add impl/T001.txt");
  });
});

describe("runner", () => {
  test("holdStdin keeps stdin open until the adapter reports the result", async () => {
    // A child that waits 300 ms, says whether stdin already closed, then waits for stdin to end before exiting.
    const script = `
      let ended = false; process.stdin.on("end", () => { ended = true; if (reported) process.exit(0); }); process.stdin.resume();
      let reported = false;
      setTimeout(() => { process.stdout.write(JSON.stringify({ early: ended }) + "\\n"); reported = true; if (ended) process.exit(0); }, 300);
      setTimeout(() => process.exit(3), 5000);`;
    const make = (holdStdin) => ({
      name: "stub", supportsResume: false,
      launch: () => ({ command: process.execPath, args: ["-e", script], stdin: "hello", holdStdin }),
      parseLine(msg, state) { state.sawResult = true; state.finalText = JSON.stringify(msg); return [{ kind: "info", data: msg }]; },
      finish() {},
    });
    const run = (holdStdin) => runAgent({ adapter: make(holdStdin), adapterConfig: { type: "stub", command: "", extraArgs: [], env: {} }, prompt: "p", cwd: ROOT, timeoutMs: 10_000, onEvent() {} });
    const held = await run(true);
    assert.equal(held.ok, true, "the child exited 0 after stdin was ended on sawResult");
    assert.deepEqual(JSON.parse(held.text), { early: false });
    const plain = await run(false);
    assert.equal(plain.ok, true);
    assert.deepEqual(JSON.parse(plain.text), { early: true }, "without holdStdin, stdin closes right after the prompt");
  });
});

describe("invariants (npm run check)", () => {
  test("passes, and its vendor regex covers the new vendors", () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "check-invariants.mjs")], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const src = fs.readFileSync(path.join(ROOT, "scripts", "check-invariants.mjs"), "utf8");
    const vendor = src.match(/^const VENDOR = (\/.*\/i);$/m)[1];
    for (const word of ["claude", "gemini", "anthropic", "antigravity", "agy", "codex", "openai"]) assert.ok(new RegExp(vendor.slice(1, -2), "i").test(`x ${word} y`), word);
    assert.ok(!new RegExp(vendor.slice(1, -2), "i").test("strategy"), "agy matches as a word only");
    const allow = src.slice(src.indexOf("const ALLOWLIST"), src.indexOf("const errors"));
    assert.ok(/\(claude\|antigravity\|codex\): /.test(allow) && /"\(claude\|antigravity\|agy\|codex\)"/.test(allow), "allowlist covers the new defaults");
    assert.ok(!/\(claude\|gemini\)/.test(allow), "allowlist no longer covers a gemini default");
  });
});
