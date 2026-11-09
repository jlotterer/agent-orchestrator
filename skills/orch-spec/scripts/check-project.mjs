#!/usr/bin/env node
/**
 * check-project.mjs: self-check for the project record written by orch-spec's project and fold-back modes
 * (a Node port of requirements-architect's check_docs.py, without the per-task parts, which check-feature.mjs
 * covers for feature folders). Node ≥ 22, no dependencies.
 *
 *   node check-project.mjs <project_root>
 *
 * Checks, over `*.md` at the root, `docs/**` and `specs/*‌/spec.md`:
 *   links      relative links point to files that exist; `#anchors` exist in the target (GitHub slug rules)
 *   duplicate  no REQ ID is defined twice in docs/requirements.md
 *   roadmap    every MUST REQ ID is covered by a roadmap feature (docs/roadmap.md), and the roadmap and the
 *              feature specs cite only defined IDs; no ID is listed by two features' table rows
 *   rules      AGENTS.md exists (orch hands it to every agent; `handoff.projectFiles`)
 *
 * Exit 0 with no output when clean; otherwise one line per problem, `file:line: message` (paths relative to
 * the root), exit 1. Exit 2 when the root is not a directory.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brokenLinks, requirementDefs, lf, REQ_ID } from "./lib/feature.mjs";

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(p, out); }
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

export function checkProject(root) {
  const abs = path.resolve(root);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`project root not found: ${abs}`);
  const rel = (p) => path.relative(abs, p).split(path.sep).join("/");
  const problems = [];
  const add = (file, line, message) => problems.push({ file, line, message });

  const files = [];
  for (const e of fs.readdirSync(abs)) if (e.endsWith(".md")) files.push(path.join(abs, e));
  if (fs.existsSync(path.join(abs, "docs"))) walk(path.join(abs, "docs"), files);
  if (fs.existsSync(path.join(abs, "specs"))) for (const d of fs.readdirSync(path.join(abs, "specs"))) {
    const spec = path.join(abs, "specs", d, "spec.md");
    if (fs.existsSync(spec)) files.push(spec);
  }

  const cache = new Map();
  for (const f of files.sort()) for (const b of brokenLinks(f, fs.readFileSync(f, "utf8"), cache)) add(rel(f), b.line, b.message);

  if (!fs.existsSync(path.join(abs, "AGENTS.md"))) add("AGENTS.md", 1, "AGENTS.md not found; orch hands the project rules file to every agent (handoff.projectFiles)");

  const reqFile = path.join(abs, "docs", "requirements.md");
  if (!fs.existsSync(reqFile)) { add("docs/requirements.md", 1, "docs/requirements.md not found"); return finish(problems); }
  const { defs, duplicates } = requirementDefs(fs.readFileSync(reqFile, "utf8"));
  for (const d of duplicates) add("docs/requirements.md", d.line, `${d.id} is defined more than once`);

  const roadmap = path.join(abs, "docs", "roadmap.md");
  if (!fs.existsSync(roadmap)) { add("docs/roadmap.md", 1, "docs/roadmap.md not found; project mode writes the ordered features and the REQ IDs each covers"); return finish(problems); }
  const covered = new Set();
  const owner = new Map(); // id → the first roadmap table row (feature) that lists it
  let fence = false;
  lf(fs.readFileSync(roadmap, "utf8")).split("\n").forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return; }
    if (fence) return;
    const row = l.match(/^\|\s*(F\d+)\s*\|/);
    for (const id of expandIds(l)) {
      covered.add(id);
      if (!defs[id]) add("docs/roadmap.md", i + 1, `${id} is not defined in docs/requirements.md`);
      if (row) {
        if (owner.has(id) && owner.get(id) !== row[1]) add("docs/roadmap.md", i + 1, `${id} is listed by ${owner.get(id)} and ${row[1]}; one feature owns a requirement, the other extends it with a new ID or a decision`);
        else owner.set(id, row[1]);
      }
    }
  });
  for (const f of files.filter((f) => /[\\/]specs[\\/][^\\/]+[\\/]spec\.md$/.test(f))) {
    lf(fs.readFileSync(f, "utf8")).split("\n").forEach((l, i) => { for (const id of l.match(REQ_ID) ?? []) if (!defs[id]) add(rel(f), i + 1, `${id} is not defined in docs/requirements.md`); });
  }
  for (const [id, d] of Object.entries(defs)) if (d.must && !covered.has(id)) add("docs/requirements.md", d.line, `${id} (MUST) is covered by no roadmap feature`);
  return finish(problems);
}

/** REQ IDs on a line, expanding `REQ-X-01, -02` and `REQ-X-01..04` / `REQ-X-01 … REQ-X-04` forms. */
export function expandIds(line) {
  const ids = new Set();
  for (const m of line.matchAll(/REQ-([A-Z0-9]+)-(\d+)\s*(?:…|\.\.\.?|–|to)\s*(?:REQ-\1-)?(\d+)/g)) for (let n = +m[2]; n <= +m[3]; n++) ids.add(`REQ-${m[1]}-${String(n).padStart(2, "0")}`);
  for (const m of line.matchAll(/REQ-([A-Z0-9]+)-(\d+)((?:\s*,\s*-\d+)*)/g)) {
    ids.add(`REQ-${m[1]}-${m[2]}`);
    for (const n of m[3].matchAll(/-(\d+)/g)) ids.add(`REQ-${m[1]}-${n[1]}`);
  }
  return [...ids];
}

function finish(problems) {
  return problems.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  if (!root) { console.error("usage: check-project.mjs <project_root>"); process.exit(2); }
  let problems;
  try { problems = checkProject(root); } catch (e) { console.error(e.message); process.exit(2); }
  if (problems.length) console.log(problems.map((p) => `${p.file}:${p.line}: ${p.message}`).join("\n"));
  process.exit(problems.length ? 1 : 0);
}
