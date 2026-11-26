import { registerSettings, settings } from "../admin/settings.ts";
import type { Row } from "../admin/health-rows.ts";
import type { Session } from "../core/types.ts";
import { machine } from "../tools/heavy.ts";
import { capture, D } from "./core.ts";
import { decide, IDLE, loadWhy, over, SAMPLE_MS, SETTLE_MS, type LoadState, type Reading, type Tree } from "./load-rules.ts";

// Agent trees wait while the machine is over its thread count (the decision is pure, in ./load-rules.ts). It is
// one of the engine's `stepHold`s, beside the fleet pause: a held tree's turns wait before their next model step,
// so a running turn stops at its step boundary and a new agent of the tree waits before its first one. A top
// session's turn that the owner's own words started or steered is no tree and always goes on. The reading is the
// heavy pool's (`machine.read` in src/tools/heavy.ts), taken every five seconds on the automation's pulse.

registerSettings("load_hold", { on: true, threads: null }, (v) => {
  if (typeof v.on !== "boolean") return "on is true or false";
  if (v.threads !== null && !(typeof v.threads === "number" && v.threads > 0 && Number.isFinite(v.threads))) return "threads is a positive number, or null for the machine's own count";
  return undefined;
});

const conf = () => settings().load_hold as { on: boolean; threads: number | null };

let readings: Reading[] = [];
let st: LoadState = IDLE;
let lastAt = 0;
// The trees seen at the last pass, by key: when each started and what it is called.
let known = new Map<string, Tree & { title: string }>();
const heldAt = new Map<string, number>();
const waiters = new Map<string, Set<() => void>>();
// The day's account: trees that waited (newest first, at most 50) and the time over the line, by hour.
type Waited = { key: string; title: string; from: number; ms: number };
let waited: Waited[] = [];
const overByHour = new Map<number, number>();
const DAY = 86_400_000;
let printed = "";

// The tree a session works in: the agent its top session started, or the top session itself.
export function treeOf(s: Session): string {
  const { store } = D();
  let cur = s;
  for (let i = 0; i < 32 && cur.parent_id; i++) {
    const up = store.session(cur.parent_id);
    if (!up || !up.parent_id) return cur.id;
    cur = up;
  }
  return cur.id;
}

// The trees with unattended work now: every running turn that is not a top session's turn the owner started.
function trees(): Map<string, Tree & { title: string }> {
  const { engine, store } = D();
  const out = new Map<string, Tree & { title: string }>();
  for (const id of engine.runningIds()) {
    const s = store.session(id);
    if (!s) continue;
    if (!s.parent_id && engine.byOwner(id)) continue;
    const key = treeOf(s);
    if (out.has(key)) continue;
    const root = key === s.id ? s : store.session(key);
    out.set(key, { key, started: root?.created ?? s.created, title: root?.title || "an agent" });
  }
  return out;
}

const release = (key: string) => { const w = waiters.get(key); waiters.delete(key); for (const go of w ?? []) go(); };
const releaseAll = () => { for (const k of [...waiters.keys()]) release(k); };

function settle(next: LoadState, now: number) {
  const was = new Set(st.held);
  const is = new Set(next.held);
  for (const k of next.held) if (!was.has(k)) heldAt.set(k, now);
  for (const k of st.held) {
    if (is.has(k)) continue;
    const from = heldAt.get(k) ?? now;
    heldAt.delete(k);
    waited = [{ key: k, title: known.get(k)?.title ?? "an agent", from, ms: now - from }, ...waited.filter((w) => now - w.from < DAY)].slice(0, 50);
    release(k);
  }
  st = next;
}

function account(r: Reading, gap: number) {
  if (r.load1 <= r.threads) return;
  const hour = Math.floor(r.at / 3_600_000);
  overByHour.set(hour, (overByHour.get(hour) ?? 0) + gap);
  for (const h of overByHour.keys()) if (h < hour - 24) overByHour.delete(h);
}

// One pass of the automation's pulse: a reading every five seconds and the decision on it.
export function tick(now = Date.now()) {
  if (now - lastAt < SAMPLE_MS) return;
  const gap = lastAt ? Math.min(now - lastAt, 2 * SAMPLE_MS) : 0;
  lastAt = now;
  try {
    const c = conf();
    if (!c.on) { if (st.held.length) settle(IDLE, now); readings = []; tell(); return; }
    const m = machine.read();
    const r: Reading = { at: now, load1: m.load1, threads: c.threads ?? m.cores };
    // Readings older than the minute (and a sample) are no longer read. A hole in them (the pulse paused while
    // the daemon was idle) starts them again: `over` then waits for a whole minute of readings.
    const prev = readings.at(-1);
    readings = prev && now - prev.at <= 3 * SAMPLE_MS ? [...readings.filter((x) => now - x.at <= SETTLE_MS + SAMPLE_MS), r] : [r];
    account(r, gap);
    known = trees();
    settle(decide(st, readings, [...known.values()], now), now);
    tell();
  } catch (e) { capture(e, { at: "load hold" }); }
}

export type LoadHoldView = {
  on: boolean;
  load1: number | null;
  threads: number | null;
  over: boolean;
  since: number | null;
  held: { key: string; title: string; since: number }[];
  // The last day: minutes over the line, and the trees that waited and let go.
  over_min_day: number;
  waited: { title: string; from: number; ms: number }[];
};

export function state(now = Date.now()): LoadHoldView {
  const r = readings.at(-1);
  const hour = Math.floor(now / 3_600_000);
  let overMs = 0;
  for (const [h, ms] of overByHour) if (h > hour - 24) overMs += ms;
  return {
    on: conf().on,
    load1: r ? Math.round(r.load1 * 10) / 10 : null,
    threads: r?.threads ?? null,
    over: over(readings, now),
    since: st.since,
    held: st.held.map((k) => ({ key: k, title: known.get(k)?.title ?? "an agent", since: heldAt.get(k) ?? now })),
    over_min_day: Math.round(overMs / 60_000),
    waited: waited.filter((w) => now - w.from < DAY).map(({ title, from, ms }) => ({ title, from, ms })),
  };
}

// Every page hears a change of what is held, and of the load while anything is held.
function tell() {
  const v = state();
  const print = JSON.stringify([v.held.map((h) => h.key), v.held.length ? Math.round(v.load1 ?? 0) : 0, v.on]);
  if (print === printed) return;
  printed = print;
  try { D().bus.emit({ t: "feature", name: "load_hold", data: v }); } catch (e) { capture(e, { at: "load hold" }); }
}

// What a model step of a session waits for while its tree is held (the engine's `stepHold`).
export function hold(s: Session, byOwner: () => boolean): { why: string; kind: "load"; note: string; wait: (signal: AbortSignal) => Promise<void> } | undefined {
  if (!st.held.length) return undefined;
  if (!s.parent_id && byOwner()) return undefined;
  const key = treeOf(s);
  if (!st.held.includes(key)) return undefined;
  const r = readings.at(-1) ?? { load1: 0, threads: 0 };
  const why = loadWhy(r);
  return {
    why,
    kind: "load",
    note: `The machine is busy (load ${Math.round(r.load1)} on ${r.threads} threads): this work waits until the machine has room. The owner's own turns go on.`,
    wait: (signal) => new Promise<void>((go) => {
      if (signal.aborted) return go();
      const set = waiters.get(key) ?? new Set();
      waiters.set(key, set);
      const end = () => { set.delete(end); signal.removeEventListener("abort", end); go(); };
      set.add(end);
      signal.addEventListener("abort", end, { once: true });
    }),
  };
}

const min = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;

// Settings > Health: whether trees wait for the machine now, and the day's account.
export function healthRows(now = Date.now()): Row[] {
  const v = state(now);
  const how = "read the 1-minute load average every five seconds against the thread count";
  if (!v.on) return [{ id: "machine:load", group: "machine", level: "ok", title: "agent trees do not wait for the machine", detail: "the load hold is off (load_hold.on)" }];
  const day = `over the line ${v.over_min_day} min in the last day${v.waited.length ? `; ${v.waited.length} ${v.waited.length === 1 ? "tree" : "trees"} waited, the longest ${min(Math.max(...v.waited.map((w) => w.ms)))}` : ""}`;
  const load = v.load1 === null ? "no reading yet" : `load ${v.load1} on ${v.threads} threads`;
  if (v.held.length) {
    const names = v.held.slice(0, 5).map((h) => `${h.title} (${min(now - h.since)})`).join(", ");
    return [{ id: "machine:load", group: "machine", level: "warning", title: `${v.held.length} agent ${v.held.length === 1 ? "tree waits" : "trees wait"} for the machine`, detail: `${load}; waiting: ${names}${v.held.length > 5 ? ` and ${v.held.length - 5} more` : ""}; ${day}`, fix: "nothing to do: they go on as the load falls, the oldest first", how }];
  }
  return [{ id: "machine:load", group: "machine", level: "ok", title: v.load1 === null ? "the machine's load is not read yet" : `the machine has room: ${load}`, detail: day, how }];
}

// For a test: nothing held, nothing read.
export function reset() { releaseAll(); readings = []; st = IDLE; lastAt = 0; known = new Map(); heldAt.clear(); waited = []; overByHour.clear(); printed = ""; }
