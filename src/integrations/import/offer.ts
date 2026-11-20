// What a machine offers of its transcripts to the daemon that asks: the list
// (never one under a credentials folder or name, titles and prompts through
// the export redactor) and a preview's last messages. The same rules whether a
// paired daemon answers (src/server/routes/imports.ts) or the helper of an ssh
// machine (src/fleet/hands-sessions.ts).
import { redact } from "../redact.ts";
import type { Found, Harness } from "./types.ts";

export type ListQuery = { harness?: Harness; q?: string; cwd?: string; show?: string; sort?: "updated" | "size" | "title"; limit?: number; cursor?: number };

const CREDENTIAL = /(^|\/)(\.ssh|\.gnupg|\.aws|\.docker|\.kube|\.password-store|[^/]*(credential|secret|token|passw|\.pem$|\.key$)[^/]*)(\/|$)/i;

export const offered = (f: Found) => !CREDENTIAL.test(f.path) && !CREDENTIAL.test(f.cwd ?? "");
export const scrub = <T extends Found>(f: T): T => ({ ...f, title: redact(f.title), first_prompt: f.first_prompt && redact(f.first_prompt), last_prompt: f.last_prompt && redact(f.last_prompt) });

// The rows a listing shows, in its order: interactive sessions unless more
// are asked for, every word of the search in the title, folder, prompts or id.
export function select(rows: Found[], q: ListQuery): Found[] {
  const words = (q.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const show = new Set((q.show ?? "").split(",").filter(Boolean));
  const out = rows.filter((f) => {
    if (q.harness && f.harness !== q.harness) return false;
    if (f.kind !== "interactive" && !show.has("all") && !show.has(f.kind === "subagent" ? "subagents" : "headless")) return false;
    if (q.cwd && f.cwd !== q.cwd) return false;
    if (words.length) {
      const hay = `${f.title} ${f.cwd ?? ""} ${f.first_prompt ?? ""} ${f.last_prompt ?? ""} ${f.id}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  const sort = q.sort ?? "updated";
  return out.sort((a, b) => (sort === "size" ? b.size_bytes - a.size_bytes : sort === "title" ? a.title.localeCompare(b.title) : b.updated_ms - a.updated_ms));
}

// The newest messages of a read, for a preview.
export function tail(events: { kind: string; data: any }[], n = 6) {
  const out: { role: string; text: string }[] = [];
  for (const e of events) {
    if (e.kind === "user") out.push({ role: "user", text: e.data.text });
    else if (e.kind === "assistant") {
      const t = (e.data.blocks ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
      if (t) out.push({ role: "assistant", text: t });
    }
  }
  return out.slice(-n).map((m) => ({ ...m, text: m.text.length > 1200 ? m.text.slice(0, 1199) + "…" : m.text }));
}
