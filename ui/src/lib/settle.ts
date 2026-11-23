// What a list says of a session moves when the session's state has settled,
// not with every flicker of it. A turn of a second, an agent started among
// twelve in one breath, a step that gives way to the next: a row that showed
// each of them changed several times a second and said nothing the owner could
// read. A change that calls the owner (something needs them, something failed,
// a machine went quiet) is shown at once; any other once it has held for
// SETTLE_MS, and at the latest MAX_BEHIND_MS after the row fell behind, so a
// session whose step changes every second still shows a recent one. The pane
// that shows the session follows it live: only the lists wait.
import { useRef, useSyncExternalStore } from "react";
import type { SessionState, Watch } from "../../../src/core/watch.ts";

export const SETTLE_MS = 1500;
export const MAX_BEHIND_MS = 6000;

// The states that call the owner: a change into or out of one is never held back.
const CALLS: readonly Watch[] = ["need", "fail", "declined"];
export const calls = (w: Watch | undefined) => !!w && CALLS.includes(w);

// What a row shows of a state, as one word: two states with the same key look the same on the row.
// (`since` is left out: a new step's start is not a change of what the row says.)
const REST: readonly Watch[] = ["done", "idle"];
export const stateKey = (st: SessionState) => REST.includes(st.watch) && !st.offline && st.as_of === undefined ? st.watch : [st.watch, st.why ?? "", st.text ?? "", st.on ?? "", st.agents, st.parked ?? 0, st.agents_total ?? 0, st.asks ?? 0, st.cls ?? "", st.until ?? "", st.offline ? "off" : "", st.as_of ?? "", st.stuck?.what ?? ""].join("|");

// Whether a change from what is shown to what is now is shown at once: one into, out of or within a state
// that calls the owner, and one of whether the state is current at all.
export function urgent(shown: SessionState | undefined, now: SessionState): boolean {
  if (!shown) return true;
  return calls(shown.watch) || calls(now.watch) || !!shown.offline !== !!now.offline || (shown.as_of === undefined) !== (now.as_of === undefined);
}

// How long to wait before what is now is shown: it is as it is since `changed`, and what is shown fell behind at `behind`.
export function settleIn(changed: number, behind: number, now: number, ms = SETTLE_MS, max = MAX_BEHIND_MS): number {
  return Math.max(0, Math.min(changed + ms, behind + max) - now);
}

// What the lists show, by what each value stands for (`st:<session>`, `kids:<parent>`): one store for
// the page, so what changed together moves together. A change waits until it has held SETTLE_MS, and
// is shown at the latest MAX_BEHIND_MS after the row fell behind, also while it keeps changing (from
// state to state or within one). When one is due, every one that
// is due within a moment of it is shown in the same frame, and a change that is shown at once takes
// every one that waits with it. A coordinator's row, its agents' line and the count above the list
// then change once for twelve agents started in a breath, and a turn of a second is never shown.
type Held = { key: string; value: unknown };
type Waits = Held & { at: number; behind: number };
const shown = new Map<string, Held>();
const waiting = new Map<string, Waits>();
let timer: ReturnType<typeof setTimeout> | undefined, rev = 0;
const subs = new Set<() => void>();
// What is shown together with what is due: what falls due within this much after it.
const TOGETHER_MS = 400;
// When a change that waits is shown: once it has held, and at the latest MAX_BEHIND_MS after the row fell
// behind, whatever it changed to meanwhile (a session that goes from state to state every second is shown
// as it is then, not as it was before).
export const dueAt = (w: { at: number; behind: number }) => settleIn(w.at, w.behind, 0);
const due = dueAt;
function flush(all = false) {
  clearTimeout(timer);
  timer = undefined;
  if (!waiting.size) return;
  const now = Date.now();
  let moved = false;
  for (const [id, w] of waiting) {
    if (!all && due(w) > now + TOGETHER_MS) continue;
    shown.set(id, { key: w.key, value: w.value });
    waiting.delete(id);
    moved = true;
  }
  wait();
  if (!moved) return;
  rev++;
  subs.forEach((f) => f());
}
function wait() {
  clearTimeout(timer);
  if (!waiting.size) return;
  const next = Math.min(...[...waiting.values()].map(due));
  timer = setTimeout(() => flush(), Math.max(0, next - Date.now()));
}
// (Read while a component renders: what it shows is decided there, and the store is told after.)
function settled<T>(id: string, key: string, value: T, atOnce: (was: T) => boolean): T {
  const was = shown.get(id);
  if (!was || was.key === key || atOnce(was.value as T)) {
    shown.set(id, { key, value });
    const queued = waiting.delete(id);
    // A change shown at once takes the ones that wait with it (on the next turn of the loop: not inside this render).
    if (was && was.key !== key && waiting.size) queueMicrotask(() => flush(true));
    else if (queued) wait();
    return value;
  }
  const had = waiting.get(id);
  const now = Date.now();
  if (!had || had.key !== key) {
    waiting.set(id, { key, value, at: now, behind: had?.behind ?? now });
    wait();
  } else had.value = value;
  return was.value as T;
}
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
const version = () => rev;
const useSettledRev = () => useSyncExternalStore(subscribe, version);

// The value a list shows for `id`: `value` once it has held (by its `key`), or at once when `atOnce` says so of what is shown.
export function useSettled<T>(id: string, value: T, key: string, atOnce: (shown: T) => boolean): T {
  useSettledRev();
  return settled(id, key, value, atOnce);
}

// A session's state as a list shows it (see above).
export const useSettledState = (id: string, st: SessionState): SessionState => useSettled(`st:${id}`, st, stateKey(st), (was) => urgent(was, st));

// The states of many sessions as a list orders and counts them: each as its row shows it.
export function useSettledStates(states: Record<string, SessionState>): Record<string, SessionState> {
  const r = useSettledRev();
  const out: Record<string, SessionState> = {};
  for (const [id, st] of Object.entries(states)) out[id] = settled(`st:${id}`, stateKey(st), st, (was) => urgent(was, st));
  // The same object while nothing it holds changed, for what is memoized on it.
  const last = useRef<{ r: number; keys: string; out: Record<string, SessionState> } | null>(null);
  const keys = Object.entries(out).map(([id, st]) => `${id}:${stateKey(st)}`).join(" ");
  if (!last.current || last.current.keys !== keys) last.current = { r, keys, out };
  return last.current.out;
}
