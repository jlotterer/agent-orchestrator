/**
 * Authored task briefs and feature-folder checks (architecture §6.4; decision 0023). Pure: the caller
 * passes file contents keyed by their path relative to the feature folder; nothing here reads the
 * file system or the clock. Fixtures: test/fixtures/spec-dir/<folder>/ + <folder>.expected.json.
 *
 *   parseFrontmatter(text)            the YAML subset the contract allows
 *   parseBrief(key, text)             one tasks/<key>.md → fields, criteria, target files, contracts, problems
 *   mergeBriefIntoTask(task, brief, feature)  frontmatter wins over tasks.md marks; conflicts for decisions
 *   checkFeature(feature, merged, opts)       markers, overlap, size, test-only, contracts → problems
 *   readFeature(files, tasks, opts)   all of the above for one folder, in the shape of the fixtures
 */
import type { ImportedTask } from "../speckit.js";
import type { MergePolicy, ValidateMode } from "../types.js";
import { ownedOverlap } from "./ownership.js";

/** The brief format this orch reads (`orch: 1`). */
export const BRIEF_FORMAT = 1;
/** Default for `handoff.briefChars` until the project's settings carry it (TASK-21). */
export const DEFAULT_BRIEF_CHARS = 8000;

export type ProblemKind = "error" | "warning";
export type ProblemRule =
  | "marker"            // unresolved marker in spec.md, a brief or contracts/*.md (error)
  | "version"           // `orch:` missing or unsupported (error)
  | "frontmatter"       // a line the YAML subset does not allow, or a value of the wrong type (error)
  | "unknown-key"       // a frontmatter key the contract does not define (warning)
  | "contract"          // a named contract that does not resolve, or resolves twice (warning)
  | "parallel-overlap"  // two parallel tasks list the same target file (warning)
  | "brief-size"        // a brief over handoff.briefChars (warning)
  | "test-only";        // every target file is a test path (warning)

export interface Problem {
  kind: ProblemKind;
  rule: ProblemRule;
  /** Path relative to the feature folder (`spec.md`, `tasks/T003.md`, `contracts/auth-api.md`). */
  file: string;
  /** 1-based line. */
  line: number;
  message: string;
  tasks?: string[];
  path?: string;
  chars?: number;
  limit?: number;
}

/** Plan values a brief's frontmatter may set; only the keys present and valid. */
export interface BriefFields {
  depends_on?: string[];
  parallel?: boolean;
  merge_policy?: MergePolicy;
  validate_mode?: ValidateMode;
  validate_cmd?: string;
}

export interface ParsedBrief {
  /** `tasks/<key>.md` */
  file: string;
  key: string;
  /** Characters after CRLF → LF normalization (what `handoff.briefChars` limits). */
  chars: number;
  /** The `orch:` value as written when it is an integer; null when missing or not an integer. */
  version: number | null;
  /** True when `orch` is a format this orch reads; false means nothing else of the brief is applied. */
  supported: boolean;
  fields: BriefFields;
  /** The `covers` list: REQ IDs in the order written, deduplicated. Exactly what the task cites. */
  cites: string[];
  /** `## Acceptance criteria` bullets, verbatim; null when the section is absent. */
  criteria: string[] | null;
  /** `## Target files` bullets with their lines; null when the section is absent. */
  targetFiles: { path: string; line: number }[] | null;
  /** `## Contracts` bullets (the name before ` (`); null when the section is absent. */
  contracts: { name: string; line: number }[] | null;
  /** Frontmatter keys the contract does not define (kept, reported as warnings). */
  unknownKeys: string[];
  /** Line of the `# <key>: <title>` heading, or of the first body line when there is none. */
  h1Line: number;
  warnings: Problem[];
  errors: Problem[];
}

export interface Conflict {
  key: string;
  field: "parallel";
  tasksMd: boolean;
  brief: boolean;
  /** The decision text recorded at plan time. */
  decision: string;
}

/** A task after `tasks.md` and its brief are merged: the shape of the fixtures' `tasks[]`. */
export interface FeatureTask {
  key: string;
  title: string;
  description: string;
  phase: string | null;
  done: boolean;
  order_idx: number;
  brief: string | null;
  briefChars: number | null;
  orch: number | null;
  depends_on: string[];
  parallel: boolean;
  merge_policy: MergePolicy | null;
  validate_mode: ValidateMode | null;
  validate_cmd: string | null;
  files_owned: string[];
  acceptance: string[];
  cites: string[];
  contracts: { name: string; resolved: string | null }[];
  fromBrief: string[];
  tasksMd: { parallel: boolean; depends_on: string[] };
}

export interface FeatureInput {
  /** Every file of the folder by relative path: `spec.md`, `tasks.md`, `tasks/T001.md`, `contracts/x.md`, … */
  files: Record<string, string>;
  /** The `tasks.md` parse (§6.1), in file order. */
  tasks: ImportedTask[];
}

export interface FeatureResult {
  tasks: FeatureTask[];
  conflicts: Conflict[];
  problems: Problem[];
  /** The parsed briefs by task key (only `tasks/<key>.md` files whose key is in `tasks.md`). */
  briefs: Map<string, ParsedBrief>;
  /** True when at least one task has a brief. */
  hasBriefs: boolean;
}

export interface CheckOptions {
  /** `handoff.briefChars`: a brief over this many characters warns. */
  briefChars?: number;
}

const FRONTMATTER_KEYS = ["orch", "covers", "depends_on", "parallel", "merge_policy", "validate", "validate_command"];
const TASK_KEY = /^T\d{2,4}$/;
const BRIEF_FILE = /^tasks\/(T\d{2,4})\.md$/;
const CONTRACT_FILE = /^contracts\/[^/]+\.md$/;
const MARKER = /\[NEEDS CLARIFICATION|\b(?:TBD|TODO)\b/;

const normalize = (text: string) => text.replace(/\r\n/g, "\n");
const briefFile = (key: string) => `tasks/${key}.md`;

// ------------------------------------------------------------------ frontmatter
export type Scalar = string | number | boolean;
export type FrontmatterValue = Scalar | Scalar[];

export interface Frontmatter {
  /** True when the text starts with a `---` line (a frontmatter block, closed or not). */
  present: boolean;
  data: Record<string, FrontmatterValue>;
  /** 1-based line of each key. */
  lines: Record<string, number>;
  /** Number of lines the block takes, including both `---` lines; 0 when absent. */
  length: number;
  errors: { line: number; message: string }[];
}

/** Drop a `#` comment that is outside quotes and preceded by whitespace (or starts the value). */
function stripComment(s: string): string {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === "\\" && quote === '"') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

/** One scalar: int, bool, quoted string or an unquoted string. Returns an error message for an unclosed quote. */
function parseScalar(raw: string): { value: Scalar } | { error: string } {
  const s = raw.trim();
  if (s === "") return { value: "" };
  if ((s[0] === '"' || s[0] === "'")) {
    const q = s[0];
    if (s.length < 2 || s[s.length - 1] !== q) return { error: `unclosed ${q} quote` };
    const inner = s.slice(1, -1);
    return { value: q === '"' ? inner.replace(/\\(["\\])/g, "$1") : inner.replace(/''/g, "'") };
  }
  if (s === "true") return { value: true };
  if (s === "false") return { value: false };
  if (/^-?\d+$/.test(s)) return { value: Number(s) };
  return { value: s };
}

/** Split a flow list body on commas outside quotes. */
function splitFlow(body: string): string[] | null {
  const out: string[] = [];
  let cur = "", quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) { cur += c; if (c === "\\" && quote === '"') { cur += body[++i] ?? ""; } else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === "[" || c === "{") return null; // nested collections are outside the subset
    if (c === ",") { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (quote) return null;
  out.push(cur);
  return out;
}

/**
 * The YAML subset of §6.4: `key: value` lines, scalars (int, true/false, quoted or unquoted strings),
 * flow lists (`[a, b]`), `#` comments. Anything else is an error with its line. Keys are not validated here.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const fm: Frontmatter = { present: false, data: {}, lines: {}, length: 0, errors: [] };
  const lines = normalize(text).split("\n");
  if (lines[0]?.trim() !== "---") return fm;
  fm.present = true;
  let closed = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    if (line.trim() === "---") { closed = true; fm.length = i + 1; break; }
    const code = stripComment(line);
    if (!code.trim()) continue;
    if (/^\s/.test(code)) { fm.errors.push({ line: lineNo, message: `indented line is not allowed in a brief's frontmatter: ${line.trim()}` }); continue; }
    const m = code.match(/^([A-Za-z_][\w-]*)\s*:(?:\s+(.*)|\s*)$/);
    if (!m) {
      const what = /^\s*-\s/.test(code) ? "block lists are not allowed; write a flow list [a, b]" : "expected `key: value`";
      fm.errors.push({ line: lineNo, message: `${what}: ${line.trim()}` });
      continue;
    }
    const key = m[1], raw = (m[2] ?? "").trim();
    if (key in fm.data) { fm.errors.push({ line: lineNo, message: `duplicate key ${key}` }); continue; }
    let value: FrontmatterValue;
    if (raw.startsWith("[")) {
      if (!raw.endsWith("]")) { fm.errors.push({ line: lineNo, message: `unclosed flow list for ${key}` }); continue; }
      const body = raw.slice(1, -1);
      const parts = body.trim() === "" ? [] : splitFlow(body);
      if (!parts) { fm.errors.push({ line: lineNo, message: `flow list for ${key} must hold scalars only` }); continue; }
      const items: Scalar[] = [];
      let bad: string | null = null;
      for (const p of parts) {
        const r = parseScalar(p);
        if ("error" in r) { bad = r.error; break; }
        if (r.value === "") { bad = "empty item"; break; }
        items.push(r.value);
      }
      if (bad) { fm.errors.push({ line: lineNo, message: `${bad} in the list for ${key}` }); continue; }
      value = items;
    } else if (raw.startsWith("{")) {
      fm.errors.push({ line: lineNo, message: `maps are not allowed in a brief's frontmatter: ${key}` });
      continue;
    } else {
      const r = parseScalar(raw);
      if ("error" in r) { fm.errors.push({ line: lineNo, message: `${r.error} for ${key}` }); continue; }
      value = r.value;
    }
    fm.data[key] = value;
    fm.lines[key] = lineNo;
  }
  if (!closed) { fm.errors.push({ line: 1, message: "frontmatter is not closed by a `---` line" }); fm.length = lines.length; }
  return fm;
}

// ------------------------------------------------------------------ brief
interface Section { name: string; line: number; lines: { text: string; line: number }[] }

/** `## <name>` sections of the body (exactly two `#`, outside code fences), plus the H1 line. */
function splitSections(lines: string[], firstLine: number): { h1Line: number; sections: Section[] } {
  const sections: Section[] = [];
  let cur: Section | null = null, fence = false, h1Line = 0;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i], line = firstLine + i;
    if (/^\s*(```|~~~)/.test(text)) fence = !fence;
    if (!fence) {
      const h2 = text.match(/^##(?!#)\s+(.+?)\s*$/);
      if (h2) { cur = { name: h2[1], line, lines: [] }; sections.push(cur); continue; }
      if (!h1Line && /^#(?!#)\s+\S/.test(text)) { h1Line = line; continue; }
    }
    cur?.lines.push({ text, line });
  }
  return { h1Line, sections };
}

const section = (sections: Section[], name: string) => sections.find((s) => s.name.toLowerCase() === name);
const bullets = (s: Section) =>
  s.lines.flatMap((l) => { const m = l.text.match(/^\s*[-*]\s+(.*?)\s*$/); return m && m[1] ? [{ text: m[1], line: l.line }] : []; });
const unquote = (s: string) => s.replace(/^`+|`+$/g, "");
const dedupe = (xs: string[]) => [...new Set(xs)];

function stringList(v: FrontmatterValue | undefined): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.every((x) => typeof x === "string") ? (v as string[]) : null;
}

/**
 * Parse one brief. `key` is the task key the file is named after (`tasks/<key>.md`). When `orch` is
 * missing or unsupported the result carries only the error, the version and the size (§6.4).
 */
export function parseBrief(key: string, text: string): ParsedBrief {
  const file = briefFile(key);
  const norm = normalize(text);
  const fm = parseFrontmatter(norm);
  const b: ParsedBrief = {
    file, key, chars: norm.length, version: null, supported: false, fields: {}, cites: [], criteria: null,
    targetFiles: null, contracts: null, unknownKeys: [], h1Line: 0, warnings: [], errors: [],
  };
  const err = (rule: ProblemRule, line: number, message: string) => b.errors.push({ kind: "error", rule, file, line, message });
  const warn = (rule: ProblemRule, line: number, message: string) => b.warnings.push({ kind: "warning", rule, file, line, message });

  const orch = fm.data["orch"];
  if (typeof orch === "number" && Number.isInteger(orch)) b.version = orch;
  if (b.version !== BRIEF_FORMAT) {
    const shown = orch === undefined ? "(missing)" : Array.isArray(orch) ? `[${orch.join(", ")}]` : String(orch);
    err("version", fm.lines["orch"] ?? 1, `unsupported brief format orch: ${shown}; this orch reads orch: ${BRIEF_FORMAT}`);
    return b;
  }
  b.supported = true;
  for (const e of fm.errors) err("frontmatter", e.line, e.message);

  for (const k of Object.keys(fm.data)) {
    if (FRONTMATTER_KEYS.includes(k)) continue;
    b.unknownKeys.push(k);
    warn("unknown-key", fm.lines[k], `unknown frontmatter key ${k}; the brief contract defines ${FRONTMATTER_KEYS.join(", ")}`);
  }

  const typeErr = (k: string, expected: string) => err("frontmatter", fm.lines[k], `${k} must be ${expected}`);
  if ("covers" in fm.data) {
    const v = stringList(fm.data["covers"]);
    if (v) b.cites = dedupe(v); else typeErr("covers", "a list of requirement IDs, for example [REQ-AUTH-01]");
  }
  if ("depends_on" in fm.data) {
    const v = stringList(fm.data["depends_on"]);
    if (v && v.every((k) => TASK_KEY.test(k))) b.fields.depends_on = dedupe(v);
    else typeErr("depends_on", "a list of task keys, for example [T001, T002]");
  }
  if ("parallel" in fm.data) {
    const v = fm.data["parallel"];
    if (typeof v === "boolean") b.fields.parallel = v; else typeErr("parallel", "true or false");
  }
  if ("merge_policy" in fm.data) {
    const v = fm.data["merge_policy"];
    if (v === "auto" || v === "manual") b.fields.merge_policy = v; else typeErr("merge_policy", "auto or manual");
  }
  if ("validate" in fm.data) {
    const v = fm.data["validate"];
    if (v === "standard" || v === "ui") b.fields.validate_mode = v; else typeErr("validate", "standard or ui");
  }
  if ("validate_command" in fm.data) {
    const v = fm.data["validate_command"];
    if (typeof v === "string" && v.trim()) b.fields.validate_cmd = v.trim(); else typeErr("validate_command", "a non-empty command string");
  }

  const bodyLines = norm.split("\n").slice(fm.length);
  const { h1Line, sections } = splitSections(bodyLines, fm.length + 1);
  b.h1Line = h1Line || fm.length + 1;
  const crit = section(sections, "acceptance criteria");
  if (crit) b.criteria = bullets(crit).map((x) => x.text);
  const files = section(sections, "target files");
  if (files) b.targetFiles = bullets(files).map((x) => ({ path: unquote(x.text), line: x.line }));
  const contracts = section(sections, "contracts");
  if (contracts) b.contracts = bullets(contracts).map((x) => ({ name: unquote(x.text.split(" (")[0].trim()), line: x.line }));
  const byLine = (a: Problem, c: Problem) => a.line - c.line;
  b.errors.sort(byLine);
  b.warnings.sort(byLine);
  return b;
}

// ------------------------------------------------------------------ contracts
/** `### <name>` sections under spec.md's `## Contracts`, by name. */
export function contractSections(specMd: string | undefined): string[] {
  if (!specMd) return [];
  const names: string[] = [];
  let inContracts = false, fence = false;
  for (const line of normalize(specMd).split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h2 = line.match(/^##(?!#)\s+(.+?)\s*$/);
    if (h2) { inContracts = h2[1].toLowerCase() === "contracts"; continue; }
    const h3 = line.match(/^###(?!#)\s+(.+?)\s*$/);
    if (h3 && inContracts) names.push(h3[1]);
  }
  return names;
}

/**
 * Where a named contract lives: a file of the folder (`contracts/auth-api.md`) or a `### <name>` section
 * under spec.md's `## Contracts` (`spec.md#<name>`). Both → the section wins with a warning; neither → a warning.
 */
export function resolveContract(files: Record<string, string>, name: string, at: { file: string; line: number }): { resolved: string | null; warning?: Problem } {
  const asFile = name.replace(/\\/g, "/").replace(/^\.\//, "");
  const inFile = Object.prototype.hasOwnProperty.call(files, asFile) ? asFile : null;
  const inSpec = contractSections(files["spec.md"]).includes(name) ? `spec.md#${name}` : null;
  if (inFile && inSpec) {
    return { resolved: inSpec, warning: { kind: "warning", rule: "contract", file: at.file, line: at.line, message: `contract ${name} is both a section of spec.md and the file ${inFile}; the section is used` } };
  }
  if (inFile || inSpec) return { resolved: inFile ?? inSpec };
  return { resolved: null, warning: { kind: "warning", rule: "contract", file: at.file, line: at.line, message: `contract ${name} named in ${at.file} is neither a section under spec.md's "## Contracts" nor a file in the folder` } };
}

// ------------------------------------------------------------------ merge
/** Keys of the tasks in phases before `task` (REQ-INTAKE-02): the part of the dependencies a brief cannot remove. */
export function earlierPhaseKeys(tasks: ImportedTask[], task: ImportedTask): string[] {
  const out: string[] = [];
  let groupStart = 0;
  for (let i = 0; i < tasks.length; i++) {
    if (i > 0 && tasks[i].phase !== tasks[i - 1].phase) groupStart = i;
    if (tasks[i].key === task.key) return tasks.slice(0, groupStart).map((t) => t.key);
    out.push(tasks[i].key);
  }
  return out;
}

const FROM_BRIEF_ORDER = ["depends_on", "parallel", "merge_policy", "validate_mode", "validate_cmd", "files_owned", "acceptance"];

/**
 * Apply a brief to an imported task: frontmatter wins over the `tasks.md` marks; effective `depends_on` is
 * earlier-phase tasks ∪ the brief's list; `cites` is the `covers` list only; `fromBrief` names only what the
 * brief sets. A `[P]` / `parallel` difference is a conflict (a decision, not a warning). Contract warnings
 * come back as `problems`.
 */
export function mergeBriefIntoTask(
  task: ImportedTask, brief: ParsedBrief | null, feature: FeatureInput,
): { task: FeatureTask; conflicts: Conflict[]; problems: Problem[] } {
  const known = new Set(feature.tasks.map((t) => t.key));
  const tasksMd = { parallel: task.parallel, depends_on: [...task.depends_on].sort() };
  const out: FeatureTask = {
    key: task.key, title: task.title, description: task.description, phase: task.phase, done: task.done, order_idx: task.order_idx,
    brief: brief ? brief.file : null, briefChars: brief ? brief.chars : null, orch: brief ? brief.version : null,
    depends_on: tasksMd.depends_on, parallel: task.parallel, merge_policy: null, validate_mode: null, validate_cmd: null,
    files_owned: [], acceptance: [], cites: [], contracts: [], fromBrief: [], tasksMd,
  };
  const conflicts: Conflict[] = [];
  const problems: Problem[] = [];
  if (!brief || !brief.supported) return { task: out, conflicts, problems };

  const from = new Set<string>();
  const f = brief.fields;
  if (f.depends_on) {
    const deps = new Set(earlierPhaseKeys(feature.tasks, task));
    for (const k of f.depends_on) if (known.has(k) && k !== task.key) deps.add(k);
    out.depends_on = [...deps].sort();
    from.add("depends_on");
  }
  if (f.parallel !== undefined) {
    out.parallel = f.parallel;
    from.add("parallel");
    if (f.parallel !== task.parallel) {
      conflicts.push({
        key: task.key, field: "parallel", tasksMd: task.parallel, brief: f.parallel,
        decision: `${task.key}: tasks.md ${task.parallel ? "marks" : "does not mark"} [P] but the brief says parallel: ${f.parallel}; the brief wins`,
      });
    }
  }
  if (f.merge_policy) { out.merge_policy = f.merge_policy; from.add("merge_policy"); }
  if (f.validate_mode) { out.validate_mode = f.validate_mode; from.add("validate_mode"); }
  if (f.validate_cmd) { out.validate_cmd = f.validate_cmd; from.add("validate_cmd"); }
  if (brief.targetFiles) { out.files_owned = dedupe(brief.targetFiles.map((x) => x.path)); from.add("files_owned"); }
  if (brief.criteria) { out.acceptance = brief.criteria; from.add("acceptance"); }
  out.cites = brief.cites;
  if (brief.contracts) {
    for (const c of brief.contracts) {
      const r = resolveContract(feature.files, c.name, { file: brief.file, line: c.line });
      out.contracts.push({ name: c.name, resolved: r.resolved });
      if (r.warning) problems.push(r.warning);
    }
  }
  out.fromBrief = FROM_BRIEF_ORDER.filter((k) => from.has(k));
  return { task: out, conflicts, problems };
}

// ------------------------------------------------------------------ checks
const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec"]);

/** §6.4 test path: a test directory anywhere in the path or a `*.test.*` / `*.spec.*` name; never under `fixtures/`. */
export function isTestPath(p: string): boolean {
  const segs = p.replace(/\\/g, "/").split("/").filter((s) => s && s !== ".");
  if (!segs.length) return false;
  const dirs = segs.slice(0, -1), name = segs[segs.length - 1];
  if (dirs.includes("fixtures")) return false;
  return dirs.some((d) => TEST_DIRS.has(d)) || /\.(test|spec)\./.test(name);
}

/** Order of §6.4: `spec.md`, then `tasks/<key>.md` by key, then `contracts/*.md` alphabetically, then by line. */
function fileRank(file: string): [number, string] {
  if (file === "spec.md") return [0, ""];
  const b = file.match(BRIEF_FILE);
  if (b) return [1, b[1]];
  if (CONTRACT_FILE.test(file)) return [2, file];
  return [3, file];
}
export function sortProblems(problems: Problem[]): Problem[] {
  return problems
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const [ra, fa] = fileRank(a.p.file), [rb, fb] = fileRank(b.p.file);
      return ra - rb || (fa < fb ? -1 : fa > fb ? 1 : 0) || a.p.line - b.p.line || a.i - b.i;
    })
    .map((x) => x.p);
}

/** The brief files of a folder, by task key. Only `tasks/<key>.md` with a known key counts as a brief. */
export function briefFiles(files: Record<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of Object.keys(files).sort()) {
    const m = f.match(BRIEF_FILE);
    if (m) out.set(m[1], f);
  }
  return out;
}

/**
 * Folder checks (REQ-INTAKE-13/14, REQ-SPEC-03): unresolved markers in `spec.md`, every brief and
 * `contracts/*.md` (errors); parallel target-file overlap, oversized briefs and test-only tasks (warnings).
 * `merged` are the tasks after their briefs were applied (effective `parallel`, `files_owned`, `depends_on`).
 */
export function checkFeature(feature: FeatureInput, merged: FeatureTask[], briefs: Map<string, ParsedBrief>, opts: CheckOptions = {}): Problem[] {
  const limit = opts.briefChars ?? DEFAULT_BRIEF_CHARS;
  const problems: Problem[] = [];
  const scanned = ["spec.md", ...[...briefFiles(feature.files).values()], ...Object.keys(feature.files).filter((f) => CONTRACT_FILE.test(f)).sort()];
  for (const file of scanned) {
    const text = feature.files[file];
    if (text === undefined) continue;
    normalize(text).split("\n").forEach((line, i) => {
      const m = line.match(MARKER);
      if (m) problems.push({ kind: "error", rule: "marker", file, line: i + 1, message: `unresolved marker "${m[0]}"` });
    });
  }
  for (const b of briefs.values()) problems.push(...b.errors, ...b.warnings);

  // Two parallel tasks that may touch the same file, neither depending on the other: warn at the later task's entry.
  for (let j = 0; j < merged.length; j++) {
    const later = merged[j], lb = briefs.get(later.key);
    if (!later.parallel || !lb?.targetFiles) continue;
    for (let i = 0; i < j; i++) {
      const earlier = merged[i];
      if (!earlier.parallel || later.depends_on.includes(earlier.key) || earlier.depends_on.includes(later.key)) continue;
      const seen = new Set<number>();
      for (const entry of lb.targetFiles) {
        if (seen.has(entry.line)) continue;
        const hit = earlier.files_owned.find((p) => ownedOverlap([p], [entry.path]));
        if (hit === undefined) continue;
        seen.add(entry.line);
        const message = hit === entry.path
          ? `${earlier.key} and ${later.key} are both parallel and both list ${entry.path}`
          : `${earlier.key} and ${later.key} are both parallel and ${earlier.key}'s ${hit} overlaps ${entry.path}`;
        problems.push({ kind: "warning", rule: "parallel-overlap", file: lb.file, line: entry.line, message, tasks: [earlier.key, later.key], path: entry.path });
      }
    }
  }
  for (const b of briefs.values()) {
    if (b.chars > limit) {
      problems.push({ kind: "warning", rule: "brief-size", file: b.file, line: 1, message: `brief is ${b.chars} characters; handoff.briefChars is ${limit}`, chars: b.chars, limit });
    }
    if (b.supported && b.targetFiles && b.targetFiles.length && b.targetFiles.every((t) => isTestPath(t.path))) {
      problems.push({ kind: "warning", rule: "test-only", file: b.file, line: b.h1Line, message: "task appears to add only tests: every target file is a test path" });
    }
  }
  return sortProblems(problems);
}

/** Read a whole feature folder: parse the briefs, merge them into the tasks, check the folder. */
export function readFeature(files: Record<string, string>, tasks: ImportedTask[], opts: CheckOptions = {}): FeatureResult {
  const feature: FeatureInput = { files, tasks };
  const briefs = new Map<string, ParsedBrief>();
  for (const [key, file] of briefFiles(files)) {
    if (tasks.some((t) => t.key === key)) briefs.set(key, parseBrief(key, files[file]));
  }
  const merged: FeatureTask[] = [], conflicts: Conflict[] = [], contractProblems: Problem[] = [];
  for (const t of tasks) {
    const r = mergeBriefIntoTask(t, briefs.get(t.key) ?? null, feature);
    merged.push(r.task);
    conflicts.push(...r.conflicts);
    contractProblems.push(...r.problems);
  }
  const problems = sortProblems([...checkFeature(feature, merged, briefs, opts), ...contractProblems]);
  return { tasks: merged, conflicts, problems, briefs, hasBriefs: briefs.size > 0 };
}
