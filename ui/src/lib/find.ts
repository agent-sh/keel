// The page's own Find in a conversation (components/FindBar.tsx). The browser's
// Find reaches only what is drawn; this one reaches every place the
// conversation holds the text: a folded step, a closed call's input and
// output, rows not drawn yet, and the part of the history the page has not
// read, which the daemon finds in its search index (GET
// /api/sessions/:id/find, src/server/routes/find-read.ts).
//
// A place is a unit of the transcript: a prompt, a reply's prose (with what
// it said between calls), or a call (its input and its output, which its card
// shows). The text of each is the one the index keeps of it, so a place the
// daemon counts and the same place once read count alike. Kept pure: events
// and the daemon's answer go in, the places and their order come out.
import type { StoredEvent } from "../../../src/core/types.ts";

// Case and accents fold the way the daemon's index folds them (é = e = É).
export const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();

// A text folded, with where each folded character came from in the text, so a
// match in the folded text is a range of the text (a ligature or a letter with
// its accent folds to more or fewer characters).
export function foldMap(s: string): { text: string; at: number[] } {
  let text = "";
  const at: number[] = [];
  let i = 0;
  for (const ch of s) {
    const f = fold(ch);
    text += f;
    for (let k = 0; k < f.length; k++) at.push(i);
    i += ch.length;
  }
  at.push(i);
  return { text, at };
}

// Where the needle (folded) stands in a text: ranges of the text, one after the other.
export function rangesOf(s: string, needle: string): [number, number][] {
  if (!needle) return [];
  const out: [number, number][] = [];
  // (Plain ASCII folds to itself, letter for letter: no map to make.)
  if (/^[\x00-\x7f]*$/.test(s)) {
    const t = s.toLowerCase();
    for (let k = t.indexOf(needle); k >= 0; k = t.indexOf(needle, k + needle.length)) out.push([k, k + needle.length]);
    return out;
  }
  const m = foldMap(s);
  for (let k = m.text.indexOf(needle); k >= 0; k = m.text.indexOf(needle, k + needle.length)) out.push([m.at[k]!, m.at[k + needle.length]!]);
  return out;
}

export function count(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) n++;
  return n;
}

// A unit of the transcript Find lands on. `key`: the same for the place the
// daemon names and the place once read (a call by its id, else the event).
export type Unit = { key: string; ev: string; call?: string; seq: number; text: string };

const strings = (v: unknown, out: string[]) => {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
};
const resultText = (c: unknown) =>
  typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join("\n") : "";

// The units of a branch's events, in its order. A call's output joins its call
// (the card shows both); an output whose call is not held is a unit of its own.
export function unitsOf(events: readonly StoredEvent[]): Unit[] {
  const out: Unit[] = [];
  const calls = new Map<string, Unit>();
  for (const e of events) {
    const d = e.data ?? {};
    if (e.kind === "user") {
      const text = d.text === "(image)" || d.text === "(attached file)" ? "" : String(d.text ?? "");
      const files = (d.images ?? []).filter((b: any) => b?.type === "attachment").map((b: any) => String(b.name ?? ""));
      const all = [text, ...files].filter(Boolean).join(" ");
      if (all) out.push({ key: e.id, ev: e.id, seq: e.seq, text: all });
    } else if (e.kind === "assistant") {
      if (d.stop === "refusal") continue;
      const blocks: any[] = d.blocks ?? [];
      const prose = blocks.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join("\n");
      if (prose) out.push({ key: e.id, ev: e.id, seq: e.seq, text: prose });
      for (const b of blocks) {
        if (b?.type !== "tool_use" || !b.id) continue;
        const u: Unit = { key: `call:${b.id}`, ev: e.id, call: b.id, seq: e.seq, text: strings(b.input, []).join(" ") };
        calls.set(b.id, u);
        out.push(u);
      }
    } else if (e.kind === "tool_result") {
      for (const r of d.results ?? []) {
        const text = resultText(r?.content);
        if (!text) continue;
        const u = calls.get(r.tool_use_id);
        if (u) u.text = u.text ? `${u.text}\n${text}` : text;
        else out.push({ key: `call:${r.tool_use_id}`, ev: e.id, call: r.tool_use_id, seq: e.seq, text });
      }
    }
  }
  return out;
}

// A place Find stops at: the unit, which of its matches, and whether the page holds it.
export type Place = { key: string; ev: string; call?: string; seq: number; k: number; held: boolean };
// What the daemon found outside the part the page holds.
export type Outside = { event: string; seq: number; call?: string; count: number };

// Every match, in the branch's order: the daemon's places before the part held,
// the part's own, the daemon's after it. A unit both name (the part grew
// meanwhile) is the page's. `first`: the seq of the first event the page holds.
export function placesOf(units: readonly Unit[], outside: readonly Outside[], needle: string, first: number): Place[] {
  const held: Place[] = [];
  const keys = new Set<string>();
  for (const u of units) {
    const n = count(fold(u.text), needle);
    if (!n) continue;
    keys.add(u.key);
    for (let k = 0; k < n; k++) held.push({ key: u.key, ev: u.ev, call: u.call, seq: u.seq, k, held: true });
  }
  const before: Place[] = [], after: Place[] = [];
  // (A call's output adds to the count of the call the daemon named before it.)
  const outs = new Map<string, number>();
  const order: Outside[] = [];
  for (const o of outside) {
    const key = o.call ? `call:${o.call}` : o.event;
    if (keys.has(key)) continue;
    if (outs.has(key)) { outs.set(key, outs.get(key)! + o.count); continue; }
    outs.set(key, o.count);
    order.push(o);
  }
  for (const o of order) {
    const key = o.call ? `call:${o.call}` : o.event;
    const list = o.seq < first ? before : after;
    for (let k = 0; k < outs.get(key)!; k++) list.push({ key, ev: o.event, call: o.call, seq: o.seq, k, held: false });
  }
  return [...before, ...held, ...after];
}

// Where the place that was current stands in a new list (the part grew, the
// text arrived): the same unit and match, else the nearest of the same unit.
export function placeAgain(list: readonly Place[], was: Place | null): number {
  if (!was || !list.length) return list.length ? 0 : -1;
  let best = -1;
  for (let i = 0; i < list.length; i++) {
    const p = list[i]!;
    if (p.key !== was.key) continue;
    if (p.k === was.k) return i;
    if (best < 0 || Math.abs(p.k - was.k) < Math.abs(list[best]!.k - was.k)) best = i;
  }
  return best >= 0 ? best : 0;
}

// What the bar says of the matches: "3 of 12", "No matches", "12+" when the daemon stopped reading.
export function tally(at: number, total: number, more: boolean): string {
  if (!total) return "No matches";
  return `${at + 1} of ${total}${more ? "+" : ""}`;
}

// Whether the find key is the page's: the platform's key (Cmd+F on a Mac,
// Ctrl+F elsewhere), pressed in the conversation's pane or in no field of
// another place. A terminal and an editor keep their own Ctrl+F, and on a Mac
// Ctrl+F stays the text fields' (it moves the caret).
export function findKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }, mac: boolean): boolean {
  if (e.key.toLowerCase() !== "f" || e.altKey || e.shiftKey) return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}
