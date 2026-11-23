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
import { localTime, zoned, zonedPair, zoneLabel } from "../core/clock.ts";
import { WATCH_LABEL, WATCH_RANK, type Watch } from "../core/watch.ts";
import type { DaemonFacts, OutageFact, StallFact } from "./daemon-facts.ts";
import { downMs, type Restart, restartSummary, tally } from "./life-rows.ts";
import { agentsText, costText, cutText, failedText, fitted, MAX, name, plural, shortId, SINCE_MAX_MS, titleAt, usd, type Overview, type OverviewRow } from "./overview.ts";
import { dur } from "./timeline-rows.ts";

// The gap that makes an absence. Longer than the 20 s between a page's reports.
export const awayGap = () => Number(process.env.KEEL_AWAY_MS) || 5 * 60_000;
// How often the daemon notes that it runs. The record is written down then
// only when it changed (the owner's last input, an absence, time not
// running), and at the latest every SAVE_MS: when the daemon went down is
// read from its sign of life at the next start (src/admin/life.ts), so a
// daemon nobody is at writes nothing for this.
export const TICK_MS = 60_000;
const SAVE_MS = 15 * TICK_MS;
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

  private saved = "";
  private savedAt = 0;

  // `now`: when this daemon starts. The time since the last daemon's last note is time not running.
  // `downAt`: when the daemon before this one went down, when its sign of life says: it ran until then,
  // whatever the record's last note says.
  constructor(private io: { load(): string | null; save(v: string): void }, private gap = awayGap(), now = Date.now(), downAt?: number) {
    try {
      const k = JSON.parse(io.load() ?? "null") as Partial<Kept> | null;
      if (typeof k?.last === "number") this.last = k.last;
      if (typeof k?.alive === "number") this.alive = k.alive;
      if (typeof k?.blind === "number" && k.blind > 0) this.blind = k.blind;
      if (Array.isArray(k?.away)) this.away = k.away.filter((a) => typeof a?.from === "number" && typeof a?.to === "number" && a.to > a.from).slice(-ABSENCES);
    } catch { /* a record that does not parse is no record */ }
    if (typeof downAt === "number" && downAt <= now && (this.alive === null || downAt > this.alive)) this.alive = downAt;
    this.note(now);
    this.save(now);
  }

  private save(now = Date.now()) {
    this.saved = JSON.stringify([this.last, this.blind, this.away]);
    this.savedAt = now;
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
    if (now - this.savedAt >= SAVE_MS || JSON.stringify([this.last, this.blind, this.away]) !== this.saved) this.save(now);
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
    if (back) this.save(now);
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
const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);
// A stall's cause without what makes two stalls of one cause read differently: the
// duration it opens with, a process id, a pressure figure.
export const stallCause = (what: string): string =>
  what.replace(/^[:\s]+/, "").replace(/^\d+(?:\.\d+)?\s*(?:ms|s|min|h)\s+/, "").replace(/\s*\((?:pid \d+|[A-Za-z ]*pressure \d+%|machine load \d+(?:, [A-Za-z ]*pressure \d+%)?)\)/g, "").trim() || "cause not known";
// "4 times, 15 s in all: 9.0 s (2 times) stopped by a signal; 6.0 s waiting for a child: git status and others."
// One entry a kind of cause, the longest first, in the words of its longest stall.
export function stallsLine(stalls: StallFact[]): string {
  if (!stalls.length) return "";
  const total = stalls.reduce((n, s) => n + s.ms, 0);
  const by = new Map<string, { ms: number; n: number; longest: number; what: string; texts: Set<string> }>();
  for (const s of stalls) {
    const what = stallCause(s.what);
    const c = by.get(s.kind || what) ?? by.set(s.kind || what, { ms: 0, n: 0, longest: -1, what, texts: new Set() }).get(s.kind || what)!;
    c.ms += s.ms;
    c.n++;
    c.texts.add(what);
    if (s.ms > c.longest) { c.longest = s.ms; c.what = what; }
  }
  const causes = [...by.values()].sort((a, b) => b.ms - a.ms);
  const told = causes.slice(0, CAUSES_TOLD).map((c) => `${secs(c.ms)}${c.n > 1 ? ` (${c.n} times)` : ""} ${c.what}${c.texts.size > 1 ? " and others of that kind" : ""}`);
  if (causes.length > CAUSES_TOLD) told.push(`${causes.length - CAUSES_TOLD} more ${causes.length - CAUSES_TOLD === 1 ? "kind of cause" : "kinds of cause"}`);
  return `The daemon was unresponsive ${stalls.length === 1 ? "once" : `${stalls.length} times`}, ${secs(total)}${stalls.length > 1 ? " in all" : ""}: ${told.join("; ")}.`;
}

// How a start came about decides how it is told. `own`: nobody asked the daemon to stop
// (a kill, the machine, a failure of its own, an end nothing recorded). `asked`: a restart or a
// stop somebody asked for. An asked one is never told as the daemon going down. `signal`: a stop
// signal from outside: neither asked of Keel nor the daemon's own doing, and said as such.
const wasAsked = (r: Restart) => r.before?.how === "restart" || r.before?.how === "stop";
const bySignal = (r: Restart) => r.before?.how === "signal";
const longest = (rs: Restart[]) => rs.reduce((n, r) => Math.max(n, downMs(r)), 0);
const cutOf = (rs: Restart[]) => rs.flatMap((r) => r.turns.filter((t) => !t.earlier));
const downOf = (rs: Restart[]) => rs.reduce((n, r) => n + downMs(r), 0);
// "(killed, or the machine went down; ended on a failure)": the ways among these starts.
function ownWays(rs: Restart[]): string {
  const has = (how: string | undefined) => rs.some((r) => r.before?.how === how);
  return [has("killed") ? "killed, or the machine went down" : "", has("crash") ? "ended on a failure" : "", rs.some((r) => !r.before) ? "an end that was not recorded" : ""].filter(Boolean).join("; ");
}
// The sentences, a bounded few. The starts nobody asked for come first, the newest of them
// each in a sentence; the asked ones are one sentence: how many, the time down, what they cut.
// Then the stalls in one.
// Whether what the daemon went through is worth a digest by itself: asked restarts that cut
// nothing are not (they are told beside whatever else there is to tell).
export const daemonTold = (f: DaemonFacts | undefined): boolean => !!f && (f.restarts.some((r) => !wasAsked(r)) || f.stalls.length > 0 || cutOf(f.restarts).length > 0 || !!f.outages?.length);

// A provider outage in the absence, in one sentence: the provider, when, how long, the turns that
// waited in it and whether they went on. "Bedrock could not be reached from 03:12:40 to 03:15:10 CET
// (2 min 30 s): 3 turns waited and went on when it answered."
const OUTAGES_TOLD = 3;
// How long it lasted, to the second under an hour: an outage of minutes is read by its seconds too.
const lasted = (ms: number) => {
  const t = Math.round(ms / 1000);
  return ms < 60_000 || ms >= 3_600_000 ? secs(ms) : `${Math.floor(t / 60)} min${t % 60 ? ` ${t % 60} s` : ""}`;
};
const turnsWaited = (n: number, still: boolean) => (n ? `${plural(n, "turn")} ${still ? (n === 1 ? "waits" : "wait") : "waited"}` : still ? "no turn waits" : "no turn waited");
export function outageLine(o: OutageFact): string {
  if (o.ms === null) return `${o.label} cannot be reached since ${localTime(o.since)} ${zoneLabel(o.since)}: ${turnsWaited(o.sessions, true)}${o.sessions ? ` and ${o.sessions === 1 ? "goes" : "go"} on when it answers` : ""}.`;
  const [a, b] = zonedPair(o.since, o.since + o.ms);
  const what = !o.sessions ? turnsWaited(0, false) : o.answered ? `${turnsWaited(o.sessions, false)} and went on when it answered` : `${turnsWaited(o.sessions, false)}; none waits for it any more`;
  return `${o.label} could not be reached from ${a} to ${b} (${lasted(o.ms)}): ${what}.`;
}
// "Bedrock could not be reached for 2 min 30 s, 3 turns waited"; two or more: "Bedrock could not be reached twice, 4 turns waited".
function outageBrief(os: OutageFact[] | undefined): string {
  if (!os?.length) return "";
  const by = new Map<string, OutageFact[]>();
  for (const o of os) by.set(o.label, [...(by.get(o.label) ?? []), o]);
  return [...by].map(([label, list]) => {
    const open = list.some((o) => o.ms === null);
    const n = list.reduce((x, o) => x + o.sessions, 0);
    const how = open ? "cannot be reached" : list.length === 1 ? `could not be reached for ${lasted(list[0]!.ms!)}` : `could not be reached ${times(list.length)}`;
    return `${label} ${how}${n ? `, ${turnsWaited(n, open)}` : ""}`;
  }).join("; ");
}
// "was stopped by a signal, down 42 min", "was stopped by a signal twice, down 42 min at the longest".
const signalWords = (rs: Restart[]) => `was stopped by a signal${rs.length > 1 ? ` ${times(rs.length)}` : ""}, down ${dur(longest(rs))}${rs.length > 1 ? " at the longest" : ""}`;
export function daemonLines(f: DaemonFacts | undefined): string[] {
  if (!f) return [];
  const out: string[] = [];
  const own = f.restarts.filter((r) => !wasAsked(r) && !bySignal(r)), wanted = f.restarts.filter(wasAsked), signalled = f.restarts.filter(bySignal);
  const told = own.slice(-RESTARTS_TOLD);
  if (own.length > 1) out.push(`The daemon stopped by itself ${times(own.length)} (${ownWays(own)})${own.length > told.length ? `; the last ${told.length}:` : ":"}`);
  for (const r of told) out.push(restartSummary(r));
  // Each stop by a signal in its own sentence (a few): when, how long down, what it cut.
  for (const r of signalled.slice(-RESTARTS_TOLD)) out.push(restartSummary(r));
  const stalls = stallsLine(f.stalls);
  if (wanted.length === 1 && !own.length && !signalled.length) out.push(restartSummary(wanted[0]!));
  else if (wanted.length) {
    const cut = cutOf(wanted);
    out.push(`${own.length || signalled.length ? "It also restarted" : "The daemon restarted"} ${times(wanted.length)} when asked (down ${secs(downOf(wanted))} in all); ${cut.length ? `${cut.length} turn${cut.length > 1 ? "s were" : " was"} cut: ${tally(cut)}` : "no turn was cut"}.`);
  }
  if (stalls) out.push(stalls);
  for (const o of (f.outages ?? []).slice(-OUTAGES_TOLD)) out.push(outageLine(o));
  if ((f.outages?.length ?? 0) > OUTAGES_TOLD) out.push(`${plural(f.outages!.length - OUTAGES_TOLD, "earlier outage")} of a provider, not listed.`);
  return out;
}
// "3 turns cut", and what did not go on by itself: "3 turns cut (1 held for the owner)".
function cutBrief(rs: Restart[]): string {
  const cut = cutOf(rs);
  if (!cut.length) return "";
  const stuck = cut.filter((t) => t.state === "held" || t.state === "left");
  return `, ${plural(cut.length, "turn")} cut${stuck.length ? ` (${tally(stuck)})` : ""}`;
}
const downWords = (r: Restart) => (!r.before ? "started after an end that was not recorded" : `${r.before.how === "killed" ? "went down" : "ended on a failure"} and came back after ${dur(downMs(r))}`);
// "the daemon went down and came back after 29 s, 6 turns cut; restarted 12 times when asked, 71 turns cut; unresponsive twice".
export function daemonBrief(f: DaemonFacts | undefined): string {
  const outages = outageBrief(f?.outages);
  if (!f || (!f.restarts.length && !f.stalls.length)) return outages;
  const own = f.restarts.filter((r) => !wasAsked(r) && !bySignal(r)), wanted = f.restarts.filter(wasAsked), signalled = f.restarts.filter(bySignal);
  const parts = [
    own.length ? `${own.length === 1 ? downWords(own[0]!) : `stopped by itself ${times(own.length)}`}${cutBrief(own)}` : "",
    signalled.length ? `${signalWords(signalled)}${cutBrief(signalled)}` : "",
    wanted.length ? `restarted ${wanted.length === 1 ? "" : `${times(wanted.length)} `}when asked${cutBrief(wanted)}` : "",
    f.stalls.length ? `${own.length || wanted.length || signalled.length ? "" : "was "}unresponsive ${times(f.stalls.length)}` : "",
  ].filter(Boolean);
  return [parts.length ? `the daemon ${parts.join("; ")}` : "", outages].filter(Boolean).join("; ");
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
  if (!rows.length && !daemonTold(more.daemon)) return null;
  const daemon = daemonLines(more.daemon);
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
export const hms = (ts: number, by: number) => zoned(by).clock(ts, by);
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
