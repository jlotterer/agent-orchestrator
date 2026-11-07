#!/usr/bin/env node
/**
 * Stack invariants (REQ-NFR-02, REQ-NFR-04; decisions 0007 and 0009). Exits non-zero on any violation.
 *   1. package.json `dependencies` is exactly { better-sqlite3 }.
 *   2. Agent-vendor names appear in src/**\/*.ts only inside src/adapters/, plus the allowlisted
 *      built-in defaults in src/config.ts below.
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

if (errors.length) {
  console.error("Invariant check FAILED:\n  " + errors.join("\n  "));
  process.exit(1);
}
console.log("Invariant check passed: 1 runtime dependency, vendor names only in src/adapters/.");
