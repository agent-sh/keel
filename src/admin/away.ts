// "While you were away": one digest of what happened while the owner was not
// at a page of the daemon. Per session: the turns that ended, the failures by
// class, how its agents ended, the approvals that wait, the agents parked on
// a wake of their own, and the spend. Built from the same read as the report
// across sessions (overview.ts), so the two never disagree, and content-free
// like it.
//
// The owner is present while they do something in a page: each page says with
// its report (POST /api/presence, every 20 s) how long ago its last key,
// pointer or wheel input was. A page that only has focus is not the owner. An
// absence is the gap between two inputs, when it is longer than the gap that
// makes one. Absences are kept, across daemon restarts, as a short list until
// the owner dismisses their digest, and only what happened inside them is
// counted: the time between two absences, when the owner was there, is not.
// The daemon's own time not running (it was down, or the machine slept) is no
// absence: nothing happened in it, and no report could arrive.
import { WATCH_LABEL, WATCH_RANK, type Watch } from "../core/watch.ts";
import { agentsText, costText, failedText, fitted, MAX, name, plural, shortId, SINCE_MAX_MS, titleAt, usd, type Overview, type OverviewRow } from "./overview.ts";
import { dur } from "./timeline-rows.ts";

// The gap that makes an absence. Longer than the 20 s between a page's reports.
export const awayGap = () => Number(process.env.KEEL_AWAY_MS) || 5 * 60_000;
// How often the daemon notes that it runs (and writes the record down).
export const TICK_MS = 60_000;
// A note this late means the daemon was not running in between.
const LATE_MS = TICK_MS * 2.5;
// Absences kept until dismissed: past this the oldest goes, and so does one
// that ended longer ago than the longest window a read is asked for.
export const ABSENCES = 8;

export type Absence = { from: number; to: number };
// `spans`: the absences, oldest first, the last one still going on when `present` is false.
export type AwayWindow = { spans: Absence[]; present: boolean };
type Kept = { last: number | null; alive: number | null; blind: number; away: Absence[] };

export class Presence {
  private last: number | null = null; // the owner's last input in a page
  private alive: number | null = null; // the last time the daemon noted that it runs
  private blind = 0; // time since `last` the daemon was not running: no absence is read off it
  private away: Absence[] = []; // the closed absences not dismissed yet

  // `now`: when this daemon starts. The time since the last daemon's last note is time not running.
  constructor(private io: { load(): string | null; save(v: string): void }, private gap = awayGap(), now = Date.now()) {
    try {
      const k = JSON.parse(io.load() ?? "null") as Partial<Kept> | null;
      if (typeof k?.last === "number") this.last = k.last;
      if (typeof k?.alive === "number") this.alive = k.alive;
      if (typeof k?.blind === "number" && k.blind > 0) this.blind = k.blind;
      if (Array.isArray(k?.away)) this.away = k.away.filter((a) => typeof a?.from === "number" && typeof a?.to === "number" && a.to > a.from).slice(-ABSENCES);
    } catch { /* a record that does not parse is no record */ }
    this.tick(now);
  }

  private save() {
    this.io.save(JSON.stringify({ last: this.last, alive: this.alive, blind: this.blind, away: this.away } satisfies Kept));
  }

  // The daemon runs: noted every TICK_MS. A note that comes much later than
  // that (a restart, a suspended machine) adds the time in between to `blind`.
  private note(now: number) {
    if (this.alive !== null && now - this.alive > LATE_MS) this.blind += now - this.alive;
    this.alive = now;
  }
  tick(now = Date.now()) {
    this.note(now);
    this.save();
  }

  private gone(until: number) { return this.last !== null && until - this.last - this.blind >= this.gap; }

  // The owner did something in a page at `at`. After a gap: that was an absence.
  // `now`: when the report arrived. The daemon's own note is made first, so a
  // page that reports before the minute's note after a sleep reads no absence off it.
  seen(at = Date.now(), now = at) {
    this.note(now);
    if (this.last !== null && at <= this.last) return;
    const back = this.gone(at);
    if (back) this.away = [...this.away, { from: this.last!, to: at }].slice(-ABSENCES);
    this.last = at;
    this.blind = 0;
    if (back) this.save();
  }

  // The absences to tell of: those not dismissed, and the one going on.
  // Nothing older than the longest window a read is asked for: an absence that ended before it
  // goes, and one that began before it is told from there.
  window(now = Date.now()): AwayWindow | null {
    const going = this.gone(now);
    const floor = now - SINCE_MAX_MS;
    if (this.away.some((a) => a.to <= floor)) this.away = this.away.filter((a) => a.to > floor);
    const spans = (going ? [...this.away, { from: this.last!, to: now }] : this.away).slice(-ABSENCES).map((a) => (a.from < floor ? { from: floor, to: a.to } : a));
    return spans.length ? { spans, present: !going } : null;
  }

  dismiss() {
    this.away = [];
    this.save();
  }

  get lastSeen() { return this.last; }
}

// The daemon's own record, for the route that takes the pages' reports.
let bound: Presence | undefined;
export const bindPresence = (p: Presence) => void (bound = p);
// `idleMs`: how long ago the page's owner last did something in it.
export const ownerSeen = (idleMs: number, now = Date.now()) => bound?.seen(now - Math.max(idleMs, 0), now);

// --- the digest
export type DigestRow = {
  id: string;
  title: string;
  watch: Watch;
  turns: number;
  failed: Record<string, number>;
  agents: Record<string, number>;
  approvals: number;
  parked: number;
  cost: number;
  unpriced?: true;
  text: string; // the row's facts in words
  bad?: string; // the part of `text` that went wrong
};
export type Digest = {
  from: number; // the first absence's start
  to: number; // the last one's end
  spans: Absence[];
  away_ms: number; // the absences' time in all
  present: boolean; // the owner is back: the last absence is closed
  as_of: number;
  sessions: DigestRow[]; // the sessions in which something happened while the owner was away
  quiet: number; // the other sessions
  // `turns`, `failed`: the sessions' own turns. `agents`: how their agents ended, by outcome.
  totals: { turns: number; failed: number; agents: Record<string, number>; approvals: number; parked: number; cost: number; unpriced?: true };
};

const waits = (n: number) => (n ? `${plural(n, "approval")} ${n === 1 ? "waits" : "wait"}` : "");
const parked = (n: number) => (n ? `${plural(n, "agent")} parked` : "");
type Facts = Pick<DigestRow, "turns" | "failed" | "agents" | "approvals" | "parked" | "cost" | "unpriced">;
// A row's facts in words; `level`: how much is left out to fit (overview.ts).
function factsText(r: Facts, level = 0): { text: string; bad?: string } {
  const failed = failedText(r.failed, level >= 3);
  const ended = level >= 1 ? (r.agents.failed ? agentsText({ failed: r.agents.failed }) : "") : agentsText(r.agents);
  const text = [
    r.turns ? `${plural(r.turns, "turn")} ended${failed ? `, ${failed}` : ""}` : "",
    ended, waits(r.approvals), parked(r.parked), level >= 4 ? "" : costText(r),
  ].filter(Boolean).join("; ");
  return { text, ...(failed ? { bad: failed } : r.agents.failed ? { bad: `${r.agents.failed} failed` } : {}) };
}

function digestRow(r: OverviewRow): DigestRow | null {
  // Something happened in it while the owner was away: a turn ended, an agent ended, or it spent.
  if (!r.did) return null;
  const facts: Facts = { turns: r.did.turns, failed: r.did.failed, agents: r.did.agents, approvals: r.approvals, parked: r.parked, cost: r.did.cost, ...(r.did.unpriced ? { unpriced: true as const } : {}) };
  return { id: r.id, title: r.title, watch: r.watch, ...facts, ...factsText(facts) };
}

// `o`: the report across sessions, read for the absences (overview's `spans`).
// Null when nothing happened in them: there is nothing to tell.
export function digest(o: Overview, w: AwayWindow): Digest | null {
  const rows = o.sessions.map(digestRow).filter((r): r is DigestRow => !!r);
  if (!rows.length) return null;
  rows.sort((a, b) => WATCH_RANK[a.watch] - WATCH_RANK[b.watch] || b.turns - a.turns);
  const sum = (f: (r: DigestRow) => number) => rows.reduce((n, r) => n + f(r), 0);
  const agents: Record<string, number> = {};
  for (const r of rows) for (const [k, n] of Object.entries(r.agents)) agents[k] = (agents[k] ?? 0) + n;
  return {
    from: w.spans[0]!.from, to: w.spans.at(-1)!.to, spans: w.spans, away_ms: w.spans.reduce((n, s) => n + (s.to - s.from), 0), present: w.present, as_of: o.as_of,
    sessions: rows, quiet: o.sessions.length + o.hidden - rows.length,
    totals: {
      turns: sum((r) => r.turns), failed: sum((r) => Object.values(r.failed).reduce((n, x) => n + x, 0)), agents, approvals: sum((r) => r.approvals), parked: sum((r) => r.parked),
      cost: sum((r) => r.cost), ...(rows.some((r) => r.unpriced) ? { unpriced: true as const } : {}),
    },
  };
}

// "6 of the sessions' own turns ended in 4 sessions, 2 failed; agents: 3 ended, 1 failed; 1 approval waits; 1 agent parked; $0.42 spent in all".
export function digestTotals(d: Digest): string {
  const t = d.totals;
  const busy = d.sessions.filter((r) => r.turns).length;
  return [
    `${t.turns} of the sessions' own turns ended${t.turns ? ` in ${plural(busy, "session")}` : ""}${t.failed ? `, ${t.failed} failed` : ""}`,
    agentsText(t.agents), waits(t.approvals), parked(t.parked),
    `${usd(t.cost)}${t.unpriced ? " + unpriced" : ""} spent in all`,
  ].filter(Boolean).join("; ");
}

// The same in a few words, for one line: "6 turns ended, 2 failed; 1 agent failed; 1 approval waits".
export function digestBrief(d: Digest): string {
  const t = d.totals;
  return [`${plural(t.turns, "turn")} ended${t.failed ? `, ${t.failed} failed` : ""}`, t.agents.failed ? `${plural(t.agents.failed, "agent")} failed` : "", waits(t.approvals)].filter(Boolean).join("; ");
}

// The text form. Times are UTC, as the timeline's. `since`: the window was
// asked for, not an absence. Twenty rows at most, within the report's bound
// (overview.ts): the rest are counted.
const hm = (ts: number, by: number) => (new Date(ts).toISOString().slice(0, 10) === new Date(by).toISOString().slice(0, 10) ? new Date(ts).toISOString().slice(11, 16) : new Date(ts).toISOString().slice(0, 16).replace("T", " "));
export function digestText(d: Digest, opts: { ids?: boolean; since?: boolean } = {}): string {
  const many = d.spans.length > 1;
  const span = opts.since ? `From ${hm(d.from, d.as_of)} to ${hm(d.to, d.as_of)} UTC (${dur(d.to - d.from)})`
    : d.present
      ? `While you were away, ${many ? `${d.spans.length} times between ${hm(d.from, d.as_of)} and ${hm(d.to, d.as_of)} UTC (${dur(d.away_ms)} in all)` : `${hm(d.from, d.as_of)} to ${hm(d.to, d.as_of)} UTC (${dur(d.away_ms)})`}`
      : `While you are away, ${many ? `${d.spans.length} times since ${hm(d.from, d.as_of)} UTC (${dur(d.away_ms)} in all)` : `since ${hm(d.from, d.as_of)} UTC (${dur(d.away_ms)})`}`;
  const shown = d.sessions.slice(0, MAX);
  const more = d.sessions.length - shown.length;
  return fitted((level) => {
    const out = [`${span}: ${digestTotals(d)}.`];
    for (const r of shown) out.push(`  ${name(r.title, undefined, titleAt(level))}, ${WATCH_LABEL[r.watch].toLowerCase()}: ${factsText(r, level).text}${opts.ids === false ? "" : `  [session=${shortId(r.id)}]`}`);
    if (more) out.push(`${plural(more, "more session")} with something to tell, not listed.`);
    if (d.quiet) out.push(`${plural(d.quiet, "other session")}: nothing happened.`);
    return out.join("\n");
  }, shown.length);
}
