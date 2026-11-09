/**
 * Import a GitHub Spec Kit feature directory (specs/NNN-name/) into task records.
 *
 * tasks.md conventions handled:
 *   ## Phase 1: Setup            -> phase header
 *   - [ ] T001 [P] Do a thing    -> task, [P] = can run in parallel with siblings
 *   - [x] T002 Done thing        -> already completed; imported as done
 *   Task IDs are T### ; descriptions may mention paths and "depends on T00X".
 *
 * Dependency rules (Spec Kit semantics):
 *   - every task depends on all tasks in earlier phases
 *   - a non-[P] task also depends on the previous task in its phase
 *   - "depends on T001" / "after T001" in the text adds explicit edges
 */
import fs from "node:fs";
import path from "node:path";
import { readFeature, type FeatureResult, type ParsedBrief, type CheckOptions } from "./core/brief.js";

export interface ImportedTask {
  key: string;
  title: string;
  description: string;
  parallel: boolean;
  phase: string | null;
  done: boolean;
  depends_on: string[];
  order_idx: number;
  /** The authored brief `tasks/<key>.md`, when the folder has one (§6.4; set by `importFeature`). */
  brief?: ParsedBrief;
}

export interface SpecDir {
  dir: string;
  title: string;
  /**
   * Relative path → contents: the root `*.md` files (spec.md, plan.md, tasks.md, …) and the `.md` files one
   * level down (`tasks/T001.md`, `contracts/auth-api.md`), always with `/` separators.
   */
  files: Record<string, string>;
}

export function readSpecDir(dir: string): SpecDir {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) throw new Error(`spec dir not found: ${abs}`);
  const files: Record<string, string> = {};
  for (const f of fs.readdirSync(abs).sort()) {
    const p = path.join(abs, f);
    const st = fs.statSync(p);
    if (st.isFile() && f.endsWith(".md")) files[f] = fs.readFileSync(p, "utf8");
    else if (st.isDirectory()) {
      for (const g of fs.readdirSync(p).sort()) {
        const q = path.join(p, g);
        if (g.endsWith(".md") && fs.statSync(q).isFile()) files[`${f}/${g}`] = fs.readFileSync(q, "utf8");
      }
    }
  }
  let title = path.basename(abs);
  const spec = files["spec.md"] ?? files["plan.md"] ?? "";
  const h1 = spec.match(/^#\s+(.+)$/m);
  if (h1) title = h1[1].replace(/^Feature Specification:\s*/i, "").replace(/^Implementation Plan:\s*/i, "").trim();
  return { dir: abs, title, files };
}

export function parseTasksMd(md: string): ImportedTask[] {
  const lines = md.split(/\r?\n/);
  const tasks: ImportedTask[] = [];
  let phase: string | null = null;
  let phaseTasks: ImportedTask[] = [];
  const phases: ImportedTask[][] = [];
  const flush = () => { if (phaseTasks.length) phases.push(phaseTasks); phaseTasks = []; };

  for (const line of lines) {
    const h = line.match(/^##+\s+(.+)$/);
    if (h) {
      flush();
      phase = h[1].trim();
      continue;
    }
    const m = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(T\d{2,4})\b\s*(\[P\])?\s*(.*)$/);
    if (!m) continue;
    const text = m[4].trim();
    const t: ImportedTask = {
      key: m[2],
      title: text.length > 110 ? text.slice(0, 107) + "..." : text,
      description: text,
      parallel: !!m[3],
      phase,
      done: m[1] !== " ",
      depends_on: [],
      order_idx: tasks.length,
    };
    tasks.push(t);
    phaseTasks.push(t);
  }
  flush();

  // Dependency edges.
  const seenEarlier: string[] = [];
  for (const group of phases) {
    for (let i = 0; i < group.length; i++) {
      const t = group[i];
      const deps = new Set<string>(seenEarlier);
      if (!t.parallel && i > 0) deps.add(group[i - 1].key);
      const explicit = t.description.matchAll(/(?:depends on|after|requires)\s+((?:T\d{2,4}(?:\s*,\s*|\s+and\s+)?)+)/gi);
      for (const e of explicit) for (const k of e[1].match(/T\d{2,4}/g) ?? []) if (k !== t.key) deps.add(k);
      t.depends_on = [...deps].filter((k) => tasks.some((x) => x.key === k));
    }
    for (const t of group) seenEarlier.push(t.key);
  }
  // Only keep edges to the *latest* tasks needed (transitive reduction is unnecessary for
  // correctness, but keeping the raw set is fine and makes the graph explicit). Keep raw.
  return tasks;
}

/**
 * Read a feature folder as `orch plan` sees it (§6.4): parse `tasks.md`, apply each `tasks/<key>.md` brief
 * (frontmatter wins over the `[P]` marks), and check the folder. Pure apart from `spec` having been read.
 * Each returned `ImportedTask` carries its parsed `brief` when it has one. Throws when `tasks.md` is missing or empty.
 */
export function importFeature(spec: SpecDir, opts: CheckOptions = {}): { tasks: ImportedTask[]; feature: FeatureResult } {
  const tasksMd = spec.files["tasks.md"];
  if (!tasksMd) throw new Error(`no tasks.md in ${spec.dir}. Run /speckit.tasks first.`);
  const tasks = parseTasksMd(tasksMd);
  if (!tasks.length) throw new Error(`no tasks found in ${path.join(spec.dir, "tasks.md")}`);
  const feature = readFeature(spec.files, tasks, opts);
  for (const t of tasks) {
    const b = feature.briefs.get(t.key);
    if (b) t.brief = b;
  }
  return { tasks, feature };
}

/** Mark a task as done in tasks.md ("- [ ] T001" -> "- [x] T001"). Returns true if changed. */
export function markTaskDoneInFile(tasksPath: string, key: string): boolean {
  if (!fs.existsSync(tasksPath)) return false;
  const src = fs.readFileSync(tasksPath, "utf8");
  const re = new RegExp(`^(\\s*[-*]\\s*)\\[ \\](\\s*${key}\\b)`, "m");
  if (!re.test(src)) return false;
  fs.writeFileSync(tasksPath, src.replace(re, "$1[x]$2"));
  return true;
}
