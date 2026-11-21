// The transcript's rows, made from the events of the branch shown. Each step
// takes the previous result: an event appended to the branch makes rows for
// itself only, and a row whose content did not change stays the same object,
// so the page renders it once (Transcript.tsx keeps rows in memo components).
// Pure: the same inputs give the same rows.
import { lineage } from "../../../src/core/tree.ts";
import type { StoredEvent, ToolResultBlock } from "../../../src/core/types.ts";

export type RowKind = "harness" | "input" | "user" | "checkpoint" | "refusal" | "assistant" | "error" | "fork" | "peer_refused" | "images" | "model" | "note" | "end";
export type Row = {
  id: string; // the event's id
  kind: RowKind;
  e: StoredEvent;
  vs?: StoredEvent[]; // user: the versions of the prompt
  undoable?: boolean; // checkpoint: a clear nothing the model reads came after
  handled?: boolean; // refusal: the fallback model took the request
  results?: (ToolResultBlock | undefined)[]; // assistant: the result of each block that is a tool call
  reply?: string[]; // end: the texts of the turn's replies, for Copy
  prompt?: StoredEvent; // end: the prompt that started the turn
  notes?: StoredEvent[]; // end: harness notes of the turn, shown on its footer
  failures?: StoredEvent[]; // end: what failed in the turn, shown above its footer
  times?: number; // end: the restarts in a row this footer stands for
  folded?: boolean; // end: a restart that the next restart's footer stands for
  after?: string; // error: the event before it
};

// Rows in order, in blocks of the events' seq (BLOCK to a block): a block's
// place does not depend on where the loaded history starts or ends, so
// loading older events or appending new ones leaves the other blocks as they are.
const BLOCK_BITS = 5;
export const blockKey = (rows: Row[]) => rows[0]!.e.seq >> BLOCK_BITS;

export type Built = {
  events: StoredEvent[];
  siblings: Siblings;
  previewing: boolean;
  blocks: Row[][];
  at: Map<string, number>; // the block of each row, by event id
  pending: StoredEvent[]; // notes after the last turn's end
  // Where the fold stands after the last event.
  prompt?: StoredEvent;
  reply: string[];
  uses: Map<string, string>; // tool call id -> the event id of its row
  checkpoint: string | null; // the last checkpoint row while it may still be undone
  refusal: string | null; // the refusal the previous event was
  failed: string | null; // the footer of a failed turn while its failures follow it
  // The footer of a restart while nothing was said since: the next restart's footer stands for it too.
  restart: { id: string; times: number; notes: StoredEvent[] } | null;
};

// Counters for the e2e: a row model made, a row rendered. Development builds
// only: the production bundle has neither the counters nor their calls.
export const PROBE = process.env.NODE_ENV !== "production";
export const rowProbe: { made?: (id: string) => void; rendered?: (id: string) => void } = {};
if (PROBE) (globalThis as any).__keelRows = rowProbe;

const EMPTY: StoredEvent[] = [];
const sameList = <T>(a: T[] | undefined, b: T[] | undefined) => a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]));
const sameRow = (a: Row, b: Row) =>
  a.kind === b.kind && a.e === b.e && a.undoable === b.undoable && a.handled === b.handled && a.prompt === b.prompt &&
  a.times === b.times && a.folded === b.folded && a.after === b.after &&
  sameList(a.vs, b.vs) && sameList(a.results, b.results) && sameList(a.reply, b.reply) && sameList(a.notes, b.notes) && sameList(a.failures, b.failures);

// `input`: what an owner-side message is shown as when it is not a prompt
// (a notice of the harness, a message from another session).
export function buildRows(prev: Built | undefined, events: StoredEvent[], siblings: Siblings, previewing: boolean, input: (e: StoredEvent) => boolean): Built {
  if (prev && prev.events === events && prev.siblings === siblings && prev.previewing === previewing) return prev;
  let common = 0;
  if (prev && prev.previewing === previewing) {
    const n = Math.min(prev.events.length, events.length);
    while (common < n && prev.events[common] === events[common]) common++;
  }
  // The branch grew at its end and nothing else moved: only the new events are read.
  const append = !!prev && common === prev.events.length && (events.length > common || prev.siblings === siblings);
  const b: Built = append
    ? { ...prev!, events, siblings, blocks: prev!.blocks.slice(), reply: prev!.reply.slice(), pending: prev!.pending.slice() }
    : { events, siblings, previewing, blocks: [], at: new Map(), pending: [], reply: [], uses: new Map(), checkpoint: null, refusal: null, failed: null, restart: null };
  const owned = new Set<number>(); // blocks this build made or copied
  const own = (j: number) => {
    if (!owned.has(j)) { b.blocks[j] = (b.blocks[j] ?? []).slice(); owned.add(j); }
    return b.blocks[j]!;
  };
  const push = (row: Row) => {
    if (PROBE) rowProbe.made?.(row.id);
    const last = b.blocks.length - 1;
    const j = last >= 0 && blockKey(b.blocks[last]!) === row.e.seq >> BLOCK_BITS ? last : last + 1;
    own(j).push(row);
    b.at.set(row.id, j);
  };
  const patch = (id: string | null, change: (r: Row) => Partial<Row> | null) => {
    const j = id === null ? undefined : b.at.get(id);
    if (j === undefined) return;
    const k = b.blocks[j]!.findIndex((r) => r.id === id);
    const fields = k < 0 ? null : change(b.blocks[j]![k]!);
    if (fields) own(j)[k] = { ...b.blocks[j]![k]!, ...fields };
  };

  for (let i = append ? common : 0; i < events.length; i++) {
    const e = events[i]!;
    if (b.refusal) {
      if (e.kind === "note" && e.data.kind === "fallback") patch(b.refusal, () => ({ handled: true }));
      b.refusal = null;
    }
    // A clear is undone while nothing the model reads came after it (a note of the page may have).
    if (b.checkpoint && !(e.kind === "note" && !e.data.model)) {
      patch(b.checkpoint, (r) => (r.undoable ? { undoable: false } : null));
      b.checkpoint = null;
    }
    // The failures of a turn follow its end in the record; anything else ends the run.
    if (e.kind !== "error") b.failed = null;
    // Restarts in a row with nothing said between (a card that waits through them) are one footer.
    if (b.restart && !(e.kind === "turn_end" || e.kind === "turn_start" || e.kind === "tool_result" || (e.kind === "user" && e.data.origin === "restart"))) b.restart = null;
    const row = (kind: RowKind, more?: Partial<Row>) => push({ id: e.id, kind, e, ...more });
    if (e.kind === "user") {
      // Folded into the turn's notes (the footer); the cut itself shows on the footer.
      if (e.data.origin === "restart") b.pending.push(e);
      else if (e.data.origin === "harness") row("harness");
      else {
        b.prompt = e;
        b.reply = [];
        if (input(e)) row("input");
        else row("user", { vs: siblings.get(e.parent) ?? EMPTY });
      }
    } else if (e.kind === "compaction") {
      // Only a clear is undone; a summary's row has nothing that waits on what follows.
      const undoable = !previewing && e.data.mode === "clear";
      row("checkpoint", { undoable });
      if (undoable) b.checkpoint = e.id;
    } else if (e.kind === "assistant" && e.data.stop === "refusal") {
      row("refusal", { handled: false });
      b.refusal = e.id;
    } else if (e.kind === "assistant") {
      for (const x of e.data.blocks) {
        if (x.type === "text" && x.text.trim()) b.reply.push(x.text);
        if (x.type === "tool_use") b.uses.set(x.id, e.id);
      }
      row("assistant", { results: e.data.blocks.map(() => undefined) });
    } else if (e.kind === "tool_result") {
      for (const r of e.data.results as ToolResultBlock[]) {
        // A call's `shown` (the owner's answers to a question) rides with its result, for the card only.
        const shown = e.data.shown?.[r.tool_use_id];
        const result = shown ? ({ ...r, shown } as ToolResultBlock) : r;
        patch(b.uses.get(r.tool_use_id) ?? null, (at) => {
          const k = (at.e.data.blocks as any[]).findIndex((x) => x.type === "tool_use" && x.id === r.tool_use_id);
          if (k < 0) return null;
          const results = at.results!.slice();
          results[k] = result;
          return { results };
        });
      }
    } else if (e.kind === "error") {
      // The failure of a turn is shown where the turn ended, above its footer.
      const end = b.failed;
      if (end) patch(end, (r) => ({ failures: [...(r.failures ?? []), e] }));
      else row("error", { after: events[i - 1]?.id });
    }
    else if (e.kind === "note") {
      // Memory and hook notes fold into the turn's notes on its footer: quiet at six stations.
      if (e.data.hook || e.data.memory) b.pending.push(e);
      else if (e.data.kind === "summary") row("checkpoint", { undoable: false });
      else if (e.data.kind === "fork") row("fork");
      else if (e.data.kind === "peer_refused") row("peer_refused");
      else if (e.data.kind === "images") row("images");
      // What the new model is told after a switch: the switch note above already says it.
      else if (e.data.kind === "model_told") continue;
      else if (e.data.kind === "model") row("model");
      else row("note");
    } else if (e.kind === "turn_end") {
      // A restart right after a restart: the footer before is folded into this one, with its notes.
      const before = e.data.reason === "restart" ? b.restart : null;
      if (before) patch(before.id, (r) => (r.folded ? null : { folded: true }));
      const notes = before ? [...before.notes, ...b.pending] : b.pending;
      const times = (before?.times ?? 0) + 1;
      row("end", { reply: b.reply.slice(), prompt: b.prompt, notes, ...(times > 1 ? { times } : {}) });
      b.pending = [];
      b.restart = e.data.reason === "restart" ? { id: e.id, times, notes } : null;
      if (e.data.reason === "error") b.failed = e.id;
    }
  }

  // Read from the start (another branch, older events loaded): a row that came
  // out as it was before is the object it was, and so is a block of such rows.
  if (!append && prev) {
    for (let j = 0; j < b.blocks.length; j++) {
      const rows = b.blocks[j]!;
      let was: Row[] | undefined;
      for (let k = 0; k < rows.length; k++) {
        const pj = prev.at.get(rows[k]!.id);
        const old = pj === undefined ? undefined : prev.blocks[pj]!.find((r) => r.id === rows[k]!.id);
        if (old && sameRow(old, rows[k]!)) { rows[k] = old; was ??= prev.blocks[pj!]; }
      }
      if (was && sameList(was, rows)) b.blocks[j] = was;
    }
  }
  return b;
}

// The versions of each prompt (see versions() in tree.ts), by parent. Events
// added to the list change only the parents they name.
export type Siblings = Map<string | null, StoredEvent[]>;
export type SiblingsOf = { all: StoredEvent[]; map: Siblings };
export function nextSiblings(prev: SiblingsOf | undefined, all: StoredEvent[]): SiblingsOf {
  const grew = !!prev && prev.all.length > 0 && all.length >= prev.all.length && all[0] === prev.all[0] && all[prev.all.length - 1] === prev.all[prev.all.length - 1];
  let map: Siblings = grew ? prev!.map : new Map();
  let copied = !grew;
  for (let i = grew ? prev!.all.length : 0; i < all.length; i++) {
    const e = all[i]!;
    if (e.kind !== "user" || e.data.origin) continue;
    if (!copied) { map = new Map(map); copied = true; }
    map.set(e.parent, [...(map.get(e.parent) ?? []), e]);
  }
  return { all, map };
}

// lineage() of tree.ts, from the previous one: events appended under the
// branch's end are added to it, anything else is read again.
export type LineageOf = { all: StoredEvent[]; head: string | null; out: StoredEvent[] };
export function nextLineage(prev: LineageOf | undefined, all: StoredEvent[], head: string | null): LineageOf {
  const n = prev?.all.length ?? 0;
  if (prev && n > 0 && all.length >= n && all[0] === prev.all[0] && all[n - 1] === prev.all[n - 1]) {
    if (head === prev.head) return { all, head, out: prev.out };
    const fresh = new Map<string, StoredEvent>();
    for (let i = n; i < all.length; i++) fresh.set(all[i]!.id, all[i]!);
    const chain: StoredEvent[] = [];
    for (let e = head ? fresh.get(head) : undefined; e; e = e.parent ? fresh.get(e.parent) : undefined) {
      chain.push(e);
      if (e.parent === prev.head) return { all, head, out: [...prev.out, ...chain.reverse()] };
    }
  }
  const out = lineage(all, head);
  // The head may be named before its event is in the list (the session's frame
  // comes first): the branch shown stays until the event arrives, instead of
  // an empty transcript and every row made again a moment later.
  if (!out.length && head && prev?.out.length && prev.all[0] === all[0]) return { all, head: prev.head, out: prev.out };
  return { all, head, out };
}

// A list of a whole session a view keeps for itself (lib/whole.ts), with the
// events the page holds after its last one. What the page lets go of later
// stays in the list.
export function grown(list: StoredEvent[], held: StoredEvent[] | undefined): StoredEvent[] {
  const last = list.at(-1)?.seq ?? 0;
  if (!held?.length || held.at(-1)!.seq <= last) return list;
  let from = held.length;
  while (from > 0 && held[from - 1]!.seq > last) from--;
  return [...list, ...held.slice(from)];
}
