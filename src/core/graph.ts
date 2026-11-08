/**
 * Dependency graph checks for plan approval (architecture §6.3). Pure: no I/O.
 */

/**
 * The first dependency cycle found, as the keys along it with the first key repeated at the end
 * (`["T1","T2","T1"]` for T1→T2→T1, `["T1","T1"]` for a self-edge), or null when the graph is a DAG.
 * Edges point from a task to the keys in its `dependsOn`; keys not in `tasks` are ignored.
 * Tasks are visited in input order, so the result is deterministic.
 */
export function findCycle(tasks: { key: string; dependsOn: string[] }[]): string[] | null {
  const deps = new Map(tasks.map((t) => [t.key, t.dependsOn]));
  const state = new Map<string, "open" | "closed">();
  const stack: string[] = [];

  const visit = (key: string): string[] | null => {
    state.set(key, "open");
    stack.push(key);
    for (const d of deps.get(key) ?? []) {
      if (!deps.has(d)) continue;
      const s = state.get(d);
      if (s === "open") return [...stack.slice(stack.indexOf(d)), d];
      if (s === undefined) {
        const found = visit(d);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(key, "closed");
    return null;
  };

  for (const t of tasks) {
    if (state.has(t.key)) continue;
    const found = visit(t.key);
    if (found) return found;
  }
  return null;
}
