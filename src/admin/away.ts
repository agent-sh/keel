// "While you were away": one digest of what happened while the owner was not
// at a page of the daemon. Per session: the turns that ended, the failures by
// class, how its agents ended, the approvals that wait, the agents parked on
// a wake of their own, and the spend. Built from the same read as the report
// across sessions (overview.ts), so the two never disagree, and content-free
// like it. Before the sessions it tells what the daemon itself went through in
// that time: each time it went down and came back (how, for how long, the
// turns that cut and what became of them) and the stalls of its loop with
// their named causes. Open questions are counted with the approvals.
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
import { localDay, localTime, zoneLabel } from "../core/clock.ts";
import { WATCH_LABEL, WATCH_RANK, type Watch } from "../core/watch.ts";
import type { DaemonFacts, StallFact } from "./daemon-facts.ts";
import { type Restart, restartSummary } from "./life-rows.ts";
import { agentsText, costText, cutText, failedText, fitted, MAX, name, plural, shortId, SINCE_MAX_MS, titleAt, usd, type Overview, type OverviewRow } from "./overview.ts";
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
  turns: number; // its own turns that ended
  cut?: number;  // those a daemon restart cut: they did not end
  failed: Record<string, number>;
  agents: Record<string, number>;
  approvals: number;
  questions: number; // questions the session or its agents asked that wait for an answer
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
  // `approvals`, `questions`: what waits for the owner now in these sessions (a card in a session where nothing else happened is the Inbox's to tell).
  totals: { turns: number; cut?: number; failed: number; agents: Record<string, number>; approvals: number; questions: number; parked: number; cost: number; unpriced?: true };
  // What the daemon went through in the absences: sentences, the oldest first, a bounded few.
  daemon: string[];
  // The same in a few words, for one line ("the daemon went down and came back after 29 s, 6 turns cut").
  daemon_brief?: string;
};

// What the digest is told besides the sessions' report.
export type DigestMore = { daemon?: DaemonFacts; questions?: Record<string, number> };

// --- what the daemon went through
const RESTARTS_TOLD = 3;
const CAUSES_TOLD = 3;
const secs = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : dur(ms));
// "2 times, 9.9 s in all: 6.0 s blocked by its own code; 3.9 s waiting for a child: sleep 4".
export function stallsLine(stalls: StallFact[]): string {
  if (!stalls.length) return "";
  const total = stalls.reduce((n, s) => n + s.ms, 0);
  // One entry a cause, the longest first: the cause is what the stall's row says after its duration.
  const by = new Map<string, { ms: number; n: number }>();
  for (const s of stalls) {
    const what = s.what.replace(/^[:\s]+/, "").trim() || "cause not known";
    const c = by.get(what) ?? by.set(what, { ms: 0, n: 0 }).get(what)!;
    c.ms += s.ms;
    c.n++;
  }
  const causes = [...by].sort((a, b) => b[1].ms - a[1].ms);
  const told = causes.slice(0, CAUSES_TOLD).map(([what, c]) => `${secs(c.ms)}${c.n > 1 ? ` (${c.n} times)` : ""} ${what}`);
  if (causes.length > CAUSES_TOLD) told.push(`${causes.length - CAUSES_TOLD} more causes`);
  return `The daemon was unresponsive ${stalls.length === 1 ? "once" : `${stalls.length} times`}, ${secs(total)}${stalls.length > 1 ? " in all" : ""}: ${told.join("; ")}.`;
}
// The sentences, a bounded few: the newest restarts, then the stalls in one.
export function daemonLines(f: DaemonFacts | undefined): string[] {
  if (!f) return [];
  const out: string[] = [];
  const told = f.restarts.slice(-RESTARTS_TOLD);
  if (f.restarts.length > told.length) out.push(`The daemon started ${f.restarts.length} times; the last ${told.length}:`);
  for (const r of told) out.push(restartSummary(r));
  const stalls = stallsLine(f.stalls);
  if (stalls) out.push(stalls);
  return out;
}
const downWords = (r: Restart) => (r.before ? `${r.before.how === "killed" ? "went down" : r.before.how === "crash" ? "ended on a failure" : r.before.how === "restart" ? "restarted" : "was stopped"} and came back after ${dur(Math.max(0, r.up_ms - r.before.down_ms))}` : "started");
// "the daemon went down and came back after 29 s, 6 turns cut; unresponsive twice".
export function daemonBrief(f: DaemonFacts | undefined): string {
  if (!f || (!f.restarts.length && !f.stalls.length)) return "";
  const cut = f.restarts.reduce((n, r) => n + r.turns.filter((t) => !t.earlier).length, 0);
  const last = f.restarts.at(-1);
  // (A start that does not know how the daemon before it ended is a start, not a time it went down.)
  const downs = f.restarts.filter((r) => r.before).length;
  const went = !last ? "" : `the daemon ${f.restarts.length > 1 ? (downs === f.restarts.length ? `went down ${downs} times` : `started ${f.restarts.length} times`) : downWords(last)}${cut ? `, ${plural(cut, "turn")} cut` : ""}`;
  const stalled = f.stalls.length ? `${went ? "" : "the daemon was "}unresponsive ${f.stalls.length === 1 ? "once" : `${f.stalls.length} times`}` : "";
  return [went, stalled].filter(Boolean).join("; ");
}

// "1 approval and 2 questions wait", "1 question waits".
export function waits(approvals: number, questions = 0): string {
  const parts = [approvals ? plural(approvals, "approval") : "", questions ? plural(questions, "question") : ""].filter(Boolean);
  return parts.length ? `${parts.join(" and ")} ${approvals + questions === 1 ? "waits" : "wait"}` : "";
}
const parked = (n: number) => (n ? `${plural(n, "agent")} parked` : "");
type Facts = Pick<DigestRow, "turns" | "cut" | "failed" | "agents" | "approvals" | "questions" | "parked" | "cost" | "unpriced">;
// A row's facts in words; `level`: how much is left out to fit (overview.ts).
function factsText(r: Facts, level = 0): { text: string; bad?: string } {
  const failed = failedText(r.failed, level >= 3);
  const ended = level >= 1 ? (r.agents.failed ? agentsText({ failed: r.agents.failed }) : "") : agentsText(r.agents);
  const text = [
    r.turns ? `${plural(r.turns, "turn")} ended${failed ? `, ${failed}` : ""}` : "",
    // A turn a restart cut did not end: said apart ("2 turns cut by a restart" for a session that only waited).
    r.cut ? (r.turns ? cutText(r.cut) : `${plural(r.cut, "turn")} cut by a restart`) : "",
    ended, waits(r.approvals, r.questions), parked(r.parked), level >= 4 ? "" : costText(r),
  ].filter(Boolean).join("; ");
  return { text, ...(failed ? { bad: failed } : r.agents.failed ? { bad: `${r.agents.failed} failed` } : {}) };
}

function digestRow(r: OverviewRow, questions: number): DigestRow | null {
  // Something happened in it while the owner was away: a turn ended, an agent ended, or it spent.
  if (!r.did) return null;
  const facts: Facts = { turns: r.did.turns, ...(r.did.cut ? { cut: r.did.cut } : {}), failed: r.did.failed, agents: r.did.agents, approvals: r.approvals, questions, parked: r.parked, cost: r.did.cost, ...(r.did.unpriced ? { unpriced: true as const } : {}) };
  return { id: r.id, title: r.title, watch: r.watch, ...facts, ...factsText(facts) };
}

// `o`: the report across sessions, read for the absences (overview's `spans`).
// `more`: what the daemon went through in them, and the open questions by
// session (an agent's under its parent too). Null when nothing happened in
// them, to the sessions or to the daemon: there is nothing to tell.
export function digest(o: Overview, w: AwayWindow, more: DigestMore = {}): Digest | null {
  const asked = more.questions ?? {};
  const rows = o.sessions.map((r) => digestRow(r, asked[r.id] ?? 0)).filter((r): r is DigestRow => !!r);
  const daemon = daemonLines(more.daemon);
  if (!rows.length && !daemon.length) return null;
  rows.sort((a, b) => WATCH_RANK[a.watch] - WATCH_RANK[b.watch] || b.turns - a.turns);
  const sum = (f: (r: DigestRow) => number) => rows.reduce((n, r) => n + f(r), 0);
  const agents: Record<string, number> = {};
  for (const r of rows) for (const [k, n] of Object.entries(r.agents)) agents[k] = (agents[k] ?? 0) + n;
  const brief = daemonBrief(more.daemon);
  return {
    from: w.spans[0]!.from, to: w.spans.at(-1)!.to, spans: w.spans, away_ms: w.spans.reduce((n, s) => n + (s.to - s.from), 0), present: w.present, as_of: o.as_of,
    sessions: rows, quiet: o.sessions.length + o.hidden - rows.length,
    totals: {
      turns: sum((r) => r.turns), ...(sum((r) => r.cut ?? 0) ? { cut: sum((r) => r.cut ?? 0) } : {}), failed: sum((r) => Object.values(r.failed).reduce((n, x) => n + x, 0)), agents,
      approvals: sum((r) => r.approvals), questions: sum((r) => r.questions), parked: sum((r) => r.parked),
      cost: sum((r) => r.cost), ...(rows.some((r) => r.unpriced) ? { unpriced: true as const } : {}),
    },
    daemon, ...(brief ? { daemon_brief: brief } : {}),
  };
}

// The turns a restart cut, in the totals: said there unless the daemon's own account on the same line already counts them.
const cutSaid = (d: Digest): string => (d.totals.cut && !/\bturns? cut\b/.test(d.daemon_brief ?? "") ? `, ${cutText(d.totals.cut)}` : "");

// "6 of the sessions' own turns ended in 4 sessions, 2 failed; agents: 3 ended, 1 failed; 1 approval waits; 1 agent parked; $0.42 spent in all".
export function digestTotals(d: Digest): string {
  const t = d.totals;
  const busy = d.sessions.filter((r) => r.turns).length;
  return [
    `${t.turns} of the sessions' own turns ended${t.turns ? ` in ${plural(busy, "session")}` : ""}${t.failed ? `, ${t.failed} failed` : ""}${cutSaid(d)}`,
    agentsText(t.agents), waits(t.approvals, t.questions), parked(t.parked),
    `${usd(t.cost)}${t.unpriced ? " + unpriced" : ""} spent in all`,
  ].filter(Boolean).join("; ");
}

// The same in a few words, for one line: "the daemon went down and came back
// after 29 s, 6 turns cut; 6 turns ended, 2 failed; 1 agent failed; 1 approval and 1 question wait".
export function digestBrief(d: Digest): string {
  const t = d.totals;
  return [
    d.daemon_brief ?? "",
    t.turns || !d.daemon_brief ? `${plural(t.turns, "turn")} ended${t.failed ? `, ${t.failed} failed` : ""}${cutSaid(d)}` : cutSaid(d).slice(2),
    t.agents.failed ? `${plural(t.agents.failed, "agent")} failed` : "", waits(t.approvals, t.questions),
  ].filter(Boolean).join("; ");
}

// The text form. Times are local, with the zone's offset said once on the
// first line (clock.ts), as in every text Keel writes. `since`: the window was asked
// for, not an absence. The daemon's own account comes first, a few sentences
// at most; then twenty rows at most, within the report's bound (overview.ts):
// the rest are counted.
export const hms = (ts: number, by: number) => (localDay(ts) === localDay(by) ? localTime(ts) : `${localDay(ts)} ${localTime(ts)}`);
export function digestText(d: Digest, opts: { ids?: boolean; since?: boolean } = {}): string {
  const many = d.spans.length > 1;
  const at = (ts: number) => hms(ts, d.as_of);
  // The zone is said once, where the old text said UTC: after the last time of the span.
  const z = zoneLabel(d.as_of);
  const span = opts.since ? `From ${at(d.from)} to ${at(d.to)} ${z} (${dur(d.to - d.from)})`
    : d.present
      ? `While you were away, ${many ? `${d.spans.length} times between ${at(d.from)} and ${at(d.to)} ${z} (${dur(d.away_ms)} in all)` : `${at(d.from)} to ${at(d.to)} ${z} (${dur(d.away_ms)})`}`
      : `While you are away, ${many ? `${d.spans.length} times since ${at(d.from)} ${z} (${dur(d.away_ms)} in all)` : `since ${at(d.from)} ${z} (${dur(d.away_ms)})`}`;
  const shown = d.sessions.slice(0, MAX);
  const more = d.sessions.length - shown.length;
  return fitted((level) => {
    // The first line names what the daemon went through, then the totals; its sentences follow.
    const out = [`${span}: ${d.daemon_brief ? `${d.daemon_brief}; ` : ""}${digestTotals(d)}.`, ...d.daemon];
    for (const r of shown) out.push(`  ${name(r.title, undefined, titleAt(level))}, ${WATCH_LABEL[r.watch].toLowerCase()}: ${factsText(r, level).text}${opts.ids === false ? "" : `  [session=${shortId(r.id)}]`}`);
    if (more) out.push(`${plural(more, "more session")} with something to tell, not listed.`);
    if (d.quiet) out.push(`${plural(d.quiet, "other session")}: nothing happened.`);
    return out.join("\n");
  }, shown.length);
}
