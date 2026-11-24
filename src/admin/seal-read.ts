// What the sealed record says of one session, and of the days' roots (src/core/seal.ts has the rules).
// It runs on the read thread (src/server/read-tasks.ts): it reads every row of a session, in one snapshot,
// and imports nothing of the daemon.
import type { Database } from "bun:sqlite";
import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import { ALGO, BUNDLE_FORMAT, dayRoot, hex, judge, leaf, merkle, same, verifyCards, verifyEgress, verifyEvents, ZERO, type Anchor, type CardRow, type Checked, type EgressRow, type EventRow } from "../core/seal.ts";

type Rows = { events: EventRow[]; cards: CardRow[]; egress: EgressRow[]; heads: { events: Uint8Array | null; cards: Uint8Array | null; egress: Uint8Array | null }; anchors: Anchor[]; exists: boolean };

const has = (db: Database, table: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

// One session's rows and the days that hold its heads. One snapshot: the loop writes meanwhile.
function read(db: Database, session: string): Rows {
  db.exec("BEGIN");
  try {
    const s = db.query<{ seal: Uint8Array | null }, [string]>("SELECT seal FROM sessions WHERE id = ?").get(session);
    const events = db.query<EventRow, [string]>("SELECT id, session_id, seq, parent, kind, data, ts, prev FROM events WHERE session_id = ? ORDER BY seq").all(session);
    const head = (kind: string) => db.query<{ head: Uint8Array }, [string, string]>("SELECT head FROM seal_heads WHERE session_id = ? AND kind = ?").get(session, kind)?.head ?? null;
    const cards = db.query<CardRow, [string]>("SELECT id, session_id, ts, data, prev FROM seal_cards WHERE session_id = ? ORDER BY id").all(session);
    const egress = has(db, "egress")
      ? db.query<EgressRow, [string]>("SELECT id, ts, session_id, turn_event, call_id, tool, via, host, port, bytes_out, outcome, status, why, prev FROM egress WHERE session_id = ? ORDER BY id").all(session)
      : [];
    return { events, cards, egress, heads: { events: s?.seal ?? null, cards: head("cards"), egress: head("egress") }, anchors: anchorsOf(db, session), exists: !!s || events.length > 0 };
  } finally {
    db.exec("COMMIT");
  }
}

type DayLeaf = { session_id: string; events: Uint8Array | null; cards: Uint8Array | null; egress: Uint8Array | null };
const leavesOf = (db: Database, day: string) => db.query<DayLeaf, [string]>("SELECT session_id, events, cards, egress FROM seal_days WHERE day = ? ORDER BY session_id").all(day);
const leafOf = (l: DayLeaf) => leaf({ session: l.session_id, events: l.events, cards: l.cards, egress: l.egress });

// The roots that hold a session's heads, each with the path from the session's leaf to the day's root.
function anchorsOf(db: Database, session: string): Anchor[] {
  const out: Anchor[] = [];
  const days = db.query<{ day: string; at: number; root: Uint8Array; prev_root: Uint8Array | null; sessions: number }, [string]>(
    "SELECT r.day, r.at, r.root, r.prev_root, r.sessions FROM seal_roots r JOIN seal_days d ON d.day = r.day WHERE d.session_id = ? ORDER BY r.day").all(session);
  for (const r of days) {
    const leaves = leavesOf(db, r.day);
    const at = leaves.findIndex((l) => l.session_id === session);
    const { proof } = merkle(leaves.map(leafOf), at);
    const mine = leaves[at]!;
    out.push({ day: r.day, at: r.at, root: hex(r.root)!, prev_root: hex(r.prev_root), sessions: r.sessions, leaf: { events: hex(mine.events), cards: hex(mine.cards), egress: hex(mine.egress) }, proof });
  }
  return out;
}

export type Counts = { events: number; cards: number; egress: number };
export type SessionVerdict = Checked & { found: boolean; counts: Counts };
// Whether the session's history is whole, and where it breaks. `roots`: the roots a place outside the store holds, by day.
export function sealVerify(db: Database, a: { session: string; roots?: Record<string, string> | null }): SessionVerdict {
  const r = read(db, a.session);
  const keptRoots = a.roots ? new Map(Object.entries(a.roots)) : undefined;
  const v = judge(a.session, { events: verifyEvents(r.events, r.heads.events), cards: verifyCards(r.cards, r.heads.cards), egress: verifyEgress(r.egress, r.heads.egress) }, r.anchors, keptRoots);
  return { ...v, found: r.exists, counts: { events: r.events.length, cards: r.cards.length, egress: r.egress.length } };
}

// The session's receipts as one file that verifies alone (`verifyBundle`), written to `path` a row at a time
// inside one snapshot: a session of tens of thousands of events is never held whole in memory, here or on the
// loop, which only streams the file. Null when there is no such session (nothing is written).
export function sealBundleTo(db: Database, a: { session: string; path: string }): { bytes: number } | null {
  db.exec("BEGIN");
  let fd: number | undefined;
  try {
    const s = db.query<{ seal: Uint8Array | null }, [string]>("SELECT seal FROM sessions WHERE id = ?").get(a.session);
    if (!s && !db.query("SELECT 1 FROM events WHERE session_id = ? LIMIT 1").get(a.session)) return null;
    const head = (kind: string) => db.query<{ head: Uint8Array }, [string, string]>("SELECT head FROM seal_heads WHERE session_id = ? AND kind = ?").get(a.session, kind)?.head ?? null;
    fd = openSync(a.path, "w", 0o600);
    let buf = "";
    let bytes = 0;
    const flush = () => { if (buf) { const b = Buffer.from(buf); writeSync(fd!, b); bytes += b.length; buf = ""; } };
    const put = (t: string) => { buf += t; if (buf.length > 1 << 20) flush(); };
    const rows = (it: Iterable<{ prev: Uint8Array | null }>) => {
      let first = true;
      put("[");
      for (const x of it) { put(`${first ? "" : ","}${JSON.stringify({ ...x, prev: hex(x.prev) })}`); first = false; }
      put("]");
    };
    put(`{"format":${JSON.stringify(BUNDLE_FORMAT)},"algorithm":${JSON.stringify(ALGO)},"session":${JSON.stringify(a.session)},"made_at":${Date.now()}`);
    put(`,"events":{"head":${JSON.stringify(hex(s?.seal ?? null))},"rows":`);
    rows(db.query<EventRow, [string]>("SELECT id, session_id, seq, parent, kind, data, ts, prev FROM events WHERE session_id = ? ORDER BY seq").iterate(a.session));
    put(`},"cards":{"head":${JSON.stringify(hex(head("cards")))},"rows":`);
    rows(db.query<CardRow, [string]>("SELECT id, session_id, ts, data, prev FROM seal_cards WHERE session_id = ? ORDER BY id").iterate(a.session));
    put(`},"egress":{"head":${JSON.stringify(hex(head("egress")))},"rows":`);
    rows(has(db, "egress") ? db.query<EgressRow, [string]>("SELECT id, ts, session_id, turn_event, call_id, tool, via, host, port, bytes_out, outcome, status, why, prev FROM egress WHERE session_id = ? ORDER BY id").iterate(a.session) : []);
    put(`},"anchors":${JSON.stringify(anchorsOf(db, a.session))}}`);
    flush();
    return { bytes };
  } catch (e) {
    if (fd !== undefined) { closeSync(fd); fd = undefined; try { unlinkSync(a.path); } catch {} }
    throw e;
  } finally {
    if (fd !== undefined) closeSync(fd);
    db.exec("COMMIT");
  }
}

export type RootCheck = { day: string; at: number; root: string; sessions: number; ok: boolean; why?: string };
// The days' roots held against what the store's day tables make of them, the roots before them, and a copy kept elsewhere.
// `kept`: the days and roots of a file kept outside the store, null when none was read.
export function sealRoots(db: Database, a: { kept?: { day: string; root: string }[] | null }): { roots: RootCheck[]; ok: boolean; sessions: number } {
  const rows = db.query<{ day: string; at: number; root: Uint8Array; prev_root: Uint8Array | null; sessions: number }, []>("SELECT day, at, root, prev_root, sessions FROM seal_roots ORDER BY day").all();
  const kept = a.kept ? new Map(a.kept.map((k) => [k.day, k.root])) : null;
  let before: Uint8Array | null = null;
  const roots: RootCheck[] = rows.map((r) => {
    const leaves = leavesOf(db, r.day);
    const made = dayRoot(r.day, before, merkle(leaves.map(leafOf)).root);
    let why: string | undefined;
    if (!same(r.prev_root ?? ZERO, before ?? ZERO)) why = "it does not follow the root before it";
    else if (leaves.length !== r.sessions) why = `it covers ${r.sessions} sessions and the store holds ${leaves.length} of their heads`;
    else if (!same(made, r.root)) why = "the heads the store holds for this day do not make its root";
    else if (kept && kept.get(r.day) !== hex(r.root)) why = kept.has(r.day) ? "it differs from the root kept outside the store" : "the root kept outside the store has no such day";
    before = r.root;
    return { day: r.day, at: r.at, root: hex(r.root)!, sessions: r.sessions, ok: !why, ...(why ? { why } : {}) };
  });
  // A day the outside copy holds and the store does not: taken out of the store.
  if (kept) for (const [day, root] of kept) if (!rows.some((r) => r.day === day)) roots.push({ day, at: 0, root, sessions: 0, ok: false, why: "the root kept outside the store has a day the store no longer holds" });
  return { roots, ok: roots.every((r) => r.ok), sessions: new Set(db.query<{ session_id: string }, []>("SELECT DISTINCT session_id FROM seal_days").all().map((x) => x.session_id)).size };
}
