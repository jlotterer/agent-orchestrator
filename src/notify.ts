import type { Config } from "./config.js";

export type Priority = "min" | "low" | "default" | "high" | "urgent";

export async function notify(cfg: Config, title: string, message: string, opts: { priority?: Priority; click?: string; tags?: string[] } = {}) {
  if (!cfg.notify.ntfyUrl) return;
  try {
    const headers: Record<string, string> = {
      Title: title,
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
