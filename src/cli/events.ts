// A session's stored events for a terminal: as text lines, or as stream-json
// lines (Claude Code's shapes where Keel says the same thing). Following a
// session reads stored events by seq (ordered, never lost) and uses the
// WebSocket for streamed text and to wake the next read early.
import type { StoredEvent } from "../core/types.ts";
import { authHeaders, clean, type Client } from "./client.ts";

const short = (v: unknown, n = 160) => {
  const s = clean(String(v ?? "")).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

// What a tool call is about, in one line.
export function callSummary(name: string, input: any): string {
  if (!input || typeof input !== "object") return short(input);
  const v = input.command ?? input.cmd ?? input.file_path ?? input.absolute_path ?? input.path ?? input.notebook_path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt;
  return short(Array.isArray(v) ? v.join(" ") : v ?? JSON.stringify(input));
}

const resultText = (c: unknown) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n") : "");

export const assistantText = (e: StoredEvent) =>
  e.kind === "assistant" ? (e.data.blocks ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("") : "";

const tok = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n));

export function textLines(e: StoredEvent, o: { thoughts?: boolean } = {}): string[] {
  const d = e.data ?? {};
  switch (e.kind) {
    case "user": {
      const tag = d.kind ? `[${d.kind}] ` : d.origin && d.origin !== "owner" ? `[${d.origin}] ` : "";
      const files = (d.images ?? []).length ? ` (+${d.images.length} file${d.images.length === 1 ? "" : "s"})` : "";
      return clean(d.text).split("\n").map((l, i) => (i === 0 ? `> ${tag}${l}` : `  ${l}`)).concat(files ? [`  ${files.trim()}`] : []);
    }
    case "assistant": {
      const out: string[] = [];
      for (const b of d.blocks ?? []) {
        if (b.type === "text" && b.text.trim()) out.push(...clean(b.text).split("\n"));
        else if (b.type === "thinking" && o.thoughts && b.thinking.trim()) out.push(...clean(b.thinking).split("\n").map((l: string) => `  (thinking) ${l}`));
        else if (b.type === "tool_use") out.push(`  -> ${clean(b.name)}  ${callSummary(b.name, b.input)}`);
      }
      return out;
    }
    case "tool_result":
      return (d.results ?? []).map((r: any) => {
        const t = resultText(r.content);
        const n = t ? t.split("\n").length : 0;
        return `  <- ${r.is_error ? "error: " : ""}${short(t.split("\n")[0], 120)}${n > 1 ? ` (${n} lines)` : ""}`;
      });
    case "turn_end": {
      const u = d.usage ?? {};
      return [`-- turn ended: ${d.reason}, ${tok((u.input ?? 0) + (u.cache_read ?? 0) + (u.cache_write ?? 0))} in, ${tok(u.output ?? 0)} out, ${((d.ms ?? 0) / 1000).toFixed(1)} s`];
    }
    case "error":
      return [`! ${short(d.message, 400)}`];
    case "note":
      return d.model ? [] : [`* ${short(d.text, 400)}`];
    case "compaction":
      return [`* context ${d.mode === "clear" ? "cleared" : "compacted"}${d.tokens_before ? ` from ${tok(d.tokens_before)} tokens` : ""}`];
    default:
      return [];
  }
}

export function streamLine(e: StoredEvent): Record<string, unknown> {
  const meta = { session_id: e.session_id, seq: e.seq, id: e.id, ts_ms: e.ts, event: e };
  const d = e.data ?? {};
  if (e.kind === "user") return { type: "user", message: { role: "user", content: [{ type: "text", text: d.text }] }, ...meta };
  if (e.kind === "assistant") {
    const content = (d.blocks ?? []).filter((b: any) => ["text", "thinking", "tool_use"].includes(b.type)).map((b: any) =>
      b.type === "text" ? { type: "text", text: b.text } : b.type === "thinking" ? { type: "thinking", thinking: b.thinking } : { type: "tool_use", id: b.id, name: b.name, input: b.input });
    return { type: "assistant", message: { role: "assistant", model: d.model, content }, ...meta };
  }
  if (e.kind === "tool_result") {
    return { type: "user", message: { role: "user", content: (d.results ?? []).map((r: any) => ({ type: "tool_result", tool_use_id: r.tool_use_id, content: r.content, is_error: !!r.is_error })) }, ...meta };
  }
  return { type: "system", subtype: e.kind, ...meta };
}

export type Delta = { kind: "text" | "thinking" | "tool_input"; text: string };

// Reads a session's events after `seq` as they are stored.
export class Follower {
  private ws?: WebSocket;
  private wake?: () => void;
  private stopped = false;
  constructor(private c: Client, private sessionId: string, public seq: number, private onEvent: (e: StoredEvent) => void, private onDelta?: (d: Delta) => void) {}

  connect(): Promise<void> {
    return new Promise((resolve) => {
      try {
        const ws = new WebSocket(this.c.base.replace(/^http/, "ws") + "/ws", { headers: authHeaders() } as any);
        this.ws = ws;
        // The daemon sends a socket events and deltas only after its resume;
        // events before now are read by seq, so this one asks from now on.
        ws.onopen = () => { ws.send(JSON.stringify({ op: "resume", cursors: {} })); resolve(); };
        ws.onerror = () => resolve(); // reading by seq still works
        ws.onmessage = (m) => {
          let f: any;
          try { f = JSON.parse(String(m.data)); } catch { return; }
          if (f.t === "delta" && f.session_id === this.sessionId) this.onDelta?.({ kind: f.kind, text: f.text });
          else if ((f.t === "event" && f.event?.session_id === this.sessionId) || (f.t === "session" && f.session?.id === this.sessionId) || f.t === "queue") this.wake?.();
          else if (f.t === "feature" && (f.name === "approval" || f.name === "question")) this.wake?.();
        };
      } catch { resolve(); }
    });
  }

  async read(): Promise<StoredEvent[]> {
    const { events } = await this.c.get<{ events: StoredEvent[] }>(`/api/sessions/${this.sessionId}/events?after=${this.seq}`);
    for (const e of events) {
      this.seq = Math.max(this.seq, e.seq);
      this.onEvent(e);
    }
    return events;
  }

  // Wait for a frame of this session, at most `ms`.
  pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); resolve(); }
      this.wake = done;
    });
  }

  close() {
    this.stopped = true;
    try { this.ws?.close(); } catch {}
  }
  get closed() { return this.stopped; }
}
