import type { ServerConfig } from "./config.js";

export type Priority = "min" | "low" | "default" | "high" | "urgent";

export interface NotifyOptions {
  priority?: Priority;
  click?: string;
  tags?: string[];
  /** Project name; the title becomes `[<project>] <title>` (REQ-HITL-02). */
  project?: string;
}

export type NotifyResult = { ok: true } | { ok: false; error: string };

/**
 * One ntfy POST (architecture §14). Resolves to the outcome instead of throwing, and an error message never
 * contains the token. Nothing is sent when no topic URL is set.
 */
export async function sendNtfy(cfg: Pick<ServerConfig, "notify" | "publicUrl">, title: string, message: string, opts: NotifyOptions = {}): Promise<NotifyResult> {
  if (!cfg.notify.ntfyUrl) return { ok: false, error: "no ntfy URL is set" };
  const token = cfg.notify.ntfyToken;
  try {
    const headers: Record<string, string> = {
      Title: opts.project ? `[${opts.project}] ${title}` : title,
      Priority: opts.priority ?? "default",
      Click: opts.click ?? cfg.publicUrl,
    };
    if (opts.tags?.length) headers.Tags = opts.tags.join(",");
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(cfg.notify.ntfyUrl, { method: "POST", headers, body: message });
    return res.ok ? { ok: true } : { ok: false, error: `ntfy answered ${res.status}${res.statusText ? " " + res.statusText : ""}` };
  } catch (e: any) {
    const text = String(e?.cause?.message ?? e?.message ?? e);
    return { ok: false, error: token ? text.split(token).join("***") : text };
  }
}

/** ntfy push (architecture §14). Failures are logged to stderr, never thrown. */
export async function notify(cfg: Pick<ServerConfig, "notify" | "publicUrl">, title: string, message: string, opts: NotifyOptions = {}) {
  if (!cfg.notify.ntfyUrl) return;
  const r = await sendNtfy(cfg, title, message, opts);
  if (!r.ok) console.error(`[notify] ntfy failed: ${r.error}`);
}
