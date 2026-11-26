// The Conversation lens of a session: the owner's own messages, the reply each
// of his turns ended with, and between them one folded run for each stretch of
// work nobody asked for in that moment (agents' reports, wakes, loops, landings,
// the work inside his own turn), told by what came of it. Pure: the route reads
// the branch's events without their bodies and a few facts of some of them
// (src/server/routes/lens.ts), the page draws the items (ui/src/components/Lens.tsx).
// A folded run is never read for its words but one line: its line is made from
// event kinds and facts, with the first line of the last reply a turn in it
// ended with (`said`, read for the line by the route: `words`), and its full
// stream is read only when the owner opens it.
import { OWNER_ORIGINS } from "./owner.ts";

// An event of the branch as the index has it: no body.
export type Mark = { id: string; seq: number; ts: number; kind: string };

// What started a turn, or came into one, as its facts say.
export type InputFacts = {
  origin?: string | null; kind?: string | null; status?: string | null; peer?: boolean;
  // A delivery of several inputs at once: the meta of each.
  parts?: { kind?: string; status?: string; entries?: string[] }[];
  // A landing outcome: its entries in the landing queue, and how many of them landed or were left.
  landed?: number; left?: number;
};
export type EndFacts = { reason?: string | null; cost?: number | null; ms?: number | null; stopped_by?: string | null };

// What a folded run holds, every field a sum, so two runs that meet are one.
export type RunFacts = {
  turns: number; steps: number; reports: number; wakes: number; loops: number; messages: number;
  landed: number; left: number; failed: number; cost: number;
  // Cards that asked the owner in the run, and of them the ones still waiting.
  asked: number; waiting: number;
};
export const NO_FACTS: RunFacts = { turns: 0, steps: 0, reports: 0, wakes: 0, loops: 0, messages: 0, landed: 0, left: 0, failed: 0, cost: 0, asked: 0, waiting: 0 };
export const addFacts = (a: RunFacts, b: RunFacts): RunFacts => {
  const out = { ...a };
  for (const k of Object.keys(NO_FACTS) as (keyof RunFacts)[]) out[k] = a[k] + b[k];
  return out;
};

// `open`: past the last turn that ended, so the next read gives it again.
export type LensItem =
  | { t: "you"; id: string; seq: number; ts: number; open?: true }
  | { t: "reply"; id: string; seq: number; ts: number; turn?: EndFacts; open?: true }
  | { t: "run"; from: number; to: number; first: string; last: string; ts0: number; ts1: number; facts: RunFacts; open?: true; said?: string; words?: string };

// The owner's own words: typed, steered, queued, spoken or sent from the command line, and not a peer's message.
export const ownerInput = (f: InputFacts | undefined) => !!f && !f.kind && OWNER_ORIGINS.has(f.origin ?? undefined) && !f.peer;

const FAILED = new Set(["failed"]);
function addInput(r: RunFacts, f: InputFacts | undefined) {
  if (!f) return;
  if (f.peer) { r.messages++; return; }
  const parts = f.parts?.length ? f.parts : [{ kind: f.kind ?? undefined, status: f.status ?? undefined }];
  for (const p of parts) {
    if (p.kind === "subagent") { r.reports++; if (p.status && FAILED.has(p.status)) r.failed++; }
    else if (p.kind === "wait" || p.kind === "wake") r.wakes++;
    else if (p.kind === "loop" || p.kind === "goal") r.loops++;
  }
  r.landed += f.landed ?? 0;
  r.left += f.left ?? 0;
}

// A turn that went wrong: it failed, or the model declined. A stop, a restart or a budget is not a failure.
const failedEnd = (f: EndFacts | undefined) => f?.reason === "error" || f?.reason === "refusal";

// The items of a part of a branch, in its order. `line`: its events. `input` and
// `end`: the facts of an input and of a turn's end (only those are asked).
// `asks`: when cards asked the owner, and whether each still waits.
// `owner`: the turn open where the part starts is the owner's (a read after a point).
// Returns the items, and `stable`: the seq of the last turn's end in the part (what
// a next read starts after), or undefined when no turn ended in it.
export function lensItems(
  line: readonly Mark[],
  input: (id: string) => InputFacts | undefined,
  end: (id: string) => EndFacts | undefined,
  asks: readonly { at: number; waiting: boolean }[] = [],
): { items: LensItem[]; stable?: number } {
  // Each turn's last reply: the one before its end. (A turn with no end yet has none.)
  const finalOf = new Map<number, number>(); // index of a turn_start -> index of its last reply
  let lastEnd = -1;
  {
    let start = -1, reply = -1;
    for (let i = 0; i < line.length; i++) {
      const k = line[i]!.kind;
      if (k === "turn_start") { start = i; reply = -1; }
      else if (k === "assistant") reply = i;
      else if (k === "turn_end") { if (start >= 0 && reply > start) finalOf.set(start, reply); start = -1; lastEnd = i; }
    }
  }
  const items: LensItem[] = [];
  let run: Extract<LensItem, { t: "run" }> | null = null;
  const touch = (e: Mark) => {
    if (!run) run = { t: "run", from: e.seq, to: e.seq, first: e.id, last: e.id, ts0: e.ts, ts1: e.ts, facts: { ...NO_FACTS } };
    run.to = e.seq; run.last = e.id; run.ts1 = e.ts;
    return run.facts;
  };
  const flush = () => {
    const r = run as Extract<LensItem, { t: "run" }> | null;
    run = null;
    if (!r) return;
    const f = r.facts;
    // A run that holds nothing to tell (a turn's end after its reply, notes) is no line.
    if (!(f.turns || f.steps || f.reports || f.wakes || f.loops || f.messages || f.landed || f.left || f.failed)) return;
    items.push(r);
  };
  // Whose turn the next one is, whose the one running is, and the reply that ends it.
  let next = false, mine = false, inTurn = false, reply = -1, start = -1;
  let lastReply: Extract<LensItem, { t: "reply" }> | null = null;
  for (let i = 0; i < line.length; i++) {
    const e = line[i]!;
    if (e.kind === "user") {
      const f = input(e.id);
      if (ownerInput(f)) {
        flush();
        items.push({ t: "you", id: e.id, seq: e.seq, ts: e.ts });
        if (!inTurn) next = true;
        // Steered into a turn of the harness's: its reply answers him too.
        else if (!mine) { mine = true; reply = finalOf.get(start) ?? -1; }
        continue;
      }
      // A turn a restart cut goes on: it stays whose it was.
      if (f?.origin === "restart") { touch(e); if (!inTurn) next = mine; continue; }
      addInput(touch(e), f);
    } else if (e.kind === "turn_start") {
      inTurn = true; mine = next; next = false; start = i;
      reply = mine ? finalOf.get(i) ?? -1 : -1;
      lastReply = null;
      const f = touch(e);
      if (!mine) f.turns++;
    } else if (e.kind === "assistant") {
      if (i === reply) { flush(); items.push((lastReply = { t: "reply", id: e.id, seq: e.seq, ts: e.ts })); }
      else {
        touch(e).steps++;
        // The reply a turn of the run ended with: the newest is what the run said last.
        if (!mine && finalOf.get(start) === i) (run as Extract<LensItem, { t: "run" }> | null)!.said = e.id;
      }
    } else if (e.kind === "turn_end") {
      const f = end(e.id);
      inTurn = false;
      if (lastReply) {
        lastReply.turn = f;
        lastReply = null;
      } else {
        const r = touch(e);
        r.cost += f?.cost ?? 0;
        if (failedEnd(f)) r.failed++;
      }
      // What ends here is settled: a run that goes on past it is told in two parts, the second open.
      if (i === lastEnd) flush();
    } else touch(e);
  }
  flush();
  // The cards that asked the owner, each in the run whose span holds it.
  for (const a of asks) {
    const r = items.find((x): x is Extract<LensItem, { t: "run" }> => x.t === "run" && a.at >= x.ts0 && a.at <= x.ts1);
    if (!r) continue;
    r.facts.asked++;
    if (a.waiting) r.facts.waiting++;
  }
  const stable = lastEnd >= 0 ? line[lastEnd]!.seq : undefined;
  for (const it of items) {
    const at = it.t === "run" ? it.from : it.seq;
    if (stable === undefined || at > stable) it.open = true;
  }
  return { items, stable };
}

// Runs that stand next to each other are one line (a part read later goes on the run before it).
export function joinRuns(items: readonly LensItem[]): LensItem[] {
  const out: LensItem[] = [];
  for (const it of items) {
    const prev = out.at(-1);
    if (it.t === "run" && prev?.t === "run") {
      const said = it.said ? { said: it.said, ...(it.words ? { words: it.words } : {}) } : {};
      out[out.length - 1] = { ...prev, to: it.to, last: it.last, ts1: it.ts1, facts: addFacts(prev.facts, it.facts), ...(it.open ? { open: true as const } : {}), ...said };
    } else out.push(it);
  }
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// "45 s", "12 min", "3 h 5 min", "2 d 4 h".
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}
export const dollars = (n: number) => (n >= 10 ? `$${n.toFixed(0)}` : n >= 0.995 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(2)}` : n > 0 ? "under $0.01" : "");

// What a folded run says: what came of it first (asks you, landed, failed, needs you), then what it took.
// `live`: it is the run the session works in now; `needs`: the session waits on the owner now; `asks`: the
// run ended asking the owner in prose, and he has not written since (src/core/closing-ask.ts); `agents`: the
// session's agents at work now, said on the last run when the session's own turn is over.
export function runWords(r: { facts: RunFacts; ts0: number; ts1: number }, o: { live?: boolean; needs?: boolean; asks?: boolean; agents?: number } = {}): { came: string; took: string; state: "needs" | "failed" | "live" | "done" } {
  const f = r.facts;
  const came: string[] = [];
  if (o.asks) came.push("asks you");
  if (f.landed) came.push(`${f.landed} landed`);
  if (f.failed) came.push(`${f.failed} failed`);
  if (f.left) came.push(`${f.left} not landed`);
  if ((f.waiting || o.needs) && !o.asks) came.push("needs you");
  const agents = !o.live && o.agents ? `${plural(o.agents, "agent")} at work` : "";
  const did: string[] = [];
  if (f.turns) did.push(plural(f.turns, "turn"));
  else if (f.steps) did.push(plural(f.steps, "step"));
  if (f.reports) did.push(plural(f.reports, "agent report"));
  if (f.wakes) did.push(plural(f.wakes, "wake"));
  if (f.loops) did.push(plural(f.loops, "loop run"));
  if (f.messages) did.push(plural(f.messages, "message"));
  const took = [did.join(", "), span(r.ts1 - r.ts0), dollars(f.cost)].filter(Boolean).join(", ");
  const lead = [came.length ? came.join(", ") : o.live ? "Working" : agents ? "" : f.turns ? "Worked on its own" : "Worked", agents].filter(Boolean).join(", ");
  return { came: lead[0]!.toUpperCase() + lead.slice(1), took, state: f.waiting || o.needs || o.asks ? "needs" : f.failed ? "failed" : o.live || agents ? "live" : "done" };
}
