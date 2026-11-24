// Where an approval card's call stands among the calls of its model reply, and
// which later calls of that reply have not run yet. The calls of one reply are
// judged side by side: a card for the first one can be open while the others are
// still being checked, run on their own, or sit behind "Later". The card says
// "1 of 4" and names those, so an Allow on call 1 is never given blind to what
// stands behind it. Pure: the page's events and cards in, words out. Only calls
// of the reply that exist are named; a call the model has not made yet does not.
import { commandOf } from "../../../src/core/command.ts";
import { toolKind, toolLine } from "../../../src/core/tool-line.ts";
import type { StoredEvent } from "../../../src/core/types.ts";
import type { Approval } from "../../../src/safety/gate.ts";

export type Later = { id: string; tool: string; line: string; asks: boolean; high: boolean };
export type Place = { at: number; of: number; later: Later[] };

const ONE_LINE = 120;

// One line of what a call does: a command as written (its first line), anything else as the transcript says it.
export function lineOf(name: string, input: any, cwd?: string): string {
  const body = input && typeof input === "object" ? input : {};
  const text = toolKind(name) === "shell" ? (commandOf(body) ?? "").split("\n").find((l) => l.trim())?.trim() ?? "" : toolLine(name, body, cwd);
  const line = text || toolLine(name, body, cwd);
  return line.length > ONE_LINE ? `${line.slice(0, ONE_LINE).trimEnd()}…` : line;
}

// `events`: the session's events as the page holds them. `open`: every pending card of the session, those put away included.
// Null when the card has no place in a reply (an older card, a call no reply made), the reply is not in the page's
// events, or the reply made one call.
export function placeOf(events: readonly StoredEvent[] | undefined, a: Approval, open: readonly Approval[], cwd?: string): Place | null {
  if (!a.reply || !events?.length) return null;
  let from = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.seq === a.reply.seq && e.kind === "assistant") { from = i; break; }
    if (e.seq < a.reply.seq) break;
  }
  if (from < 0) return null;
  const reply = events[from]!;
  const blocks: any[] = Array.isArray(reply.data?.blocks) ? reply.data.blocks : [];
  const uses = blocks.filter((b) => b?.type === "tool_use");
  // The last call of a reply that hit the output limit may be cut: it is never run, so it is not one of the calls.
  const calls = reply.data?.stop === "max_tokens" && uses.length ? uses.slice(0, -1) : uses;
  const at = calls.findIndex((u) => u.id === a.call_id);
  if (at < 0 || calls.length < 2) return null;
  const done = new Set<string>();
  for (let i = from + 1; i < events.length; i++) {
    const e = events[i]!;
    if (e.kind === "tool_result") for (const r of e.data?.results ?? []) done.add(r.tool_use_id);
  }
  const later: Later[] = [];
  for (const u of calls.slice(at + 1)) {
    if (done.has(u.id)) continue;
    const card = open.find((x) => x.call_id === u.id && x.state === "pending");
    later.push({ id: u.id, tool: String(u.name), line: lineOf(String(u.name), u.input, cwd), asks: !!card, high: card?.risk === "high" });
  }
  return { at: at + 1, of: calls.length, later };
}
