import type { AgentAdapter } from "./types.js";
import { claudeAdapter } from "./claude.js";
import { geminiAdapter } from "./gemini.js";

export const ADAPTERS: Record<string, AgentAdapter> = {
  claude: claudeAdapter,
  gemini: geminiAdapter,
};

export function getAdapter(type: string): AgentAdapter {
  const a = ADAPTERS[type];
  if (!a) throw new Error(`unknown adapter type '${type}' (known: ${Object.keys(ADAPTERS).join(", ")})`);
  return a;
}

export { runAgent, extractJson } from "./runner.js";
export type * from "./types.js";
