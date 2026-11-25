import { onSettings, patchSettings, registerSettings, settings } from "../admin/settings.ts";
import type { Session } from "../core/types.ts";
import { capture, D } from "./core.ts";

// One switch that holds every start nobody at the keyboard asked for: loop runs, timer wakes, monitor
// batches, an agent's new turns, follow-ups, reports that wake a session. It is the engine's `stepHold`
// (src/engine/turn.ts holdForSpend): a turn that is not the owner's own waits before its next model step,
// so a turn already running stops at its step boundary and a turn that starts waits before its first
// step. Only a top session's turn that the owner's own words started or steered goes on. The switch is a
// settings section (`fleet_pause`), so it survives a restart: a paused fleet stays paused until the owner
// resumes it. Optionally the turns running now are stopped too (the stopper `pause`).

registerSettings("fleet_pause", { on: false, since: null }, (v) => {
  if (typeof v.on !== "boolean") return "on is true or false";
  if (v.since !== null && !(typeof v.since === "number" && Number.isFinite(v.since))) return "since is a time in milliseconds, or null";
  return undefined;
});

export type FleetPause = { paused: boolean; since: number | null };

export const state = (): FleetPause => {
  const s = settings().fleet_pause as { on: boolean; since: number | null };
  return { paused: s.on, since: s.on ? s.since : null };
};

const waiting = new Set<() => void>();
const release = () => { for (const go of [...waiting]) go(); waiting.clear(); };

// What a model step of a session waits for while the fleet is paused (the engine's `stepHold`).
export function hold(s: Session, byOwner: () => boolean): { why: string; kind: "pause"; note: string; wait: (signal: AbortSignal) => Promise<void> } | undefined {
  if (!state().paused) return undefined;
  if (!s.parent_id && byOwner()) return undefined;
  return {
    why: "the fleet is paused",
    kind: "pause",
    note: "The owner paused the fleet: this turn was not started by them, so it waits until they resume it.",
    wait: (signal) => new Promise<void>((go) => {
      if (signal.aborted) return go();
      const end = () => { waiting.delete(end); signal.removeEventListener("abort", end); go(); };
      waiting.add(end);
      signal.addEventListener("abort", end, { once: true });
    }),
  };
}

// The turns running now that the owner did not start, by session id.
export function unattended(): string[] {
  const { engine, store } = D();
  return engine.runningIds().filter((id) => {
    const s = store.session(id);
    return !!s && (!!s.parent_id || !engine.byOwner(id));
  });
}

// Pause: hold every unattended start from now on; with `stopRunning`, end the unattended turns running
// now as well. Returns the sessions whose turn was stopped.
export async function pause(stopRunning = false): Promise<{ state: FleetPause; stopped: string[] }> {
  if (!state().paused) {
    const r = patchSettings({ fleet_pause: { on: true, since: Date.now() } });
    if (!r.ok) throw Object.assign(new Error(r.error), { status: r.status ?? 400 });
  }
  const stopped = stopRunning ? unattended() : [];
  await Promise.all(stopped.map((id) => D().engine.interrupt(id, "pause").catch((e) => capture(e, { at: "fleet pause", session: id }))));
  return { state: state(), stopped };
}

export function resume(): FleetPause {
  if (state().paused) {
    const r = patchSettings({ fleet_pause: { on: false, since: null } });
    if (!r.ok) throw Object.assign(new Error(r.error), { status: r.status ?? 400 });
  }
  return state();
}

let tied = false;
// A change of the switch, however it was made (a route, a settings patch): what waits is released on a
// resume, and every page hears the new state once.
export function listen() {
  if (tied) return;
  tied = true;
  let was = JSON.stringify(state());
  onSettings(() => {
    const now = state();
    if (JSON.stringify(now) === was) return;
    was = JSON.stringify(now);
    if (!now.paused) release();
    try { D().bus.emit({ t: "feature", name: "fleet_pause", data: now }); } catch (e) { capture(e, { at: "fleet pause" }); }
  });
}

// For a test: nothing held, nothing waiting.
export function reset() { release(); tied = false; }
