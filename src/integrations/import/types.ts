// What every reader of another harness's store gives: sessions it finds
// (cheap: a file's head and tail), and one session read whole as keel-bun
// events. Readers only read: they never write beside the files they read.
import type { EventKind } from "../../core/types.ts";

export type Harness = "claude" | "codex" | "keel" | "agy" | "hermes";
export type Kind = "interactive" | "subagent" | "headless";

export type Found = {
  harness: Harness;
  id: string;
  path: string;          // the file (or the database) it is read from
  cwd?: string;
  title: string;
  first_prompt?: string;
  last_prompt?: string;
  updated_ms: number;
  size_bytes: number;
  model?: string;
  // The permission mode the source session last ran in, as a Keel mode (a
  // Claude Code session in auto is Auto, bypassPermissions is Full auto).
  perm_mode?: "ask" | "auto-edits" | "auto" | "full-auto" | "plan";
  kind: Kind;
  parent_id?: string;
  archived?: boolean;   // the source keeps it archived
};

export type ImportedEvent = { kind: EventKind; data: any; ts: number };

export type Counts = { prompts: number; assistant_messages: number; tool_calls: number; thoughts_dropped: number; skipped: number; media: number };

export type Read = {
  found: Found;
  events: ImportedEvent[];
  counts: Counts;
  notes: string[];
};

export const emptyCounts = (): Counts => ({ prompts: 0, assistant_messages: 0, tool_calls: 0, thoughts_dropped: 0, skipped: 0, media: 0 });

export const clip = (s: string, n = 200) => {
  const l = s.replace(/\s+/g, " ").trim();
  return l.length > n ? l.slice(0, n - 1) + "…" : l;
};

// Grouping helper: assistant blocks of one reply become one event, results of
// one round one event, so the history reads as keel-bun writes its own.
// A note the model reads, written where a destination has only user messages:
// labelled, so it never reads as the owner's words, and read back as a note.
export const NOTE_OPEN = "<keel_note>";
export const NOTE_CLOSE = "</keel_note>";
// A failed result where the destination has no failure flag: a label line before the text.
export const FAILED_LABEL = "[Keel: this call failed]";

export class Builder {
  events: ImportedEvent[] = [];
  counts = emptyCounts();
  private last(kind: EventKind) {
    const e = this.events[this.events.length - 1];
    return e && e.kind === kind ? e : undefined;
  }
  user(text: string, ts: number, images: any[] = []) {
    // Stored as Keel stores a prompt's images (the providers' wires read that shape).
    images = images.map((b) => (b?.type === "image" && b.source?.type === "base64" ? { type: "image", media_type: b.source.media_type, data: b.source.data } : b));
    if (!text.trim() && !images.length) return;
    this.counts.prompts++;
    this.counts.media += images.length;
    this.events.push({ kind: "user", data: { text, images: images.length ? images : undefined }, ts });
  }
  // `stop` is a stored outcome the source says outright (an interrupted reply);
  // without one, a reply with calls asked for tools and one without ended.
  assistant(blocks: any[], ts: number, model?: string, newMessage = false, stop?: string) {
    if (!blocks.length) return;
    const prev = newMessage ? undefined : this.last("assistant");
    for (const b of blocks) if (b.type === "tool_use") this.counts.tool_calls++;
    if (prev) prev.data.blocks.push(...blocks);
    else {
      this.counts.assistant_messages++;
      this.events.push({ kind: "assistant", data: { blocks: [...blocks], model, stop: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", imported: true }, ts });
    }
    const e = this.last("assistant")!;
    e.data.stop = stop ?? (e.data.blocks.some((b: any) => b.type === "tool_use") ? "tool_use" : "end_turn");
  }
  // The source says its last reply was stopped before completion.
  interrupted() {
    const e = this.events.findLast((x) => x.kind === "assistant" || x.kind === "user");
    if (e?.kind === "assistant") e.data.stop = "interrupted";
  }
  result(r: { tool_use_id: string; content: any; is_error?: boolean }, ts: number) {
    const prev = this.last("tool_result");
    const block = { type: "tool_result", tool_use_id: r.tool_use_id, content: r.content, is_error: r.is_error || undefined };
    if (Array.isArray(r.content)) this.counts.media += r.content.filter((c: any) => c?.type === "image").length;
    if (prev) prev.data.results.push(block);
    else this.events.push({ kind: "tool_result", data: { results: [block] }, ts });
  }
  note(text: string, ts: number, model = false) {
    this.events.push({ kind: "note", data: { text, model: model || undefined, imported: true }, ts });
  }
}

// What a source holds that cannot be read here (a file id, a remote link,
// encrypted content): named, never invented.
export const unavailable = (what: string) => ({ type: "text", text: `[unavailable: ${what}]` });

// An image as Keel stores one (bytes and type), from Anthropic's base64
// source or a Responses input_image data URL; a reference to bytes the file
// does not hold is named as unavailable.
function imageOf(p: any): any {
  if (p.source?.type === "base64") return { type: "image", media_type: p.source.media_type, data: p.source.data };
  if (p.type === "image" && typeof p.data === "string") return p;
  const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
  const [, media_type, data] = (typeof url === "string" && url.match(/^data:([^;,]+);base64,(.*)$/)) || [];
  if (media_type && data) return { type: "image", media_type, data };
  return unavailable(p.file_id ? `image file ${p.file_id}` : p.source?.url || url ? `image at ${p.source?.url ?? url}` : "image");
}

// Text and images of a tool result in any of the shapes harnesses write.
export function resultText(c: any): string | any[] {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const out: any[] = [];
    for (const p of c) {
      if (typeof p === "string") out.push({ type: "text", text: p });
      else if (p?.type === "text" || p?.type === "input_text" || p?.type === "output_text") out.push({ type: "text", text: p.text ?? "" });
      else if (p?.type === "image" || p?.type === "input_image") out.push(imageOf(p));
      else if (p?.type === "input_audio") out.push(unavailable(p.file_id ? `audio file ${p.file_id}` : "audio"));
      else if (p?.type === "input_file") out.push(unavailable(`file ${p.filename ?? p.file_id ?? ""}`.trim()));
      else if (p?.type === "encrypted_content") out.push(unavailable("encrypted content"));
      else if (p?.type) out.push(unavailable(`${p.type} content`));
    }
    return out.length === 1 && out[0].type === "text" ? out[0].text : out;
  }
  return c == null ? "" : JSON.stringify(c);
}
