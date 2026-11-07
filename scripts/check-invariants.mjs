#!/usr/bin/env node
/**
 * Stack invariants (REQ-NFR-02, REQ-NFR-04, REQ-NFR-05; decisions 0007, 0009 and 0020). Exits non-zero on any violation.
 *   1. package.json `dependencies` is exactly { better-sqlite3 }.
 *   2. Agent-vendor names appear in src/**\/*.ts only inside src/adapters/, plus the allowlisted
 *      built-in defaults in src/config.ts below.
 *   3. src/core/ is pure (decision 0020): no node:fs, node:child_process or ../db imports, no
 *      Date.now() / new Date() without arguments.
 *   npm run check
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED_DEPENDENCIES = ["better-sqlite3"];
const VENDOR = /claude|gemini|anthropic/i;

/**
 * Lines outside src/adapters/ that may name a vendor. Keep this list short and specific:
 * src/config.ts ships the built-in adapter definitions (`agents.adapters.claude|gemini`), the default
 * role → adapter mapping, and the pre-0.2 `agent` block migration, which by nature name vendors.
 * Matched against the trimmed line. Anything else naming a vendor belongs in src/adapters/.
 */
const ALLOWLIST = {
  "src/config.ts": [
    /^(\/\/|\/\*|\*)/,                                                     // comments in the config module
    /^(claude|gemini): \{$/,                                               // default adapter keys
    /^(type|command): "(claude|gemini)",$/,                                // default adapter type / CLI command
    /^(planner|worker|validator): \{ adapter: "claude", model: (""|a\.\w+ \?\? "") \},$/, // default roles + legacy migration
    /^adapters: \{ claude: \{ type: "claude", command: a\.command \?\? "claude", /,        // legacy `agent` block migration
  ],
};

const errors = [];

// 1. Exactly one runtime dependency.
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const deps = Object.keys(pkg.dependencies ?? {}).sort();
if (JSON.stringify(deps) !== JSON.stringify(ALLOWED_DEPENDENCIES)) {
  errors.push(`package.json dependencies must be exactly [${ALLOWED_DEPENDENCIES.join(", ")}], found [${deps.join(", ")}] (decision 0009)`);
}

// 2. Vendor names only in the adapter layer.
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}
for (const file of walk(path.join(ROOT, "src"))) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  if (rel.startsWith("src/adapters/")) continue;
  const allow = ALLOWLIST[rel] ?? [];
  fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
    if (!VENDOR.test(line)) return;
    const t = line.trim();
    if (allow.some((re) => re.test(t))) return;
    errors.push(`${rel}:${i + 1}: vendor name outside src/adapters/ (decision 0007): ${t}`);
  });
}

// 3. src/core/ is pure (decision 0020): no file system, child processes or DB, and no clock reads.
//    Time is passed in; `new Date(x)` and `Date.parse(x)` are fine, `Date.now()` and `new Date()` are not.
const CORE_RULES = [
  [/\bfrom\s+["'](node:)?(fs|fs\/promises|child_process)["']|\brequire\(\s*["'](node:)?(fs|child_process)["']\s*\)|\bimport\(\s*["'](node:)?(fs|fs\/promises|child_process)["']\s*\)/, "imports node:fs or node:child_process"],
  [/\bfrom\s+["']\.\.\/db(\.js)?["']|\bimport\(\s*["']\.\.\/db(\.js)?["']\s*\)/, "imports ../db"],
  [/\bDate\.now\s*\(/, "reads the clock (Date.now())"],
  [/\bnew\s+Date\s*\(\s*\)/, "reads the clock (new Date())"],
  [/\bperformance\.now\s*\(/, "reads the clock (performance.now())"],
];
const coreDir = path.join(ROOT, "src", "core");
for (const file of fs.existsSync(coreDir) ? walk(coreDir) : []) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "").trim();
    if (!code || /^(\*|\/\*)/.test(code)) return; // comments
    for (const [re, what] of CORE_RULES) if (re.test(code)) errors.push(`${rel}:${i + 1}: src/core must be pure but ${what} (decision 0020): ${line.trim()}`);
  });
}

if (errors.length) {
  console.error("Invariant check FAILED:\n  " + errors.join("\n  "));
  process.exit(1);
}
console.log("Invariant check passed: 1 runtime dependency, vendor names only in src/adapters/, src/core is pure.");
