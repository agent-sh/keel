// Clearing at a cold point. When a session's cache has lapsed, the next request
// writes the whole context again at the cache-write price, and every request
// after it reads the context at the read price. Old tool results are most of
// that context, and the model rarely needs one of them again: a result that is
// still there costs its write once and a read at every step until the context
// is compacted. So at a cold point, and only then (on a warm cache it would
// change the prefix and pay a rewrite of its own), the old results are sent as
// a stub that says what the call was, how large its result was and where the
// full text is, and the thinking of earlier turns is left out (Anthropic: the
// oldest run of thinking may go, and a block left out stays out,
// src/providers/wires/binding.ts). Claude Code does the same after a gap past
// the cache lifetime and counts it as an expected rebuild
// (code.claude.com/docs/en/costs); Anthropic documents the edit as context
// editing (platform.claude.com, context-editing).
//
// The decision is stored as a note of the session (`kind: "cleared"`) at the
// moment it is made. `toMessages` reads the notes of the branch: the results a
// note names are stubs and the thinking before the turn it names is left out,
// in every request after it, from the same stored bytes. Nothing is rewritten,
// a branch from before the note has the whole results again, and a request on
// a warm cache never sees a change.
import type { StoredEvent, ToolResultBlock } from "../core/types.ts";

// A result shorter than this stays: the stub is about 250 characters, and a
// small result is often what the model acts on.
export const CLEAR_MIN = 1_500;
// The newest results always stay: the steps the model is in the middle of.
export const KEEP_NEWEST = 10;
// Clearing is not worth a note for less than this many characters carried
// (results and thinking together).
export const CLEAR_GAIN = 12_000;

export type Cleared = {
  kind: "cleared";
  text: string;
  ids: string[];        // the tool_use ids whose results are stubs
  dir: string;          // where the full text of a result without a file of its own is kept: <dir>/cleared/<id>.txt
  thinking?: number;    // thinking of replies before this event seq is left out
  chars: number;        // characters the stubs take out
  thinking_chars?: number;
};

const NOTE = "cleared";
export const isCleared = (e: StoredEvent): boolean => e.kind === "note" && e.data?.kind === NOTE && Array.isArray(e.data.ids);

// What the notes of the lineage (from `from`) say: the stubs' ids with the folder
// of each note, and the seq before which thinking is left out.
export type Clearing = { ids: Map<string, string>; thinking: number };
export function clearingOf(events: readonly StoredEvent[], from = 0): Clearing | undefined {
  let out: Clearing | undefined;
  for (let i = from; i < events.length; i++) {
    const e = events[i]!;
    if (!isCleared(e)) continue;
    out ??= { ids: new Map(), thinking: -1 };
    for (const id of e.data.ids) if (typeof id === "string") out.ids.set(id, String(e.data.dir ?? ""));
    if (typeof e.data.thinking === "number") out.thinking = Math.max(out.thinking, e.data.thinking);
  }
  return out;
}

type Content = ToolResultBlock["content"];

// The text of a result that holds text blocks alone (an image or a tool
// reference keeps its result whole: a reference is how a loaded tool is named).
export function textOnly(c: Content): string | undefined {
  if (typeof c === "string") return c;
  let s = "";
  for (const b of c) {
    if (b.type !== "text") return undefined;
    s += (s ? "\n" : "") + b.text;
  }
  return s;
}

// The file a cut result already names (spill, the shell tool).
const SAVED = /chars cut; full output \(\d+ lines\) saved to (\S+) \.\.\.\]|Full output saved to: (\S+)/;
export const savedAt = (text: string): string | undefined => { const m = SAVED.exec(text); return m?.[1] ?? m?.[2]; };

const FIELDS = ["command", "cmd", "file_path", "path", "pattern", "url", "query", "name", "description"];
const brief = (s: string) => { const one = s.replace(/\s+/g, " ").trim(); return one.length > 100 ? `${one.slice(0, 100)}...` : one; };
// What the call was, in words: its tool and the first of its inputs that names a target.
export function callWords(name: string, input: unknown): string {
  const o = input && typeof input === "object" ? input as Record<string, unknown> : {};
  for (const f of FIELDS) if (typeof o[f] === "string" && o[f]) return `${name} ${brief(o[f] as string)}`;
  const j = JSON.stringify(input ?? {});
  return j === "{}" ? name : `${name} ${brief(j)}`;
}

export const clearedFile = (dir: string, id: string) => `${dir}/cleared/${id.replace(/[^\w.-]/g, "_")}.txt`;

// The stub that stands for a result. The same words from the same stored
// result, call and note, on every request.
export function stubOf(b: ToolResultBlock, call: { name: string; input: unknown } | undefined, dir: string): ToolResultBlock {
  const text = textOnly(b.content);
  if (text === undefined) return b;
  const path = savedAt(text) ?? clearedFile(dir, b.tool_use_id);
  const what = call ? callWords(call.name, call.input) : "a call";
  const stub = `[Cleared to keep the context short (the cache had lapsed): the result of ${what}, ${text.length.toLocaleString("en-US")} characters. Its full text is in ${path}: Read it there, or make the call again.]`;
  return { ...b, content: typeof b.content === "string" ? stub : [{ type: "text", text: stub }] };
}

// Which results and thinking a cold point clears, from the branch as it is.
// `thinking`: the wire takes the oldest run of thinking out (Anthropic's).
// `asks`: a tool whose result is the owner's own words.
// A result after the last prompt is never cleared, and on the Anthropic wire (`thinking`) none is when the turn
// the last prompt opened already holds thinking: a stub changes the prefix every later thinking block is bound
// to, and the wire would take out that turn's own thinking along with the old.
export type Pick = { ids: string[]; chars: number; thinking?: number; thinking_chars: number; files: { id: string; text: string }[] };
export function pickCleared(events: readonly StoredEvent[], from: number, opts: { thinking: boolean; asks: (tool: string) => boolean; keep?: number }): Pick | undefined {
  const done = clearingOf(events, from);
  type Row = { id: string; name: string; target: string | undefined; chars: number; text: string; ok: boolean };
  const calls = new Map<string, { name: string; input: unknown }>();
  const rows: Row[] = [];
  // Where each target was touched, by which tool, and after which result (its index in `rows`).
  const touches: { at: number; name: string; target: string }[] = [];
  let lastUser = -1, lastUserSeq = -1, rowsAtUser = 0, turnThinks = false;
  for (let i = from; i < events.length; i++) {
    const e = events[i]!;
    if (e.kind === "user") { lastUser = i; lastUserSeq = e.seq; rowsAtUser = rows.length; turnThinks = false; }
    else if (e.kind === "assistant") {
      for (const b of e.data.blocks ?? []) if ((b.type === "thinking" || b.type === "redacted_thinking") && b.bind !== "stale") turnThinks = true;
      for (const b of e.data.blocks ?? []) if (b.type === "tool_use") {
        calls.set(b.id, { name: b.name, input: b.input });
        const t = targetOf(b.input);
        if (t) touches.push({ at: rows.length, name: b.name, target: t });
      }
    } else if (e.kind === "tool_result") {
      for (const r of e.data.results ?? []) {
        const c = calls.get(r.tool_use_id);
        const text = textOnly(r.content);
        const ok = text !== undefined && !r.is_error && !!c && !opts.asks(c.name) && !done?.ids.has(r.tool_use_id) && text.length >= CLEAR_MIN;
        rows.push({ id: r.tool_use_id, name: c?.name ?? "", target: c ? targetOf(c.input) : undefined, chars: text?.length ?? 0, text: text ?? "", ok });
      }
    }
  }
  const keep = opts.keep ?? KEEP_NEWEST;
  const ids: string[] = [], files: Pick["files"] = [];
  let chars = 0;
  const upto = opts.thinking && turnThinks ? 0 : Math.min(rows.length - keep, rowsAtUser);
  for (let k = 0; k < upto; k++) {
    const r = rows[k]!;
    if (!r.ok) continue;
    // Referred to since: a later call of another tool names the same file or folder (an edit of what it read).
    if (r.target && touches.some((t) => t.at > k && t.target === r.target && t.name !== r.name)) continue;
    ids.push(r.id);
    chars += r.chars;
    if (!savedAt(r.text)) files.push({ id: r.id, text: r.text });
  }
  // Thinking of the turns before the one the last prompt opened (its own thinking goes back with its tool calls).
  let thinking: number | undefined, thinkChars = 0;
  if (opts.thinking && lastUser > from) {
    for (let i = from; i < lastUser; i++) {
      const e = events[i]!;
      if (e.kind !== "assistant" || e.seq <= (done?.thinking ?? -1)) continue;
      for (const b of e.data.blocks ?? []) if ((b.type === "thinking" || b.type === "redacted_thinking") && b.bind !== "stale") { thinkChars += (b.thinking ?? b.data ?? "").length; thinking = lastUserSeq; }
    }
  }
  if (chars + thinkChars < CLEAR_GAIN) return undefined;
  return { ids, chars, ...(thinking !== undefined ? { thinking } : {}), thinking_chars: thinkChars, files };
}

function targetOf(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  const p = o.file_path ?? o.path;
  return typeof p === "string" && p.length >= 4 ? p : undefined;
}

// The note's words for the owner.
export function clearedText(p: Pick): string {
  const n = p.ids.length;
  const bits = [
    n ? `${n} old tool ${n === 1 ? "result" : "results"} (${Math.round(p.chars / 1000).toLocaleString("en-US")} thousand characters) became one line each, with the file that holds the full text` : "",
    p.thinking !== undefined ? "the thinking of earlier turns was left out" : "",
  ].filter(Boolean);
  return `The prompt cache had lapsed, so the context was written again anyway. Before that, ${bits.join(" and ")}. Each later request reads less.`;
}
