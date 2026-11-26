// The pace of a session's unattended turns (the rule is pure, in ./pace-rules.ts). The owner's
// default is the settings section `pace` (`unattended_min`, for the sessions he talks to); a session's
// own `pace_min` (its menu) takes its place, 0 for off. The flush of what waits for a session
// (./core.ts) asks `held` before it starts a turn; the turn-end hook says when an unattended turn ended
// (`ended`). What waits, and until when, is a `pace` frame of the session, read by its dock, and
// `GET /api/sessions/:id/pace` says the same with what the pace did since the daemon started.
import { registerSettings, settings } from "../admin/settings.ts";
import { capture, D, flush, paceGate } from "./core.ts";
import { badPace, decide, paceMsOf, PACE_DEFAULT_MIN, type PacePart } from "./pace-rules.ts";

registerSettings("pace", { unattended_min: PACE_DEFAULT_MIN }, (v) => badPace(v.unattended_min));

const defaultMin = () => Number((settings().pace as { unattended_min?: number } | undefined)?.unattended_min ?? PACE_DEFAULT_MIN);

// When each session's last unattended turn ended, and how long its cache surely lives from then.
const ends = new Map<string, { at: number; life: number }>();
// What waits now: until when, and how many inputs.
const waiting = new Map<string, { at: number; n: number; timer: ReturnType<typeof setTimeout> }>();
// Since the daemon started: inputs that waited, and turns they did not start (inputs that went with another).
const done = new Map<string, { waited: number; joined: number }>();

export type PaceView = {
  session_id: string;
  pace_min: number;
  from: "session" | "default" | "agent";
  waiting: number;
  at?: number;
  last_end?: number;
  waited: number;
  joined: number;
};

export function paceMs(sessionId: string): number {
  const s = D().store.session(sessionId);
  if (!s) return 0;
  return paceMsOf(s.settings.pace_min, defaultMin(), !s.parent_id);
}

export function view(sessionId: string): PaceView {
  const s = D().store.session(sessionId);
  const own = s?.settings.pace_min;
  const w = waiting.get(sessionId), d = done.get(sessionId), e = ends.get(sessionId);
  return {
    session_id: sessionId,
    pace_min: paceMs(sessionId) / 60_000,
    from: own !== undefined ? "session" : s?.parent_id ? "agent" : "default",
    waiting: w?.n ?? 0,
    ...(w ? { at: w.at } : {}),
    ...(e ? { last_end: e.at } : {}),
    waited: d?.waited ?? 0,
    joined: d?.joined ?? 0,
  };
}

const tell = (sessionId: string) => {
  try { D().bus.emit({ t: "feature", name: "pace", session_id: sessionId, data: view(sessionId) }); } catch (e) { capture(e, { at: "pace", session: sessionId }); }
};

const stop = (sessionId: string) => {
  const w = waiting.get(sessionId);
  if (!w) return false;
  clearTimeout(w.timer);
  waiting.delete(sessionId);
  return true;
};

// The flush asks before it starts a turn: true holds what is lined up until the pace lets it go.
paceGate.held = (sessionId, parts) => {
  const e = ends.get(sessionId);
  const out = decide({ paceMs: paceMs(sessionId), lastEnd: e?.at, life: e?.life, now: Date.now(), parts: parts as PacePart[] });
  if (out.go) { if (stop(sessionId)) tell(sessionId); return false; }
  const w = waiting.get(sessionId);
  if (w && w.at === out.at && w.n === parts.length) return true;
  if (w) clearTimeout(w.timer);
  const timer = setTimeout(() => { waiting.delete(sessionId); flush(sessionId); }, Math.max(0, out.at - Date.now()));
  // A wait that is still owed keeps nothing alive at exit (the inputs are owed in their own tables).
  (timer as { unref?: () => void }).unref?.();
  waiting.set(sessionId, { at: out.at, n: parts.length, timer });
  const d = done.get(sessionId) ?? { waited: 0, joined: 0 };
  if (!w) d.waited += 1; else d.waited += Math.max(0, parts.length - w.n);
  done.set(sessionId, d);
  tell(sessionId);
  return true;
};

// The flush started a turn of `n` inputs: the wait is over, and n - 1 turns were not started.
paceGate.sent = (sessionId, n) => {
  const was = stop(sessionId);
  if (n > 1) {
    const d = done.get(sessionId) ?? { waited: 0, joined: 0 };
    d.joined += n - 1;
    done.set(sessionId, d);
  }
  if (was || n > 1) tell(sessionId);
};

// Nothing waits for the session any more (its inputs were dropped or moved).
paceGate.dropped = (sessionId) => { if (stop(sessionId)) tell(sessionId); };

// A turn of the session ended. One that carried the owner's word sets no pace: the next unattended
// input after it goes at once. The cache's lifetime is read from the turn that just ran.
export function ended(sessionId: string, owned: boolean) {
  if (owned) return void ends.delete(sessionId);
  const at = Date.now();
  ends.set(sessionId, { at, life: 0 });
  D().engine.cacheSure?.(sessionId).then((life) => {
    const cur = ends.get(sessionId);
    if (cur?.at === at) cur.life = life;
  }, (e) => capture(e, { at: "pace: cache life", session: sessionId }));
}

// The pace each session was last told with: a session frame that moves it decides what waits again.
const told = new Map<string, number | undefined>();
// The turn-end hook: whether the turn that ended carried the owner's word is read without its own end,
// which closes the search (src/engine/turn.ts byOwner).
export function turnEnded(sessionId: string) {
  try {
    const line = D().engine.lineage(sessionId);
    ended(sessionId, D().engine.byOwner(sessionId, line.at(-1)?.kind === "turn_end" ? line.slice(0, -1) : line));
  } catch (e) { capture(e, { at: "pace", session: sessionId }); }
}

// The session's own pace changed: what waits is decided again now.
export function changed(sessionId: string) {
  if (waiting.has(sessionId)) { stop(sessionId); flush(sessionId); }
  tell(sessionId);
}
export function onSession(s: { id: string; settings: { pace_min?: number } }) {
  if (told.has(s.id) ? told.get(s.id) === s.settings.pace_min : s.settings.pace_min === undefined) return;
  told.set(s.id, s.settings.pace_min);
  changed(s.id);
}

export function forget(sessionId: string) {
  stop(sessionId);
  told.delete(sessionId);
  ends.delete(sessionId);
  done.delete(sessionId);
}

// New parts (a test's, a restart's): nothing of the old ones waits.
paceGate.reset = () => {
  for (const w of waiting.values()) clearTimeout(w.timer);
  waiting.clear();
  ends.clear();
  done.clear();
  told.clear();
};
