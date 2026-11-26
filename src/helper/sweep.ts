// The helper's daily sweep of the memory systems: how each did over the last day, from Keel's own
// records (the meter's recalls and what turns then named, the rules followed or broken, the native
// memory log, the helper's records, momentum's nudges and what followed them), and one to three
// improvements it offers. Nothing here asks a model or changes a thing: an offer is a plain
// description of a change, applied only when the owner presses it (src/server/routes/sweep.ts).
//
// What "helped" means, per system, is the share of what it gave that a turn then used:
// - the owner's memory store (tacit): facts a turn named, of the facts given (the meter's proxy);
// - the helper's records: recalls a turn used, of the recalls made;
// - Claude Code's auto memory: its index facts a loading session's next steps used, of the facts loaded
//   (src/helper/sweep-recall.ts); with no steps to judge, access: the loading sessions that read or wrote a file of it;
// - Codex's memories: the same, for its summary and folder;
// - momentum: the turns its nudges were delivered into that ended on their own, of those that ended
//   (a nudge not delivered or not ended yet is pending: unobserved; observed outcomes, not their cause).
// A system with nothing in the window says so (`helped: null`), never a zero.
import { existsSync, linkSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { writeOwnFile } from "../core/ownfile.ts";
import { basename, join } from "node:path";
import type { Store } from "../core/store.ts";
import { timed } from "../admin/stall.ts";
import { notesOf, type NoteFile } from "../engine/native-memory.ts";
import { bytesPerToken } from "../engine/compact.ts";
import { bansIn, indexFacts, judge, lineOf, moved, nextOf, nudgeOutcomes, recallOf, stepOf, summaryFacts, SESSIONS_MAX, STEPS_MAX, type Act, type Delivered, type Measure, type Next, type Nudges, type Recall, type TurnEnd } from "./sweep-recall.ts";

export const DAY = 86_400_000;
// What a fact must have been given before the sweep says it never helped, in the days it looks back.
export const FACT_DAYS = 14;
export const FACT_GIVEN = 5;
export const FACT_SESSIONS = 3;
// A record the helper kept and no turn has used, and a note nobody touched, are stale after these.
export const RECORD_STALE_DAYS = 30;
export const NOTE_STALE_DAYS = 120;
export const OFFERS_MAX = 3;
export const KEEP_SWEEPS = 60;

export type Sql = <T = any>(sql: string, params?: (string | number | null)[]) => Promise<T[]>;
export type SystemId = "tacit" | "helper" | "claude" | "codex" | "momentum";
export type Figures = Record<string, number>;
// `measure`: the four figures every system is read by (facts judged, used, repeated mistakes, recall tokens);
// `next`: its one ranked improvement, a plain description (an offer below is what can be pressed).
export type System = { id: SystemId; label: string; short?: string; on: boolean; note?: string; figures: Figures; helped: number | null; measure?: Measure; next?: Next | null };

export type OfferKind = "drop_record" | "drop_note" | "tidy_index" | "tacit_note";
export type OfferState = "open" | "applied" | "dismissed";
export type Offer = {
  id: string; kind: OfferKind; system: SystemId; title: string; why: string; state: OfferState;
  // What pressing it does, exactly: stored with the offer, never taken from a request.
  // `stamp`: the size and time of the file it changes, as the sweep saw it; `updated`: the record's time. An apply
  // whose file or record moved since is refused (stampOf, the route's record check).
  target: { key?: string; dir?: string; file?: string; add?: string[]; remove?: string[]; name?: string; text?: string; stamp?: string; updated?: number };
  done?: string; at?: number;
};
export type Card = { id: string; ts: number; since: number; until: number; systems: System[]; offers: Offer[] };

const share = (n: number, d: number): number | null => (d > 0 ? Math.round((1000 * n) / d) / 1000 : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// --- figures ---------------------------------------------------------------------

export type PathRow = { path: string; asked: number; recalls: number; empty: number; missed: number; facts: number; tokens: number; facts_checked: number; used: number; rules: number; followed: number; broken: number; recalls_checked: number; recalls_used: number };
export type FactRow = { name: string; given: number; sessions: number; checked: number; used: number; rule: number; followed: number; broken: number; tokens: number; last: number };
export type RecordRow = { key: string; value: string; kind: string; source: string; ts: number; updated: number; used: number };
export type NativeRow = { system: string; action: string; rows: number; sessions: number; bytes: number };
export type ActRow = { action: string; ok: number };

const sum = (rows: PathRow[], k: keyof PathRow) => rows.reduce((n, r) => n + num(r[k]), 0);

export function tacitSystem(rows: PathRow[], on: boolean, open: number): System {
  const own = rows.filter((r) => r.path.startsWith("store_"));
  const f: Figures = {
    asked: sum(own, "asked"), recalls: sum(own, "recalls"), empty: sum(own, "empty"), missed: sum(own, "missed"), facts: sum(own, "facts"), tokens: sum(own, "tokens"),
    named: sum(own, "used"), checked: sum(own, "facts_checked"), rules: sum(own, "rules"), followed: sum(own, "followed"), broken: sum(own, "broken"), falls: open,
  };
  return { id: "tacit", label: "Memory store (tacit)", on, figures: f, helped: share(f.named!, f.checked!) };
}

export function helperSystem(rows: PathRow[], records: RecordRow[], now: number): System {
  const own = rows.filter((r) => r.path === "helper");
  const stale = records.filter((r) => r.source !== "owner" && r.used === 0 && now - r.updated > RECORD_STALE_DAYS * DAY).length;
  const f: Figures = { asked: sum(own, "asked"), recalls: sum(own, "recalls"), facts: sum(own, "facts"), tokens: sum(own, "tokens"), recalls_used: sum(own, "recalls_used"), checked: sum(own, "recalls_checked"), records: records.length, unused: records.filter((r) => r.used === 0).length, stale };
  return { id: "helper", label: "Helper records", on: true, figures: f, helped: share(f.recalls_used!, f.checked!) };
}

// A native system from its log rows and the notes found in its folders.
export function nativeSystem(id: "claude" | "codex", log: NativeRow[], dirs: { dir: string; notes: NoteFile[]; index: ReturnType<typeof notesOf>["index"] }[], on: boolean, note?: string, accessed = 0): System {
  const of = (action: string) => log.find((r) => r.system === id && r.action === action);
  const loaded = of("loaded"), read = of("read"), wrote = of("wrote");
  const notes = dirs.flatMap((d) => d.notes);
  const f: Figures = {
    loads: loaded?.rows ?? 0, sessions: loaded?.sessions ?? 0, bytes: loaded?.bytes ?? 0,
    reads: read?.rows ?? 0, writes: wrote?.rows ?? 0, sessions_read: read?.sessions ?? 0, sessions_wrote: wrote?.sessions ?? 0,
    notes: notes.length, unindexed: notes.filter((n) => !n.indexed).length,
    dangling: dirs.reduce((n, d) => n + (d.index?.missing.length ?? 0), 0), over: dirs.filter((d) => d.index?.over).length,
  };
  // Access, not use: the loading sessions of the window whose tools read or wrote a file of it, each once.
  f.accessed = Math.min(accessed, f.sessions!);
  return { id, label: id === "claude" ? "Claude Code auto memory" : "Codex memories", on, ...(note ? { note } : {}), figures: f, helped: share(f.accessed, f.sessions!) };
}

export function momentumSystem(rows: ActRow[], o: Nudges, on: boolean): System {
  const ok = (a: string) => rows.find((r) => r.action === a)?.ok ?? 0;
  const f: Figures = { acts: rows.reduce((s, r) => s + r.ok, 0), steer: ok("steer"), queue: ok("queue"), interrupt: ok("interrupt"), ended: o.ended, interrupted: o.interrupted, failed: o.failed, stops: o.stops, pending: o.pending };
  return { id: "momentum", label: "Supervisor (momentum)", on, figures: f, helped: share(o.ended, o.ended + o.interrupted + o.failed) };
}

// --- offers ------------------------------------------------------------------------

// A file as an offer saw it: its size and its time to the millisecond. Any write moves one of them.
const stamp = (bytes: number, mtime: number) => `${bytes}:${Math.floor(mtime)}`;
export function stampOf(path: string): string {
  try { const st = statSync(path); return stamp(st.size, st.mtimeMs); } catch { return "none"; }
}
// An offer that cannot be checked against what it changes (a card from before offers kept a stamp) is
// refused, with why: the next sweep offers it again with one.
export function unstampedOffer(o: Pick<Offer, "kind" | "target">): string | null {
  if (o.kind === "drop_record" && o.target.updated === undefined) return "this offer is from an older sweep that did not keep the record's time; the next sweep offers it again";
  if ((o.kind === "tidy_index" || o.kind === "drop_note") && o.target.stamp === undefined) return "this offer is from an older sweep that did not keep the file's size and time; the next sweep offers it again";
  return null;
}
const unchanged = (path: string, want: string | undefined) => {
  if (want !== undefined && stampOf(path) !== want) throw new Error(`${basename(path)} changed since the sweep offered this; the next sweep looks at it again`);
};

const age = (now: number, ts: number) => Math.max(0, Math.floor((now - ts) / DAY));

export function offersFrom(i: { facts: FactRow[]; records: RecordRow[]; native: { dir: string; notes: NoteFile[]; index: ReturnType<typeof notesOf>["index"] }[]; reads?: Set<string>; now: number; sweep: string }): Offer[] {
  const found: (Offer & { score: number })[] = [];
  const add = (o: Omit<Offer, "id" | "state">, score: number) => found.push({ ...o, id: "", state: "open", score });
  for (const r of i.records) {
    if (r.source === "owner" || r.used > 0 || age(i.now, r.updated) < RECORD_STALE_DAYS) continue;
    add({ kind: "drop_record", system: "helper", title: `Drop the helper's record ${r.key}`, why: `Kept ${age(i.now, r.ts)} days ago by the helper and not used by any turn in the ${age(i.now, r.updated)} days since it last changed: "${r.value.slice(0, 120)}".`, target: { key: r.key, updated: r.updated } }, age(i.now, r.updated));
  }
  for (const f of i.facts) {
    if (f.given < FACT_GIVEN || f.sessions < FACT_SESSIONS || f.used > 0) continue;
    if (f.rule ? f.followed + f.broken > 0 : f.checked < FACT_GIVEN) continue;
    const text = f.rule
      ? `Keel's memory meter: this rule was given ${f.given} times in ${f.sessions} sessions in ${FACT_DAYS} days; no turn named it or tested it. Consider rewording it so a call can test it, or retiring it.`
      : `Keel's memory meter: this fact was given ${f.given} times in ${f.sessions} sessions in ${FACT_DAYS} days; no turn named it. Consider narrowing or retiring it.`;
    add({ kind: "tacit_note", system: "tacit", title: f.rule ? `A rule that never fired: ${f.name}` : `A fact that never helped: ${f.name}`, why: `Given ${f.given} times (${f.tokens} tokens) in ${f.sessions} sessions in ${FACT_DAYS} days; ${f.rule ? "it names no call a turn made or avoided" : "no turn named it"}. Pressing sends the store's curator a note to read against the fact; the store keeps editing and retiring to you.`, target: { name: f.name, text } }, f.tokens + f.given);
  }
  for (const d of i.native) {
    const fix = { add: d.notes.filter((n) => !n.indexed).map((n) => n.file), remove: d.index?.missing ?? [] };
    if (fix.add.length + fix.remove.length) {
      add({ kind: "tidy_index", system: "claude", title: `Tidy MEMORY.md (${fix.add.length} note${fix.add.length === 1 ? "" : "s"} not listed, ${fix.remove.length} line${fix.remove.length === 1 ? "" : "s"} pointing nowhere)`, why: `A note the index does not list is not seen at a start; a line that points at a missing file is noise. Pressing adds a line for each unlisted note and removes the dead ones in ${d.dir}.`, target: { dir: d.dir, add: fix.add, remove: fix.remove, stamp: d.index ? stamp(d.index.bytes, d.index.mtime ?? 0) : "none" } }, fix.add.length + fix.remove.length);
    }
    for (const n of d.notes) {
      if (n.type !== "project" || age(i.now, n.mtime) < NOTE_STALE_DAYS || i.reads?.has(join(d.dir, n.file))) continue;
      add({ kind: "drop_note", system: "claude", title: `Drop the stale note ${n.file}`, why: `A project note not changed in ${age(i.now, n.mtime)} days and not read by any session in the log. Pressing moves it to .dropped/ in its folder (kept there) and removes its line from MEMORY.md.`, target: { dir: d.dir, file: n.file, stamp: stamp(n.bytes, n.mtime) } }, age(i.now, n.mtime));
    }
  }
  // The best of each kind first, at most two of one kind, three in all.
  found.sort((a, b) => b.score - a.score);
  const per = new Map<OfferKind, number>();
  const out: Offer[] = [];
  for (const o of found) {
    if ((per.get(o.kind) ?? 0) >= 2 || out.length >= OFFERS_MAX) continue;
    per.set(o.kind, (per.get(o.kind) ?? 0) + 1);
    const { score: _, ...rest } = o;
    out.push({ ...rest, id: `${i.sweep}:${out.length}` });
  }
  return out;
}

// --- applying an offer's file changes ------------------------------------------------

const NOTE_NAME = /^[\w.-]+\.md$/;
const description = (text: string) => /^---\n[\s\S]*?\ndescription:\s*(.+)/.exec(text.slice(0, 800))?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";

// The index lines an offer adds and removes, and a stale note moved aside. `dir` is one the log
// saw a session load: the caller checks that.
export function tidyIndex(dir: string, add: string[], remove: string[], want?: string): string {
  const file = join(dir, "MEMORY.md");
  unchanged(file, want);
  let text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = text.split("\n").filter((l) => !remove.some((f) => l.includes(`](${f})`)));
  for (const f of add) {
    if (!NOTE_NAME.test(f) || lines.some((l) => l.includes(`](${f})`))) continue;
    const d = description(readFileSync(join(dir, f), "utf8")) || f.replace(/\.md$/, "").replace(/[_-]+/g, " ");
    while (lines.length && lines.at(-1) === "") lines.pop();
    lines.push(`- [${f.replace(/\.md$/, "")}](${f}): ${d.slice(0, 150)}`);
  }
  text = `${lines.join("\n").replace(/\n+$/, "")}\n`;
  writeOwnFile(file, text);
  return `Updated ${file}: ${add.length} added, ${remove.length} removed.`;
}

// The place in .dropped/ for a note: its own name, else its name with the first free number.
export function droppedName(dir: string, name: string): string {
  const into = join(dir, ".dropped");
  mkdirSync(into, { recursive: true });
  const stem = name.replace(/\.md$/, "");
  for (let n = 1; ; n++) {
    const to = join(into, n === 1 ? name : `${stem}.${n}.md`);
    if (!existsSync(to)) return to;
  }
}

export function dropNote(dir: string, name: string, want?: string): string {
  if (!NOTE_NAME.test(name) || name === "MEMORY.md") throw new Error(`${name} is not a note of the folder`);
  const from = join(dir, name);
  if (!existsSync(from)) throw new Error(`${name} is gone already`);
  unchanged(from, want);
  const to = droppedName(dir, name);
  // A hard link refuses a name that is taken, so an earlier dropped note of the same name is never replaced.
  linkSync(from, to);
  unlinkSync(from);
  const file = join(dir, "MEMORY.md");
  if (existsSync(file)) writeOwnFile(file, readFileSync(file, "utf8").split("\n").filter((l) => !l.includes(`](${name})`)).join("\n"));
  return `Moved ${name} to ${to} and took its line out of MEMORY.md.`;
}

// --- the stored cards ----------------------------------------------------------------

export class Sweeps {
  constructor(private store: Store) {
    store.migrate(`CREATE TABLE IF NOT EXISTS memory_sweeps (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, since INTEGER NOT NULL, until INTEGER NOT NULL, systems TEXT NOT NULL, offers TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS memory_sweeps_ts ON memory_sweeps(ts);`);
  }
  save(c: Card) {
    const db = this.store.db;
    db.query("INSERT OR REPLACE INTO memory_sweeps (id, ts, since, until, systems, offers) VALUES (?, ?, ?, ?, ?, ?)").run(c.id, c.ts, c.since, c.until, JSON.stringify(c.systems), JSON.stringify(c.offers));
    db.query("DELETE FROM memory_sweeps WHERE id NOT IN (SELECT id FROM memory_sweeps ORDER BY ts DESC LIMIT ?)").run(KEEP_SWEEPS);
  }
  private row(r: any): Card { return { id: r.id, ts: r.ts, since: r.since, until: r.until, systems: JSON.parse(r.systems), offers: JSON.parse(r.offers) }; }
  latest(): Card | null {
    const r = this.store.db.query("SELECT * FROM memory_sweeps ORDER BY ts DESC LIMIT 1").get();
    return r ? this.row(r) : null;
  }
  get(id: string): Card | null {
    const r = this.store.db.query("SELECT * FROM memory_sweeps WHERE id = ?").get(id);
    return r ? this.row(r) : null;
  }
  // The helped share of each system on the last cards, oldest first, for a trend.
  history(n = 14): { id: string; ts: number; helped: Partial<Record<SystemId, number | null>> }[] {
    return this.store.db.query("SELECT * FROM memory_sweeps ORDER BY ts DESC LIMIT ?").all(n).map((r: any) => this.row(r))
      .map((c) => ({ id: c.id, ts: c.ts, helped: Object.fromEntries(c.systems.map((s) => [s.id, s.helped])) })).reverse();
  }
  setOffer(offerId: string, patch: Partial<Offer>): Offer | null {
    const card = this.get(offerId.slice(0, offerId.lastIndexOf(":")));
    const o = card?.offers.find((x) => x.id === offerId);
    if (!card || !o) return null;
    Object.assign(o, patch);
    this.save(card);
    return o;
  }
}

// The helper's line for a card: each system's share used and its repeats, and what moved since the card before.
export function sweepLine(card: Card, prev: Card | null): { line: string; moved: string[] } {
  const before = new Map((prev?.systems ?? []).map((s) => [s.id, s.measure]));
  const changes = card.systems.map((s) => (s.measure ? moved(before.get(s.id), s.measure, s.short ?? s.label) : null)).filter((x): x is string => !!x);
  const line = lineOf(card.systems.map((s) => ({ label: s.label, short: s.short ?? s.label, measure: s.measure })));
  return { line: changes.length ? `${changes.join("; ")}. ${line}` : line, moved: changes };
}

// --- the sweep -------------------------------------------------------------------------

export type SweepDeps = {
  sql: Sql;
  store: Store;
  // Whether the owner's memory store is installed, and how many falls of its recall are open.
  tacit: { on: boolean; falls: number };
  momentum: { on: boolean };
  // The auto memory and Codex folders the log saw sessions load.
  now?: number;
};

const PATHS = `SELECT path, COUNT(*) AS asked, COALESCE(SUM(outcome = 'added'), 0) AS recalls, COALESCE(SUM(outcome = 'empty'), 0) AS empty,
  COALESCE(SUM(outcome IN ('timeout', 'late', 'failure')), 0) AS missed,
  COALESCE(SUM(CASE WHEN outcome = 'added' THEN facts ELSE 0 END), 0) AS facts, COALESCE(SUM(CASE WHEN outcome = 'added' THEN tokens ELSE 0 END), 0) AS tokens,
  COALESCE(SUM(CASE WHEN outcome = 'added' AND used IS NOT NULL THEN facts ELSE 0 END), 0) AS facts_checked, COALESCE(SUM(CASE WHEN outcome = 'added' AND used IS NOT NULL THEN used ELSE 0 END), 0) AS used,
  COALESCE(SUM(CASE WHEN outcome = 'added' THEN rules ELSE 0 END), 0) AS rules, COALESCE(SUM(CASE WHEN outcome = 'added' THEN followed ELSE 0 END), 0) AS followed, COALESCE(SUM(CASE WHEN outcome = 'added' THEN broken ELSE 0 END), 0) AS broken,
  COALESCE(SUM(outcome = 'added' AND used IS NOT NULL), 0) AS recalls_checked, COALESCE(SUM(outcome = 'added' AND used > 0), 0) AS recalls_used
  FROM telemetry_memory WHERE ts >= ? AND ts < ? GROUP BY path`;
const FACTS = `SELECT name, COUNT(*) AS given, COUNT(DISTINCT session_id) AS sessions, COALESCE(SUM(used IS NOT NULL), 0) AS checked, COALESCE(SUM(used), 0) AS used, MAX(rule) AS rule,
  COALESCE(SUM(held = 1), 0) AS followed, COALESCE(SUM(held = 0), 0) AS broken, COALESCE(SUM(tokens), 0) AS tokens, MAX(ts) AS last
  FROM memory_given WHERE ts >= ? AND ts < ? GROUP BY name`;
// The sessions that loaded a native memory in the window and whose tools then read or wrote a file of it.
const ACCESSED = `SELECT system, COUNT(DISTINCT session_id) AS n FROM native_memory_log WHERE action IN ('read', 'wrote') AND ts >= ? AND ts < ?
  AND session_id IN (SELECT session_id FROM native_memory_log WHERE action = 'loaded' AND ts >= ? AND ts < ?) GROUP BY system`;
const NATIVE = `SELECT system, action, COUNT(*) AS rows, COUNT(DISTINCT session_id) AS sessions, COALESCE(SUM(bytes), 0) AS bytes FROM native_memory_log WHERE ts >= ? AND ts < ? GROUP BY system, action`;
const ACTS = `SELECT action, COUNT(*) AS ok FROM momentum_acts WHERE ts >= ? AND ts < ? GROUP BY action`;

const SHORT: Record<SystemId, string> = { tacit: "tacit", helper: "helper", claude: "Claude", codex: "Codex", momentum: "momentum" };

// A native system's day: each session that loaded it (the newest SESSIONS_MAX judged), its facts as its
// files hold them now, and the session's next steps. The tokens are every load's block, at the
// session's model's own bytes a token.
const LOADS = `SELECT l.session_id, MIN(l.ts) AS ts, l.file AS dir, SUM(l.bytes) AS bytes, s.model AS model FROM native_memory_log l LEFT JOIN sessions s ON s.id = l.session_id AND s.outside IS NULL
  WHERE l.system = ? AND l.action = 'loaded' AND l.ts >= ? AND l.ts < ? GROUP BY l.session_id, l.file ORDER BY MAX(l.ts) DESC`;
const STEPS = `SELECT data FROM events WHERE session_id = ? AND kind = 'assistant' AND ts >= ? AND ts < ? ORDER BY seq LIMIT ?`;
const TOUCHED = `SELECT DISTINCT file FROM native_memory_log WHERE session_id = ? AND system = ? AND action IN ('read', 'wrote') AND file != '' AND ts >= ? AND ts < ?`;

export function nativeFacts(system: "claude" | "codex", dir: string): { facts: ReturnType<typeof indexFacts>; bans: string[] } {
  const text = (f: string) => { try { return readFileSync(join(dir, f), "utf8"); } catch { return ""; } };
  if (system === "codex") { const summary = text("memory_summary.md"); return { facts: summaryFacts(summary), bans: bansIn([summary]) }; }
  const notes = notesOf(dir).notes.filter((n) => n.type === "feedback").map((n) => text(n.file));
  return { facts: indexFacts(text("MEMORY.md")), bans: bansIn(notes) };
}

export async function nativeRecall(d: Pick<SweepDeps, "sql">, system: "claude" | "codex", since: number, until: number): Promise<Recall> {
  const loads = await d.sql<{ session_id: string; ts: number; dir: string; bytes: number; model: string | null }>(LOADS, [system, since, until]);
  const byDir = new Map<string, ReturnType<typeof nativeFacts>>();
  const out: Parameters<typeof recallOf>[0][number][] = [];
  for (const [i, l] of loads.entries()) {
    const tokens = Math.round(l.bytes / bytesPerToken(l.model ?? undefined));
    if (!l.dir || !existsSync(l.dir)) { out.push({ facts: [], judged: null, tokens }); continue; }
    let f = byDir.get(l.dir);
    if (!f) byDir.set(l.dir, (f = nativeFacts(system, l.dir)));
    if (i >= SESSIONS_MAX || !f.facts.length) { out.push({ facts: f.facts, judged: null, tokens }); continue; }
    const [rows, touched] = await Promise.all([d.sql<{ data: string }>(STEPS, [l.session_id, l.ts, until, STEPS_MAX]), d.sql<{ file: string }>(TOUCHED, [l.session_id, system, l.ts, until])]);
    // Up to STEPS_MAX bodies parsed and every fact judged on them: one section of the loop a session,
    // named together with the day's others if they hold it.
    const facts = f.facts, bans = f.bans;
    const judged = timed(() => `memory sweep: ${system} recall judged on ${rows.length} steps`, () => {
      const steps = rows.map((r) => { try { return stepOf(JSON.parse(r.data)); } catch { return null; } }).filter((x) => !!x);
      return steps.length || touched.length ? judge(facts, bans, steps, touched.map((t) => t.file)) : null;
    }, true, "memory-sweep-judge");
    out.push({ facts, judged, tokens });
  }
  return recallOf(out);
}

// A system with its four figures and its one improvement.
export function measured(s: System, facts: FactRow[] = [], recall?: Recall): System {
  const f = s.figures, extra: Next[] = [];
  let m: Measure, list: { name: string; given: number; used: number }[] = [], broken = recall?.broken;
  if (s.id === "tacit") {
    m = { given: f.checked ?? 0, used: f.named ?? 0, mistakes: f.broken ?? 0, tokens: f.tokens ?? 0 };
    list = facts.filter((x) => !x.rule).map((x) => ({ name: x.name, given: x.checked, used: x.used, tokens: x.tokens }));
    const rule = facts.filter((x) => x.broken > 0).sort((a, b) => b.broken - a.broken)[0];
    if (rule) extra.push({ text: `The rule ${rule.name} was broken ${rule.broken} times after it was given: give it a deny key so the store stops the call.`, score: 1000 + rule.broken });
    if (f.falls) extra.push({ text: `Recall fell on ${f.falls} path${f.falls === 1 ? "" : "s"}: see the store's own health before trusting its share.`, score: 50 });
  } else if (s.id === "helper") {
    m = { given: f.checked ?? 0, used: f.recalls_used ?? 0, mistakes: 0, tokens: f.tokens ?? 0 };
    if (f.stale) extra.push({ text: `Forget ${f.stale} stale record${f.stale === 1 ? "" : "s"} no turn used in ${RECORD_STALE_DAYS} days.`, score: 20 + f.stale });
  } else if (s.id === "momentum") {
    // A nudge is judged once the session's next turn ended: then it either ended on its own or did not.
    m = { given: (f.ended ?? 0) + (f.interrupted ?? 0) + (f.failed ?? 0), used: f.ended ?? 0, mistakes: 0, tokens: 0 };
    if (!f.acts) extra.push({ text: "momentum sent Keel no command today: its session scan does not read Keel's control socket (momentum.sock in Keel's state folder), so it supervises no Keel session.", score: 10 });
    else if ((f.interrupted ?? 0) > (f.ended ?? 0)) extra.push({ text: `More of momentum's nudges were stopped (${f.interrupted}) than ended on their own (${f.ended}): review what it steers.`, score: 30 });
  } else {
    m = recall ? { given: recall.given, used: recall.used, mistakes: recall.mistakes, tokens: recall.tokens } : { given: 0, used: 0, mistakes: 0, tokens: 0 };
    list = recall?.facts ?? [];
    if (f.unindexed || f.dangling) extra.push({ text: `MEMORY.md misses ${f.unindexed} note${f.unindexed === 1 ? "" : "s"} and points at ${f.dangling} missing: tidy it (offered below).`, score: 60 + (f.unindexed ?? 0) + (f.dangling ?? 0) });
    if (f.over) extra.push({ text: "MEMORY.md is past what a start reads: move detail into topic files.", score: 80 });
  }
  const next = nextOf({ label: s.label, ...m, days: s.id === "tacit" ? FACT_DAYS : 1, facts: list, broken, extra });
  // A native system's helped share is its facts used when its steps were judged, else the sessions that touched it.
  const helped = recall && recall.given > 0 ? share(recall.used, recall.given) : s.helped;
  return { ...s, short: SHORT[s.id], helped, measure: m, next };
}

export async function sweep(d: SweepDeps): Promise<Card> {
  const now = d.now ?? Date.now(), since = now - DAY;
  const [paths, facts, nlog, acts, access] = await Promise.all([
    d.sql<PathRow>(PATHS, [since, now]),
    d.sql<FactRow>(FACTS, [now - FACT_DAYS * DAY, now]),
    d.sql<NativeRow>(NATIVE, [since, now]),
    d.sql<{ action: string; ok: number }>(ACTS, [since, now]).catch(() => []),
    d.sql<{ system: string; n: number }>(ACCESSED, [since, now, since, now]),
  ]);
  const accessed = (sys: string) => access.find((r) => r.system === sys)?.n ?? 0;
  const db = d.store.db;
  let records: RecordRow[] = [];
  try { records = db.query<RecordRow, []>("SELECT key, value, kind, source, ts, updated, used FROM helper_records").all(); } catch {} // the helper's table is made with the helper
  // The folders the log saw loaded in the last two weeks, and what the sessions read in them.
  const dirs = new Map<string, "claude" | "codex">();
  for (const r of db.query<{ system: "claude" | "codex"; file: string }, [number]>("SELECT DISTINCT system, file FROM native_memory_log WHERE action = 'loaded' AND file != '' AND ts >= ?").all(now - FACT_DAYS * DAY)) dirs.set(r.file, r.system);
  const found = [...dirs].map(([dir, system]) => ({ dir, system, ...notesOf(dir) })).filter((x) => existsSync(x.dir));
  const claudeDirs = found.filter((x) => x.system === "claude").map((x) => ({ dir: x.dir, notes: x.notes, index: x.index }));
  const codexDirs = found.filter((x) => x.system === "codex").map((x) => ({ dir: x.dir, notes: x.notes, index: x.index }));
  const reads = new Set(db.query<{ file: string }, [number]>("SELECT DISTINCT file FROM native_memory_log WHERE action IN ('read', 'wrote') AND file != '' AND ts >= ?").all(now - 90 * DAY).map((r) => r.file));
  // What followed each nudge: the turn it was delivered into (src/helper/sweep-recall.ts nudgeOutcomes), read per session.
  const nudges: Nudges = { ended: 0, interrupted: 0, failed: 0, stops: 0, pending: 0, turns: [] };
  if (acts.length) {
    const list = await d.sql<Act & { session_id: string }>("SELECT id, session_id, ts, action FROM momentum_acts WHERE ts >= ? AND ts < ? ORDER BY ts", [since, now]);
    for (const sid of new Set(list.map((a) => a.session_id))) {
      const mine = list.filter((a) => a.session_id === sid), from = mine[0]!.ts;
      const [users, ends] = await Promise.all([
        d.sql<Delivered>("SELECT seq, ts FROM events WHERE session_id = ? AND kind = 'user' AND ts >= ? AND data ->> '$.origin' = 'momentum' ORDER BY seq", [sid, from]),
        d.sql<TurnEnd>("SELECT id, seq, ts, data ->> '$.reason' AS reason, data ->> '$.stopped_by' AS stopped_by FROM events WHERE session_id = ? AND kind = 'turn_end' AND ts >= ? ORDER BY seq", [sid, from]),
      ]);
      const o = nudgeOutcomes(mine, users, ends);
      for (const k of ["ended", "interrupted", "failed", "stops", "pending"] as const) nudges[k] += o[k];
      nudges.turns.push(...o.turns);
    }
  }
  const claudeOn = !!found.length || nlog.some((r) => r.system === "claude");
  const [claudeRecall, codexRecall] = await Promise.all([nativeRecall(d, "claude", since, now), nativeRecall(d, "codex", since, now)]);
  const systems: System[] = [
    measured(tacitSystem(paths, d.tacit.on, d.tacit.falls), facts),
    measured(helperSystem(paths, records, now)),
    measured(nativeSystem("claude", nlog, claudeDirs, claudeOn, claudeOn ? undefined : "no session has loaded it yet", accessed("claude")), [], claudeRecall),
    measured(nativeSystem("codex", nlog, codexDirs, nlog.some((r) => r.system === "codex"), nlog.some((r) => r.system === "codex") ? undefined : "off, or no session has loaded it yet", accessed("codex")), [], codexRecall),
    measured(momentumSystem(acts, nudges, d.momentum.on)),
  ];
  const id = Bun.randomUUIDv7();
  const offers = offersFrom({ facts, records, native: claudeDirs, reads, now, sweep: id });
  return { id, ts: now, since, until: now, systems, offers };
}
