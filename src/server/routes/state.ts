// The state of every session, told to the pages: the one fact of
// src/core/watch.ts as src/automation/state.ts works it out, kept current
// here. Whatever may change a session's state (its row, a turn event, a
// status, a card opening or closing, an agent, a wait) marks it to be read
// again; a state that really changed goes out as one frame.
//
// GET /api/state -> { states: { [session id]: SessionState }, rev }
//   every session that is not archived, agents' sessions included.
// Frame: { t: "feature", name: "state", session_id, data: SessionState | null }
//   (null: the session is gone).
// GET /api/stuck?after=SECONDS&format=text -> { as_of, after, items }
//   "is anything stuck": the running turns whose step has made no progress
//   for too long (src/core/stuck.ts), agents' included, longest first.
//   `after` sets the limit for a model and a tool alike; format=text is the
//   same answer a line an item.
import type { Frame } from "../../core/types.ts";
import { STUCK_AFTER, stuckOf, stuckText, type After, type StuckItem } from "../../core/stuck.ts";
import type { SessionState } from "../../core/watch.ts";
import { lens, sessionState, type Lens } from "../../automation/state.ts";
import type { Deps, RouteModule } from "../app.ts";

// Changes that arrive together (a turn ending, its card closing) are read once.
const SETTLE_MS = 25;
// What no frame tells (a background command ending) is caught within this.
const SWEEP_MS = 5000;

export class StateBoard {
  private last = new Map<string, string>();
  private dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private asking = new Set<string>();

  constructor(private deps: Pick<Deps, "store" | "bus" | "engine">) {}

  private from() { return { store: this.deps.store, engine: this.deps.engine }; }

  // One session's state as told now, without its words.
  read(id: string, l: Lens = lens(this.from())): SessionState | null {
    const s = this.deps.store.session(id);
    if (!s) return null;
    const { label: _l, word: _w, ...st } = sessionState(s, { lens: l });
    return st;
  }

  all(): Record<string, SessionState> {
    const l = lens(this.from());
    const out: Record<string, SessionState> = {};
    for (const s of this.deps.store.sessions()) {
      const st = this.read(s.id, l)!;
      out[s.id] = st;
      this.last.set(s.id, JSON.stringify(st));
    }
    return out;
  }

  // The steps that have made no progress for too long, the longest first.
  stuck(after: After = STUCK_AFTER, now = Date.now()): StuckItem[] {
    const l = lens(this.from());
    const out: StuckItem[] = [];
    for (const s of this.deps.store.sessions()) {
      if (!this.deps.engine.isRunning(s.id)) continue;
      const hit = stuckOf(this.read(s.id, l) ?? undefined, now, after);
      if (!hit) continue;
      const parent = s.parent_id ? this.deps.store.session(s.parent_id) : undefined;
      out.push({ ...hit, session_id: s.id, title: s.title, agent: !!s.parent_id, ...(parent ? { parent_id: parent.id, parent_title: parent.title } : {}), elapsed_ms: now - hit.since });
    }
    return out.sort((a, b) => b.elapsed_ms - a.elapsed_ms);
  }

  // The session and the sessions above it: an agent's card is its parent's too.
  touch(id: string | undefined | null) {
    for (let n = 0; id && n < 32; n++) {
      this.dirty.add(id);
      id = this.deps.store.session(id)?.parent_id;
    }
    this.timer ??= setTimeout(() => this.flush(), SETTLE_MS);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty.size) return;
    const ids = [...this.dirty];
    this.dirty.clear();
    const l = lens(this.from());
    for (const id of ids) {
      const st = this.read(id, l);
      if (!st) { this.gone(id); continue; }
      const now = JSON.stringify(st);
      if (this.last.get(id) === now) continue;
      this.last.set(id, now);
      this.deps.bus.emit({ t: "feature", name: "state", session_id: id, data: st });
    }
  }

  onFrame(f: Frame) {
    if (f.t === "session") return f.deleted ? this.gone(f.session.id) : this.touch(f.session.id);
    if (f.t === "event") return this.touch(f.event.session_id);
    if (f.t === "status" || f.t === "queue") return this.touch(f.session_id);
    if (f.t === "questions") {
      if (f.machine) return;
      const now = new Set(f.pending.map((q) => q.session_id));
      for (const id of new Set([...this.asking, ...now])) this.touch(id);
      this.asking = now;
      return;
    }
    if (f.t !== "feature" || f.name === "state") return;
    // A module's frame names its session on the frame or in what it carries (an agent's record names both ends).
    const d = f.data as any;
    for (const x of [f.session_id, d?.session_id, d?.parent_id, d?.card?.session_id, d?.data?.session_id, d?.data?.parent_id]) if (typeof x === "string") this.touch(x);
  }

  private gone(id: string) {
    this.dirty.delete(id);
    if (this.last.delete(id)) this.deps.bus.emit({ t: "feature", name: "state", session_id: id, data: null });
  }

  // Sessions that are not at rest are read again: what ended without a frame shows within the sweep.
  sweep() {
    for (const [id, st] of this.last) {
      const w = (JSON.parse(st) as SessionState).watch;
      if (w === "need" || w === "work" || w === "wait") this.touch(id);
    }
  }
}

export let board: StateBoard | undefined;

export const stateRoutes: RouteModule = (deps) => {
  const b = (board = new StateBoard(deps));
  const g = globalThis as { __keelStateOff?: () => void; __keelStateSweep?: ReturnType<typeof setInterval> };
  g.__keelStateOff?.();
  g.__keelStateOff = deps.bus.on((f) => b.onFrame(f));
  clearInterval(g.__keelStateSweep);
  g.__keelStateSweep = setInterval(() => b.sweep(), SWEEP_MS);
  g.__keelStateSweep.unref?.();
  return {
    "/api/state": { GET: () => Response.json({ states: b.all(), rev: deps.bus.rev() }) },
    "/api/stuck": {
      GET: (req: Request) => {
        const q = new URL(req.url).searchParams;
        const given = q.get("after");
        const secs = given === null ? undefined : Number(given);
        if (secs !== undefined && !(secs > 0)) return Response.json({ error: "after is a number of seconds above 0" }, { status: 400 });
        const after = secs === undefined ? STUCK_AFTER : { model: secs * 1000, tool: secs * 1000 };
        const now = Date.now();
        const items = b.stuck(after, now);
        if (q.get("format") === "text") return new Response(`${stuckText(items, after)}\n`, { headers: { "content-type": "text/plain; charset=utf-8" } });
        return Response.json({ as_of: now, after, items });
      },
    },
  };
};
