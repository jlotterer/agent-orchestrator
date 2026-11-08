#!/usr/bin/env node
/**
 * A stand-in for a project's web app in UI validation mode (scripts/e2e-ui.mjs, TASK-16).
 * Started by orch with `validation.ui.startCommand` in the task's worktree; listens on 127.0.0.1:$PORT.
 *   GET any path -> 200 "<h1>fake app</h1>" plus the worktree's impl/ file names
 *   NEVER_READY=1 (env)   -> answers 503 to everything, so orch's readiness check never passes
 *   FAKE_APP_PIDS=<file>  -> appends this process's pid, so a test can check none is left running
 * It exits on SIGTERM, and by itself after 180 s so a failed test leaves nothing behind for long.
 */
import fs from "node:fs";
import http from "node:http";

const port = Number(process.env.PORT);
if (!port) { console.error("fake app: PORT is not set"); process.exit(2); }
if (process.env.FAKE_APP_PIDS) fs.appendFileSync(process.env.FAKE_APP_PIDS, `${process.pid}\n`);
const neverReady = !!process.env.NEVER_READY;

const server = http.createServer((req, res) => {
  if (neverReady) { res.writeHead(503, { "content-type": "text/plain" }); res.end("warming up forever\n"); return; }
  const files = fs.existsSync("impl") ? fs.readdirSync("impl") : [];
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><h1>fake app</h1><ul>${files.map((f) => `<li>${f}</li>`).join("")}</ul>\n`);
});
server.listen(port, "127.0.0.1", () => {
  console.log(`fake app pid ${process.pid} listening on ${port}${neverReady ? " (NEVER_READY: answering 503)" : ""}`);
});
process.on("SIGTERM", () => { console.log("fake app: SIGTERM"); process.exit(0); });
setTimeout(() => process.exit(3), 180_000).unref();
