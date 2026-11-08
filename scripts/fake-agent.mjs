#!/usr/bin/env node
/**
 * A stand-in for `claude -p --output-format stream-json` used by the e2e test.
 * It reads the prompt from stdin, emits NDJSON like Claude Code does, and
 * performs scripted behaviour based on which role prompt it received:
 *   planner   -> returns acceptance criteria for every task
 *   worker    -> writes impl/<KEY>.txt and commits; T002 asks a question first;
 *                T003 writes BAD on its first attempt (gate catches it);
 *                T004 writes NEEDS_REVIEW on its first attempt (validator catches it)
 *                PR scenario (scripts/e2e-pr.mjs): a task whose description has CI_TRAP writes
 *                CIFAIL until it gets feedback (fake gh's CI fails on it); review feedback
 *                that mentions "the reviewer" makes the worker write "reviewed"
 *                Owner feedback (scripts/e2e.mjs, TASK-06): a retry whose prompt says "trailing note"
 *                writes "OK note"
 *   validator -> FAIL if the diff contains NEEDS_REVIEW, else PASS
 *
 * Lifecycle markers (scripts/e2e-lifecycle.mjs), matched anywhere in the prompt:
 *   PLANNER_FAIL  (spec.md, planner) -> prints to stderr and exits 1 with no plan
 *   SLEEP_LONG    (task, worker)     -> commits impl/<KEY>.wip, writes its pid to $FAKE_STATE_DIR/<KEY>.pid,
 *                                       then sleeps (up to 120 s; exits early if orphaned). Once
 *                                       impl/<KEY>.wip exists in the worktree it behaves normally.
 *   NO_COMMIT     (task, worker)     -> reports done without changing anything
 *   CONFLICT_FILE (task, worker)     -> also writes shared.txt with task-specific content
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const resumeIdx = args.indexOf("--resume");
const sessionId = resumeIdx >= 0 ? args[resumeIdx + 1] : "sess-" + Math.random().toString(36).slice(2, 10);
const prompt = fs.readFileSync(0, "utf8");
// FAKE_FLAVOR=gemini makes this script speak Gemini CLI's stream-json dialect instead of Claude Code's.
const gemini = process.env.FAKE_FLAVOR === "gemini";
if (gemini && !args.includes("--yolo")) { console.error("fake gemini: expected --yolo"); process.exit(42); }
const emit = (o) => process.stdout.write(JSON.stringify(gemini ? o : { session_id: sessionId, ...o }) + "\n");
const say = (text) => gemini
  ? text.split(/(?<=\s)/).forEach((chunk, i) => emit({ type: "message", role: "assistant", content: chunk, delta: true }))   // Gemini streams deltas
  : emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const tool = (name, input, output) => {
  if (gemini) {
    emit({ type: "tool_use", tool_name: name, tool_id: "t1", parameters: input });
    emit({ type: "tool_result", tool_id: "t1", status: "success", output });
  } else {
    emit({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name, input }] } });
    emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: output }] } });
  }
};
const finish = (obj, text = "Done.") => {
  const full = `${text}\n\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``;
  say(full);
  if (gemini) emit({ type: "result", status: "success", stats: { duration_ms: 500 } });
  else emit({ type: "result", subtype: "success", is_error: false, result: full, total_cost_usd: 0.01, duration_ms: 500, num_turns: 3 });
};
const orch = (cmdline) => {
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "dist", "cli.js");
  const out = execSync(`node ${cli} ${cmdline}`, { env: process.env, encoding: "utf8" });
  tool("Bash", { command: `orch ${cmdline}` }, out);
  return out;
};
if (gemini) emit({ type: "init", timestamp: new Date().toISOString(), session_id: sessionId, model: "fake-gemini" });
else emit({ type: "system", subtype: "init", model: "fake", session_id: sessionId });
await new Promise((r) => setTimeout(r, 200));

if (prompt.includes("You are the PLANNER") && prompt.includes("PLANNER_FAIL")) {
  say("Something went wrong.");
  console.error("fake planner: PLANNER_FAIL marker; giving up");
  process.exit(1);
} else if (prompt.includes("You are the PLANNER")) {
  const m = prompt.match(/```json\n([\s\S]*?)\n```/);
  const tasks = JSON.parse(m[1]);
  say("Reading the spec and tasks.");
  finish({
    tasks: tasks.map((t) => ({ key: t.key, acceptance: [`impl/${t.key}.txt exists and contains OK`], depends_on: t.depends_on, merge_policy: t.key === "T004" || /(manual)/.test(t.title) ? "manual" : "auto", validate_cmd: null })),
    decisions: [{ text: "Marked T004 manual merge", rationale: "it touches the public API" }],
    questions: [],
  }, "Plan drafted.");
} else if (prompt.includes("You are the VALIDATOR")) {
  const diffBad = prompt.includes("NEEDS_REVIEW");
  tool("Bash", { command: "sh check.sh" }, diffBad ? "found NEEDS_REVIEW marker" : "all good");
  finish(diffBad
    ? { verdict: "FAIL", criteria: [{ criterion: "contains OK", met: false, evidence: "file contains NEEDS_REVIEW" }], reasons: ["impl file still contains a NEEDS_REVIEW marker"], suggestions: [] }
    : { verdict: "PASS", criteria: [{ criterion: "contains OK", met: true, evidence: "grep OK" }], reasons: [], suggestions: [] }, "Validated.");
} else {
  // worker
  const key = (prompt.match(/# Task (T\d+)/) || prompt.match(/on task (T\d+)/))[1];
  const resumed = prompt.includes("being resumed");
  const retry = prompt.includes("Feedback");
  if (key === "T002" && !resumed) {
    say("The spec is ambiguous about the greeting format.");
    orch(`ask "Should T002 greet in English or French?" --options "English,French"`);
    finish({ status: "blocked", summary: "Waiting for an answer about greeting language." }, "Blocked on a question.");
  } else if (prompt.includes("SLEEP_LONG") && !fs.existsSync(`impl/${key}.wip`)) {
    fs.mkdirSync("impl", { recursive: true });
    fs.writeFileSync(`impl/${key}.wip`, "work in progress\n");
    execSync(`git add -A && git -c user.name=fake -c user.email=f@x commit -q -m "${key}: wip"`, { stdio: "ignore" });
    tool("Bash", { command: "git commit" }, "committed wip");
    orch(`decide "Started slow work on ${key}" --why "SLEEP_LONG marker"`);
    if (process.env.FAKE_STATE_DIR) fs.writeFileSync(path.join(process.env.FAKE_STATE_DIR, `${key}.pid`), String(process.pid));
    say("Thinking for a long time…");
    const parent = process.ppid;
    const deadline = Date.now() + 120_000;
    // Exit if the daemon died (we were re-parented), so a kill -9 scenario leaves no stray agent behind.
    while (Date.now() < deadline) {
      if (process.ppid !== parent) process.exit(1);
      await new Promise((r) => setTimeout(r, 200));
    }
    finish({ status: "failed", reason: "slept too long" });
  } else if (prompt.includes("NO_COMMIT")) {
    say("Nothing to change, apparently.");
    finish({ status: "done", summary: `${key}: nothing to do.`, files: [], decisions: [] }, "Done (no changes).");
  } else {
    fs.mkdirSync("impl", { recursive: true });
    let content = "OK";
    if (key === "T003" && !retry) content = "BAD";
    if (key === "T004" && !retry) content = "OK NEEDS_REVIEW";
    if (prompt.includes("CI_TRAP") && !retry) content = "OK CIFAIL";
    if (retry && prompt.includes("the reviewer")) content = "OK reviewed";
    if (retry && prompt.includes("trailing note")) content = "OK note";
    if (key === "T002") {
      const ans = (prompt.match(/A: (\w+)/) || [])[1] || "unknown";
      content = `OK greeting=${ans}`;
    }
    fs.writeFileSync(`impl/${key}.txt`, content + "\n");
    if (prompt.includes("CONFLICT_FILE")) fs.writeFileSync("shared.txt", `written by ${key}\n`);
    tool("Write", { file_path: `impl/${key}.txt`, content }, "written");
    if (!retry) orch(`decide "Used a plain text file for ${key}" --why "the spec does not require a format"`);
    execSync(`git add -A && git -c user.name=fake -c user.email=f@x commit -q -m "${key}: implement"`, { stdio: "ignore" });
    tool("Bash", { command: "git commit" }, "committed");
    finish({ status: "done", summary: `${key} implemented in impl/${key}.txt (${content}).`, files: [`impl/${key}.txt`], decisions: [] }, "Implemented.");
  }
}
