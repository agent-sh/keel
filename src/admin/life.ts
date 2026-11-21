// The daemon's own life across restarts: when the last one went down and how
// (it stopped by itself, or it was killed), which turns that cut, at which
// step or tool, and what became of each. One record a start, kept in the
// store, told in one place: `keel status`, Settings > Daemon and one Activity
// row.
//
// A running daemon writes a sign of life once a second into a small file
// beside its lock; a stop writes its end there. The next start reads it
// before anything else: an end means it stopped by itself, none means it went
// down under its work (a kill, a crash, the machine), within a second of the
// last sign. The engine tells of each cut turn (TurnHooks.turnCut) and of what
// became of it (turnCutSettled).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import { type CutState, type CutTurn, registerHooks } from "../engine/hooks.ts";
import type { Before, Restart, RestartTurn } from "./life-rows.ts";

export * from "./life-rows.ts";

const FILE = "daemon.alive";
const BEAT_MS = 1000;
// Starts kept: the last ones are what anyone asks about.
const KEPT = 50;
const G = globalThis as { __keelLife?: Life; __keelRestarts?: Restarts };

type Alive = { pid: number; started_ms: number; alive_ms: number; ended_ms?: number; how?: "restart" | "stop" };

export type Life = { before: Before | null; started_ms: number; end(how: "restart" | "stop"): void };

// Once per process (a hot reload keeps the life it has): reads how the last
// daemon ended, then keeps this one's sign of life.
export function beginLife(stateDir: string): Life {
  if (G.__keelLife) return G.__keelLife;
  const path = join(stateDir, FILE);
  let before: Before | null = null;
  try {
    const a = JSON.parse(readFileSync(path, "utf8")) as Alive;
    if (a.pid && a.pid !== process.pid && Number.isFinite(a.alive_ms)) {
      before = { pid: a.pid, started_ms: a.started_ms, down_ms: a.ended_ms ?? a.alive_ms, how: a.ended_ms ? a.how ?? "stop" : "killed" };
    }
  } catch {
    // No file (a first start, or a daemon from before it was written), or one cut mid-write: nothing is known.
  }
  const started_ms = Date.now();
  let ended = false;
  const write = (more: Partial<Alive> = {}) => {
    try { writeFileSync(path, JSON.stringify({ pid: process.pid, started_ms, alive_ms: Date.now(), ...more }), { mode: 0o600 }); } catch {}
  };
  write();
  const timer = setInterval(() => { if (!ended) write(); }, BEAT_MS);
  (timer as any).unref?.();
  const life: Life = {
    before, started_ms,
    end(how) {
      if (ended) return;
      ended = true;
      write({ ended_ms: Date.now(), how });
    },
  };
  // Any exit the process makes itself is a stop; one it does not make (a kill) leaves no end.
  process.on("exit", () => life.end("stop"));
  return (G.__keelLife = life);
}

// A stop the daemon makes itself says which kind before it exits.
export const endLife = (how: "restart" | "stop") => G.__keelLife?.end(how);

// When the last daemon went down, for what was open then (a turn, a span).
export const wentDownAt = (): number | undefined => G.__keelLife?.before?.down_ms;


const SCHEMA = "CREATE TABLE IF NOT EXISTS daemon_starts (id TEXT PRIMARY KEY, up_ms INTEGER NOT NULL, data TEXT NOT NULL);";

// The record of this start and the ones before it.
export class Restarts {
  private now: Restart | null = null;
  // Told when the record changes, and once when it is whole.
  changed: () => void = () => {};
  whole: (r: Restart) => void = () => {};

  constructor(private store: Store, life: Life) {
    store.migrate(SCHEMA);
    G.__keelRestarts = this;
    if (!life.before) return;
    const id = `${process.pid}-${life.started_ms}`;
    this.now = this.read(id) ?? { id, up_ms: life.started_ms, pid: process.pid, before: life.before, turns: [] };
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
    if (!r) return;
    this.store.db.query("INSERT INTO daemon_starts (id, up_ms, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(r.id, r.up_ms, JSON.stringify(r));
    try { this.changed(); } catch {}
  }

  // This start's record (null: nothing is known of a daemon before this one), else the newest kept.
  last(): Restart | null {
    if (this.now) return this.now;
    const r = this.store.db.query<{ data: string }, []>("SELECT data FROM daemon_starts ORDER BY up_ms DESC LIMIT 1").get();
    return r ? (JSON.parse(r.data) as Restart) : null;
  }

  private cut(s: Session, cut: CutTurn) {
    const r = this.now;
    if (!r || r.settled_ms || r.turns.some((t) => t.end_event === cut.end_event)) return;
    r.turns.push({ ...cut, session_id: s.id, title: s.title, parent_id: s.parent_id ?? null, state: "pending" });
    this.save();
  }

  private settle(s: Session, cut: CutTurn, state: CutState, why?: string) {
    const t = this.now?.turns.find((x) => x.end_event === cut.end_event);
    if (!t || this.now!.settled_ms) return;
    t.state = state;
    t.title = s.title || t.title;
    if (why) t.why = why.slice(0, 300);
    this.save();
  }

  // The recovery has decided every turn it had: a turn still pending went on
  // by other means (its owner's own recovery, a prompt that arrived) or was
  // left as it was. `went`: whether a session has a newer turn than the cut one.
  finish(went: (sessionId: string, cut: RestartTurn) => boolean) {
    const r = this.now;
    if (!r || r.settled_ms) return;
    for (const t of r.turns) if (t.state === "pending") t.state = went(t.session_id, t) ? "moved" : "left";
    r.settled_ms = Date.now();
    this.save();
    try { this.whole(r); } catch {}
  }
}

export const restarts = (): Restarts | undefined => G.__keelRestarts;
