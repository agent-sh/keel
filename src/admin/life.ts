// The daemon's own life across restarts: when the last one went down and how
// (it stopped by itself, it ended on a failure, or it was killed), which turns
// that cut, at which step or tool, and what became of each. One record a
// start, kept in the store, told in one place: `keel status`, Settings >
// Daemon, the log, and an Activity row when the owner has something to look at.
//
// A running daemon keeps a sign of life in a small file beside its lock,
// written in place from the daemon's one tick (src/core/pulse.ts): about
// once a second while it works (a turn runs, a request is open or was a
// moment ago) and every ten seconds while it is idle, and a stop writes its
// end there. Each sign says within how long the next one comes, so whoever
// reads the file knows how old a sign may be: the next start reads it before
// anything else. An end means it stopped by itself, none means it went down
// under its work (a kill, a crash of the runtime, the machine), within a
// second or so of the last sign when it was working, and within the time
// that sign names when it was idle. A file that is missing, empty or not this
// format, or one a daemon that keeps no such file has run after, says
// nothing: the record of that start says so, and never passes an older
// start's account off as its own. The engine tells of each cut turn
// (TurnHooks.turnCut) and of what became of it (turnCutSettled).
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import { type CutState, type CutTurn, registerHooks } from "../engine/hooks.ts";
import type { Before, Restart, RestartTurn } from "./life-rows.ts";
import { tail } from "./logs.ts";

export * from "./life-rows.ts";

const FILE = "daemon.alive";
const BEAT_MS = 1000;
// The file is one line of this length, written whole each time: never
// shorter than the line before it, so writing in place leaves nothing behind.
const WIDTH = 192;
// Starts kept: the last ones are what anyone asks about.
const KEPT = 50;
const G = globalThis as { __keelLife?: Life; __keelRestarts?: Restarts };

// `listening_ms`: when it began to answer. `code`: the exit code of an end it did not choose.
// `within_ms`: the next sign comes within this long of `alive_ms` (not there: a second, as every daemon before this field wrote).
type Alive = { pid: number; started_ms: number; alive_ms: number; within_ms?: number; listening_ms?: number; ended_ms?: number; how?: "restart" | "stop" | "crash" | "signal"; code?: number };

// `unknown`: why nothing is known of the daemon before this one.
// `beat(withinMs)`: a sign of life, with how long until the next one at the latest.
export type Life = { before: Before | null; unknown?: string; started_ms: number; beat(withinMs?: number): void; listening(): void; end(how: "restart" | "stop" | "crash" | "signal", code?: number): void };

// How the daemon that wrote this sign of life ended, or why that cannot be said.
// `listened`: when the log last shows a daemon begin to answer (any daemon writes that line).
export function readBefore(text: string | null, listened: number | undefined, pid = process.pid): { before: Before | null; unknown?: string } {
  if (text === null) return { before: null, unknown: "no sign of life was found (a first start, or the daemon before kept none)" };
  let a: Alive;
  try { a = JSON.parse(text) as Alive; } catch { return { before: null, unknown: "the sign of life was cut while it was written" }; }
  if (!a || !a.pid || !Number.isFinite(a.alive_ms) || !Number.isFinite(a.started_ms)) return { before: null, unknown: "the sign of life is not one this daemon reads" };
  if (a.pid === pid) return { before: null, unknown: "the sign of life is this process's own" };
  // A daemon began to answer after the one that wrote the file did: one that keeps no sign of life ran since.
  if (listened !== undefined && listened > (a.listening_ms ?? a.alive_ms) + 2000) return { before: null, unknown: "another daemon, one that keeps no sign of life, ran since the last sign" };
  // A daemon that left no end went down after its last sign and before the next was due: an idle one up to ten seconds after.
  const within = !a.ended_ms && Number.isFinite(a.within_ms) && a.within_ms! > 2 * BEAT_MS ? { within_ms: a.within_ms! } : {};
  return { before: { pid: a.pid, started_ms: a.started_ms, down_ms: a.ended_ms ?? a.alive_ms, how: a.ended_ms ? a.how ?? "stop" : "killed", ...(a.how === "crash" && a.code !== undefined ? { code: a.code } : {}), ...within } };
}

// Once per process (a hot reload keeps the life it has): reads how the last
// daemon ended, then keeps this one's sign of life.
export function beginLife(stateDir: string): Life {
  if (G.__keelLife) return G.__keelLife;
  const path = join(stateDir, FILE);
  let text: string | null = null;
  try { text = readFileSync(path, "utf8"); } catch {}
  const listened = tail(join(stateDir, "logs"), 2000).findLast((l) => l.text.startsWith("keel listening on "))?.ts;
  const { before, unknown } = readBefore(text, listened);
  const started_ms = Date.now();
  let ended = false;
  let listening_ms: number | undefined;
  let last = 0;
  let within = BEAT_MS;
  // Kept open and written in place: one small write, no truncate, nothing for the disk to flush each time.
  let fd: number | undefined;
  try { fd = openSync(path, "w+", 0o600); } catch {}
  const write = (more: Partial<Alive> = {}) => {
    if (fd === undefined) return;
    last = Date.now();
    try { writeSync(fd, `${JSON.stringify({ pid: process.pid, started_ms, alive_ms: last, ...(within > BEAT_MS ? { within_ms: within } : {}), ...(listening_ms ? { listening_ms } : {}), ...more }).padEnd(WIDTH - 1)}\n`, 0); } catch {}
  };
  write();
  const life: Life = {
    before, unknown, started_ms,
    beat(withinMs = BEAT_MS) {
      if (ended) return;
      // A daemon that begins to work says at once that its signs come a second apart again.
      const sooner = withinMs < within;
      within = withinMs;
      if (sooner || Date.now() - last >= BEAT_MS - 50) write();
    },
    listening() { listening_ms = Date.now(); if (!ended) write(); },
    end(how, code) {
      if (ended) return;
      ended = true;
      write({ ended_ms: Date.now(), how, ...(code !== undefined ? { code } : {}) });
      if (fd !== undefined) try { closeSync(fd); } catch {}
      fd = undefined;
    },
  };
  // An exit the process makes itself with nothing wrong is a stop; with a
  // failing code it ended on a failure (an error nothing caught); one it does
  // not make (a kill) leaves no end.
  process.on("exit", (code) => life.end(code ? "crash" : "stop", code || undefined));
  return (G.__keelLife = life);
}

// A stop the daemon makes itself says which kind before it exits.
// `signal`: a stop signal from outside ended it (main.ts), not a stop or restart asked of Keel.
export const endLife = (how: "restart" | "stop" | "signal") => G.__keelLife?.end(how);
// The sign of life, from the daemon's one tick; and the moment it began to answer.
export const beatLife = (withinMs?: number) => G.__keelLife?.beat(withinMs);
export const lifeListening = () => G.__keelLife?.listening();

// When the last daemon went down, for what was open then (a turn, a span).
export const wentDownAt = (): number | undefined => G.__keelLife?.before?.down_ms;

const SCHEMA = "CREATE TABLE IF NOT EXISTS daemon_starts (id TEXT PRIMARY KEY, up_ms INTEGER NOT NULL, data TEXT NOT NULL);";

// The record of this start and the ones before it.
export class Restarts {
  private now: Restart;
  // Told when the record changes, and once when it is whole.
  changed: () => void = () => {};
  whole: (r: Restart) => void = () => {};

  constructor(private store: Store, life: Life) {
    store.migrate(SCHEMA);
    G.__keelRestarts = this;
    // Every start has its record, also one that knows nothing of the daemon before it.
    const id = `${process.pid}-${life.started_ms}`;
    this.now = this.read(id) ?? { id, up_ms: life.started_ms, pid: process.pid, before: life.before, ...(life.before ? {} : { unknown: life.unknown ?? "nothing is known" }), turns: [] };
    this.save();
    store.db.query(`DELETE FROM daemon_starts WHERE id NOT IN (SELECT id FROM daemon_starts ORDER BY up_ms DESC LIMIT ${KEPT})`).run();
    registerHooks({
      turnCut: (s, cut) => this.cut(s, cut),
      turnCutSettled: (s, cut, state, why) => this.settle(s, cut, state, why),
    });
  }

  private read(id: string): Restart | null {
    const r = this.store.db.query<{ data: string }, [string]>("SELECT data FROM daemon_starts WHERE id = ?").get(id);
    return r ? (JSON.parse(r.data) as Restart) : null;
  }

  private save() {
    const r = this.now;
    this.store.db.query("INSERT INTO daemon_starts (id, up_ms, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(r.id, r.up_ms, JSON.stringify(r));
    try { this.changed(); } catch {}
  }

  // This start's record: its own, whatever it knows, never an older start's.
  last(): Restart {
    return this.now;
  }

  // The newest records, this start's first.
  recent(n: number): Restart[] {
    return this.store.db.query<{ data: string }, [number]>("SELECT data FROM daemon_starts ORDER BY up_ms DESC LIMIT ?").all(n + 1).map((r) => JSON.parse(r.data) as Restart);
  }

  // A parent was told what became of its cut agents (the line is stored): kept with the record
  // of the start that cut them, this one's or an earlier one's.
  told(id: string, parent: string, fates: Record<string, string>) {
    const r = id === this.now.id ? this.now : this.read(id);
    if (!r) return;
    r.told = { ...r.told, [parent]: { ...r.told?.[parent], ...fates } };
    if (r === this.now) return this.save();
    this.store.db.query("UPDATE daemon_starts SET data = ? WHERE id = ?").run(JSON.stringify(r), r.id);
  }

  private cut(s: Session, cut: CutTurn) {
    const r = this.now;
    if (r.settled_ms || r.turns.some((t) => t.end_event === cut.end_event)) return;
    // A turn cut before the daemon before this one had started was cut by an
    // earlier stop and was still waiting to be decided: it is this start's to
    // decide, and not one this stop cut.
    const earlier = !!r.before && cut.down_ms < r.before.started_ms;
    r.turns.push({ ...cut, session_id: s.id, title: s.title, parent_id: s.parent_id ?? null, state: "pending", ...(earlier ? { earlier: true as const } : {}) });
    this.save();
  }

  private settle(s: Session, cut: CutTurn, state: CutState, why?: string) {
    const t = this.now.turns.find((x) => x.end_event === cut.end_event);
    if (!t || this.now.settled_ms) return;
    t.state = state;
    t.title = s.title || t.title;
    if (why) t.why = why.slice(0, 300);
    this.save();
  }

  // The recovery has decided every turn it had: a turn still pending went on
  // by other means (its owner's own recovery, a prompt that arrived) or was
  // left as it was. `went`: what a session went on with instead of the cut
  // turn being continued, in words (a newer turn and who started it), or
  // nothing when it is as the cut left it.
  finish(went: (sessionId: string, cut: RestartTurn) => string | undefined) {
    const r = this.now;
    if (r.settled_ms) return;
    for (const t of r.turns) {
      if (t.state !== "pending" && t.state !== "moved") continue;
      const how = went(t.session_id, t);
      if (t.state === "pending") t.state = how ? "moved" : "left";
      if (how && t.state === "moved" && !t.why) t.why = how.slice(0, 300);
    }
    r.settled_ms = Date.now();
    this.save();
    try { this.whole(r); } catch {}
  }
}

export const restarts = (): Restarts | undefined => G.__keelRestarts;
