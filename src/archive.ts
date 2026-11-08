/**
 * Event archive and retention (architecture §17, decision 0019, REQ-OPS-04).
 *
 * Event logs of runs that finished more than `retention.eventDays` ago are streamed as gzip JSON lines to
 * `<archiveRoot>/<project>/<runId>-events.jsonl.gz`, then deleted from the store. The file is written to
 * `.tmp`, fsynced and renamed before anything is deleted, so a failure never loses events. Decisions,
 * questions, task rows and costs are never touched.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Store } from "./db.js";
import type { Event, Run } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Archive folder for runs from before projects existed (`project_id` NULL). */
const NO_PROJECT = "_unassigned";

/** Where a run's events are (or will be) archived. */
export function archiveFilePath(archiveRoot: string, run: Pick<Run, "id" | "project_id">): string {
  const project = run.project_id ?? NO_PROJECT;
  for (const seg of [project, run.id]) {
    if (!seg || seg === "." || seg === ".." || /[\\/]/.test(seg)) throw new Error(`invalid path segment '${seg}'`);
  }
  return path.join(archiveRoot, project, `${run.id}-events.jsonl.gz`);
}

/** The single event the log endpoints return for an archived run (§17). Its id sorts after every real event. */
export function archivedLogEvent(archiveRoot: string, run: Run, taskId: string | null): Event {
  return {
    id: Number.MAX_SAFE_INTEGER,
    run_id: run.id,
    task_id: taskId,
    ts: run.archived_at ?? run.updated_at,
    kind: "info",
    data: { message: `Log archived to ${archiveFilePath(archiveRoot, run)}` },
  };
}

function* jsonLines(events: Iterable<Event>): Generator<string> {
  for (const e of events) yield JSON.stringify(e) + "\n";
}

function fsyncPath(p: string) {
  const fd = fs.openSync(p, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Make a rename durable where the platform allows fsync on a directory (not Windows). */
function fsyncDir(dir: string) {
  try {
    const fd = fs.openSync(dir, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* best effort */ }
}

/** Write one run's events to its archive file. Throws before the rename if anything fails; the store is untouched. */
async function writeArchive(store: Store, run: Run, file: string): Promise<void> {
  const tmp = file + ".tmp";
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await pipeline(Readable.from(jsonLines(store.iterateRunEvents(run.id))), zlib.createGzip(), fs.createWriteStream(tmp));
    fsyncPath(tmp);
    fs.renameSync(tmp, file);
    fsyncDir(path.dirname(file));
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* the directory may not exist */ }
    throw e;
  }
}

/**
 * Archive every finished run whose `updated_at` is older than `eventDays` (0 = never). Each run is
 * independent: one failure is logged as an `error` event on that run and listed in `errors`, and its
 * events stay in the store. Returns the archived run ids.
 */
export async function archiveEligibleRuns(
  store: Store,
  opts: { now: Date; eventDays: number; archiveRoot: string },
): Promise<{ archived: string[]; errors: string[] }> {
  const archived: string[] = [];
  const errors: string[] = [];
  if (!(opts.eventDays > 0)) return { archived, errors };
  const before = new Date(opts.now.getTime() - opts.eventDays * DAY_MS).toISOString();
  for (const run of store.listArchivableRuns(before)) {
    let file: string;
    try {
      file = archiveFilePath(opts.archiveRoot, run);
      await writeArchive(store, run, file);
    } catch (e: any) {
      const message = `event archive failed for run ${run.id}: ${e?.message ?? e}`;
      errors.push(message);
      try { store.addEvent(run.id, null, "error", { message }); } catch { /* the store itself failed; already reported */ }
      continue;
    }
    const ts = opts.now.toISOString();
    const count = store.deleteRunEventsAndMarkArchived(run.id, ts);
    store.addDecision(run.id, null, "orchestrator", `Archived ${count} event(s) to ${file}`,
      `run finished more than ${opts.eventDays} day(s) ago (retention.eventDays)`);
    archived.push(run.id);
  }
  return { archived, errors };
}
