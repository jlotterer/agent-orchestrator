/**
 * The dashboard is one hand-written HTML file with inline scripts and no build step, so a typo
 * in it only shows up as a blank page in the browser. Parse every inline script with node's
 * compiler so a syntax error fails the unit tests instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, "..", "..", "dashboard", "index.html");

test("dashboard/index.html: every inline script parses", () => {
  const html = fs.readFileSync(file, "utf8");
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let n = 0;
  for (let m; (m = re.exec(html)); ) {
    n++;
    // Throws a SyntaxError with the line of the problem when the script does not compile.
    new vm.Script(m[1], { filename: `dashboard/index.html#script${n}` });
  }
  assert.ok(n >= 1, "expected at least one inline <script> in the dashboard");
});
