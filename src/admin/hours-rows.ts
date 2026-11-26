// Where an agent's or a tree's hours went: every moment of its life put in
// one class (model requests, commands, waiting for its agents, for its
// parent, on a wait, for the owner, held for a slot, the provider, a
// compaction, a daemon restart, Keel's own work), from the records Keel
// already keeps: the spans of its turns (src/admin/trace.ts), its turns and
// what started each (the events), its agents, its waits, its slot holds and
// the daemon's starts. Nothing is recorded twice for this.
//
// A tree's hours are read along its critical path: while a session waits for
// its agents' reports, the time is the time of the agent it waits on longest
// (the one that ends last), down the tree. So the classes of a tree add up to
// its wall time, and the largest one is what held the tree up.
//
// Pure, and free of the daemon's modules: the read thread computes with it,
// and the page and the measurement script load it too.
import { dur, originOf, type Opener } from "./timeline-rows.ts";

export const HOUR_CLASSES = ["model", "tools", "agents", "review", "wait", "owner", "slot", "provider", "compaction", "restart", "keel", "unknown"] as const;
export type HourClass = (typeof HOUR_CLASSES)[number];
// As a person reads them in a list, and in "went most to ...".
export const HOUR_WORDS: Record<HourClass, string> = {
  model: "model requests",
  tools: "commands and tools",
  agents: "waiting for its agents' reports",
  review: "waiting for its parent after a report",
  wait: "waiting on a wait it set",
  owner: "waiting for the owner",
  slot: "held for an agent slot",
  provider: "waiting for the provider",
  compaction: "compaction",
  restart: "cut by a daemon restart, until resumed",
  keel: "Keel's own work between steps",
  unknown: "not accounted for",
};
// Short names for a bar's legend and the text form's columns.
export const HOUR_SHORT: Record<HourClass, string> = {
  model: "Model", tools: "Commands", agents: "Agents", review: "Parent", wait: "Waits", owner: "Owner", slot: "Slot",
  provider: "Provider", compaction: "Compaction", restart: "Restart", keel: "Keel", unknown: "Unknown",
};

export type HourSpan = { span_id: string; parent_id: string | null; session_id: string; kind: string; name: string; start_ms: number; end_ms: number | null; tool?: string | null; purpose?: string | null };
// A turn as its events say: when it began and ended, and what started it.
export type HourTurn = { session_id: string; start: number; end: number | null; opener?: Opener };
// A session of the tree. `start`: an agent's creation, a root's first turn.
// `end`: an agent's end (its last report), null while it lives; a root's is
// its last turn's end, or null while one runs. `held`: when it was put in
// line for a slot of its parent.
export type HourMember = { session_id: string; parent_session: string | null; agent_id?: string; title: string; start: number; end: number | null; held?: number[] };
export type HourInput = {
  now: number;
  root: string;
  members: HourMember[];
  turns: HourTurn[];
  spans: HourSpan[];
  waits: { session_id: string; from: number; to: number | null }[];
  // The daemon was down from `from` to `to` (it listened again).
  restarts: { from: number; to: number }[];
  // The window asked for, inside the tree's life.
  since?: number;
  until?: number;
};
// `inferred`: no record covers the moment; its class is what started the session's next turn.
export type Segment = { from: number; to: number; cls: HourClass; who: string; inferred?: true };
export type ClassMs = Partial<Record<HourClass, number>>;
export type MemberHours = {
  session_id: string; agent_id?: string; title: string; depth: number; from: number; to: number; wall_ms: number; live: boolean;
  // `inferred_ms`: the part of each class's time read from what started a next turn, not from a record.
  classes: ClassMs; inferred_ms: ClassMs; top: HourClass | null;
};

// How a tree's time is read, said wherever its classes are shown.
export const CRITICAL_RULE = "Read along the critical path: while a session waits for its agents, the time counts as the agent that ends last, and so on down the tree; so the classes add up to the wall time.";
// What an inferred share is, in the same words everywhere.
export const INFERRED_WORDS = "read from what started the next turn";
// A class most of whose time no record covers.
export const mostlyInferred = (t: Pick<TreeHours | MemberHours, "classes" | "inferred_ms">, c: HourClass) => 2 * (t.inferred_ms[c] ?? 0) > (t.classes[c] ?? 0);
export type TreeHours = {
  root: string; title: string; from: number; to: number; wall_ms: number; live: boolean; agents: number;
  // Along the critical path: they add up to wall_ms.
  classes: ClassMs;
  // The share of wall_ms in a class other than `unknown`, and of it the part
  // from records (`recorded`) and the part read from what started a next
  // turn (`inferred`): accounted = recorded + inferred.
  accounted: number;
  recorded: number;
  inferred: number;
  inferred_ms: ClassMs;
  top: HourClass | null;
  // Who the largest class was spent in, the most first.
  top_in: { session_id: string; title: string; ms: number }[];
  line: string;
  members: MemberHours[];
};

// Tools that wait for the owner, for agents' reports or on a wait, by name across the families.
const OWNER_TOOLS = new Set(["AskUserQuestion", "ask_user", "request_user_input", "request_secret"]);
const AGENT_TOOLS = new Set(["Agent", "spawn_agent", "wait_agent", "keel__spawn_on_machine"]);
const WAIT_TOOLS = new Set(["WaitFor", "wait_for", "wait_pr_checks"]);
const READER_TOOLS = new Set(["AskReaders", "ask_readers", "advisor"]);

// What a span inside a turn was, and how strongly it holds its time against
// another span over the same moment (the owner's card over the tool it
// gates, a request over the turn around it).
const P = { base: 0, start: 1, agents: 2, wait: 3, slot: 4, turnEvent: 5, turn: 6, tool: 7, model: 8, compaction: 9, provider: 9, owner: 10, stall: 11, restart: 12 } as const;
export function spanClass(s: Pick<HourSpan, "kind" | "name" | "tool" | "purpose">): { cls: HourClass; prio: number } | null {
  if (s.kind === "request") return s.purpose === "summary" ? { cls: "compaction", prio: P.compaction } : { cls: "model", prio: P.model };
  if (s.kind === "tool") {
    const tool = s.tool ?? s.name.replace(/^execute_tool /, "");
    if (OWNER_TOOLS.has(tool)) return { cls: "owner", prio: P.owner };
    if (AGENT_TOOLS.has(tool)) return { cls: "agents", prio: P.tool };
    if (WAIT_TOOLS.has(tool)) return { cls: "wait", prio: P.tool };
    if (READER_TOOLS.has(tool)) return { cls: "model", prio: P.tool };
    return { cls: "tools", prio: P.tool };
  }
  if (s.kind === "wait") {
    if (s.name === "retry wait" || s.name === "provider wait") return { cls: "provider", prio: P.provider };
    if (s.name === "compaction") return { cls: "compaction", prio: P.compaction };
    if (s.name === "approval wait") return { cls: "owner", prio: P.owner };
    if (s.name === "queue wait") return { cls: "slot", prio: P.slot };
    if (s.name === "daemon stall") return { cls: "keel", prio: P.stall };
    return { cls: "tools", prio: P.tool };
  }
  return null;
}

// What the stretch before a turn waited for, from what started the turn: the
// owner's words, a parent's message, a wait's wake, an agent's report.
export function openerClass(o: Opener | undefined, agent: boolean): HourClass {
  const key = originOf(o).key;
  if (["owner", "voice", "continue", "queued", "plan"].includes(key)) return "owner";
  if (["steer", "parent", "task", "review", "review_fix", "peer", "task_start"].includes(key)) return agent ? "review" : "owner";
  if (["wait", "wake", "command", "loop", "goal", "verify_goal", "channel"].includes(key)) return "wait";
  if (key === "provider_wait") return "provider";
  if (key === "subagent") return "agents";
  if (key === "restart") return "restart";
  if (["harness", "hook", "failures", "diagnostic", "helper_digest", "momentum", "steward"].includes(key)) return "keel";
  return agent ? "review" : "owner";
}

type Layer = { from: number; to: number; cls: HourClass; prio: number };

// The moments of [from, to) each given to the strongest layer over it; a
// moment no layer covers is `unknown`. Adjacent pieces of one class are one.
export function paint(layers: Layer[], from: number, to: number, who: string): Segment[] {
  const ls = layers.map((l) => ({ ...l, from: Math.max(from, l.from), to: Math.min(to, l.to) })).filter((l) => l.to > l.from);
  const cuts = [...new Set([from, to, ...ls.flatMap((l) => [l.from, l.to])])].sort((a, b) => a - b);
  // Layers by their start: a sweep keeps the ones open at each cut.
  ls.sort((a, b) => a.from - b.from);
  const out: Segment[] = [];
  const open: Layer[] = [];
  let next = 0;
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i]!, b = cuts[i + 1]!;
    while (next < ls.length && ls[next]!.from <= a) open.push(ls[next++]!);
    for (let k = open.length - 1; k >= 0; k--) if (open[k]!.to <= a) open.splice(k, 1);
    let best: Layer | undefined;
    for (const l of open) if (!best || l.prio > best.prio) best = l;
    const cls = best?.cls ?? "unknown";
    const inferred = best?.prio === P.base;
    const last = out.at(-1);
    if (last && last.cls === cls && last.to === a && !!last.inferred === inferred) last.to = b;
    else out.push({ from: a, to: b, cls, who, ...(inferred ? { inferred: true as const } : {}) });
  }
  return out;
}

type Index = {
  byId: Map<string, HourMember>;
  kids: Map<string, HourMember[]>;
  turns: Map<string, HourTurn[]>;
  spans: Map<string, HourSpan[]>;
  waits: Map<string, { from: number; to: number | null }[]>;
  own: Map<string, Segment[]>;
};
const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => void (m.get(k) ?? m.set(k, []).get(k)!).push(v);

function indexOf(input: HourInput): Index {
  const ix: Index = { byId: new Map(), kids: new Map(), turns: new Map(), spans: new Map(), waits: new Map(), own: new Map() };
  for (const m of input.members) ix.byId.set(m.session_id, m);
  for (const m of input.members) if (m.parent_session && ix.byId.has(m.parent_session) && m.session_id !== input.root) push(ix.kids, m.parent_session, m);
  for (const t of input.turns) push(ix.turns, t.session_id, t);
  for (const l of ix.turns.values()) l.sort((a, b) => a.start - b.start);
  for (const s of input.spans) push(ix.spans, s.session_id, s);
  for (const w of input.waits) push(ix.waits, w.session_id, w);
  return ix;
}

const endOf = (m: HourMember, now: number) => m.end ?? now;

// One session's own life, every moment in a class.
function ownSegments(input: HourInput, ix: Index, m: HourMember): Segment[] {
  const hit = ix.own.get(m.session_id);
  if (hit) return hit;
  const now = input.now;
  const from = m.start, to = Math.max(from, endOf(m, now));
  const agent = !!m.agent_id;
  const layers: Layer[] = [];
  const turns = ix.turns.get(m.session_id) ?? [];
  // Between turns: what the next turn's start says it waited for; after the
  // last one, an agent waits for its parent and a root for the owner.
  let at = from;
  for (const t of turns) {
    if (t.start > at) layers.push({ from: at, to: t.start, cls: at === from && agent ? "keel" : openerClass(t.opener, agent), prio: at === from && agent ? P.start : P.base });
    at = Math.max(at, t.end ?? now);
  }
  // (An agent that has ended ended with its report: what lies between its last turn and that is Keel delivering it.)
  if (to > at) layers.push({ from: at, to, cls: agent ? (m.end === null ? "review" : "keel") : "owner", prio: P.base });
  // A turn's own time: its spans, the gaps between them Keel's, and a turn
  // its events hold with no span over it not accounted for.
  for (const t of turns) layers.push({ from: t.start, to: t.end ?? now, cls: "unknown", prio: P.turnEvent });
  const spans = ix.spans.get(m.session_id) ?? [];
  const turnIds = new Set<string>();
  for (const s of spans) if (s.kind === "turn") { turnIds.add(s.span_id); layers.push({ from: s.start_ms, to: s.end_ms ?? now, cls: "keel", prio: P.turn }); }
  // A span left open by a daemon that went away ends with its turn.
  const turnEnd = new Map(spans.filter((s) => s.kind === "turn").map((s) => [s.span_id, s.end_ms ?? now]));
  for (const s of spans) {
    if (s.kind === "turn") continue;
    const c = spanClass(s);
    if (!c) continue;
    const end = s.end_ms ?? (s.parent_id && turnEnd.has(s.parent_id) ? turnEnd.get(s.parent_id)! : now);
    // A request outside every turn (a side answer, a title) holds no time of the session's.
    if (!s.parent_id || !turnIds.has(s.parent_id)) { if (c.cls !== "compaction") continue; }
    layers.push({ from: s.start_ms, to: end, ...c });
  }
  for (const k of ix.kids.get(m.session_id) ?? []) layers.push({ from: k.start, to: endOf(k, now), cls: "agents", prio: P.agents });
  for (const w of ix.waits.get(m.session_id) ?? []) layers.push({ from: w.from, to: w.to ?? now, cls: "wait", prio: P.wait });
  // A slot hold lasts until the session's next turn begins.
  for (const h of m.held ?? []) {
    const next = turns.find((t) => t.start >= h)?.start ?? now;
    layers.push({ from: h, to: next, cls: "slot", prio: P.slot });
  }
  // The daemon down, and a turn it cut until that turn went on.
  for (const r of input.restarts) {
    if (r.to <= from || r.from >= to) continue;
    layers.push({ from: r.from, to: r.to, cls: "restart", prio: P.restart });
    const cut = turns.some((t) => t.start < r.from && (t.end === null || t.end >= r.from - 60_000));
    const resumed = turns.find((t) => t.start >= r.to);
    if (cut && resumed && openerClass(resumed.opener, agent) === "restart") layers.push({ from: r.to, to: resumed.start, cls: "restart", prio: P.restart });
  }
  const segs = paint(layers, from, to, m.session_id);
  ix.own.set(m.session_id, segs);
  return segs;
}

// The tree's moments from one session down: where it waits for its agents,
// the time of the agent it waits on longest, and so on down.
function critical(input: HourInput, ix: Index, m: HourMember, from: number, to: number, depth = 0): Segment[] {
  const out: Segment[] = [];
  for (const s of ownSegments(input, ix, m)) {
    const a = Math.max(from, s.from), b = Math.min(to, s.to);
    if (b <= a) continue;
    if (s.cls !== "agents" || depth > 32) { out.push({ ...s, from: a, to: b }); continue; }
    const kids = (ix.kids.get(m.session_id) ?? []).filter((k) => k.start < b && endOf(k, input.now) > a);
    const cuts = [...new Set([a, b, ...kids.flatMap((k) => [k.start, endOf(k, input.now)]).filter((t) => t > a && t < b)])].sort((x, y) => x - y);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const x = cuts[i]!, y = cuts[i + 1]!;
      let longest: HourMember | undefined;
      for (const k of kids) if (k.start <= x && endOf(k, input.now) >= y && (!longest || endOf(k, input.now) > endOf(longest, input.now))) longest = k;
      if (longest) out.push(...critical(input, ix, longest, x, y, depth + 1));
      else out.push({ from: x, to: y, cls: "agents", who: m.session_id });
    }
  }
  return out;
}

export const totals = (segs: Segment[], only?: (s: Segment) => boolean): ClassMs => {
  const c: ClassMs = {};
  for (const s of segs) if (!only || only(s)) c[s.cls] = (c[s.cls] ?? 0) + (s.to - s.from);
  return c;
};
const isInferred = (s: Segment) => !!s.inferred;
export const ranked = (c: ClassMs): [HourClass, number][] => (Object.entries(c) as [HourClass, number][]).filter(([, ms]) => ms > 0).sort((a, b) => b[1] - a[1]);
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((100 * part) / whole) : 0);
const quote = (t: string) => { const s = t.replace(/\s+/g, " ").trim(); return `"${s.length > 48 ? `${s.slice(0, 47)}…` : s}"`; };

// The tree under `input.root`, over its life or the window asked for.
export function treeHours(input: HourInput): TreeHours | null {
  const ix = indexOf(input);
  const root = ix.byId.get(input.root);
  if (!root) return null;
  const depthOf = new Map<string, number>([[root.session_id, 0]]);
  const order: HourMember[] = [];
  const walk = (m: HourMember, d: number) => {
    order.push(m);
    depthOf.set(m.session_id, d);
    for (const k of (ix.kids.get(m.session_id) ?? []).sort((a, b) => a.start - b.start)) if (!depthOf.has(k.session_id)) walk(k, d + 1);
  };
  walk(root, 0);
  // The tree lives from its root's start until its last session ends.
  const live = order.some((m) => m.end === null);
  const lifeTo = live ? input.now : Math.max(...order.map((m) => m.end!));
  const from = Math.max(root.start, input.since ?? -Infinity);
  const to = Math.max(from, Math.min(lifeTo, input.until ?? Infinity));
  // A root's own life is the tree's: it waits for agents that outlive its last turn.
  const top: HourMember = { ...root, end: live ? null : lifeTo };
  ix.byId.set(root.session_id, top);
  const path = critical(input, ix, top, from, to);
  const classes = totals(path);
  const wall = to - from;
  const list = ranked(classes);
  const largest = list.find(([c]) => c !== "unknown")?.[0] ?? null;
  const inWho = new Map<string, number>();
  if (largest) for (const s of path) if (s.cls === largest) inWho.set(s.who, (inWho.get(s.who) ?? 0) + s.to - s.from);
  const title = (id: string) => ix.byId.get(id)?.title ?? id;
  const topIn = [...inWho.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([session_id, ms]) => ({ session_id, title: title(session_id), ms }));
  const members: MemberHours[] = order.map((m) => {
    const mm = m === root ? top : m;
    const a = Math.max(from, mm.start), b = Math.min(to, endOf(mm, input.now));
    const segs = b > a ? ownSegments(input, ix, mm).map((s) => ({ ...s, from: Math.max(a, s.from), to: Math.min(b, s.to) })).filter((s) => s.to > s.from) : [];
    const c = totals(segs);
    return {
      session_id: m.session_id, ...(m.agent_id ? { agent_id: m.agent_id } : {}), title: m.title, depth: depthOf.get(m.session_id) ?? 0,
      from: a, to: Math.max(a, b), wall_ms: Math.max(0, b - a), live: mm.end === null, classes: c, inferred_ms: totals(segs, isInferred), top: ranked(c).find(([k]) => k !== "unknown")?.[0] ?? null,
    };
  });
  const unknown = classes.unknown ?? 0;
  const inferredMs = totals(path, isInferred);
  const accounted = wall > 0 ? (wall - unknown) / wall : 1;
  const inferred = wall > 0 ? Object.values(inferredMs).reduce((n, v) => n + (v ?? 0), 0) / wall : 0;
  const t: TreeHours = {
    root: root.session_id, title: root.title, from, to, wall_ms: wall, live, agents: order.length - 1,
    classes, accounted, recorded: Math.max(0, accounted - inferred), inferred, inferred_ms: inferredMs, top: largest, top_in: topIn, line: "", members,
  };
  t.line = bottleneckLine(t);
  return t;
}

// The tree's bottleneck as one line.
// A class most of whose time no record covers says so: it is read from what started the next turn.
export function bottleneckLine(t: Pick<TreeHours, "wall_ms" | "classes" | "inferred_ms" | "top" | "top_in" | "root" | "agents">): string {
  if (!t.top || !t.wall_ms) return "Nothing has run here yet.";
  const ms = t.classes[t.top] ?? 0;
  const who = t.top_in[0];
  const where = !who || !t.agents ? "" : who.session_id === t.root ? ", in the session itself" : `, most in ${quote(who.title)}`;
  const guess = mostlyInferred(t, t.top) ? `, ${INFERRED_WORDS} (no record covers it)` : "";
  return `Of ${dur(t.wall_ms)}, the most went to ${HOUR_WORDS[t.top]}: ${dur(ms)} (${pct(ms, t.wall_ms)}%)${guess}${where}.`;
}
const tenth = (share: number) => Math.floor(share * 1000) / 10;
// The shares of the wall time from records, inferred and not accounted for, as one phrase.
export function sourcesPhrase(t: Pick<TreeHours, "recorded" | "inferred" | "accounted">): string {
  const gap = 1 - t.accounted;
  return `${tenth(t.recorded)}% from records, ${tenth(t.inferred)}% ${INFERRED_WORDS}${gap > 0.0005 ? `, ${tenth(gap)}% not accounted for` : ""}`;
}

// The text form, for a coordinator reading its tree: a few hundred tokens.
export function hoursText(t: TreeHours, opts: { members?: number } = {}): string {
  const lines: string[] = [];
  const span = `${new Date(t.from).toISOString().slice(0, 16).replace("T", " ")} to ${t.live ? "now" : new Date(t.to).toISOString().slice(11, 16)} UTC`;
  lines.push(`${quote(t.title)}${t.agents ? ` and ${t.agents} ${t.agents === 1 ? "agent" : "agents"}` : ""}: ${dur(t.wall_ms)}, ${span}${t.live ? ", still working" : ""}.`);
  lines.push(t.line);
  const parts = ranked(t.classes).map(([c, ms]) => `${HOUR_SHORT[c].toLowerCase()} ${dur(ms)} (${pct(ms, t.wall_ms)}%${mostlyInferred(t, c) ? ", inferred" : ""})`);
  if (parts.length) lines.push(`Along the critical path: ${parts.join(", ")}.`);
  lines.push(CRITICAL_RULE);
  lines.push(`Of the wall time: ${sourcesPhrase(t)} ("inferred" above: a class mostly ${INFERRED_WORDS}).`);
  const n = opts.members ?? 8;
  const agents = t.members.filter((m) => m.depth > 0).sort((a, b) => b.wall_ms - a.wall_ms);
  if (agents.length) {
    lines.push(`Agents by their own time (the ${Math.min(n, agents.length)} longest${agents.length > n ? ` of ${agents.length}` : ""}):`);
    for (const m of agents.slice(0, n)) {
      const own = ranked(m.classes).slice(0, 3).map(([c, ms]) => `${HOUR_SHORT[c].toLowerCase()} ${pct(ms, m.wall_ms)}%${mostlyInferred(m, c) ? " inferred" : ""}`).join(", ");
      lines.push(`- ${m.agent_id ?? m.session_id.slice(0, 8)} ${quote(m.title)}: ${dur(m.wall_ms)}${m.live ? ", live" : ""}; ${own}`);
    }
  }
  return lines.join("\n");
}
