// The transcript's rows, made from the events of the branch shown. Each step
// takes the previous result: an event appended to the branch makes rows for
// itself only, and a row whose content did not change stays the same object,
// so the page renders it once (Transcript.tsx keeps rows in memo components).
// Pure: the same inputs give the same rows.
import { lineage } from "../../../src/core/tree.ts";
import type { StoredEvent, ToolResultBlock } from "../../../src/core/types.ts";
import { addCall, addMeta, byFamily, isAside, sameStep, setResult, type Step } from "./work.ts";

export type RowKind = "harness" | "input" | "user" | "checkpoint" | "refusal" | "assistant" | "work" | "error" | "fork" | "peer_refused" | "images" | "model" | "note" | "end";
export type Row = {
  // The event's id. A run of tool calls is `w:<id>` of the event that first began it on this page
  // (it keeps that name, and `e`, when older events of the run are read in above); a second stretch
  // of prose in one reply is `<id>:<block>`.
  id: string;
  kind: RowKind;
  e: StoredEvent;
  vs?: StoredEvent[]; // user: the versions of the prompt
  undoable?: boolean; // checkpoint: a clear nothing the model reads came after
  handled?: boolean; // refusal: the fallback model took the request
  prose?: number[]; // assistant: the blocks shown as the reply's own words (the rest are in the runs of work around it)
  steps?: Step[]; // work: the run's tool calls in steps (work.ts), with what was said and thought between them
  events?: string[]; // work: the events the run holds, in order
  reply?: string[]; // end: the texts of the turn's replies, for Copy
  partial?: boolean; // end: the turn began before the events shown (its reply above is not all here)
  prompt?: StoredEvent; // end: the prompt that started the turn
  notes?: StoredEvent[]; // end: harness notes of the turn, shown on its footer
  failures?: StoredEvent[]; // end: what failed in the turn, shown above its footer
  times?: number; // end: the restarts in a row this footer stands for
  folded?: boolean; // end: a restart that the next restart's footer stands for
  after?: string; // error: the event before it; refusal: the end of the turn it ended
};

// Rows in order, in blocks of the events' seq (BLOCK to a block): a block's
// place does not depend on where the loaded history starts or ends, so
// loading older events or appending new ones leaves the other blocks as they are.
// A block is also what the transcript draws or holds as one (lib/window.ts): eight events, a turn
// or two, so what is drawn near the view is about what the view shows.
export const BLOCK_BITS = 3;
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
  uses: Map<string, string>; // tool call id -> the id of its row
  work: string | null; // the run of tool calls the next call joins: the newest row, while it is one
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
  a.times === b.times && a.folded === b.folded && a.after === b.after && a.partial === b.partial &&
  sameList(a.vs, b.vs) && sameList(a.prose, b.prose) && sameSteps(a.steps, b.steps) && sameList(a.events, b.events) && sameList(a.reply, b.reply) && sameList(a.notes, b.notes) && sameList(a.failures, b.failures);
// Steps read again from the start are new objects with the same items: the row is the one it was.
const sameSteps = (a: Step[] | undefined, b: Step[] | undefined) => a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => sameStep(x, b[i]!)));

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
    : { events, siblings, previewing, blocks: [], at: new Map(), pending: [], reply: [], uses: new Map(), work: null, checkpoint: null, refusal: null, failed: null, restart: null };
  const owned = new Set<number>(); // blocks this build made or copied
  const own = (j: number) => {
    if (!owned.has(j)) { b.blocks[j] = (b.blocks[j] ?? []).slice(); owned.add(j); }
    return b.blocks[j]!;
  };
  const push = (row: Row) => {
    if (PROBE) rowProbe.made?.(row.e.id);
    const last = b.blocks.length - 1;
    const j = last >= 0 && blockKey(b.blocks[last]!) === row.e.seq >> BLOCK_BITS ? last : last + 1;
    own(j).push(row);
    b.at.set(row.id, j);
    // Anything but a run of calls ends the run before it.
    if (row.kind !== "work") b.work = null;
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
      // The turn's end that follows it says whether it is still the session's last (a fresh start is offered then).
      else if (e.kind === "turn_end") patch(b.refusal, () => ({ after: e.id }));
      if (e.kind !== "note" || e.data.kind === "fallback") b.refusal = null;
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
      const blocks = e.data.blocks as any[];
      for (const x of blocks) if (x.type === "text" && x.text.trim()) b.reply.push(x.text);
      if (!blocks.some((x) => x.type === "tool_use")) {
        // A reply that calls no tool is all on the page.
        row("assistant", { prose: blocks.map((_x, k) => k) });
      } else {
        // One that does keeps there only what it says at length; a line said in
        // passing, a thought and the calls go to the run of work. Each in the
        // order the reply has it: prose after a call stands after its run.
        let run: { id: string; steps: Step[]; events: string[] } | null = null;
        const open = (k: number) => {
          if (run) return run;
          const was = b.work === null ? undefined : b.blocks[b.at.get(b.work)!]!.find((r) => r.id === b.work);
          if (was) return (run = { id: was.id, steps: was.steps!, events: was.events!.at(-1) === e.id ? was.events! : [...was.events!, e.id] });
          // A second run of the same reply (calls, prose, calls) is named by the block it begins at.
          const id = b.at.has(`w:${e.id}`) ? `w:${e.id}:${k}` : `w:${e.id}`;
          push({ id, kind: "work", e, steps: [], events: [e.id] });
          b.work = id;
          return (run = { id, steps: [], events: [e.id] });
        };
        const close = () => {
          if (!run) return;
          const { id, steps, events: evs } = run;
          patch(id, () => ({ steps, events: evs }));
          if (!b.at.has(e.id)) b.at.set(e.id, b.at.get(id)!);
          run = null;
        };
        let calls: any[] = [];
        let at = 0; // the block the calls waiting to be added began at
        let prose: number[] = [];
        const said = () => {
          if (!prose.length) return;
          close();
          // The first row of the event is named by it; a later stretch of prose by its first block.
          push({ id: b.at.has(e.id) ? `${e.id}:${prose[0]}` : e.id, kind: "assistant", e, prose });
          prose = [];
        };
        const called = () => {
          if (!calls.length) return;
          const r = open(at);
          for (const u of byFamily(calls)) { r.steps = addCall(r.steps, u, e.id); b.uses.set(u.id, r.id); }
          calls = [];
        };
        blocks.forEach((x, k) => {
          if (x.type === "tool_use") { said(); if (!calls.length) at = k; calls.push(x); }
          else if (x.type === "text" && x.text.trim()) {
            if (!isAside(x.text)) { called(); prose.push(k); }
            else { said(); called(); const r = open(k); r.steps = addMeta(r.steps, { t: "note", id: `${e.id}:${k}`, text: x.text, event: e.id }); }
          } else if (x.type === "thinking" && x.thinking.trim()) { said(); called(); const r = open(k); r.steps = addMeta(r.steps, { t: "thought", id: `${e.id}:${k}`, text: x.thinking, event: e.id }); }
        });
        said();
        called();
        close();
      }
    } else if (e.kind === "tool_result") {
      for (const r of e.data.results as ToolResultBlock[]) {
        // A call's `shown` (the owner's answers to a question) rides with its result, for the card only.
        const shown = e.data.shown?.[r.tool_use_id];
        const result = shown ? ({ ...r, shown } as ToolResultBlock) : r;
        patch(b.uses.get(r.tool_use_id) ?? null, (at) => {
          const steps = at.steps && setResult(at.steps, r.tool_use_id, result);
          return steps ? { steps } : null;
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
      // A rewind is undone while nothing the model reads came after it.
      else if (e.data.kind === "rewound") {
        const undoable = !previewing;
        row("checkpoint", { undoable });
        if (undoable) b.checkpoint = e.id;
      }
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
      // No prompt since the first event shown, and events before it: the turn began in a part not held.
      const partial = !b.prompt && events[0]!.parent !== null;
      row("end", { reply: b.reply.slice(), prompt: b.prompt, notes, ...(times > 1 ? { times } : {}), ...(partial ? { partial } : {}) });
      b.pending = [];
      b.restart = e.data.reason === "restart" ? { id: e.id, times, notes } : null;
      if (e.data.reason === "error") b.failed = e.id;
    }
  }

  // Older events read in above a run of calls (a run longer than a part): the
  // run now begins earlier, and it is still the row it was. It keeps the name
  // and the place it had, so the page renders its new steps into the row the
  // reader is in, instead of taking that row away and making another.
  if (!append && prev) {
    let moved = false;
    for (let j = 0; j < b.blocks.length; j++) {
      const k = b.blocks[j]!.findIndex((r) => r.kind === "work" && !prev.at.has(r.id) && r.events!.some((id, n) => n > 0 && prev.at.has(`w:${id}`)));
      if (k < 0) continue;
      const row = b.blocks[j]![k]!;
      const name = row.events!.find((id, n) => n > 0 && prev.at.has(`w:${id}`))!;
      const e = events.find((x) => x.id === name);
      if (!e || b.at.has(`w:${name}`)) continue;
      // Its place is the block of the event that names it. Nothing was made between its first
      // event and that one, so it is the last row of its block and comes first in the other.
      const key = e.seq >> BLOCK_BITS;
      const here = key === blockKey(b.blocks[j]!);
      if (!here && k !== b.blocks[j]!.length - 1) continue;
      const named: Row = { ...row, id: `w:${name}`, e };
      if (b.work === row.id) b.work = named.id;
      for (const st of row.steps!) for (const it of st.items) if (it.t === "call") b.uses.set(it.id, named.id);
      b.at.delete(row.id);
      b.at.set(named.id, j);
      if (here) { b.blocks[j]![k] = named; continue; }
      b.blocks[j]!.pop();
      const to = b.blocks.findIndex((rows, n) => n > j && rows.length > 0 && blockKey(rows) >= key);
      if (to >= 0 && blockKey(b.blocks[to]!) === key) b.blocks[to]!.unshift(named);
      else b.blocks.splice(to < 0 ? b.blocks.length : to, 0, [named]);
      moved = true;
    }
    if (moved) {
      b.blocks = b.blocks.filter((rows) => rows.length);
      b.at = new Map();
      b.blocks.forEach((rows, j) => { for (const r of rows) { b.at.set(r.id, j); if (r.kind === "work") for (const id of r.events!) if (!b.at.has(id)) b.at.set(id, j); } });
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
        // A run that changed keeps the steps that did not: the page renders only the others.
        else if (old?.steps && rows[k]!.steps) {
          const by = new Map(old.steps.map((st) => [st.key, st]));
          rows[k] = { ...rows[k]!, steps: rows[k]!.steps!.map((st) => { const o = by.get(st.key); return o && sameStep(o, st) ? o : st; }) };
        }
      }
      if (was && sameList(was, rows)) b.blocks[j] = was;
    }
  }
  return b;
}

// The versions of each prompt (see versions() in tree.ts): the list is under the parent of each of its
// members, so a prompt finds the others by its own parent. Prompts that branch from the same place are
// versions even when notes stand between (a rewind's: the prompt typed after one is stored under them).
// Events added to the list change only the lists they join.
export type Siblings = Map<string | null, StoredEvent[]>;
export type SiblingsOf = { all: StoredEvent[]; map: Siblings; up: Map<string, string | null>; groups: Map<string | null, StoredEvent[]> };
export function nextSiblings(prev: SiblingsOf | undefined, all: StoredEvent[]): SiblingsOf {
  const grew = !!prev && prev.all.length > 0 && all.length >= prev.all.length && all[0] === prev.all[0] && all[prev.all.length - 1] === prev.all[prev.all.length - 1];
  let map: Siblings = grew ? prev!.map : new Map();
  let copied = !grew;
  // A note's place: where it branches from, past the notes under it. Held across calls, only ever added to.
  const up: SiblingsOf["up"] = grew ? prev!.up : new Map();
  const groups: SiblingsOf["groups"] = grew ? prev!.groups : new Map();
  for (let i = grew ? prev!.all.length : 0; i < all.length; i++) {
    const e = all[i]!;
    if (e.kind === "note") { up.set(e.id, e.parent !== null && up.has(e.parent) ? up.get(e.parent)! : e.parent); continue; }
    if (e.kind !== "user" || e.data.origin) continue;
    if (!copied) { map = new Map(map); copied = true; }
    const at = e.parent !== null && up.has(e.parent) ? up.get(e.parent)! : e.parent;
    const list = [...(groups.get(at) ?? []), e];
    groups.set(at, list);
    for (const m of list) map.set(m.parent, list);
  }
  return { all, map, up, groups };
}

// lineage() of tree.ts, from the previous one: events appended under the
// branch's end are added to it, anything else is read again.
export type LineageOf = { all: StoredEvent[]; head: string | null; out: StoredEvent[] };
export function nextLineage(prev: LineageOf | undefined, all: StoredEvent[], head: string | null): LineageOf {
  const n = prev?.all.length ?? 0;
  // Only a branch that ends at its head grows from it. One read while its head was not held yet
  // (a snapshot older than the session's row: the row names a head its events are still coming
  // to) is empty, and is read again when they come.
  const ends = !!prev && (prev.out.at(-1)?.id ?? null) === prev.head;
  if (prev && ends && n > 0 && all.length >= n && all[0] === prev.all[0] && all[n - 1] === prev.all[n - 1]) {
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

// The branch of a session that ends at `head`, for the parts of a pane that read it at every
// event (the context ring, the queue, the plan): kept per session from one event to the next, so
// an event added at the branch's end adds to it, instead of the whole tree being indexed again
// by each of them.
const lines = new Map<string, LineageOf>();
export function branchLine(sessionId: string, all: StoredEvent[], head: string | null): StoredEvent[] {
  const next = nextLineage(lines.get(sessionId), all, head);
  if (lines.size > 64 && !lines.has(sessionId)) lines.clear(); // sessions long closed
  lines.set(sessionId, next);
  return next.out;
}

// A list of a whole session a view keeps for itself (lib/whole.ts), with the
// events the page holds after its last one. What the page lets go of later
// stays in the list.
// Whether the page may have let go of events the list never saw: everything
// it holds is newer than the list's last event, with seqs between them (a
// reconnect that replayed more than the page keeps, trimmed before the view
// looked). The view then reads what follows its last event from the daemon.
export const missedSince = (list: StoredEvent[], held: StoredEvent[] | undefined): boolean =>
  !!held?.length && !!list.length && held[0]!.seq > list.at(-1)!.seq + 1;

export function grown(list: StoredEvent[], held: StoredEvent[] | undefined): StoredEvent[] {
  const last = list.at(-1)?.seq ?? 0;
  if (!held?.length || held.at(-1)!.seq <= last) return list;
  let from = held.length;
  while (from > 0 && held[from - 1]!.seq > last) from--;
  return [...list, ...held.slice(from)];
}
