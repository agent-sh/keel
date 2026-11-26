import { registerSettings, settings } from "../admin/settings.ts";
import type { Row } from "../admin/health-rows.ts";
import type { Session } from "../core/types.ts";
import { machine } from "../tools/heavy.ts";
import type { WaitShape } from "../engine/cache-plan.ts";
import { capture, D } from "./core.ts";
import * as failures from "./failures.ts";
import { decide, IDLE, loadWhy, MAX_WAIT_MS, over, SAMPLE_MS, SETTLE_MS, type LoadState, type Psi, type Reading, type Tree } from "./load-rules.ts";
import type { Pressures } from "../tools/pressure.ts";
import { blocksOnAgents } from "./tools.ts";

// Agent trees wait while the machine is over its thread count (the decision is pure, in ./load-rules.ts). It is
// one of the engine's `stepHold`s, beside the fleet pause: a held tree's turns wait before their next model step,
// so a running turn stops at its step boundary and a new agent of the tree waits before its first one. A top
// session's turn that the owner's own words started or steered is no tree and always goes on, and so is an agent
// whose turn carries the owner's word (his turn started it, he wrote to it from its card), an agent such a turn
// waits on (wait_agent, an Agent call in the foreground) and one whose tools run on another machine, which adds
// nothing to this one's load. The reading is the
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

// The day's account is kept in the store: a restart (several an hour on a busy day) left "the last day" at
// what this daemon had seen since it started. Read at the first pass, written when a tree let go or, for the
// time over the line, at most once a minute.
const KEPT = "load_hold_day";
const KEEP_MS = 60_000;
let loaded = false;
let keptPrint = "";
let keptAt = 0;
function loadKept(now: number) {
  if (loaded) return;
  loaded = true;
  try {
    const db = D().store.db;
    db.exec("CREATE TABLE IF NOT EXISTS admin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const row = db.query<{ value: string }, [string]>("SELECT value FROM admin_meta WHERE key = ?").get(KEPT);
    if (!row) return;
    const k = JSON.parse(row.value) as { waited?: Waited[]; over?: [number, number][] };
    const hour = Math.floor(now / 3_600_000);
    const mine = new Set(waited.map((w) => `${w.key}\0${w.from}`));
    const old = (Array.isArray(k.waited) ? k.waited : []).filter((w) => typeof w?.from === "number" && typeof w?.ms === "number" && now - w.from < DAY && !mine.has(`${w.key}\0${w.from}`));
    waited = [...waited, ...old].sort((a, b) => b.from - a.from).slice(0, 50);
    for (const [h, ms] of Array.isArray(k.over) ? k.over : []) if (typeof h === "number" && typeof ms === "number" && h > hour - 24) overByHour.set(h, (overByHour.get(h) ?? 0) + ms);
  } catch (e) { capture(e, { at: "load hold: the day's account" }); }
}
function keep(now: number, soon: boolean) {
  const value = JSON.stringify({ waited, over: [...overByHour] });
  if (value === keptPrint || (!soon && now - keptAt < KEEP_MS)) return;
  try {
    D().store.db.query("INSERT OR REPLACE INTO admin_meta (key, value) VALUES (?, ?)").run(KEPT, value);
    keptPrint = value;
    keptAt = now;
  } catch (e) { capture(e, { at: "load hold: the day's account" }); }
}

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

// Whether a session's steps go on whatever the load: its turn carries the owner's word, or an owner's turn above
// it waits on it, or its tools run on another machine.
export function exempt(s: Session, byOwner: (id: string) => boolean = (id) => D().engine.byOwner(id)): boolean {
  if (s.machine) return true;
  const { store } = D();
  let cur: Session | undefined = s;
  for (let i = 0; i < 32 && cur; i++) {
    if (byOwner(cur.id)) return true;
    const up: Session | undefined = cur.parent_id ? store.session(cur.parent_id) : undefined;
    // Only through a parent that blocks on its agents now: a parent that goes on working does not wait on this one.
    if (!up || !blocksOnAgents(up.id)) return false;
    cur = up;
  }
  return false;
}

// The trees with unattended work now: every running turn that is not exempt.
function trees(): Map<string, Tree & { title: string }> {
  const { engine, store } = D();
  const out = new Map<string, Tree & { title: string }>();
  for (const id of engine.runningIds()) {
    const s = store.session(id);
    if (!s) continue;
    if (exempt(s)) continue;
    const key = treeOf(s);
    if (out.has(key)) continue;
    const root = key === s.id ? s : store.session(key);
    out.set(key, { key, started: root?.created ?? s.created, title: root?.title || "an agent" });
  }
  return out;
}

// A tree the cap let go is told to its parent once (the top session that started it; a top session's own
// unattended turn is told to itself), riding its next input.
const capTold = new Set<string>();
export const CAP_CLS = "machine busy";
function toldCap(key: string, r: Reading) {
  if (capTold.has(key)) return;
  capTold.add(key);
  try {
    const s = D().store.session(key);
    if (!s) return;
    const to = s.parent_id ?? s.id;
    const mins = Math.round(MAX_WAIT_MS / 60_000);
    failures.record(to, { kind: "wait", cls: CAP_CLS, message: `${s.title || "An agent"} waited ${mins} min for the machine (load ${Math.round(r.load1)} on ${r.threads} threads) and goes on now: a wait for the load is capped at ${mins} min so no tree waits for good.`, ...(s.parent_id ? { ref: { id: s.id, label: s.title || "an agent" } } : {}), tell: "ride" }, s.id);
  } catch (e) { capture(e, { at: "load hold" }); }
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

// The pressure beside the load (src/automation/load-rules.ts): none where the machine's processors' is not read.
function psiOf(p: Pressures | undefined): { psi?: Psi } {
  const cpu = p?.host.cpu;
  if (cpu === undefined) return {};
  return { psi: { cpu, ...(p!.host.memory !== undefined ? { memory: p!.host.memory } : {}), ...(p!.unattended.cpu !== undefined ? { slice_cpu: p!.unattended.cpu } : {}) } };
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
    // The pressure's lines are measured against the machine's own thread count: a line the owner set
    // (load_hold.threads) is his, and the load alone is read against it.
    const r: Reading = { at: now, load1: m.load1, threads: c.threads ?? m.cores, ...(c.threads === null ? psiOf(m.pressure) : {}) };
    loadKept(now);
    const had = waited.length ? waited[0] : undefined;
    // Readings older than the minute (and a sample) are no longer read. A hole in them (the pulse paused while
    // the daemon was idle) starts them again: `over` then waits for a whole minute of readings.
    const prev = readings.at(-1);
    readings = prev && now - prev.at <= 3 * SAMPLE_MS ? [...readings.filter((x) => now - x.at <= SETTLE_MS + SAMPLE_MS), r] : [r];
    account(r, gap);
    known = trees();
    const next = decide(st, readings, [...known.values()], now);
    settle(next, now);
    for (const k of next.capped) toldCap(k, r);
    keep(now, waited[0] !== had);
    tell();
  } catch (e) { capture(e, { at: "load hold" }); }
}

export type LoadHoldView = {
  on: boolean;
  load1: number | null;
  threads: number | null;
  over: boolean;
  // The pressure read beside the load (some avg10, percent): null where the kernel has none.
  pressure: { cpu: number; memory: number | null; unattended_cpu: number | null } | null;
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
    pressure: r?.psi ? { cpu: r.psi.cpu, memory: r.psi.memory ?? null, unattended_cpu: r.psi.slice_cpu ?? null } : null,
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
export function hold(s: Session, byOwner: () => boolean): { why: string; kind: "load"; note: string; shape: WaitShape; wait: (signal: AbortSignal) => Promise<void> } | undefined {
  if (!st.held.length) return undefined;
  if (byOwner()) return undefined;
  const key = treeOf(s);
  if (!st.held.includes(key)) return undefined;
  if (exempt(s, (id) => id !== s.id && D().engine.byOwner(id))) return undefined;
  const at = st.at[key] ?? Date.now();
  // The cache plan's wait: it began when the tree was held and ends at the cap at the latest.
  const past = waited.map((w) => w.ms).slice(0, 20);
  const shape: WaitShape = { kind: "load", since: at, deadline: at + MAX_WAIT_MS, ...(past.length ? { past } : {}) };
  const r = readings.at(-1) ?? { load1: 0, threads: 0 };
  const why = loadWhy(r);
  return {
    why,
    kind: "load",
    shape,
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
  const how = v.pressure ? "read every five seconds: the 1-minute load against the thread count, and beside it the share of the last ten seconds tasks waited for a processor, the machine's and the unattended jobs'" : "read the 1-minute load average every five seconds against the thread count (this kernel reports no pressure)";
  if (!v.on) return [{ id: "machine:load", group: "machine", level: "ok", title: "agent trees do not wait for the machine", detail: "the load hold is off (load_hold.on)" }];
  const day = `over the line ${v.over_min_day} min in the last day${v.waited.length ? `; ${v.waited.length} ${v.waited.length === 1 ? "tree" : "trees"} waited, the longest ${min(Math.max(...v.waited.map((w) => w.ms)))}` : ""}`;
  const psi = v.pressure ? `, processors waited ${Math.round(v.pressure.cpu)}% of the last 10 s${v.pressure.unattended_cpu !== null ? ` (unattended jobs ${Math.round(v.pressure.unattended_cpu)}%)` : ""}${v.pressure.memory !== null && v.pressure.memory >= 1 ? `, memory ${Math.round(v.pressure.memory)}%` : ""}` : "";
  const load = v.load1 === null ? "no reading yet" : `load ${v.load1} on ${v.threads} threads${psi}`;
  if (v.held.length) {
    const names = v.held.slice(0, 5).map((h) => `${h.title} (${min(now - h.since)})`).join(", ");
    return [{ id: "machine:load", group: "machine", level: "warning", title: `${v.held.length} agent ${v.held.length === 1 ? "tree waits" : "trees wait"} for the machine`, detail: `${load}; waiting: ${names}${v.held.length > 5 ? ` and ${v.held.length - 5} more` : ""}; ${day}`, fix: "nothing to do: they go on as the load falls, the oldest first", how }];
  }
  return [{ id: "machine:load", group: "machine", level: "ok", title: v.load1 === null ? "the machine's load is not read yet" : `the machine has room: ${load}`, detail: day, how }];
}

// For a test: nothing held, nothing read.
export function reset() { releaseAll(); readings = []; st = IDLE; lastAt = 0; known = new Map(); heldAt.clear(); capTold.clear(); waited = []; overByHour.clear(); printed = ""; loaded = false; keptPrint = ""; keptAt = 0; }
