#!/usr/bin/env node
/**
 * scaffold-briefs.mjs: write a brief skeleton (tasks/<key>.md) for every task in tasks.md that has none.
 * Used by the skill's adopt mode (REQ-SPEC-04) and, optionally, feature mode. Node ≥ 22, no dependencies.
 *
 *   node scaffold-briefs.mjs <folder> [--dry-run]
 *
 * tasks.md is never modified: keys, titles, phases, [P] marks and ticks stay exactly as they are. Each skeleton
 * carries the frontmatter orch derives from tasks.md today (`depends_on` is the full effective list of §6.4:
 * earlier phases ∪ the previous task when not [P] ∪ explicit "depends on" text; `parallel` from [P]) and empty
 * sections with an `<!-- orch-spec: … -->` note on what to write. The skeleton is not a finished brief:
 * check-feature.mjs fails it until the acceptance criteria and target files are filled in, which is the point.
 *
 * Prints one line per brief written (`wrote tasks/T003.md`). When every task already has a brief there is nothing to
 * adopt: it says so on stderr and exits 1, so a second run is never mistaken for a silent success. Exit 2 when the
 * folder or tasks.md is missing.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFeature, BRIEF_VERSION } from "./lib/feature.mjs";

export function skeleton(task) {
  const deps = task.depends_on.length ? `[${task.depends_on.join(", ")}]` : "[]";
  return `---
orch: ${BRIEF_VERSION}
covers: []
depends_on: ${deps}
parallel: ${task.parallel}
merge_policy: auto
validate: standard
---
# ${task.key}: ${task.title}

## Goal
${task.description}
<!-- orch-spec: replace with one paragraph: what exists when this task is done and why it matters. Fill \`covers\` above with the REQ IDs it satisfies. -->

## Acceptance criteria
<!-- orch-spec: one "Given …, When …, Then …" bullet per criterion; each becomes a test the validator checks. -->

## Target files
<!-- orch-spec: one path per bullet; parallel tasks must not share any. -->

## Contracts
<!-- orch-spec: one bullet per interface this task shares with another: "<Name> (spec.md §Contracts)" or "contracts/<file>.md"; write "None." when it shares none. -->

## Out of scope
<!-- orch-spec: what neighbouring tasks own, so this worker does not build it. -->

## Notes for the worker
<!-- orch-spec: names, boundaries and the order to work in; delete this section if there is nothing to say. -->
`;
}

export function scaffold(folder, { dryRun = false } = {}) {
  const feature = readFeature(folder);
  if (feature.files["tasks.md"] === undefined) throw new Error(`tasks.md not found in ${feature.dir}`);
  if (!feature.tasks.length) throw new Error(`no tasks found in ${path.join(feature.dir, "tasks.md")} (expected lines like \`- [ ] T001 Title\`)`);
  const written = [];
  const dir = path.join(feature.dir, "tasks");
  for (const t of feature.tasks) {
    const rel = `tasks/${t.key}.md`;
    if (feature.files[rel] !== undefined) continue;
    if (!dryRun) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(feature.dir, rel), skeleton(t), "utf8"); }
    written.push(rel);
  }
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const folder = args.find((a) => !a.startsWith("--"));
  if (!folder) { console.error("usage: scaffold-briefs.mjs <folder> [--dry-run]"); process.exit(2); }
  let written;
  try { written = scaffold(folder, { dryRun }); } catch (e) { console.error(e.message); process.exit(2); }
  if (!written.length) {
    console.error(`nothing to scaffold: every task in tasks.md already has a brief in ${path.join(path.resolve(folder), "tasks")}; edit those briefs instead`);
    process.exit(1);
  }
  for (const rel of written) console.log(`${dryRun ? "would write" : "wrote"} ${rel}`);
}
