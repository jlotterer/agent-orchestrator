/**
 * File ownership (architecture §7.2, §10.2; decision 0017). Pure.
 * Fixtures: test/fixtures/ownership.json.
 */
import path from "node:path";

const WILDCARD = /[*?[{]/;

/** Normalized path segments: `\` → `/`, no leading `./` or `/`, no empty or `.` segments. */
function segments(p: string): string[] {
  return p.replace(/\\/g, "/").split("/").filter((s) => s !== "" && s !== ".");
}

/** Segments up to (excluding) the first one containing a wildcard; a literal path is its own prefix. */
export function staticPrefix(pattern: string): string[] {
  const segs = segments(pattern);
  const i = segs.findIndex((s) => WILDCARD.test(s));
  return i < 0 ? segs : segs.slice(0, i);
}

function isPrefix(a: string[], b: string[]): boolean {
  return a.length <= b.length && a.every((s, i) => s === b[i]);
}

/**
 * True when two ownership lists may touch the same file. Empty lists never overlap (unknown ownership is
 * unconstrained). Conservative: two patterns overlap when one static prefix is a prefix of the other.
 */
export function ownedOverlap(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  const pa = a.map(staticPrefix), pb = b.map(staticPrefix);
  return pa.some((x) => pb.some((y) => isPrefix(x, y) || isPrefix(y, x)));
}

/** Files (from a diff) matched by none of the owned patterns; none when ownership is empty. Order kept. */
export function outOfScope(files: string[], owned: string[]): string[] {
  if (!owned.length) return [];
  const globs = owned.map((g) => segments(g).join("/")).filter(Boolean);
  return files.filter((f) => {
    const p = segments(f).join("/");
    return !globs.some((g) => g === p || path.posix.matchesGlob(p, g) || path.posix.matchesGlob(p, `${g}/**`));
  });
}
