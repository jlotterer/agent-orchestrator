#!/usr/bin/env node
/**
 * Fake CLI sign-in flow for the accounts tests (T028). Behaves like a device-code login:
 *   prints "Open https://example.test/device and enter code ABCD-EFGH", waits for one line on stdin,
 *   then writes the marker file and exits 0.
 * Env: FAKE_LOGIN_MARKER (file to write on success), FAKE_LOGIN_PIDFILE (file that receives this pid),
 *      FAKE_LOGIN_MODE = "ansi" (colour codes and an echo of the input) | "hang" (never ends) | "prompt" (the
 *      prompt has no trailing newline) | "fail" (exits 3 after the input).
 * Argument: `--version` prints a version; `status` exits 0 when the marker exists, 1 otherwise.
 */
import fs from "node:fs";
import readline from "node:readline";

const arg = process.argv[2];
const marker = process.env.FAKE_LOGIN_MARKER;
const mode = process.env.FAKE_LOGIN_MODE ?? "";

if (arg === "--version") { console.log("fake-login 1.2.3"); process.exit(0); }
if (arg === "status") {
  const ok = !!marker && fs.existsSync(marker);
  console.log(ok ? "Logged in using a fake account" : "Not logged in");
  process.exit(ok ? 0 : 1);
}

if (process.env.FAKE_LOGIN_PIDFILE) fs.writeFileSync(process.env.FAKE_LOGIN_PIDFILE, String(process.pid));
const C = (n, s) => (mode === "ansi" ? `\x1b[${n}m${s}\x1b[0m` : s);

console.log(C(32, "Open https://example.test/device and enter code ABCD-EFGH"));
if (mode === "hang") setInterval(() => {}, 1000);
else {
  if (mode === "prompt") process.stdout.write("Paste the code here > ");
  const rl = readline.createInterface({ input: process.stdin });
  rl.once("line", (line) => {
    if (mode === "fail") { console.log("sign-in failed"); process.exit(3); }
    if (marker) fs.writeFileSync(marker, "signed in\n");
    console.log("Signed in");
    process.exit(0);
  });
}
