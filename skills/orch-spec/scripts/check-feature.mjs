#!/usr/bin/env node
/**
 * check-feature.mjs: verify a feature folder (specs/NNN-name/) against orch's brief contract
 * (architecture §6.4; REQ-SPEC-02, REQ-SPEC-03). Node ≥ 22, no dependencies.
 *
 *   node check-feature.mjs <folder> [--requirements <file> | --no-requirements]
 *                          [--brief-chars 8000] [--contract-chars 6000] [--total-chars 20000] [--json]
 *
 * Exit 0 with no output when the folder is clean. Otherwise one line per problem, `file:line: message`,
 * paths relative to the folder, ordered spec.md, tasks.md, tasks/<key>.md by key, contracts/*.md, then by
 * line; exit 1. `--json` prints the problems as `[{kind, rule, file, line, message}]` instead (plus `tasks`/`path` on
 * parallel-overlap and `chars`/`limit` on brief-size, as orch reports them). Exit 2 for a
 * usage error or an unreadable folder.
 *
 * What it checks (the rules orch applies at `plan` time, plus the ones only an author can fix):
 *   version          `orch:` must be 1 (error at the `orch:` line, or line 1 when missing)
 *   frontmatter      required keys (orch, covers, depends_on, parallel), known keys, types and values
 *   h1               `# <key>: <title>` matching the file name
 *   sections         `## Acceptance criteria` and `## Target files` each with at least one bullet
 *   depends_on       known task keys, no self-dependency
 *   contracts        each `## Contracts` bullet resolves to contracts/<file> or a `### <name>` under spec.md
 *                    `## Contracts` (both → the section wins; neither → problem)
 *   marker           `[NEEDS CLARIFICATION`, `TBD`, `TODO` (whole word, case-sensitive) in spec.md, briefs
 *                    and contracts/*.md
 *   brief-size       brief over handoff.briefChars (default 8000)
 *   contract-size    a named contract over handoff.contractChars (default 6000)
 *   total-size       brief plus the contracts it names over 20,000 characters in total (orch budgets each part
 *                    on its own and has no total cap, so this is the author's only guard on the whole context)
 *   parallel-overlap two effectively parallel tasks whose target files overlap (§7.2 static-prefix rule), unless one
 *                    depends on the other (brief depends_on ∪ earlier phases); orch's exact message
 *   test-only        every target file is a test path (`fixtures/` is not a test path)
 *   tasks            every tasks.md task has a brief and every brief has a task
 *   coverage         spec.md `## Covers` IDs exist in the requirements file; every MUST ID it covers is cited by
 *                    a brief; a brief cites only IDs spec.md covers; cited IDs exist
 *   links            relative links and heading anchors resolve (spec.md, briefs, contracts)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BRIEF_VERSION, DEFAULT_BUDGETS, FRONTMATTER_KEYS, REQUIRED_KEYS, REQ_ID, TASK_KEY,
  readFeature, parseFrontmatter, parseSections, bullets, isTestPath, patternsOverlap,
  specContracts, specCovers, requirementDefs, findRequirementsFile, brokenLinks,
} from "./lib/feature.mjs";

const MARKER = /\[NEEDS CLARIFICATION|\bTBD\b|\bTODO\b/;

export function parseArgs(argv) {
  const opts = { folder: null, requirements: undefined, noRequirements: false, json: false, ...DEFAULT_BUDGETS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === "--requirements") opts.requirements = next();
    else if (a === "--no-requirements") opts.noRequirements = true;
    else if (a === "--brief-chars") opts.briefChars = Number(next());
    else if (a === "--contract-chars") opts.contractChars = Number(next());
    else if (a === "--total-chars") opts.totalChars = Number(next());
    else if (a === "--json") opts.json = true;
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else if (opts.folder) throw new Error("only one folder can be checked at a time");
    else opts.folder = a;
  }
  if (!opts.folder) throw new Error("usage: check-feature.mjs <folder> [--requirements <file> | --no-requirements] [--brief-chars N] [--contract-chars N] [--total-chars N] [--json]");
  return opts;
}

/**
 * Check a feature folder. Returns the problems, sorted as §6.4 orders them. `opts.requirementsText` may carry the
 * requirements file contents directly (used by tests); otherwise `opts.requirements` or a `docs/requirements.md`
 * found above the folder is read.
 */
export function checkFeature(folder, opts = {}) {
  const budgets = { ...DEFAULT_BUDGETS, ...opts };
  const feature = readFeature(folder);
  const { files, tasks } = feature;
  const problems = [];
  const add = (kind, rule, file, line, message) => problems.push({ kind, rule, file, line, message });

  const spec = files["spec.md"];
  if (spec === undefined) add("error", "layout", "spec.md", 1, "spec.md not found");
  if (files["tasks.md"] === undefined) add("error", "layout", "tasks.md", 1, "tasks.md not found");
  else if (!tasks.length) add("error", "layout", "tasks.md", 1, "no tasks found (expected lines like `- [ ] T001 Title`)");

  // Markers (§6.4): spec.md, every brief, every contracts/*.md; one problem per line, naming the first marker.
  const scanned = Object.keys(files).filter((f) => f === "spec.md" || f.startsWith("tasks/") || f.startsWith("contracts/"));
  for (const f of scanned) files[f].split("\n").forEach((l, i) => {
    const m = l.match(MARKER);
    if (m) add("error", "marker", f, i + 1, `unresolved marker "${m[0]}"`);
  });

  // Links.
  const anchorCache = new Map();
  for (const f of scanned) for (const b of brokenLinks(path.join(feature.dir, f), files[f], anchorCache)) add("error", "link", f, b.line, b.message);

  const contracts = specContracts(spec);
  for (const [name, c] of Object.entries(contracts)) if (c.chars > budgets.contractChars)
    add("warning", "contract-size", "spec.md", c.line, `contract "${name}" is ${c.chars} characters; handoff.contractChars is ${budgets.contractChars}`);
  for (const f of Object.keys(files).filter((f) => f.startsWith("contracts/"))) if (files[f].length > budgets.contractChars)
    add("warning", "contract-size", f, 1, `contract is ${files[f].length} characters; handoff.contractChars is ${budgets.contractChars}`);

  // Briefs.
  const known = new Set(tasks.map((t) => t.key));
  const briefs = new Map(); // key → parsed brief
  if (feature.hasTasksDir) {
    for (const t of tasks) if (files[`tasks/${t.key}.md`] === undefined) add("error", "tasks", "tasks.md", t.line, `${t.key} has no brief (tasks/${t.key}.md)`);
    for (const f of Object.keys(files).filter((f) => f.startsWith("tasks/"))) {
      const key = path.basename(f, ".md");
      if (!TASK_KEY.test(key)) { add("error", "tasks", f, 1, `brief file name must be a task key (T001.md); "${key}" is not`); continue; }
      if (!known.has(key)) { add("error", "tasks", f, 1, `no task ${key} in tasks.md`); continue; }
      briefs.set(key, parseBrief(f, files[f], key, tasks.find((t) => t.key === key), { known, contracts, files, budgets, add, problems }));
    }
  }

  // Parallel overlap (§6.4), exactly as orch's checkFeature: two effectively parallel tasks, neither depending on the
  // other (effective depends_on = brief depends_on ∪ earlier phases, or tasks.md's list when the brief sets none);
  // one warning per (earlier task, later entry), at the later task's brief, on the shared entry's line.
  const effective = tasks.map((t) => {
    const b = briefs.get(t.key)?.supported ? briefs.get(t.key) : undefined; // orch applies nothing from an unsupported brief
    const deps = b?.dependsOn ? [...new Set([...t.earlierPhases, ...b.dependsOn])] : t.depends_on;
    return { t, b, parallel: b?.parallel ?? t.parallel, deps };
  });
  for (let j = 0; j < effective.length; j++) {
    const later = effective[j];
    if (!later.parallel || !later.b?.targets.length) continue;
    for (let i = 0; i < j; i++) {
      const earlier = effective[i];
      if (!earlier.parallel || !earlier.b || later.deps.includes(earlier.t.key) || earlier.deps.includes(later.t.key)) continue;
      const seen = new Set();
      for (const entry of later.b.targets) {
        if (seen.has(entry.line)) continue;
        const hit = earlier.b.targets.find((pa) => patternsOverlap(pa.text, entry.text));
        if (!hit) continue;
        seen.add(entry.line);
        const message = hit.text === entry.text
          ? `${earlier.t.key} and ${later.t.key} are both parallel and both list ${entry.text}`
          : `${earlier.t.key} and ${later.t.key} are both parallel and ${earlier.t.key}'s ${hit.text} overlaps ${entry.text}`;
        problems.push({ kind: "warning", rule: "parallel-overlap", file: `tasks/${later.t.key}.md`, line: entry.line, message, tasks: [earlier.t.key, later.t.key], path: entry.text });
      }
    }
  }

  // Coverage.
  if (spec !== undefined && briefs.size) checkCoverage(folder, spec, briefs, opts, add);

  const rank = (f) => f === "spec.md" ? 0 : f === "tasks.md" ? 1 : f.startsWith("tasks/") ? 2 : f.startsWith("contracts/") ? 3 : 4;
  problems.sort((x, y) => rank(x.file) - rank(y.file) || (x.file < y.file ? -1 : x.file > y.file ? 1 : 0) || x.line - y.line);
  return problems;
}

function parseBrief(file, text, key, task, ctx) {
  const { known, contracts, files, budgets, add, problems } = ctx;
  const out = { key, parallel: undefined, supported: false, dependsOn: undefined, targets: [], cites: [], citesLine: 1, contractChars: 0 };
  const fm = parseFrontmatter(text);
  for (const p of fm.problems) add("error", "frontmatter", file, p.line, p.message);
  if (!fm.end) add("error", "frontmatter", file, 1, "missing frontmatter (`---` block with `orch: 1`)");
  const f = fm.fields;

  // Version first: anything but 1 is an error and the other fields are not applied (§6.4).
  if (!f.orch) add("error", "version", file, 1, `unsupported brief format orch: (missing); this orch reads orch: ${BRIEF_VERSION}`);
  else if (f.orch.value !== BRIEF_VERSION) add("error", "version", file, f.orch.line, `unsupported brief format orch: ${f.orch.value}; this orch reads orch: ${BRIEF_VERSION}`);
  else out.supported = true;

  for (const k of REQUIRED_KEYS) if (k !== "orch" && !f[k]) add("error", "frontmatter", file, Math.max(1, fm.end), `frontmatter is missing "${k}"`);
  for (const [k, v] of Object.entries(f)) {
    if (!FRONTMATTER_KEYS.includes(k)) { add("warning", "frontmatter", file, v.line, `unknown frontmatter key "${k}"`); continue; }
    const isList = Array.isArray(v.value);
    switch (k) {
      case "covers":
        if (!isList || v.value.some((x) => typeof x !== "string" || !new RegExp(`^${REQ_ID.source}$`).test(x))) add("error", "frontmatter", file, v.line, "covers must be a flow list of REQ IDs, for example [REQ-AUTH-01, REQ-AUTH-02]");
        else { out.cites = [...new Set(v.value)]; out.citesLine = v.line; }
        break;
      case "depends_on":
        if (!isList || v.value.some((x) => typeof x !== "string" || !TASK_KEY.test(x))) add("error", "frontmatter", file, v.line, "depends_on must be a flow list of task keys, for example [T001, T002]");
        else {
          for (const d of v.value) {
            if (d === key) add("error", "frontmatter", file, v.line, "depends_on names the task itself");
            else if (!known.has(d)) add("error", "frontmatter", file, v.line, `depends_on names unknown task ${d}`);
          }
          out.dependsOn = v.value.filter((d) => d !== key && known.has(d));
        }
        break;
      case "parallel":
        if (typeof v.value !== "boolean") add("error", "frontmatter", file, v.line, "parallel must be true or false");
        else out.parallel = v.value;
        break;
      case "merge_policy":
        if (!["auto", "manual"].includes(v.value)) add("error", "frontmatter", file, v.line, `merge_policy must be auto or manual, not "${v.value}"`);
        break;
      case "validate":
        if (!["standard", "ui"].includes(v.value)) add("error", "frontmatter", file, v.line, `validate must be standard or ui, not "${v.value}"`);
        break;
      case "validate_command":
        if (typeof v.value !== "string" || !v.value.trim()) add("error", "frontmatter", file, v.line, "validate_command must be a non-empty string");
        break;
    }
  }

  const bodyStart = fm.end ? fm.end + 1 : 1;
  const body = fm.end ? text.split("\n").slice(fm.end).join("\n") : text;
  const { h1, sections } = parseSections(body, bodyStart);
  const h1Line = h1?.line ?? bodyStart;
  if (!h1) add("error", "h1", file, bodyStart, `missing H1 "# ${key}: <title>"`);
  else if (!h1.text.startsWith(`${key}:`)) add("error", "h1", file, h1.line, `H1 must start with "${key}:" (found "${h1.text}")`);

  const acceptance = bullets(sections["Acceptance criteria"]);
  if (!acceptance.length) add("error", "sections", file, sections["Acceptance criteria"]?.line ?? h1Line, 'no "## Acceptance criteria" bullets; orch would ask the planner to write them');
  out.targets = bullets(sections["Target files"]);
  if (!out.targets.length) add("error", "sections", file, sections["Target files"]?.line ?? h1Line, 'no "## Target files" bullets; orch would not know what this task owns');
  else if (out.supported && out.targets.every((t) => isTestPath(t.text))) add("warning", "test-only", file, h1Line, "task appears to add only tests: every target file is a test path");

  for (const c of bullets(sections["Contracts"])) {
    const name = c.text.split(" (")[0].trim();
    const asFile = files[name] !== undefined && (name.startsWith("contracts/") || name.endsWith(".md"));
    const asSection = contracts[name];
    if (asFile && asSection) { add("warning", "contracts", file, c.line, `contract "${name}" is both a file and a spec.md section; the section wins`); out.contractChars += asSection.chars; }
    else if (asSection) out.contractChars += asSection.chars;
    else if (asFile) out.contractChars += files[name].length;
    else add("warning", "contracts", file, c.line, `contract "${name}" is neither a file in the folder nor a "### ${name}" heading under spec.md "## Contracts"`);
  }

  const chars = text.length;
  if (chars > budgets.briefChars) problems.push({ kind: "warning", rule: "brief-size", file, line: 1, message: `brief is ${chars} characters; handoff.briefChars is ${budgets.briefChars}`, chars, limit: budgets.briefChars });
  if (chars + out.contractChars > budgets.totalChars) add("warning", "total-size", file, 1, `brief plus its contracts total ${chars + out.contractChars} characters; keep the total under ${budgets.totalChars} (orch budgets each part on its own and has no total cap)`);
  return out;
}

function checkCoverage(folder, spec, briefs, opts, add) {
  const covers = specCovers(spec);
  let defs = null;
  if (!opts.noRequirements) {
    let text = opts.requirementsText;
    if (text === undefined) {
      const file = opts.requirements ?? findRequirementsFile(path.resolve(folder, ".."));
      if (!file || !fs.existsSync(file)) {
        add("warning", "coverage", "spec.md", 1, opts.requirements
          ? `requirements file not found: ${opts.requirements}`
          : "no docs/requirements.md found above the folder; REQ definitions not checked (pass --requirements <file> or --no-requirements)");
      } else text = fs.readFileSync(file, "utf8");
    }
    if (text !== undefined) defs = requirementDefs(text).defs;
  }
  const covered = new Set(covers.map((c) => c.id));
  const cited = new Map();
  for (const b of briefs.values()) for (const id of b.cites) { if (!cited.has(id)) cited.set(id, []); cited.get(id).push(b.key); }
  if (!covers.length && !(opts.noRequirements && !cited.size)) add("warning", "coverage", "spec.md", 1, 'no REQ IDs under "## Covers"; every MUST requirement the feature covers should be listed there and cited by a brief');
  for (const c of covers) {
    if (defs && !defs[c.id]) add("error", "coverage", "spec.md", c.line, `${c.id} is not defined in the requirements file`);
    const must = defs ? defs[c.id]?.must ?? true : true;
    if (must && !cited.has(c.id)) add("error", "coverage", "spec.md", c.line, `${c.id}${defs ? " (MUST)" : ""} is covered by the feature but cited by no brief`);
  }
  for (const [key, b] of [...briefs.entries()].sort()) for (const id of b.cites) {
    if (defs && !defs[id]) add("error", "coverage", `tasks/${key}.md`, b.citesLine, `${id} is not defined in the requirements file`);
    if (covers.length && !covered.has(id)) add("warning", "coverage", `tasks/${key}.md`, b.citesLine, `${id} is cited here but not listed under spec.md "## Covers"`);
  }
}

export function format(problems) {
  return problems.map((p) => `${p.file}:${p.line}: ${p.message}`).join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  let problems;
  try { problems = checkFeature(opts.folder, opts); } catch (e) { console.error(e.message); process.exit(2); }
  if (opts.json) { if (problems.length) console.log(JSON.stringify(problems, null, 2)); }
  else if (problems.length) console.log(format(problems));
  process.exit(problems.length ? 1 : 0);
}
