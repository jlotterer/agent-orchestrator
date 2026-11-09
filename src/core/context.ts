/**
 * Spec context assembly (architecture §6.4 and §9; REQ-WORK-09, REQ-WORK-10). Pure: the caller
 * reads the files and passes their contents; this module decides what a worker or validator sees,
 * in which order, and where each part's budget cuts it. Every part is clipped on its own, so a long
 * `plan.md` can never push `spec.md` out. Sizes are characters after CRLF→LF normalization.
 * Fixtures: test/fixtures/spec-dir/<folder>.expected.json `context`.
 */

/** A file's contents with the name used in headers and messages (`tasks/T003.md`, `docs/requirements.md`, `AGENTS.md`). */
export interface NamedText {
  name: string;
  text: string;
}

/** The `handoff.*` budgets the assembly uses (§19). */
export interface ContextBudgets {
  /** The brief, `tasks/<key>.md`. */
  briefChars: number;
  /** The requirement rows and criteria for the REQ IDs the brief cites. */
  reqChars: number;
  /** Each named contract. */
  contractChars: number;
  /** Each project rules file. */
  rulesChars: number;
  /** Each spec file, for a task without a brief. */
  specChars: number;
}

export type ContextPartKind = "brief" | "requirements" | "contract" | "rules" | "spec";

/** One part of the assembled text, in prompt order. `chars` is the content without its header. */
export interface ContextPart {
  part: ContextPartKind;
  header: string;
  source: string;
  budget: number;
  chars: number;
  cut: boolean;
  /** Present when `cut`: characters kept (= budget) and dropped. */
  kept?: number;
  dropped?: number;
}

/** A part that was clipped: `from` characters down to `to`. The orchestrator records one decision per cut (`cutDecision`). */
export interface ContextCut {
  part: ContextPartKind;
  source: string;
  from: number;
  to: number;
}

/** The requirement lines for the cited IDs, in `cites` order, as `extractReqRows` returns them. */
export interface ReqRows {
  /** The requirements file's configured path, used in the header and in not-found lines. */
  name: string;
  /** The cited IDs, deduplicated, in order. */
  ids: string[];
  /** Table rows and bullet lines, verbatim; `REQ-X-NN: not found in <name>` for an ID without any. */
  lines: string[];
}

/** A feature folder as the caller read it: paths relative to the folder with `/` separators. */
export interface SpecFolder {
  files: Record<string, string>;
}

/** A contract a brief names, resolved to a `spec.md` section (`spec.md#Name`) or a file; `null` when neither exists. */
export interface ResolvedContract {
  name: string;
  source: string | null;
  text: string | null;
}

export interface ContractResolution {
  contracts: ResolvedContract[];
  /** One line per contract that is both a section and a file, or neither. */
  warnings: string[];
}

export interface SpecContextInput {
  /** The task's brief. When present, `specFiles` and `contextFiles` are not used (REQ-WORK-09). */
  brief?: NamedText | null;
  /** From `extractReqRows`; no requirements part when absent or when `ids` is empty. */
  reqRows?: ReqRows | null;
  /** From `resolveContracts`, in the brief's order. */
  contracts?: ResolvedContract[];
  /** The project rules files that exist (`handoff.projectFiles`); absent files are simply not passed. */
  rules?: NamedText[];
  /** The feature folder's files, for a task without a brief (REQ-WORK-10). */
  specFiles?: Record<string, string>;
  /** `handoff.contextFiles`: the spec files that come first, in this order. */
  contextFiles?: string[];
}

export interface SpecContext {
  /** The parts, each `header\ncontent`, joined with blank lines. Empty when there is nothing to show. */
  text: string;
  parts: ContextPart[];
  cuts: ContextCut[];
}

const BUDGET_KEY: Record<ContextPartKind, keyof ContextBudgets> = {
  brief: "briefChars",
  requirements: "reqChars",
  contract: "contractChars",
  rules: "rulesChars",
  spec: "specChars",
};

const lf = (s: string): string => s.replace(/\r\n?/g, "\n");
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normPath = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Same marker as `clip` in src/prompts.ts (kept here so src/core stays dependency-free). */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… (truncated, ${s.length - max} more chars)`;
}

/**
 * The requirement lines for `ids` (§6.4): per ID, the table rows whose first cell is the ID, then the
 * bullet lines (`-`/`*`) that contain the ID as a whole word (edge cases, acceptance criteria), all
 * verbatim in file order. An ID with neither gives `REQ-X-NN: not found in <name>`; it is not an error,
 * so a missing requirements file (`text: ""`) yields one such line per ID.
 */
export function extractReqRows(file: NamedText, ids: string[]): ReqRows {
  const lines = lf(file.text).split("\n");
  const uniq = [...new Set(ids)];
  const out: string[] = [];
  for (const id of uniq) {
    const row = new RegExp(`^\\|\\s*${escapeRe(id)}\\s*\\|`);
    const word = new RegExp(`(?<![\\w-])${escapeRe(id)}(?![\\w-])`);
    const rows = lines.filter((l) => row.test(l));
    const bullets = lines.filter((l) => /^\s*[-*]\s/.test(l) && word.test(l));
    if (!rows.length && !bullets.length) out.push(`${id}: not found in ${file.name}`);
    else out.push(...rows, ...bullets);
  }
  return { name: file.name, ids: uniq, lines: out };
}

/**
 * The `### <name>` section under spec.md's `## Contracts`: from its heading line to the line before
 * the next `##`/`###` heading, trailing blank lines removed. `null` when there is no such section.
 */
export function contractSection(specMd: string, name: string): string | null {
  const lines = lf(specMd).split("\n");
  let inContracts = false;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (start >= 0) {
      if (/^##{1,2}\s+/.test(line)) return trimTrailingBlank(lines.slice(start, i));
      continue;
    }
    const h2 = /^##\s+(.*?)\s*$/.exec(line);
    if (h2) {
      inContracts = h2[1] === "Contracts";
      continue;
    }
    const h3 = /^###\s+(.*?)\s*$/.exec(line);
    if (inContracts && h3 && h3[1] === name) start = i;
  }
  return start < 0 ? null : trimTrailingBlank(lines.slice(start));
}

function trimTrailingBlank(lines: string[]): string {
  const out = [...lines];
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join("\n");
}

/** The folder file a contract name points at: the name itself, or `contracts/<name>[.md]`. */
function contractFile(files: Record<string, string>, name: string): string | null {
  const n = normPath(name);
  for (const candidate of [n, `contracts/${n}`, `contracts/${n}.md`]) if (candidate in files) return candidate;
  return null;
}

/**
 * Resolves the contracts a brief names (§6.4): a `### <name>` section under spec.md's `## Contracts`,
 * else a file in the folder. Both present → the section wins and a warning names both. Neither →
 * a warning naming the brief and the contract, and the contract resolves to `null`.
 */
export function resolveContracts(spec: SpecFolder, names: string[], brief = "brief"): ContractResolution {
  const files = Object.fromEntries(Object.entries(spec.files).map(([k, v]) => [normPath(k), v]));
  const contracts: ResolvedContract[] = [];
  const warnings: string[] = [];
  for (const name of names) {
    const section = "spec.md" in files ? contractSection(files["spec.md"], name) : null;
    const file = contractFile(files, name);
    if (section !== null) {
      if (file) warnings.push(`${brief}: contract ${name} is both a spec.md section and ${file}; the section is used`);
      contracts.push({ name, source: `spec.md#${name}`, text: section });
    } else if (file) {
      contracts.push({ name, source: file, text: lf(files[file]) });
    } else {
      warnings.push(`${brief}: contract ${name} is neither a section under spec.md "## Contracts" nor a file in the folder`);
      contracts.push({ name, source: null, text: null });
    }
  }
  return { contracts, warnings };
}

/**
 * The spec files a task without a brief sees, in order (§6.4): `contextFiles` that exist, in that
 * order; then the folder's other root `*.md` alphabetically; then `contracts/*` alphabetically.
 * Never `tasks.md` or anything under `tasks/`.
 */
export function specFileOrder(files: Record<string, string>, contextFiles: string[]): string[] {
  const names = Object.keys(files).map(normPath);
  const excluded = (f: string) => f === "tasks.md" || f.startsWith("tasks/");
  const out: string[] = [];
  for (const f of contextFiles.map(normPath)) if (names.includes(f) && !excluded(f) && !out.includes(f)) out.push(f);
  const root = names.filter((f) => !f.includes("/") && f.endsWith(".md") && !excluded(f) && !out.includes(f)).sort(byName);
  const contracts = names.filter((f) => f.startsWith("contracts/") && !out.includes(f)).sort(byName);
  return [...out, ...root, ...contracts];
}

/**
 * Builds the spec part of a worker's or validator's context (§6.4). With a brief: the brief, the
 * requirement rows, each contract, then each rules file. Without: the spec files in `specFileOrder`,
 * then each rules file. Each part is clipped to its own budget with the `clip` marker; `cuts` lists
 * every clipped part for the orchestrator to record. The hand-off of §9 is appended by the caller.
 */
export function assembleSpecContext(input: SpecContextInput, budgets: ContextBudgets): SpecContext {
  const parts: ContextPart[] = [];
  const cuts: ContextCut[] = [];
  const chunks: string[] = [];
  const add = (part: ContextPartKind, header: string, source: string, text: string) => {
    const body = lf(text);
    const budget = budgets[BUDGET_KEY[part]];
    const chars = body.length;
    const cut = chars > budget;
    parts.push(cut ? { part, header, source, budget, chars, cut, kept: budget, dropped: chars - budget } : { part, header, source, budget, chars, cut });
    if (cut) cuts.push({ part, source, from: chars, to: budget });
    chunks.push(`${header}\n${clip(body, budget)}`);
  };

  if (input.brief) {
    add("brief", `### Brief: ${input.brief.name}`, input.brief.name, input.brief.text);
    const rr = input.reqRows;
    if (rr && rr.ids.length) add("requirements", `### Requirements: ${rr.ids.join(", ")} (${rr.name})`, rr.name, rr.lines.join("\n"));
    for (const c of input.contracts ?? []) {
      if (c.source === null || c.text === null) {
        add("contract", `### Contract: ${c.name}`, c.name, `${c.name}: not found (no "### ${c.name}" section under spec.md "## Contracts" and no such file in the feature folder)`);
      } else if (c.source.startsWith("spec.md#")) {
        add("contract", `### Contract: ${c.name} (spec.md)`, c.source, c.text);
      } else {
        add("contract", `### Contract: ${c.source}`, c.source, c.text);
      }
    }
  } else {
    const files = Object.fromEntries(Object.entries(input.specFiles ?? {}).map(([k, v]) => [normPath(k), v]));
    for (const f of specFileOrder(files, input.contextFiles ?? [])) add("spec", `### ${f}`, f, files[f]);
  }
  for (const r of input.rules ?? []) add("rules", `### Rules: ${r.name}`, r.name, r.text);

  return { text: chunks.join("\n\n"), parts, cuts };
}

/** The decision text for one cut: `T004: brief cut from 8265 to 8000 characters (handoff.briefChars)`. */
export function cutDecision(taskKey: string, cut: ContextCut): string {
  const what =
    cut.part === "brief" ? "brief"
    : cut.part === "requirements" ? "requirement rows"
    : cut.part === "contract" ? `contract ${cut.source}`
    : cut.source;
  return `${taskKey}: ${what} cut from ${cut.from} to ${cut.to} characters (handoff.${BUDGET_KEY[cut.part]})`;
}
