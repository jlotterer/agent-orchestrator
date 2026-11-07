/**
 * Which tasks start now (architecture §7.1). Pure: no I/O, no clock; the orchestrator gathers the facts.
 * Fixtures: test/fixtures/readiness.json.
 */
import type { TaskStatus } from "../types.js";
import { ownedOverlap } from "./ownership.js";

export interface ReadinessProject {
  id: string;
  runId: string | null;
  runStatus: string | null;
  maxParallel: number;
  lastStartAt: string | null;
  planQuestionsOpen: number;
  resumeOnRetry: boolean;
}

export interface ReadinessTask {
  id: string;
  projectId: string;
  runId: string;
  key: string;
  orderIdx: number;
  status: TaskStatus;
  dependsOn: string[];
  filesOwned: string[];
  openQuestions: number;
  attempt: number;
  fixRounds: number;
  hasSession: boolean;
  adapterSupportsResume: boolean;
}

export interface ReadinessInput {
  /** Global cap on concurrent agents (server-wide). */
  maxAgents: number;
  /** Agents not tied to a task row: planners, phase validators. */
  busyAgents: number;
  projects: ReadinessProject[];
  tasks: ReadinessTask[];
}

export interface ReadinessResult {
  start: { taskId: string; resume: boolean }[];
  heldForOverlap: { taskId: string; blockedByTaskId: string }[];
}

const ACTIVE: ReadonlySet<string> = new Set(["running", "validating"]);
const FINISHED: ReadonlySet<string> = new Set(["done", "skipped"]);

export function selectReady(input: ReadinessInput): ReadinessResult {
  const start: ReadinessResult["start"] = [];
  const heldForOverlap: ReadinessResult["heldForOverlap"] = [];
  const heldSeen = new Set<string>();

  // 1. Free agent slots, never negative.
  const active = input.tasks.filter((t) => ACTIVE.has(t.status));
  let free = Math.max(0, input.maxAgents - active.length - input.busyAgents);

  // 2. Candidates per eligible project.
  const eligible = input.projects.filter((p) => p.runId !== null && p.runStatus === "running" && p.planQuestionsOpen === 0);
  const queues = new Map<string, ReadinessTask[]>();
  for (const p of eligible) {
    const runTasks = input.tasks.filter((t) => t.runId === p.runId && t.projectId === p.id);
    const finishedKeys = new Set(runTasks.filter((t) => FINISHED.has(t.status)).map((t) => t.key));
    const candidates = runTasks
      .filter((t) => t.status === "pending" && t.openQuestions === 0 && t.dependsOn.every((k) => finishedKeys.has(k)))
      .sort((a, b) => a.orderIdx - b.orderIdx);
    queues.set(p.id, candidates);
  }

  // 3. Fairness: least recently started project first (never started first), ties by id.
  const ordered = [...eligible].sort((a, b) => {
    if (a.lastStartAt !== b.lastStartAt) {
      if (a.lastStartAt === null) return -1;
      if (b.lastStartAt === null) return 1;
      const d = Date.parse(a.lastStartAt) - Date.parse(b.lastStartAt);
      if (d !== 0) return d;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // Per project: tasks occupying a slot (active) plus those chosen this pass.
  const busy = new Map<string, ReadinessTask[]>();
  for (const p of ordered) busy.set(p.id, active.filter((t) => t.projectId === p.id));

  // 4. Round-robin, one start per project per pass, until a pass chooses nothing.
  let chose = true;
  while (chose && free > 0) {
    chose = false;
    for (const p of ordered) {
      if (free <= 0) break;
      const queue = queues.get(p.id)!;
      const occupied = busy.get(p.id)!;
      if (occupied.length >= p.maxParallel) continue;
      for (let i = 0; i < queue.length; i++) {
        const t = queue[i];
        const blocker = occupied.find((o) => ownedOverlap(t.filesOwned, o.filesOwned));
        if (blocker) {
          const pair = `${t.id}\u0000${blocker.id}`;
          if (!heldSeen.has(pair)) { heldSeen.add(pair); heldForOverlap.push({ taskId: t.id, blockedByTaskId: blocker.id }); }
          continue;
        }
        queue.splice(i, 1);
        occupied.push(t);
        free--;
        chose = true;
        // 5. Resume the previous agent session on a retry or a fix round.
        const resume = p.resumeOnRetry && t.hasSession && t.adapterSupportsResume && (t.attempt > 0 || t.fixRounds > 0);
        start.push({ taskId: t.id, resume });
        break;
      }
    }
  }

  return { start, heldForOverlap };
}
