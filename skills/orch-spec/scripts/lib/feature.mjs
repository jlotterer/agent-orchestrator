/**
 * Shared, dependency-free reading of a feature folder (architecture §6.1 and §6.4) for the orch-spec
 * scripts. Everything here is pure except `readFeature`, which reads the folder from disk.
 *
 * It mirrors the rules orch applies (`src/speckit.ts`, `src/core/brief.ts`), so a folder the scripts
 * accept is one `orch plan --dry-run` accepts without warnings (REQ-SPEC-03). If the two disagree,
 * orch's fixtures under test/fixtures/spec-dir/ decide.
 */
import fs from "node:fs";
import path from "node:path";

export const BRIEF_VERSION = 1;
export const DEFAULT_BUDGETS = { briefChars: 8000, contractChars: 6000, totalChars: 20000 };
export const FRONTMATTER_KEYS = ["orch", "covers", "depends_on", "parallel", "merge_policy", "validate", "validate_command"];
export const REQUIRED_KEYS = ["orch", "covers", "depends_on", "parallel"];
export const REQ_ID = /REQ-[A-Z0-9]+-\d+/g;
export const TASK_KEY = /^T\d{2,4}$/;

/** Normalize line endings so sizes and line numbers hold on Windows checkouts. */
export const lf = (text) => text.replace(/\r\n?/g, "\n");

// ---------- tasks.md (§6.1) ----------

/**
 * Parse tasks.md exactly as `parseTasksMd` does: `##+` headings are phases; a task line is
 * `- [ ] T001 [P] title`; dependencies = earlier phases ∪ previous task in the phase when not [P] ∪
 * explicit `depends on|after|requires T001[, T002| and T003]`. Unknown keys and self-edges are dropped.
 * Each task also records its 1-based `line` in the file and `earlierPhases` (the REQ-INTAKE-02 part).
 */
export function parseTasksMd(md) {
  const lines = lf(md).split("\n");
  const tasks = [];
  const phases = [];
  let phase = null, phaseTasks = [];
  const flush = () => { if (phaseTasks.length) phases.push(phaseTasks); phaseTasks = []; };
  lines.forEach((line, i) => {
    const h = line.match(/^##+\s+(.+)$/);
    if (h) { flush(); phase = h[1].trim(); return; }
    const m = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(T\d{2,4})\b\s*(\[P\])?\s*(.*)$/);
    if (!m) return;
    const text = m[4].trim();
    const t = { key: m[2], title: text.length > 110 ? text.slice(0, 107) + "..." : text, description: text,
      parallel: !!m[3], phase, phaseIdx: phases.length, done: m[1] !== " ", line: i + 1, depends_on: [], earlierPhases: [] };
    tasks.push(t); phaseTasks.push(t);
  });
  flush();
  const known = new Set(tasks.map((t) => t.key));
  for (const t of tasks) {
    const deps = new Set();
    for (let p = 0; p < t.phaseIdx; p++) for (const e of phases[p]) deps.add(e.key);
    t.earlierPhases = [...deps].sort();
    const inPhase = phases[t.phaseIdx];
    const idx = inPhase.indexOf(t);
    if (!t.parallel && idx > 0) deps.add(inPhase[idx - 1].key);
    const re = /\b(?:depends on|after|requires)\s+(T\d{2,4}(?:\s*(?:,|and)\s*T\d{2,4})*)/gi;
    for (const m of t.description.matchAll(re)) for (const k of m[1].match(/T\d{2,4}/g)) deps.add(k);
    deps.delete(t.key);
    t.depends_on = [...deps].filter((k) => known.has(k)).sort();
  }
  return tasks;
}

// ---------- brief frontmatter (§6.4) ----------

/** Strip a `#` comment that is outside quotes and brackets. */
function stripComment(s) {
  let q = null, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === "#" && depth === 0 && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function scalar(raw) {
  const s = raw.trim();
  if (/^(["']).*\1$/.test(s) && s.length >= 2) return s.slice(1, -1);
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

/**
 * Parse the YAML subset of §6.4: `key: scalar` or `key: [a, b]`, `#` comments. Returns
 * `{ fields: {key: {value, line}}, end, problems: [{line, message}] }`; `end` is the 1-based line of the closing
 * `---`, or 0 when the file has no frontmatter.
 */
export function parseFrontmatter(text) {
  const lines = lf(text).split("\n");
  const out = { fields: {}, end: 0, problems: [] };
  if (lines[0] !== "---") return out;
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i] === "---") { end = i; break; }
  if (end < 0) { out.problems.push({ line: 1, message: "frontmatter is not closed by a `---` line" }); return out; }
  out.end = end + 1;
  for (let i = 1; i < end; i++) {
    const raw = stripComment(lines[i]).trim();
    if (!raw) continue;
    const m = raw.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) { out.problems.push({ line: i + 1, message: `cannot parse frontmatter line: ${lines[i].trim()}` }); continue; }
    const [, key, rest] = m;
    let value;
    if (rest.startsWith("[")) {
      if (!rest.endsWith("]")) { out.problems.push({ line: i + 1, message: `flow list for "${key}" is not closed` }); continue; }
      const inner = rest.slice(1, -1).trim();
      value = inner ? inner.split(",").map((x) => scalar(x)) : [];
    } else value = rest === "" ? "" : scalar(rest);
    if (key in out.fields) out.problems.push({ line: i + 1, message: `duplicate frontmatter key "${key}"` });
    out.fields[key] = { value, line: i + 1 };
  }
  return out;
}

// ---------- brief body ----------

/** `## Heading` sections of the body: `{ name: { line, lines: [{text, line}] } }`; the first H1 as `h1: {text, line}`. */
export function parseSections(text, startLine = 1) {
  const lines = lf(text).split("\n");
  const sections = {};
  let h1 = null, current = null;
  lines.forEach((l, i) => {
    const line = startLine + i;
    if (/^#\s+/.test(l)) { if (!h1) h1 = { text: l.replace(/^#\s+/, "").trim(), line }; current = null; return; }
    const h2 = l.match(/^##\s+(.+?)\s*$/);
    if (h2) { current = h2[1]; sections[current] = { line, lines: [] }; return; }
    if (current) sections[current].lines.push({ text: l, line });
  });
  return { h1, sections };
}

/** Bullet items of a section: `[{ text, line }]`, the text after the `-`/`*` marker, surrounding backticks stripped. */
export function bullets(section) {
  if (!section) return [];
  return section.lines
    .map(({ text, line }) => { const m = text.match(/^\s*[-*]\s+(.+?)\s*$/); return m ? { text: m[1], line } : null; })
    .filter(Boolean)
    .map((b) => ({ ...b, text: b.text.replace(/^`(.*)`$/, "$1") }));
}

const TEST_DIR = /(^|\/)(test|tests|__tests__|spec)\//;
const FIXTURE_DIR = /(^|\/)fixtures\//;
const TEST_NAME = /\.(test|spec)\.[^/]+$/;

/** §6.4 test-only rule: a test path has a test directory or a `*.test.*`/`*.spec.*` name; `fixtures/` never counts. */
export function isTestPath(p) {
  const n = normalizePath(p);
  if (FIXTURE_DIR.test(n)) return false;
  return TEST_DIR.test(n) || TEST_NAME.test(n.split("/").pop());
}

export function normalizePath(p) {
  return p.replace(/\\/g, "/").split("/").filter((s) => s !== "" && s !== ".").join("/");
}

// ---------- ownership overlap (§7.2, src/core/ownership.ts) ----------

const WILDCARD = /[*?[{]/;
export function staticPrefix(pattern) {
  const segs = normalizePath(pattern).split("/").filter(Boolean);
  const i = segs.findIndex((s) => WILDCARD.test(s));
  return i < 0 ? segs : segs.slice(0, i);
}
const isPrefix = (a, b) => a.length <= b.length && a.every((s, i) => s === b[i]);
/** True when two single patterns may touch the same file (one static prefix is a prefix of the other). */
export function patternsOverlap(a, b) {
  const pa = staticPrefix(a), pb = staticPrefix(b);
  return isPrefix(pa, pb) || isPrefix(pb, pa);
}

// ---------- spec.md contracts and coverage ----------

/**
 * Named contracts under spec.md's `## Contracts`: `{ name: { line, chars } }`, each section running from its
 * `###` heading to the line before the next `##`/`###` heading, trailing blank lines removed.
 */
export function specContracts(specText) {
  const lines = lf(specText ?? "").split("\n");
  const out = {};
  let inContracts = false, name = null, buf = [], start = 0;
  const close = () => {
    if (!name) return;
    while (buf.length && buf[buf.length - 1].trim() === "") buf.pop();
    out[name] = { line: start, chars: buf.join("\n").length };
    name = null; buf = [];
  };
  lines.forEach((l, i) => {
    const h2 = l.match(/^##\s+(.+?)\s*$/);
    if (h2) { close(); inContracts = h2[1] === "Contracts"; return; }
    const h3 = l.match(/^###\s+(.+?)\s*$/);
    if (h3) { close(); if (inContracts) { name = h3[1]; start = i + 1; buf = [l]; } return; }
    if (name) buf.push(l);
  });
  close();
  return out;
}

/** REQ IDs listed under spec.md `## Covers`: `[{ id, line }]` in file order, deduplicated. */
export function specCovers(specText) {
  const { sections } = parseSections(specText ?? "");
  const seen = new Set(), out = [];
  for (const b of bullets(sections["Covers"])) for (const id of b.text.match(REQ_ID) ?? []) if (!seen.has(id)) { seen.add(id); out.push({ id, line: b.line }); }
  return out;
}

// ---------- requirements file ----------

/**
 * REQ definitions from a requirements file: table rows whose first cell is a REQ ID. Returns
 * `{ defs: { id: { must, line } }, duplicates: [{ id, line }] }`. A row without an RFC 2119 keyword counts as MUST;
 * a row that only references tasks (a coverage table: `| REQ-X-01 | TASK-03 |`) is not a definition.
 */
export function requirementDefs(text) {
  const defs = {}, duplicates = [];
  let fence = false;
  lf(text).split("\n").forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return; }
    if (fence) return;
    const m = l.match(/^\|\s*`?(REQ-[A-Z0-9]+-\d+)`?\s*\|(.*)/);
    if (!m) return;
    const [, id, rest] = m;
    const keyword = /\b(MUST|SHOULD|MAY)\b/.test(rest);
    if (!keyword && /\b(TASK-\d+|T\d{2,4}|F\d{2})\b/.test(rest)) return;
    if (defs[id]) duplicates.push({ id, line: i + 1 });
    else defs[id] = { must: /\bMUST\b/.test(rest) || !keyword, line: i + 1 };
  });
  return { defs, duplicates };
}

/** Walk up from `start` looking for `docs/requirements.md`; null when none within eight levels. */
export function findRequirementsFile(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "docs", "requirements.md");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ---------- links (port of check_docs.py) ----------

const LINK_RE = /(?<!!)\[[^\]]*\]\(([^)\s]+)\)/g;

function renderInline(md) {
  return md.split(/(`[^`]*`)/).map((part) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) return part.slice(1, -1);
    return part
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(?<!\w)([*_])(.+?)\1(?!\w)/g, "$2");
  }).join("");
}

/** GitHub heading slug: lower-case, keep word characters, hyphens and spaces, spaces to hyphens. */
export function githubSlug(heading) {
  return renderInline(heading).trim().toLowerCase().replace(/[^\w\- ]/g, "").replace(/ /g, "-");
}

/** Heading anchors of a markdown text, with GitHub's `-1`, `-2` suffixes for repeats. Code fences are skipped. */
export function anchorsOf(text) {
  const slugs = new Set(), counts = new Map();
  let fence = false;
  for (const line of lf(text).split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (!m) continue;
    const base = githubSlug(m[2]);
    const n = counts.get(base) ?? 0;
    slugs.add(n === 0 ? base : `${base}-${n}`);
    counts.set(base, n + 1);
  }
  return slugs;
}

/**
 * Relative links of a markdown file that do not resolve: `[{ line, target, message }]`. `file` is the absolute path
 * of the file; links in code fences and inline code are ignored; `scheme:` links are skipped. Anchors are checked
 * against the target file's headings when it is a markdown file.
 */
export function brokenLinks(file, text, anchorCache = new Map()) {
  const out = [];
  let fence = false;
  lf(text).split("\n").forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (fence) return;
    const noCode = line.replace(/`[^`]*`/g, "");
    for (const m of noCode.matchAll(LINK_RE)) {
      const target = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const [filePart, anchor] = target.split("#", 2);
      const dest = filePart ? path.resolve(path.dirname(file), decodeURI(filePart)) : file;
      if (!fs.existsSync(dest)) { out.push({ line: i + 1, target, message: `broken link → ${target}` }); continue; }
      if (anchor && fs.statSync(dest).isFile() && dest.toLowerCase().endsWith(".md")) {
        if (!anchorCache.has(dest)) anchorCache.set(dest, anchorsOf(fs.readFileSync(dest, "utf8")));
        if (!anchorCache.get(dest).has(anchor)) out.push({ line: i + 1, target, message: `missing anchor #${anchor} in ${path.basename(dest)}` });
      }
    }
  });
  return out;
}

// ---------- reading the folder ----------

/** Read a feature folder: `{ dir, files: {relPath: text}, tasks, hasTasksDir }`. Only `.md` files are read; text is LF. */
export function readFeature(dir) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`feature folder not found: ${abs}`);
  const files = {};
  const isDir = (p) => fs.existsSync(p) && fs.statSync(p).isDirectory();
  const read = (rel) => { const p = path.join(abs, rel); if (fs.existsSync(p) && fs.statSync(p).isFile()) files[rel] = lf(fs.readFileSync(p, "utf8")); };
  for (const f of fs.readdirSync(abs)) if (f.endsWith(".md")) read(f);
  const hasTasksDir = isDir(path.join(abs, "tasks"));
  if (hasTasksDir) for (const f of fs.readdirSync(path.join(abs, "tasks"))) if (f.endsWith(".md")) read(`tasks/${f}`);
  if (isDir(path.join(abs, "contracts"))) for (const f of fs.readdirSync(path.join(abs, "contracts"))) if (f.endsWith(".md")) read(`contracts/${f}`);
  const tasks = files["tasks.md"] !== undefined ? parseTasksMd(files["tasks.md"]) : [];
  return { dir: abs, files, tasks, hasTasksDir };
}
