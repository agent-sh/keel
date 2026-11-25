// The helper's daily sweep of the memory systems: how each did over the last day, from Keel's own
// records (the meter's recalls and what turns then named, the rules followed or broken, the native
// memory log, the helper's records, momentum's nudges and what followed them), and one to three
// improvements it offers. Nothing here asks a model or changes a thing: an offer is a plain
// description of a change, applied only when the owner presses it (src/server/routes/sweep.ts).
//
// What "helped" means, per system, is the share of what it gave that a turn then used:
// - the owner's memory store (tacit): facts a turn named, of the facts given (the meter's proxy);
// - the helper's records: recalls a turn used, of the recalls made;
// - Claude Code's auto memory: sessions that read or wrote a file of it, of the sessions it was loaded into;
// - Codex's memories: the same, for its folder;
// - momentum: nudges after which the session's next turn ended on its own, of the nudges sent.
// A system with nothing in the window says so (`helped: null`), never a zero.
import { existsSync, readFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../core/store.ts";
import { notesOf, type NoteFile } from "../engine/native-memory.ts";

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
export type System = { id: SystemId; label: string; on: boolean; note?: string; figures: Figures; helped: number | null };

export type OfferKind = "drop_record" | "drop_note" | "tidy_index" | "tacit_note";
export type OfferState = "open" | "applied" | "dismissed";
export type Offer = {
  id: string; kind: OfferKind; system: SystemId; title: string; why: string; state: OfferState;
  // What pressing it does, exactly: stored with the offer, never taken from a request.
  target: { key?: string; dir?: string; file?: string; add?: string[]; remove?: string[]; name?: string; text?: string };
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
export type ActRow = { action: string; ok: number; ended: number; interrupted: number; failed: number };

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
export function nativeSystem(id: "claude" | "codex", log: NativeRow[], dirs: { dir: string; notes: NoteFile[]; index: ReturnType<typeof notesOf>["index"] }[], on: boolean, note?: string): System {
  const of = (action: string) => log.find((r) => r.system === id && r.action === action);
  const loaded = of("loaded"), read = of("read"), wrote = of("wrote");
  const notes = dirs.flatMap((d) => d.notes);
  const f: Figures = {
    loads: loaded?.rows ?? 0, sessions: loaded?.sessions ?? 0, bytes: loaded?.bytes ?? 0,
    reads: read?.rows ?? 0, writes: wrote?.rows ?? 0, sessions_read: read?.sessions ?? 0, sessions_wrote: wrote?.sessions ?? 0,
    notes: notes.length, unindexed: notes.filter((n) => !n.indexed).length,
    dangling: dirs.reduce((n, d) => n + (d.index?.missing.length ?? 0), 0), over: dirs.filter((d) => d.index?.over).length,
  };
  // A session that read and wrote counts once in the better of the two: the larger count bounds it.
  const touched = Math.max(f.sessions_read!, f.sessions_wrote!);
  return { id, label: id === "claude" ? "Claude Code auto memory" : "Codex memories", on, ...(note ? { note } : {}), figures: f, helped: share(Math.min(touched, f.sessions!), f.sessions!) };
}

export function momentumSystem(rows: ActRow[], on: boolean): System {
  const n = (k: keyof ActRow) => rows.reduce((s, r) => s + num(r[k]), 0);
  const acts = rows.reduce((s, r) => s + r.ok, 0);
  const f: Figures = { acts, steer: rows.find((r) => r.action === "steer")?.ok ?? 0, queue: rows.find((r) => r.action === "queue")?.ok ?? 0, interrupt: rows.find((r) => r.action === "interrupt")?.ok ?? 0, ended: n("ended"), interrupted: n("interrupted"), failed: n("failed") };
  const judged = f.ended! + f.interrupted! + f.failed!;
  return { id: "momentum", label: "Supervisor (momentum)", on, figures: f, helped: share(f.ended!, judged) };
}

// --- offers ------------------------------------------------------------------------

const age = (now: number, ts: number) => Math.max(0, Math.floor((now - ts) / DAY));

export function offersFrom(i: { facts: FactRow[]; records: RecordRow[]; native: { dir: string; notes: NoteFile[]; index: ReturnType<typeof notesOf>["index"] }[]; reads?: Set<string>; now: number; sweep: string }): Offer[] {
  const found: (Offer & { score: number })[] = [];
  const add = (o: Omit<Offer, "id" | "state">, score: number) => found.push({ ...o, id: "", state: "open", score });
  for (const r of i.records) {
    if (r.source === "owner" || r.used > 0 || age(i.now, r.updated) < RECORD_STALE_DAYS) continue;
    add({ kind: "drop_record", system: "helper", title: `Drop the helper's record ${r.key}`, why: `Kept ${age(i.now, r.ts)} days ago by the helper and not used by any turn in the ${age(i.now, r.updated)} days since it last changed: "${r.value.slice(0, 120)}".`, target: { key: r.key } }, age(i.now, r.updated));
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
      add({ kind: "tidy_index", system: "claude", title: `Tidy MEMORY.md (${fix.add.length} note${fix.add.length === 1 ? "" : "s"} not listed, ${fix.remove.length} line${fix.remove.length === 1 ? "" : "s"} pointing nowhere)`, why: `A note the index does not list is not seen at a start; a line that points at a missing file is noise. Pressing adds a line for each unlisted note and removes the dead ones in ${d.dir}.`, target: { dir: d.dir, add: fix.add, remove: fix.remove } }, fix.add.length + fix.remove.length);
    }
    for (const n of d.notes) {
      if (n.type !== "project" || age(i.now, n.mtime) < NOTE_STALE_DAYS || i.reads?.has(join(d.dir, n.file))) continue;
      add({ kind: "drop_note", system: "claude", title: `Drop the stale note ${n.file}`, why: `A project note not changed in ${age(i.now, n.mtime)} days and not read by any session in the log. Pressing moves it to .dropped/ in its folder (kept there) and removes its line from MEMORY.md.`, target: { dir: d.dir, file: n.file } }, age(i.now, n.mtime));
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
export function tidyIndex(dir: string, add: string[], remove: string[]): string {
  const file = join(dir, "MEMORY.md");
  let text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = text.split("\n").filter((l) => !remove.some((f) => l.includes(`](${f})`)));
  for (const f of add) {
    if (!NOTE_NAME.test(f) || lines.some((l) => l.includes(`](${f})`))) continue;
    const d = description(readFileSync(join(dir, f), "utf8")) || f.replace(/\.md$/, "").replace(/[_-]+/g, " ");
    while (lines.length && lines.at(-1) === "") lines.pop();
    lines.push(`- [${f.replace(/\.md$/, "")}](${f}): ${d.slice(0, 150)}`);
  }
  text = `${lines.join("\n").replace(/\n+$/, "")}\n`;
  writeFileSync(file, text);
  return `Updated ${file}: ${add.length} added, ${remove.length} removed.`;
}

export function dropNote(dir: string, name: string): string {
  if (!NOTE_NAME.test(name) || name === "MEMORY.md") throw new Error(`${name} is not a note of the folder`);
  const from = join(dir, name);
  if (!existsSync(from)) throw new Error(`${name} is gone already`);
  mkdirSync(join(dir, ".dropped"), { recursive: true });
  renameSync(from, join(dir, ".dropped", name));
  const file = join(dir, "MEMORY.md");
  if (existsSync(file)) writeFileSync(file, readFileSync(file, "utf8").split("\n").filter((l) => !l.includes(`](${name})`)).join("\n"));
  return `Moved ${name} to ${join(dir, ".dropped")} and took its line out of MEMORY.md.`;
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
const NATIVE = `SELECT system, action, COUNT(*) AS rows, COUNT(DISTINCT session_id) AS sessions, COALESCE(SUM(bytes), 0) AS bytes FROM native_memory_log WHERE ts >= ? AND ts < ? GROUP BY system, action`;
const ACTS = `SELECT action, COUNT(*) AS ok FROM momentum_acts WHERE ts >= ? AND ts < ? GROUP BY action`;

export async function sweep(d: SweepDeps): Promise<Card> {
  const now = d.now ?? Date.now(), since = now - DAY;
  const [paths, facts, nlog, acts] = await Promise.all([
    d.sql<PathRow>(PATHS, [since, now]),
    d.sql<FactRow>(FACTS, [now - FACT_DAYS * DAY, now]),
    d.sql<NativeRow>(NATIVE, [since, now]),
    d.sql<{ action: string; ok: number }>(ACTS, [since, now]).catch(() => []),
  ]);
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
  // What followed each nudge: the session's next turn end.
  const byAct: ActRow[] = [];
  for (const a of acts) {
    const row: ActRow = { action: a.action, ok: a.ok, ended: 0, interrupted: 0, failed: 0 };
    for (const n of db.query<{ session_id: string; ts: number }, [string, number, number]>("SELECT session_id, ts FROM momentum_acts WHERE action = ? AND ts >= ? AND ts < ?").all(a.action, since, now)) {
      const e = db.query<{ reason: string | null }, [string, number]>("SELECT data ->> '$.reason' AS reason FROM events WHERE session_id = ? AND kind = 'turn_end' AND ts > ? ORDER BY ts LIMIT 1").get(n.session_id, n.ts);
      if (!e) continue;
      if (e.reason === "interrupted") row.interrupted++; else if (e.reason === "error" || e.reason === "failed") row.failed++; else row.ended++;
    }
    byAct.push(row);
  }
  const claudeOn = !!found.length || nlog.some((r) => r.system === "claude");
  const systems: System[] = [
    tacitSystem(paths, d.tacit.on, d.tacit.falls),
    helperSystem(paths, records, now),
    nativeSystem("claude", nlog, claudeDirs, claudeOn, claudeOn ? undefined : "no session has loaded it yet"),
    nativeSystem("codex", nlog, codexDirs, nlog.some((r) => r.system === "codex"), nlog.some((r) => r.system === "codex") ? undefined : "off, or no session has loaded it yet"),
    momentumSystem(byAct, d.momentum.on),
  ];
  const id = Bun.randomUUIDv7();
  const offers = offersFrom({ facts, records, native: claudeDirs, reads, now, sweep: id });
  return { id, ts: now, since, until: now, systems, offers };
}
