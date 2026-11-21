// A session's stored events for a terminal: as text lines, or as stream-json
// lines (Claude Code's shapes where Keel says the same thing). Following a
// session takes its events from the WebSocket, in line with the streamed
// text, and reads them by seq (ordered, never lost) when the socket is not
// there or skipped one. A reply's event completes what streamed of it.
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

// The version of the stream-json lines (docs/headless.md). It goes up when a
// line a script reads changes its meaning or loses a field; a new field or a
// new line type does not move it.
export const STREAM_SCHEMA = 1;

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

// A stored reply as it streams: what each of its blocks adds, in order.
const streamOf = (e: StoredEvent): Delta[] => (e.data.blocks ?? []).flatMap((b: any): Delta[] =>
  b.type === "text" ? [{ kind: "text", text: b.text ?? "" }]
    : b.type === "thinking" ? [{ kind: "thinking", text: b.thinking ?? "" }]
    : b.type === "tool_use" ? [{ kind: "tool_input", text: JSON.stringify(b.input ?? {}) }] : []);

const nothing = (): Record<Delta["kind"], string> => ({ text: "", thinking: "", tool_input: "" });

// Reads a session's events after `seq`, in order and each once. Over the
// socket they come as they are stored, in line with the text streamed between
// them; without it, or past a gap, they are read by seq. The text passed on
// before a reply's event adds up to the reply: what did not stream here (the
// reply ended before the socket was there, or is read by seq) is passed on
// in one piece just before the event.
export class Follower {
  private ws?: WebSocket;
  private wake?: () => void;
  private stopped = false;
  // The last stored event the socket has passed. Streamed text is of the reply
  // after that event: when a read by seq is ahead of the socket, the text
  // still arriving is of a reply already handed over whole, or of a turn before it.
  private wsSeq = -1;
  // What was passed on of the reply after `seq`.
  private passed = nothing();
  // Streamed text of the reply the socket is at now was not passed on (the
  // socket and the reads by seq were apart): no more of that reply is, so what
  // is passed on stays its beginning, and its event passes the rest.
  private torn = false;
  // What a callback threw on a socket frame, for the next read to throw.
  private failed?: { error: unknown };
  constructor(private c: Client, private sessionId: string, public seq: number, private onEvent: (e: StoredEvent) => void, private onDelta?: (d: Delta) => void) {}

  private take(e: StoredEvent) {
    if (e.seq <= this.seq) return;
    this.seq = e.seq;
    if (e.kind === "assistant") this.complete(e);
    if (e.kind === "assistant" || e.kind === "turn_end") this.passed = nothing();
    this.onEvent(e);
  }

  private pass(ds: Delta[]) {
    if (!this.onDelta) return;
    if (this.wsSeq !== this.seq) this.torn = true;
    if (this.torn) return;
    for (const d of ds) {
      this.passed[d.kind] += d.text;
      this.onDelta(d);
    }
  }

  // The rest of a reply, after what streamed of it. Text that streamed as
  // something else than the reply holds (a tool's input as the provider wrote
  // it) is left as it streamed.
  private complete(e: StoredEvent) {
    if (!this.onDelta) return;
    const parts = streamOf(e);
    const skip: Partial<Record<Delta["kind"], number>> = {};
    for (const p of parts) {
      const had = this.passed[p.kind];
      skip[p.kind] ??= parts.filter((x) => x.kind === p.kind).map((x) => x.text).join("").startsWith(had) ? had.length : Infinity;
      const rest = p.text.slice(skip[p.kind]);
      skip[p.kind] = Math.max(0, skip[p.kind]! - p.text.length);
      if (rest) this.onDelta({ kind: p.kind, text: rest });
    }
  }

  connect(): Promise<void> {
    return new Promise((resolve) => {
      try {
        const ws = new WebSocket(this.c.base.replace(/^http/, "ws") + "/ws", { headers: authHeaders() } as any);
        this.ws = ws;
        // The daemon sends a socket events and deltas only after its resume:
        // the events after this cursor, what the running reply has streamed
        // so far, then both as they happen.
        ws.onopen = () => {
          this.wsSeq = this.seq;
          ws.send(JSON.stringify({ op: "resume", cursors: { [this.sessionId]: this.seq } }));
          resolve();
        };
        ws.onerror = () => resolve(); // reading by seq still works
        ws.onmessage = (m) => {
          let f: any;
          try { f = JSON.parse(String(m.data)); } catch { return; }
          // An error thrown here would be printed and the frame lost: the next read throws it.
          try { this.frame(f); } catch (error) {
            this.failed ??= { error };
            this.wake?.();
          }
        };
      } catch { resolve(); }
    });
  }

  private rethrow() {
    if (this.failed) throw this.failed.error;
  }

  private frame(f: any) {
    const here = (f.session_id ?? f.event?.session_id ?? f.session?.id) === this.sessionId;
    if (f.t === "event" && here) {
      this.wsSeq = Math.max(this.wsSeq, f.event.seq);
      if (f.event.kind === "assistant" || f.event.kind === "turn_end") this.torn = false; // the next reply starts whole
      if (f.event.seq === this.seq + 1) this.take(f.event);
      this.wake?.();
    } else if (f.t === "delta" && here) {
      this.pass([{ kind: f.kind, text: f.text }]);
    } else if (f.t === "draft" && here) {
      this.pass(Object.entries(f.blocks ?? {}).sort((x, y) => Number(x[0]) - Number(y[0])).map(([, b]: [string, any]) => ({ kind: b.kind, text: b.text })));
    } else if (f.t === "status" && here && f.status?.kind === "retry") {
      this.passed = nothing(); // the retried attempt streams its reply again
      this.torn = false;
    } else if ((f.t === "session" && here) || f.t === "queue") this.wake?.();
    else if (f.t === "feature" && (f.name === "approval" || f.name === "question")) this.wake?.();
  }

  async read(): Promise<StoredEvent[]> {
    this.rethrow();
    const { events } = await this.c.get<{ events: StoredEvent[] }>(`/api/sessions/${this.sessionId}/events?after=${this.seq}`);
    this.rethrow();
    for (const e of events) this.take(e);
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
