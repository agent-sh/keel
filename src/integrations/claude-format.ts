// A keel-bun session as a Claude Code transcript (JSON lines, one record per
// content block as Claude Code writes them today, chained by parentUuid). Used
// for the transcript the memory tool reads and for export to Claude Code.
import type { Session, StoredEvent } from "../core/types.ts";

export type ClaudeRecord = Record<string, unknown>;

export function toClaudeRecords(s: Session, events: StoredEvent[], sessionId: string = s.id, opts: { version?: string } = {}): ClaudeRecord[] {
  const out: ClaudeRecord[] = [];
  let parent: string | null = null;
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
      const content = [...(e.data.images ?? []), { type: "text", text: e.data.text }];
      push({ ...base(e.ts), type: "user", message: { role: "user", content: content.length === 1 ? e.data.text : content }, uuid: crypto.randomUUID() });
    } else if (e.kind === "note" && e.data.model) {
      push({ ...base(e.ts), type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text: e.data.text }] }, uuid: crypto.randomUUID() });
    } else if (e.kind === "assistant") {
      const id = `msg_keel_${e.id}`;
      for (const b of e.data.blocks ?? []) {
        push({
          ...base(e.ts),
          type: "assistant",
          message: { id, type: "message", role: "assistant", model: String(e.data.model ?? s.model).replace(/^[\w-]+:/, ""), content: [b], stop_reason: e.data.stop ?? null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
          uuid: crypto.randomUUID(),
        });
      }
    } else if (e.kind === "tool_result") {
      for (const r of e.data.results ?? []) {
        push({ ...base(e.ts), type: "user", message: { role: "user", content: [r] }, uuid: crypto.randomUUID() });
      }
    }
  }
  return out;
}

export const toJsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
