// A request the provider refused as too large in bytes, with no image left to drop: the long tool results
// of the history are sent shortened, oldest first. The stored events are never touched; this is a projection
// of what is sent, and the ids of the results it shortened are kept with the session (`results_short`), so
// every later request carries the same bytes and the provider's cache prefix does not move again.
import type { Message, TextBlock, ToolResultBlock } from "../core/types.ts";

// A result shorter than this is not worth shortening: the saving would not move the request.
export const SHORT_MIN = 4_000;
// What a shortened result keeps: its start and its end (where a command's exit and errors are).
const HEAD = 1_200;
const TAIL = 600;

const textOf = (c: ToolResultBlock["content"]): number =>
  typeof c === "string" ? c.length : c.reduce((n, b) => n + (b.type === "text" ? b.text.length : 0), 0);

const cut = (s: string): string => {
  if (s.length <= HEAD + TAIL + 200) return s;
  return `${s.slice(0, HEAD)}\n[Output shortened: ${s.length - HEAD - TAIL} characters left out of the middle because the provider refused a request as too large.]\n${s.slice(-TAIL)}`;
};

// What shortening one result would save, in characters.
const saving = (n: number) => Math.max(0, n - (HEAD + TAIL + 160));

// The results of `messages`, oldest first, that could be shortened and are not yet: id and what shortening saves.
function candidates(messages: Message[], done: ReadonlySet<string>): { id: string; save: number }[] {
  const out: { id: string; save: number }[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const b of m.content) {
      if (b.type !== "tool_result" || done.has(b.tool_use_id)) continue;
      const n = textOf(b.content);
      if (n >= SHORT_MIN) out.push({ id: b.tool_use_id, save: saving(n) });
    }
  }
  return out;
}

// The results to shorten after a refusal as too large: the oldest, until what they save is half of what
// all the long ones could (at least one), so the newest keep their words and a second refusal finds more.
// Empty when no long result is left.
export function oldestResultsForSize(messages: Message[], done: ReadonlySet<string>): string[] {
  const all = candidates(messages, done);
  const half = all.reduce((a, c) => a + c.save, 0) / 2;
  const pick: string[] = [];
  let saved = 0;
  for (const c of all) {
    if (pick.length && saved >= half) break;
    pick.push(c.id);
    saved += c.save;
  }
  return pick;
}

// `messages` with the results in `ids` shortened to their start and end.
export function shortenResults(messages: Message[], ids: ReadonlySet<string>): Message[] {
  if (!ids.size) return messages;
  const one = (b: ToolResultBlock): ToolResultBlock => {
    if (!ids.has(b.tool_use_id)) return b;
    if (typeof b.content === "string") return { ...b, content: cut(b.content) };
    return { ...b, content: b.content.map((c) => (c.type === "text" ? ({ ...c, text: cut(c.text) } satisfies TextBlock) : c)) };
  };
  return messages.map((m) => (m.role !== "user" || !m.content.some((b) => b.type === "tool_result" && ids.has(b.tool_use_id)) ? m : { ...m, content: m.content.map((b) => (b.type === "tool_result" ? one(b) : b)) }));
}
