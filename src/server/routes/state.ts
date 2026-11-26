// The state of every session, told to the pages: the one fact of
// src/core/watch.ts as src/automation/state.ts works it out, kept current
// here. Whatever may change a session's state (its row, a turn event, a
// status, a card opening or closing, an agent, a wait) marks it to be read
// again; a state that really changed goes out as one frame.
//
// GET /api/state -> { states: { [session id]: SessionState }, queued: { [session id]: number }, rev }
//   Every session that is not archived, agents' sessions included. If `queued` is present,
//   a missing count means zero. Counts and states reflect the same bus rev.
// Frame: { t: "feature", name: "state", session_id, data: SessionState | null }
//   (null: the session is gone).
// GET /api/stuck?after=SECONDS&format=text -> { as_of, after, items }
//   "is anything stuck": the running turns whose step has made no progress
//   for too long (src/core/stuck.ts), agents' included, longest first.
//   `after` sets the limit for a model and a tool alike; format=text is the
//   same answer a line an item. Without `after` the limits are the owner's:
//   the `stuck` section of the daemon settings (model_s, tool_s; 120 and 600).
import type { Frame } from "../../core/types.ts";
import { STUCK_AFTER, stuckOf, stuckText, type After, type StuckItem } from "../../core/stuck.ts";
import { liveJobs, running } from "../../tools/jobs.ts";
import { joinPulse } from "../../core/pulse.ts";
import type { SessionState } from "../../core/watch.ts";
import { registerSettings } from "../../admin/settings.ts";
import { timed } from "../../admin/stall.ts";
import { seesOutside } from "../admission.ts";
import { factsOf, lens, progressOf, sessionState, stuckAfter, type Lens } from "../../automation/state.ts";
import { ResultLandings } from "../../automation/result-landings.ts";
import type { Deps, RouteModule } from "../app.ts";
import { landing } from "./landing.ts";

// Changes that arrive together (a turn ending, its card closing) are read once.
const SETTLE_MS = 25;
// What no frame tells (a background command ending, a step passing its limit) is caught within this.
const SWEEP_MS = 5000;
// A session the telling read this recently is not read again by the sweep: a working session's frames
// (a step, a status) read it every few seconds already, and the sweep's own read would find the same.
// What only time changes in it (a step past its limit) is then caught within SWEEP_MS plus this.
export const SWEEP_FRESH_MS = SWEEP_MS / 2;
// A working session's step changes many times a second (one tool call after
// another). Its row is read at a glance, so a change from one step to the next
// is told at most this often; a change of the word itself is told at once.
const STEP_MS = 600;

// Only queues of sessions in the snapshot. An empty map is still an answer.
export function queuedFor(states: Record<string, object>, counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...counts].filter(([id]) => Object.hasOwn(states, id)));
}

// The sessions the sweep reads: those not at rest that the telling has not read lately.
export function sweepDue(live: Iterable<string>, readAt: Map<string, number>, now: number): string[] {
  const out: string[] = [];
  for (const id of live) if (now - (readAt.get(id) ?? -Infinity) >= SWEEP_FRESH_MS) out.push(id);
  return out;
}

export class StateBoard {
  // What the listeners were last told of each session, as sent. Only a telling writes it: a read
  // of every state (a page's snapshot, a peer's relay opening, the command line) tells its caller
  // and no listener, so it must not make a change look told.
  private last = new Map<string, string>();
  private dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private due = 0; // when the pending telling runs
  private asking = new Set<string>();
  private sent = new Map<string, { at: number; watch: string }>();
  // When the telling last read each session.
  private readAt = new Map<string, number>();
  // Sessions seen not at rest (told so, or read so by a snapshot): looked at again by the sweep.
  private live = new Set<string>();

  constructor(private deps: Pick<Deps, "store" | "bus" | "engine">, private landings?: ResultLandings) {}

  private from() { return { store: this.deps.store, engine: this.deps.engine }; }

  // One session's state as told now, without its words.
  read(id: string, l: Lens = lens(this.from())): SessionState | null {
    const s = this.deps.store.session(id);
    // An archived session is told to no page: its row is the archive's.
    if (!s || s.archived) return null;
    const { label: _l, word: _w, ...st } = sessionState(s, { lens: l });
    return st;
  }

  // `outside`: with the sessions another harness runs, for a view of the owner's own (src/core/outside.ts).
  all(opts: { outside?: true } = {}): Record<string, SessionState> {
    const l = lens(this.from());
    const out: Record<string, SessionState> = {};
    for (const s of this.deps.store.sessions(opts.outside ? { outside: true } : {})) {
      const st = this.read(s.id, l)!;
      out[s.id] = st;
      this.note(s.id, st);
      if (!s.parent_id && !s.outside && !s.machine) this.landings?.refresh(s.id);
    }
    return out;
  }

  // The steps that have made no progress for too long, the longest first.
  stuck(after: After = stuckAfter(), now = Date.now()): StuckItem[] {
    const l = lens(this.from());
    const out: StuckItem[] = [];
    // A session whose turn ended while a command of it runs is read too: that command can be stuck.
    const commands = new Set(liveJobs().filter((j) => j.background && running(j)).map((j) => j.sessionId));
    for (const s of this.deps.store.sessions()) {
      if (!this.deps.engine.isRunning(s.id) && !commands.has(s.id)) continue;
      const hit = stuckOf(progressOf(s, l, factsOf(s, l)), now, after);
      if (!hit) continue;
      const parent = s.parent_id ? this.deps.store.session(s.parent_id) : undefined;
      out.push({ ...hit, session_id: s.id, title: s.title, agent: !!s.parent_id, ...(parent ? { parent_id: parent.id, parent_title: parent.title } : {}), elapsed_ms: now - hit.since });
    }
    return out.sort((a, b) => b.elapsed_ms - a.elapsed_ms);
  }

  // A session not at rest goes on by itself or ends with no frame to say so: the sweep reads it again.
  private note(id: string, st: SessionState) {
    if (st.watch === "need" || st.watch === "work" || st.watch === "wait") this.live.add(id); else this.live.delete(id);
  }

  // The telling runs after `ms`, or sooner when one is already due sooner.
  private arm(ms: number) {
    const at = Date.now() + ms;
    if (this.timer && this.due <= at) return;
    clearTimeout(this.timer);
    this.due = at;
    this.timer = setTimeout(() => this.flush(), ms);
  }

  // The session and the sessions above it: an agent's card is its parent's too.
  // (A change is told within the settle time also while a step change waits out its own, longer, time.)
  // (One column of one row: a change marks the session and every one above it, many times a second.)
  private parentOf(id: string): string | null | undefined {
    try { return this.deps.store.db.query<{ parent_id: string | null }, [string]>("SELECT parent_id FROM sessions WHERE id = ?").get(id)?.parent_id; } catch { return this.deps.store.session(id)?.parent_id; } // (a store before agents' column)
  }

  touch(id: string | undefined | null) {
    for (let n = 0; id && n < 32; n++) {
      this.dirty.add(id);
      id = this.parentOf(id);
    }
    this.arm(SETTLE_MS);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty.size) return;
    const ids = [...this.dirty];
    this.dirty.clear();
    return timed(() => `reading the state of ${ids.length} sessions for the pages`, () => this.tell(ids));
  }
  private tell(ids: string[]) {
    const l = lens(this.from());
    const at = Date.now();
    let again = Infinity;
    for (const id of ids) {
      const st = this.read(id, l);
      if (!st) { this.gone(id); continue; }
      this.readAt.set(id, at);
      this.note(id, st);
      const now = JSON.stringify(st);
      if (this.last.get(id) === now) continue;
      // One step after another inside a working turn: told when the last telling is old enough.
      const told = this.sent.get(id);
      if (told && told.watch === "work" && st.watch === "work" && at - told.at < STEP_MS) {
        this.dirty.add(id);
        again = Math.min(again, told.at + STEP_MS - at);
        continue;
      }
      this.last.set(id, now);
      this.sent.set(id, { at, watch: st.watch });
      this.deps.bus.emit({ t: "feature", name: "state", session_id: id, data: st });
    }
    if (this.dirty.size) this.arm(Math.max(SETTLE_MS, again));
  }

  onFrame(f: Frame) {
    if (f.t === "session") return f.deleted ? this.gone(f.session.id) : this.touch(f.session.id);
    if (f.t === "event") {
      if (f.event.kind === "turn_end") this.landings?.refresh(f.event.session_id, true);
      return this.touch(f.event.session_id);
    }
    if (f.t === "status" || f.t === "queue") return this.touch(f.session_id);
    if (f.t === "questions") {
      if (f.machine) return;
      const now = new Set(f.pending.map((q) => q.session_id));
      for (const id of new Set([...this.asking, ...now])) this.touch(id);
      this.asking = now;
      return;
    }
    if (f.t !== "feature" || f.name === "state") return;
    // The tree-review feed already tells us when a tool moved one of this
    // tree's refs, including the base. A landing made by hand then shows up
    // without waiting for the coordinator's turn to end.
    if (f.name === "tree_review" && f.session_id) this.landings?.refresh(f.session_id, true);
    // A module's frame names its session on the frame or in what it carries (an agent's record names both ends).
    const d = f.data as any;
    for (const x of [f.session_id, d?.session_id, d?.parent_id, d?.card?.session_id, d?.data?.session_id, d?.data?.parent_id]) if (typeof x === "string") this.touch(x);
  }

  private gone(id: string) {
    this.landings?.forget(id);
    this.dirty.delete(id);
    this.sent.delete(id);
    this.readAt.delete(id);
    this.live.delete(id);
    if (this.last.delete(id)) this.deps.bus.emit({ t: "feature", name: "state", session_id: id, data: null });
  }

  // Sessions that are not at rest are read again: what ended without a frame shows within the sweep.
  // Whether a session is not at rest (the sweep has something to read).
  restless(): boolean { return this.live.size > 0; }
  sweep(now = Date.now()) {
    for (const id of sweepDue(this.live, this.readAt, now)) this.touch(id);
  }
}

export let board: StateBoard | undefined;

const positive = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;

export const stateRoutes: RouteModule = (deps) => {
  // How long a step may go without progress before it is called stuck, in seconds (src/core/stuck.ts).
  registerSettings("stuck", { model_s: STUCK_AFTER.model / 1000, tool_s: STUCK_AFTER.tool / 1000 }, (v) => (positive(v.model_s) && positive(v.tool_s) ? undefined : "model_s and tool_s are numbers of seconds above 0"));
  // What the state reads on every change: the sessions under a session, and the cards that wait.
  if (deps.store.columnExists("sessions", "parent_id")) deps.store.migrate("CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent_id)");
  if (deps.store.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'approvals'").get()) {
    deps.store.migrate("CREATE INDEX IF NOT EXISTS approvals_pending ON approvals(created, id) WHERE state = 'pending'");
  }
  const gitLandings = new ResultLandings(deps.store, async (repo) => (await landing?.baseOf(repo)) ?? null,
    (id) => b.touch(id), (e, id) => deps.errors.capture("server", e, { at: "state landing", session: id }));
  const b = (board = new StateBoard(deps, gitLandings));
  const g = globalThis as { __keelStateOff?: () => void };
  g.__keelStateOff?.();
  g.__keelStateOff = deps.bus.on((f) => b.onFrame(f));
  // On the daemon's one tick: while it is idle the sweep comes only while a session is not at rest.
  joinPulse("state sweep", () => b.sweep(), { every: SWEEP_MS, due: (now) => (b.restless() ? now : undefined) });
  return {
    "/api/state": { GET: (req: Request) => {
      // The page's list and home show every session; another machine asking is shown none another harness runs.
      const states = seesOutside(req) ? b.all({ outside: true }) : b.all();
      const queued = queuedFor(states, deps.engine.queuedCounts());
      return Response.json({ states, queued, rev: deps.bus.rev() });
    } },
    "/api/stuck": {
      GET: (req: Request) => {
        const q = new URL(req.url).searchParams;
        const given = q.get("after");
        const secs = given === null ? undefined : Number(given);
        if (secs !== undefined && !(secs > 0)) return Response.json({ error: "after is a number of seconds above 0" }, { status: 400 });
        const after = secs === undefined ? stuckAfter() : { model: secs * 1000, tool: secs * 1000 };
        const now = Date.now();
        const items = b.stuck(after, now);
        if (q.get("format") === "text") return new Response(`${stuckText(items, after)}\n`, { headers: { "content-type": "text/plain; charset=utf-8" } });
        return Response.json({ as_of: now, after, items });
      },
    },
  };
};
