import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = path.resolve(here, "..");
const BUILTIN = path.join(PKG_ROOT, "prompts");

/** Load prompts/<name>.md, letting <repo>/.orch/prompts/<name>.md override it. */
export function loadPrompt(name: string, repo: string): string {
  const override = path.join(repo, ".orch", "prompts", `${name}.md`);
  const p = fs.existsSync(override) ? override : path.join(BUILTIN, `${name}.md`);
  return fs.readFileSync(p, "utf8");
}

export function render(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => {
    const v = vars[k];
    return v === undefined || v === null ? "" : String(v);
  });
}

export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… (truncated, ${s.length - max} more chars)`;
}
