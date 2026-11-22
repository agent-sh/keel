// Every session at once, as one short answer: what needs the owner, what
// failed and why, what runs and for how long, and what was done and spent
// since a time. One builder for the route (GET /api/overview), the command
// line (keel status --sessions) and the sessions tool (keel__sessions_list
// with report), so the three say the same.
//
// Content-free like the timeline: titles, states, classes, counts, durations
// and ids, never a prompt, a tool's input or output or an error's message.
// A session's state is the one word the page shows (src/automation/state.ts);
// what it does now is the first line of its timeline's "now", in few words:
// another session's agent is counted, not named, and a card is "an approval",
// not its tool.
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import { WATCH_LABEL, WATCH_RANK, type Watch } from "../core/watch.ts";
import { localDay, localTime, zoneLabel } from "../core/clock.ts";
import { stopSays } from "../core/stoppers.ts";
import { CLASS, dur, type Refs, type TimelineNow, type TimelineRow } from "./timeline-rows.ts";
import { waitingOf } from "./waiting-line.ts";

// What a row did since the asked time. `turns`: its own turns that ended.
// `cut`: those a daemon restart cut, which did not end: they are continued
// (one that was not shows in the state), so they are counted apart.
// `failed`: the ended ones that did not end well, by class.
// `agents`: how its agents ended, by outcome. `cost`: its requests and its
// agents', in dollars.
export type Did = { turns: number; cut?: number; failed: Record<string, number>; agents: Record<string, number>; cost: number; unpriced?: true };
export type OverviewRow = {
  id: string;
  title: string;
  watch: Watch;
  agents: number; // agents still at work
  agent?: { id: string; status: string; stopped_by?: string }; // the row is an agent of the asking session
  stopped_by?: string; // a stopped row: who stopped it (a word of src/core/stoppers.ts)
  line?: string; // what it does or waits on now, most pressing first
  from?: number; // since when
  until?: number; // when what it waits on is due
  more?: number; // further lines its timeline's "now" holds
  refs?: Refs;
  failed?: { ts: number; why: string; turn?: string; error_id?: string };
  last?: number; // its last activity, for a row with nothing going on
  approvals: number; // cards waiting for the owner, its agents' included
  parked: number; // agents waiting on a wake of their own
  did?: Did;
};
export type Overview = {
  as_of: number;
  since: number;
  until: number;
  sessions: OverviewRow[];
  agents?: OverviewRow[]; // the asking session's own agents: the failed ones first, then those at work, then the rest
  // Every agent it has at work or that started or ended in the window, and the ones past the listed rows by status.
  agents_total?: number;
  agents_unlisted?: Record<string, number>;
  hidden: number; // sessions past the listed ones: within a state, the ones that did least in the window
  // What the hidden ones did in the window, when any did. They are "the quietest" only when none of
  // them did more than a listed session: where the rows went to states that come first (the ones
  // that need the owner, failed or wait), a busy done session is among the hidden. Then
  // `hidden_by` says their states and `hidden_busiest` names the one that did most.
  hidden_did?: { turns: number; cost: number };
  hidden_by?: Record<string, number>;
  hidden_busiest?: { id: string; title: string; turns: number; cost: number };
  // The sessions that spent most in the window, over every session (the hidden ones and the asking one too), their agents' spend in each.
  top?: { id: string; title: string; cost: number }[];
  // `turns`, `failed`: the sessions' own turns, not their agents'. `cut`: those a restart cut. `agents`: how their agents ended.
  totals: { turns: number; cut?: number; failed: number; agents: Record<string, number>; cost: number; unpriced?: true };
};

// What the builder asks of the running daemon.
export type From = {
  store: Store;
  state(s: Session, counts: Map<string, number>): { watch: Watch; agents: number; by?: string };
  counts(): Map<string, number>;
  now(id: string): TimelineNow;
};
// The running daemon's builder, for the tools that have no route to ask.
let bound: From | undefined;
export const bindOverview = (f: From) => void (bound = f);
export const boundOverview = () => bound;
// `spans`: count only inside these windows (each [from, to)), instead of since..until.
export type OverviewOpts = { since: number; until?: number; spans?: [number, number][]; of?: string; max?: number; agentsMax?: number };

// A turn that started more than this before the asked time and ended after
// it is not counted: the read stays on the time index.
const LOOKBACK = 86_400_000;
export const DEFAULT_SINCE = 86_400_000;
// The longest window asked for by time: a read over more holds the daemon for its length.
export const SINCE_MAX_MS = 7 * 86_400_000;
export const tooFarBack = (since: number, now = Date.now()) => (now - since > SINCE_MAX_MS ? `since is at most ${dur(SINCE_MAX_MS)} back` : undefined);
export const MAX = 20;
const AGENTS_MAX = 10;
const ENDED = ["completed", "failed", "incomplete", "stopped"];

// The outcomes that are failures, in the report's words. An error is told by its class.
const OUTCOME: Record<string, string> = { refusal: "declined", budget: "budget" };

// What a session does now, in few words, from the first line of its timeline's "now".
const lower = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
function nowWords(l: TimelineRow, agents: number, parked = 0): string {
  const inAgent = l.refs?.child_session ? " in an agent" : "";
  // A session at rest whose agent waits on a wake of its own: the agent is parked, not at work.
  if (l.kind === "agent" && parked && !agents) return `${parked} agent${parked === 1 ? "" : "s"} parked`;
  switch (l.kind) {
    case "approval": return `an approval waits${inAgent}`;
    case "question": return `a question waits${inAgent}`;
    case "restart": return "a turn cut by a restart was not resumed";
    // "Running a turn started by the owner: step 2, running Bash" is told as its step.
    case "turn": { const at = l.text.indexOf(": "); return at < 0 ? lower(l.text) : l.text.slice(at + 2); }
    // At work and parked said apart: an agent parked on a timer is not at work.
    case "agent": { const n = Math.max(agents - parked, parked ? 0 : 1); return `${n} agent${n === 1 ? "" : "s"} at work${parked ? `, ${parked} parked` : ""}`; }
    case "loop": return "a loop runs next";
    default: return lower(l.text);
  }
}

export function overview(from: From, opts: OverviewOpts): Overview {
  const db = from.store.db;
  const as_of = Date.now();
  const until = opts.until ?? as_of + 1;
  const since = opts.since;
  const has = (name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  const tables = { turns: has("telemetry_turns"), calls: has("telemetry_calls"), agents: has("agents"), approvals: has("approvals"), activity: has("activity") };

  // The class of a turn's last failed request.
  const CLS = "(SELECT c.error_class FROM telemetry_calls c WHERE c.turn_event = t.turn_event AND c.outcome = 'error' ORDER BY c.id DESC LIMIT 1)";
  const classOf = (turn: string) => (tables.calls ? db.query<{ c: string | null }, [string]>(`SELECT ${CLS} AS c FROM telemetry_turns t WHERE t.turn_event = ?`).get(turn)?.c ?? null : null);
  // Why a turn did not end well, or null when it did (or was only cut by a restart).
  const why = (outcome: string, cls: string | null) => OUTCOME[outcome] ?? (outcome === "error" ? CLASS[cls ?? ""] ?? "error" : null);

  // --- what each session did in the windows, summed by the database: one read a table, whatever the number of windows
  const spans = (opts.spans ?? [[since, until] as [number, number]]).filter(([a, b]) => b > a);
  const did = new Map<string, Did>();
  const of = (id: string) => did.get(id) ?? did.set(id, { turns: 0, failed: {}, agents: {}, cost: 0 }).get(id)!;
  if (spans.length) {
    const lo = Math.min(...spans.map(([a]) => a)), hi = Math.max(...spans.map(([, b]) => b));
    const within = (col: string) => `(${spans.map(() => `(${col} >= ? AND ${col} < ?)`).join(" OR ")})`;
    const edges = spans.flat();
    if (tables.turns) {
      for (const t of db.query<{ session_id: string; outcome: string; cls: string | null; n: number }, number[]>(
        `SELECT session_id, outcome, ${tables.calls ? `CASE WHEN outcome = 'error' THEN ${CLS} END` : "NULL"} AS cls, COUNT(*) AS n FROM telemetry_turns t
         WHERE ts >= ? AND ts < ? AND ${within("ts + COALESCE(ms, 0)")} GROUP BY session_id, outcome, cls`).all(lo - LOOKBACK, hi, ...edges)) {
        const d = of(t.session_id);
        // A turn a restart cut did not end: it is continued.
        if (t.outcome === "cut") { d.cut = (d.cut ?? 0) + t.n; continue; }
        d.turns += t.n;
        const w = why(t.outcome, t.cls);
        if (w) d.failed[w] = (d.failed[w] ?? 0) + t.n;
      }
    }
    if (tables.calls) {
      for (const c of db.query<{ session_id: string; c: number | null; u: number | null }, number[]>(
        `SELECT session_id, SUM(cost) AS c, SUM(unpriced) AS u FROM telemetry_calls WHERE ts >= ? AND ts < ? AND ${within("ts")} GROUP BY session_id`).all(lo, hi, ...edges)) {
        const d = of(c.session_id);
        d.cost += c.c ?? 0;
        if (c.u) d.unpriced = true;
      }
    }
    if (tables.activity) {
      for (const x of db.query<{ session_id: string; sub: string; n: number }, number[]>(
        `SELECT session_id, sub, COUNT(*) AS n FROM activity WHERE ts >= ? AND ts < ? AND ${within("ts")} AND kind = 'agent' AND sub IN (${ENDED.map((e) => `'${e}'`).join(", ")}) AND session_id IS NOT NULL GROUP BY session_id, sub`).all(lo, hi, ...edges)) {
        const d = of(x.session_id);
        d.agents[x.sub] = (d.agents[x.sub] ?? 0) + x.n;
      }
    }
  }
  // An agent's spend is its parent's too: the task's total.
  const kids = new Map<string, string[]>();
  for (const r of db.query<{ id: string; parent_id: string }, []>("SELECT id, parent_id FROM sessions WHERE parent_id IS NOT NULL").all()) kids.set(r.parent_id, [...(kids.get(r.parent_id) ?? []), r.id]);
  const under = (id: string, seen = new Set<string>()): string[] => (seen.has(id) ? [] : (seen.add(id), (kids.get(id) ?? []).flatMap((k) => [k, ...under(k, seen)])));
  const rolled = (id: string): Did | undefined => {
    const own = did.get(id);
    const below = under(id).map((k) => did.get(k)).filter((d): d is Did => !!d);
    if (!own && !below.length) return undefined;
    const out: Did = { turns: own?.turns ?? 0, ...(own?.cut ? { cut: own.cut } : {}), failed: own?.failed ?? {}, agents: own?.agents ?? {}, cost: own?.cost ?? 0, ...(own?.unpriced ? { unpriced: true as const } : {}) };
    for (const d of below) { out.cost += d.cost; if (d.unpriced) out.unpriced = true; }
    return out.turns || out.cut || out.cost || out.unpriced || Object.keys(out.agents).length ? out : undefined;
  };

  // --- what waits now
  const pending = new Map<string, number>();
  if (tables.approvals) for (const r of db.query<{ session_id: string; n: number }, []>("SELECT session_id, COUNT(*) AS n FROM approvals WHERE state = 'pending' GROUP BY session_id").all()) pending.set(r.session_id, r.n);
  const parked = new Map<string, number>();
  if (tables.agents) for (const r of db.query<{ parent_id: string; n: number }, []>("SELECT parent_id, COUNT(*) AS n FROM agents WHERE status = 'waiting' GROUP BY parent_id").all()) parked.set(r.parent_id, r.n);

  // Why a failed session failed: its last turn, and the Errors row of that turn when there is one.
  const failure = (s: Session): NonNullable<OverviewRow["failed"]> => {
    const t = tables.turns
      ? db.query<{ turn_event: string; ts: number; ms: number | null; outcome: string }, [string]>("SELECT turn_event, ts, ms, outcome FROM telemetry_turns WHERE session_id = ? ORDER BY ts DESC, id DESC LIMIT 1").get(s.id)
      : undefined;
    const bad = t && t.outcome !== "ok" && !t.outcome.startsWith("stopped") ? t : undefined;
    const e = bad ? db.query<{ id: string; source: string }, [string, string]>("SELECT id, source FROM errors WHERE session_id = ? AND turn_event = ? ORDER BY ts DESC LIMIT 1").get(s.id, bad.turn_event) : undefined;
    const cls = bad ? why(bad.outcome, bad.outcome === "error" ? classOf(bad.turn_event) : null) : null;
    const what = !bad ? "its last turn did not end" : cls === "error" ? (e?.source === "tool" ? "a tool failed" : e?.source === "server" ? "the daemon failed" : "its last turn failed")
      : bad.outcome === "error" ? `${cls}` : bad.outcome === "refusal" ? "the model declined" : bad.outcome === "cut" ? "cut by a daemon restart" : "ended at its budget";
    return { ts: s.settings.failed_ms ?? (bad ? bad.ts + (bad.ms ?? 0) : s.updated), why: what, ...(bad ? { turn: bad.turn_event } : {}), ...(e ? { error_id: e.id } : {}) };
  };

  const counts = from.counts();
  const row = (s: Session): OverviewRow => {
    const st = from.state(s, counts);
    const below = under(s.id);
    const r: OverviewRow = {
      id: s.id, title: s.title, watch: st.watch, agents: st.agents,
      approvals: [s.id, ...below].reduce((n, id) => n + (pending.get(id) ?? 0), 0), parked: parked.get(s.id) ?? 0,
      ...(st.watch === "stop" && st.by ? { stopped_by: st.by } : {}),
    };
    // A waiting session says what it waits for, as one that works says its step: a turn that
    // continues by itself when a provider's wait is over, a timer, a command, a parked agent.
    if (st.watch === "need" || st.watch === "work" || st.watch === "resume" || st.watch === "wait") {
      const lines = from.now(s.id).lines.filter((l) => l.kind !== "idle");
      const l = lines[0];
      if (l) {
        r.line = nowWords(l, st.agents, r.parked);
        if ((l.open || l.kind === "restart") && l.ts < as_of) r.from = l.ts;
        if (l.until) r.until = l.until;
        if (lines.length > 1) r.more = lines.length - 1;
        if (l.refs) r.refs = l.refs;
      } else Object.assign(r, waitingOf(st, as_of)); // no line of its own: what it waits on and until when, from its state (waiting-line.ts)
    } else if (st.watch === "fail") r.failed = failure(s);
    else if (st.watch !== "idle") r.last = s.updated;
    const d = rolled(s.id);
    if (d) r.did = d;
    return r;
  };
  const ranked = (rows: OverviewRow[]) => rows.sort((a, b) => WATCH_RANK[a.watch] - WATCH_RANK[b.watch] || (b.from ?? b.failed?.ts ?? b.last ?? 0) - (a.from ?? a.failed?.ts ?? a.last ?? 0));

  // The asking session's agents: those still at work, and those that started
  // or ended in the window. Every one is counted; the rows are the failed
  // ones first (a failure is what a coordinator must not miss), then those at
  // work, then the rest, the newest first, and the others are counted by status.
  let mine: OverviewRow[] | undefined;
  let agentsTotal: number | undefined;
  let agentsUnlisted: Record<string, number> | undefined;
  if (opts.of && tables.agents) {
    mine = [];
    const all = db.query<{ id: string; session_id: string; status: string; ended: number | null; stopped_by: string | null; end_reason: string | null }, [string, number, number]>(
      `SELECT id, session_id, status, ended, ${from.store.columnExists("agents", "stopped_by") ? "stopped_by, end_reason" : "NULL AS stopped_by, NULL AS end_reason"} FROM agents WHERE parent_id = ? AND (status IN ('running', 'waiting') OR ended >= ? OR created >= ?) ORDER BY (status = 'failed') DESC, (status IN ('running', 'waiting')) DESC, COALESCE(ended, created) DESC`).all(opts.of, since, since);
    agentsTotal = all.length;
    const shown = Math.min(Math.max(opts.agentsMax ?? AGENTS_MAX, 1), 40);
    for (const a of all.slice(0, shown)) {
      const s = from.store.session(a.session_id);
      if (!s) continue;
      const r = { ...row(s), agent: { id: a.id, status: a.status, ...(a.status === "stopped" && a.stopped_by ? { stopped_by: a.stopped_by } : {}) } };
      if (ENDED.includes(a.status)) r.last = a.ended ?? s.updated;
      mine.push(r);
    }
    // An agent the model declined is said so, apart from one that did not finish otherwise.
    for (const a of all.slice(shown)) { const k = a.status === "incomplete" && a.end_reason === "refusal" ? "declined" : a.status; (agentsUnlisted ??= {})[k] = (agentsUnlisted[k] ?? 0) + 1; }
    ranked(mine);
  }

  const all = from.store.sessions().filter((s) => !s.parent_id && s.id !== opts.of);
  // The asking session's agents are rows of the same answer: they count toward the bound.
  const max = Math.max(Math.min(Math.max(opts.max ?? MAX, 1), 200) - (mine?.length ?? 0), 1);
  // Past the bound the quiet ones go first: a session that needs the owner is
  // never the one left out, and within a state the ones left out are those
  // that did least in the window (a session of a thousand turns that just
  // ended is not "quiet" because four small ones ended after it).
  const rows = ranked(all.map(row));
  const busy = (r: OverviewRow) => (r.did ? r.did.turns + (r.did.cut ?? 0) + 1 : 0);
  const kept = new Set([...rows].sort((a, b) => WATCH_RANK[a.watch] - WATCH_RANK[b.watch] || busy(b) - busy(a)).slice(0, max));
  const listed = rows.filter((r) => kept.has(r)), left = rows.filter((r) => !kept.has(r));
  const leftDid = { turns: left.reduce((n, r) => n + (r.did?.turns ?? 0), 0), cost: left.reduce((n, r) => n + (r.did?.cost ?? 0), 0) };
  // "The quietest" holds when no hidden session did more than any listed one. Otherwise the line says
  // their states and names the busiest of them.
  // (Of several that did as much: the one that spent most, then by title, so the same sessions give the same name.)
  const ahead = (a: OverviewRow, b: OverviewRow) => busy(b) - busy(a) || (b.did?.cost ?? 0) - (a.did?.cost ?? 0) || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) || (a.id < b.id ? -1 : 1);
  const most = left.filter((r) => busy(r) > 0).sort(ahead)[0];
  const quiet = !most || listed.every((r) => busy(r) >= busy(most));
  const leftBy: Record<string, number> = {};
  if (!quiet || left.some((r) => r.watch !== "done" && r.watch !== "idle")) for (const r of left) leftBy[r.watch] = (leftBy[r.watch] ?? 0) + 1;
  // Who spent most, over every session: a row's place in the list says nothing about its spend.
  const top = from.store.sessions().filter((s) => !s.parent_id).map((s) => ({ id: s.id, title: s.title, cost: rolled(s.id)?.cost ?? 0 }))
    .filter((r) => r.cost > 0).sort((a, b) => b.cost - a.cost).slice(0, 3);
  // The sessions' own turns and their agents' ends (the hidden sessions' too); the spend is everyone's.
  const totals: Overview["totals"] = { turns: 0, failed: 0, agents: {}, cost: 0 };
  for (const s of from.store.sessions().filter((x) => !x.parent_id)) {
    const d = did.get(s.id);
    if (!d) continue;
    totals.turns += d.turns;
    if (d.cut) totals.cut = (totals.cut ?? 0) + d.cut;
    totals.failed += Object.values(d.failed).reduce((n, x) => n + x, 0);
    for (const [k, n] of Object.entries(d.agents)) totals.agents[k] = (totals.agents[k] ?? 0) + n;
  }
  for (const d of did.values()) {
    totals.cost += d.cost;
    if (d.unpriced) totals.unpriced = true;
  }
  return {
    as_of, since, until, sessions: listed, ...(mine ? { agents: mine, agents_total: agentsTotal, ...(agentsUnlisted ? { agents_unlisted: agentsUnlisted } : {}) } : {}),
    hidden: left.length, ...(leftDid.turns || leftDid.cost ? { hidden_did: leftDid } : {}), ...(Object.keys(leftBy).length ? { hidden_by: leftBy } : {}),
    ...(!quiet && most ? { hidden_busiest: { id: most.id, title: most.title, turns: most.did?.turns ?? 0, cost: most.did?.cost ?? 0 } } : {}),
    ...(top.length ? { top } : {}), totals,
  };
}

// --- the text form. Times are the machine's local time with its offset, as every other text says them. Kept short for a
// model: twenty rows stay under 1.5k tokens also when every row is heavy. A
// row names its session only, by the last twelve characters of its id
// (session-ref.ts takes them; the session's timeline has its turns and
// errors), a title is cut, and a list of classes says its two largest and
// counts the rest. A text still over the bound is written again with less in
// each row (the agents' ends, then shorter titles and a clipped line of what
// it does now, then the classes, then the spend), which the first line and
// the JSON form keep.
const TITLE = 37;
// The bound is in tokens, counted from the shape of the text: bytes a token
// run from 2.25 (titles of hex and numbers) to 3.1 (prose) on these forms, so
// a bound in bytes either lets the first through or cuts the second early.
export const TEXT_TOKENS = 1500;
// The tokens of one of these texts, never under what a local BPE (o200k)
// counted on them and at most a sixth over: a word is one token and a fifth
// more for each letter past eight, a run with a digit in it is a token per
// 1.3 characters, a line break is one, any other sign 1.2.
export function tokensOf(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/[A-Za-z]+|[0-9A-Za-z]*[0-9][0-9A-Za-z]*|\s+|[^]/g)) {
    const w = m[0];
    if (/^\s/.test(w)) n += w.includes("\n") ? 1 : 0;
    else if (/^[A-Za-z]+$/.test(w)) n += w.length <= 8 ? 1 : 1 + (w.length - 8) / 5;
    else if (/[0-9]/.test(w)) n += Math.max(1, w.length / 1.3);
    else n += 1.2;
  }
  return Math.ceil(n);
}
// What a session does now, past this many characters, is clipped from level 2 (a turn that runs tools with long names).
const LINE = 60;
const LEVELS = 4;
// The text at the fullest level that fits the bound: `rows` rows have 20 rows' bound each 20.
export function fitted(render: (level: number) => string, rows: number, bound = TEXT_TOKENS): string {
  const room = bound * Math.max(1, rows / MAX);
  for (let level = 0; ; level++) {
    const t = render(level);
    if (level === LEVELS || tokensOf(t) <= room) return t;
  }
}
// A session's short id: the last twelve characters of its id, the shape of an agent's id.
export const shortId = (id: string) => id.slice(-12);
export const name = (t: string, fallback = "(untitled)", max = TITLE) => { const s = t.replace(/\s+/g, " ").trim(); return s ? `"${s.length > max ? `${s.slice(0, max - 1)}…` : s}"` : fallback; };
export const usd = (c: number) => `$${c > 0 && c < 0.01 ? c.toFixed(4) : c.toFixed(2)}`;
const stamp = (ts: number) => `${localDay(ts)} ${localTime(ts).slice(0, 5)}`;
const clock = (ts: number, by: number) => (localDay(ts) === localDay(by) ? localTime(ts).slice(0, 5) : stamp(ts));
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const AGENT_WORD: Record<string, string> = { completed: "reported", failed: "failed", incomplete: "unfinished", stopped: "stopped" };
const UNLISTED_WORD: Record<string, string> = { ...AGENT_WORD, declined: "declined", running: "at work", waiting: "parked" };
// The ends of agents past the listed rows, every one with its count, the failed first: the parts add up to the whole.
const ORDER = ["failed", "declined", "incomplete", "stopped", "completed", "waiting", "running"];
export function unlistedText(by: Record<string, number>): string {
  const rank = (k: string) => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length);
  return Object.entries(by).filter(([, n]) => n > 0).sort((a, b) => rank(a[0]) - rank(b[0]) || b[1] - a[1]).map(([k, n]) => `${n} ${UNLISTED_WORD[k] ?? k}`).join(", ");
}

// The two largest of a count by name, and how many more names there are: "6 rate limit, 2 overloaded, 5 more".
export function topTwo(by: Record<string, number>, word: (k: string) => string = (k) => k, bare = false): string {
  const all = Object.entries(by).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const said = all.slice(0, 2).map(([k, n]) => (bare && n === 1 && all.length === 1 ? word(k) : `${n} ${word(k)}`));
  return `${said.join(", ")}${all.length > 2 ? `, ${all.length - 2} more` : ""}`;
}
const count = (by: Record<string, number>) => Object.values(by).reduce((n, x) => n + x, 0);
// "3 failed (2 rate limit, 1 declined)", "1 failed (rate limit)"; `bare`: the count alone.
export const failedText = (failed: Record<string, number>, bare = false) => (count(failed) ? `${count(failed)} failed${bare ? "" : ` (${topTwo(failed, (k) => k, true)})`}` : "");
// "agents: 2 reported" when they ended one way, else "agents: 18 ended, 3 failed".
export function agentsText(agents: Record<string, number>): string {
  const kinds = Object.entries(agents).filter(([, n]) => n > 0);
  if (!kinds.length) return "";
  if (kinds.length === 1) return `agents: ${kinds[0]![1]} ${AGENT_WORD[kinds[0]![0]] ?? kinds[0]![0]}`;
  return `agents: ${count(agents)} ended${agents.failed ? `, ${agents.failed} failed` : ""}`;
}
export const costText = (d: { cost: number; unpriced?: true }) => (d.cost || d.unpriced ? `${usd(d.cost)}${d.unpriced ? " + unpriced" : ""}` : "");

// "2 turns cut by a restart": said apart from the turns that ended, since a cut turn goes on.
export const cutText = (n: number | undefined) => (n ? `${n} cut by a restart` : "");
// "3 turns, 1 failed (rate limit), 2 cut; agents: 2 reported; $0.12"; a row with cut turns only: "2 turns cut"
// (the report's first line says what cut them). `level`: how much is left out to fit (see TEXT_TOKENS).
// `said`: the class the row already names as why it failed: a count of that class alone is not named again.
export function didText(d: Did, level = 0, said?: string): string {
  const classes = Object.keys(d.failed).filter((k) => d.failed[k]! > 0);
  const bad = failedText(d.failed, level >= 3 || (classes.length === 1 && classes[0] === said));
  const cut = d.cut ? (d.turns ? `, ${d.cut} cut` : `${plural(d.cut, "turn")} cut`) : "";
  return [`${d.turns ? `${plural(d.turns, "turn")}${bad ? `, ${bad}` : ""}` : ""}${cut}`, level >= 1 ? "" : agentsText(d.agents), level >= 4 ? "" : costText(d)].filter(Boolean).join("; ");
}
export const titleAt = (level: number) => (level >= 2 ? 24 : TITLE);

const SAYS_HOW_LONG = / for \d+ (ms|s|min|h|d)\b[^,]*$/;
// What a row says after its title.
function what(r: OverviewRow, at: number, level = 0): string {
  const ago = (ts: number) => `${dur(Math.max(at - ts, 0))} ago`;
  // A stopped one says who stopped it: "stopped by a hook 12 min ago".
  if (r.agent && r.last !== undefined && AGENT_WORD[r.agent.status]) return `${r.agent.stopped_by ? stopSays(r.agent.stopped_by) : AGENT_WORD[r.agent.status]} ${ago(r.last)}${r.failed ? `: ${r.failed.why}` : ""}`;
  if (r.failed) return `${r.failed.why}, ${ago(r.failed.ts)}`;
  const line = r.line && level >= 2 && r.line.length > LINE ? `${r.line.slice(0, LINE - 1)}…` : r.line;
  // A line that says how long itself (a stream gone silent) is not given the turn's time after it: one duration.
  if (line) return `${line}${r.from !== undefined && !SAYS_HOW_LONG.test(line) ? `, for ${dur(at - r.from)}` : ""}${r.until ? (r.until > at ? `, due in ${dur(r.until - at)}` : ", due now") : ""}`;
  if (r.watch === "stop") return `${r.stopped_by ? stopSays(r.stopped_by) : "stopped"}${r.last ? ` ${ago(r.last)}` : ""}`;
  if (r.watch === "done") return `finished${r.last ? ` ${ago(r.last)}` : ""}`;
  return WATCH_LABEL[r.watch].toLowerCase();
}

// "15 of the sessions' own turns ended, 3 failed; agents: 4 reported, 1 failed; $0.42 spent in all".
export function totalsText(t: Overview["totals"]): string {
  return [
    `${t.turns} of the sessions' own turns ended${t.failed ? `, ${t.failed} failed` : ""}${t.cut ? `, ${cutText(t.cut)}` : ""}`,
    agentsText(t.agents),
    `${usd(t.cost)}${t.unpriced ? " + unpriced" : ""} spent in all`,
  ].filter(Boolean).join("; ");
}

export function overviewText(o: Overview, opts: { ids?: boolean; tokens?: number } = {}): string {
  return fitted((level) => overviewAt(o, opts, level), o.sessions.length + (o.agents?.length ?? 0), opts.tokens);
}

function overviewAt(o: Overview, opts: { ids?: boolean }, level: number): string {
  const at = o.as_of;
  const title = (r: OverviewRow) => name(r.title, undefined, titleAt(level));
  const ids = (r: OverviewRow) => (opts.ids === false ? "" : `  [${r.agent ? `agent=${r.agent.id}` : `session=${shortId(r.id)}`}]`);
  const did = (r: OverviewRow) => { const t = r.did ? didText(r.did, level, r.failed?.why) : ""; return t ? `; ${t}` : ""; };
  const line = (r: OverviewRow) => `  ${title(r)}: ${what(r, at, level)}${did(r)}${ids(r)}`;
  const out: string[] = [`Sessions, read ${stamp(at)} ${zoneLabel(at)}: ${o.sessions.length + o.hidden} open. Since ${clock(o.since, at)} (${dur(at - o.since)}): ${totalsText(o.totals)}.`];
  if (o.agents) {
    // Every agent is counted, also the ones past the rows: what those are is said by status.
    const total = o.agents_total ?? o.agents.length;
    const rest = o.agents_unlisted ? `; ${count(o.agents_unlisted)} not listed: ${unlistedText(o.agents_unlisted)}` : "";
    out.push(total ? `Your agents (${total}${rest}):` : "Your agents: none at work, none ended since then.");
    for (const r of o.agents) out.push(line(r));
  }
  const groups = new Map<Watch, OverviewRow[]>();
  for (const r of o.sessions) groups.set(r.watch, [...(groups.get(r.watch) ?? []), r]);
  for (const [w, rows] of groups) {
    const quiet = w === "done" || w === "idle" ? rows.filter((r) => !r.did) : [];
    const told = rows.filter((r) => !quiet.includes(r));
    out.push(`${WATCH_LABEL[w]} (${rows.length}):${told.length ? "" : ` ${quiet.map(title).join(", ")}`}`);
    for (const r of told) out.push(line(r));
    if (told.length && quiet.length) out.push(`  nothing since then: ${quiet.map(title).join(", ")}`);
  }
  if (o.hidden) {
    // What the ones left out are, from all of them: at rest and the least busy, or by state when one is not; and what they did.
    const did = o.hidden_did ? ` (${[o.hidden_did.turns ? plural(o.hidden_did.turns, "turn") : "", o.hidden_did.cost ? usd(o.hidden_did.cost) : ""].filter(Boolean).join(", ")})` : "";
    const busiest = o.hidden_busiest ? `, the busiest: ${name(o.hidden_busiest.title, undefined, titleAt(level))}` : "";
    out.push(`${plural(o.hidden, "more session")} not listed${o.hidden_by ? `: ${topTwo(o.hidden_by, (k) => WATCH_LABEL[k as Watch].toLowerCase())}` : ", the quietest"}${did}${busiest}.`);
  }
  // Over every session, the hidden ones too (see `top`).
  const spent = o.top ?? [];
  if (spent.length > 1) out.push(`Most spent since then: ${spent.map((r) => `${name(r.title, undefined, titleAt(level))} ${usd(r.cost)}`).join(", ")}.`);
  return out.join("\n");
}
