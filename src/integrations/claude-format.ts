// A keel-bun session as a Claude Code transcript (JSON lines, one record per
// content block as Claude Code writes them today, chained by parentUuid). Used
// for the transcript the memory tool reads and for export to Claude Code.
import type { Session, StoredEvent } from "../core/types.ts";

export type ClaudeRecord = Record<string, unknown>;

// A reply's measured usage in the Messages API's names (zero where none was measured:
// the format has no unknown).
const usageOf = (u: any) => ({
  input_tokens: u?.input ?? 0,
  output_tokens: u?.output ?? 0,
  cache_read_input_tokens: u?.cache_read ?? 0,
  cache_creation_input_tokens: u?.cache_write ?? 0,
});

// The version of what toClaudeRecords gives for an event. A file written in
// one version is not appended to in another (the memory tool's transcript,
// src/integrations/tacit.ts): bump it with any change of a record's shape.
export const RECORD_FORMAT = 1;

// `parent`: the uuid the first record hangs under, when these events go on
// from records already written (the memory tool's transcript grows by appending).
export function toClaudeRecords(s: Session, events: readonly StoredEvent[], sessionId: string = s.id, opts: { version?: string; parent?: string | null } = {}): ClaudeRecord[] {
  const out: ClaudeRecord[] = [];
  let parent: string | null = opts.parent ?? null;
  const base = (ts: number) => ({
    parentUuid: parent,
    isSidechain: false,
    userType: "external",
    cwd: s.workspace,
    sessionId,
    version: opts.version ?? "2.1.0",
    timestamp: new Date(ts).toISOString(),
  });
  const push = (r: ClaudeRecord) => {
    out.push(r);
    parent = r.uuid as string;
  };
  for (const e of events) {
    if (e.kind === "user") {
      // Images in the Messages API's shape, as Claude Code writes them.
      const images = (e.data.images ?? []).filter((b: any) => b.type === "image").map((b: any) => (b.source ? b : { type: "image", source: { type: "base64", media_type: b.media_type, data: b.data } }));
      const content = [...images, ...(e.data.text ? [{ type: "text", text: e.data.text }] : [])];
      push({ ...base(e.ts), type: "user", message: { role: "user", content: content.length === 1 && !images.length ? e.data.text : content }, uuid: crypto.randomUUID() });
    } else if (e.kind === "note" && e.data.model) {
      push({ ...base(e.ts), type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text: e.data.text }] }, uuid: crypto.randomUUID() });
    } else if (e.kind === "assistant") {
      const id = `msg_keel_${e.id}`;
      for (const b of e.data.blocks ?? []) {
        push({
          ...base(e.ts),
          type: "assistant",
          message: { id, type: "message", role: "assistant", model: String(e.data.model ?? s.model).replace(/^[\w-]+:/, ""), content: [b], stop_reason: e.data.stop ?? null, stop_sequence: null, usage: usageOf(e.data.usage) },
          uuid: crypto.randomUUID(),
        });
      }
    } else if (e.kind === "compaction" && e.data.summary) {
      // Claude Code's shape: a boundary, then the summary as the chain's first message.
      parent = null;
      push({ ...base(e.ts), type: "system", subtype: "compact_boundary", content: "Conversation compacted", level: "info", uuid: crypto.randomUUID() });
      push({ ...base(e.ts), type: "user", isCompactSummary: true, message: { role: "user", content: e.data.summary }, uuid: crypto.randomUUID() });
    } else if (e.kind === "turn_end" && e.data.reason === "interrupted") {
      // Claude Code's own marker of a reply the owner stopped.
      push({ ...base(e.ts), type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }, uuid: crypto.randomUUID() });
    } else if (e.kind === "tool_result") {
      for (const r of e.data.results ?? []) {
        // Images in Claude's own shape (a base64 source), the bytes kept.
        const content = Array.isArray(r.content) ? r.content.map((c: any) => (c.type === "image" && !c.source ? { type: "image", source: { type: "base64", media_type: c.media_type, data: c.data } } : c)) : r.content;
        push({ ...base(e.ts), type: "user", message: { role: "user", content: [{ ...r, content }] }, uuid: crypto.randomUUID() });
      }
    }
  }
  return out;
}

export const toJsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
