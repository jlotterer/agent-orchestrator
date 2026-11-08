import type { ServerConfig } from "./config.js";

export type Priority = "min" | "low" | "default" | "high" | "urgent";

export interface NotifyOptions {
  priority?: Priority;
  click?: string;
  tags?: string[];
  /** Project name; the title becomes `[<project>] <title>` (REQ-HITL-02). */
  project?: string;
}

/** ntfy push (architecture §14). Failures are logged to stderr, never thrown. */
export async function notify(cfg: Pick<ServerConfig, "notify" | "publicUrl">, title: string, message: string, opts: NotifyOptions = {}) {
  if (!cfg.notify.ntfyUrl) return;
  try {
    const headers: Record<string, string> = {
      Title: opts.project ? `[${opts.project}] ${title}` : title,
      Priority: opts.priority ?? "default",
      Click: opts.click ?? cfg.publicUrl,
    };
    if (opts.tags?.length) headers.Tags = opts.tags.join(",");
    if (cfg.notify.ntfyToken) headers.Authorization = `Bearer ${cfg.notify.ntfyToken}`;
    await fetch(cfg.notify.ntfyUrl, { method: "POST", headers, body: message });
  } catch (e: any) {
    console.error(`[notify] ntfy failed: ${e?.message ?? e}`);
  }
}
