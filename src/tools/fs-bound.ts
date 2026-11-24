// A path on a mount that stopped answering (a network or cloud file system, a
// FUSE server that hangs) holds whoever asks the kernel about it, and a plain
// `statSync` or `openSync` holds the daemon's one loop: every session stops,
// and so does the Stop that would end the call. A file tool therefore never
// reaches such a path first. Before a call runs, each path it names is asked
// about on a thread of the pool (an async stat), bounded by a time limit and
// by the turn's signal. A path that answers in time is then in the kernel's
// caches and the tool's own calls on it are quick. A path that does not is a
// result that says so, and the call never starts.
//
// A mount that did not answer is remembered until its stuck calls return: a later call on it is refused at
// once instead of leaving another thread behind it. The mount is the one the path really resolves to (a path
// reached through a link is followed one component at a time, each step bounded), so a healthy file on the
// mount that only holds the link is never refused for it. The pool that runs these calls is as large as the
// machine has cores; stuck calls never take all of it, and a call that names many paths on one stalled target
// asks about a few at a time.
import { readFileSync } from "node:fs";
import { lstat, readlink, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { registerSettings, settings } from "../admin/settings.ts";
import { atCwd, homeDir } from "../core/paths.ts";
import { classify, pathsNamed } from "../safety/policy.ts";
import type { ToolCall } from "../engine/hooks.ts";

// A stat that has not come back in this long is taken to be stuck. A healthy network file system answers in
// well under a second and a retrying one (NFS with its default retries) in several, so ten seconds names a
// mount that is not coming back, and is far from the minute a stalled read used to hold a stop.
export const STALL_S = 10;
registerSettings("files", { stall_s: STALL_S }, (v) => (typeof v.stall_s === "number" && v.stall_s > 0 ? undefined : "stall_s is a number of seconds above 0"));
const limitMs = () => Math.round((Number(settings().files?.stall_s) || STALL_S) * 1000);

// Stat calls asked about one call's paths at a time: a call on one stalled target leaves at most this many behind.
const ASKED = 8;
// Calls left waiting on stalled mounts, across the daemon, before a path on a mount not known to be stalled is
// not tried either: the pool (one thread a core) would have no thread left for it. Never fewer than one.
const stuckMax = () => Math.max(1, availableParallelism() - 2);
// A stop that comes before this long names no stalled mount: the call may only be slow.
const SLOW_MS = 1000;
// One step of the walk that finds where a stalled path really is.
const STEP_MS = 500;

export type Unanswered = { path: string; mount: string; waited_ms: number; why: "limit" | "still" | "many" | "stopped" };

// One stalled target: when it was first asked, and how many of its calls are still in the pool.
type Stuck = { key: string; since: number; path: string; calls: number; links: Set<string>; into?: Stuck };
const stuck = new Map<string, Stuck>();
// A path that is a link into a stalled target (by its text) -> the target's key.
const via = new Map<string, string>();
const live = (e: Stuck): Stuck => { while (e.into) e = e.into; return e; };
const stuckCalls = () => { let n = 0; for (const e of stuck.values()) n += e.calls; return n; };

// The mount a path is on, by the mount table's own text (longest folder that is a mount point). A path
// that reaches another mount through a link is judged by where it resolves (below).
let table: { at: number; points: string[] } | undefined;
function mountPoints(): string[] {
  if (table && Date.now() - table.at < 2000) return table.points;
  let points = ["/"];
  try {
    points = readFileSync("/proc/self/mountinfo", "utf8").split("\n").map((l) => l.split(" ")[4]).filter((p): p is string => !!p)
      .map((p) => p.replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8))));
  } catch {}
  table = { at: Date.now(), points };
  return points;
}
export function mountOf(path: string): string {
  let best = "/";
  for (const m of mountPoints()) if (m.length > best.length && (path === m || path.startsWith(m + "/"))) best = m;
  return best;
}
// The root mount holds nearly everything: a path there is remembered by itself, not by the mount.
const keyOf = (path: string) => { const m = mountOf(path); return m === "/" ? path : m; };

// The stalled target a path is known to be on: by its mount, or by a link in its text that leads into one.
function known(path: string): Stuck | undefined {
  const own = stuck.get(keyOf(path));
  if (own) return own;
  if (!via.size) return undefined;
  for (let i = path.indexOf("/", 1); ; i = path.indexOf("/", i + 1)) {
    const k = via.get(i < 0 ? path : path.slice(0, i));
    const e = k && stuck.get(k);
    if (e) return e;
    if (i < 0) return undefined;
  }
}

async function within<T>(p: Promise<T>, ms: number): Promise<{ v: T } | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([p.then((v) => ({ v })), new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), ms); })]); } finally { clearTimeout(timer); }
}

// Where a path really is: its components followed one at a time, links read, each step bounded. `at` is the real
// path reached, or the one whose step did not answer; `links` are the links met on the way (their own text).
async function whereIs(path: string, hung: (p: Promise<unknown>) => void): Promise<{ at: string; links: string[] }> {
  const rest = resolve(path).split("/").filter(Boolean);
  const links: string[] = [];
  let done = "/", hops = 0;
  while (rest.length) {
    const next = join(done, rest.shift()!);
    const l = lstat(next).catch(() => null);
    const st = await within(l, STEP_MS);
    if (!st) { hung(l); return { at: next, links }; }
    if (!st.v) return { at: join(next, ...rest), links };
    if (!st.v.isSymbolicLink()) { done = next; continue; }
    if (++hops > 40) return { at: path, links };
    links.push(next);
    const r = readlink(next).catch(() => null);
    const to = await within(r, STEP_MS);
    if (!to) { hung(r); return { at: next, links }; }
    if (to.v === null) return { at: next, links };
    rest.unshift(...(isAbsolute(to.v) ? to.v : join(done, to.v)).split("/").filter(Boolean));
    done = "/";
  }
  return { at: done, links };
}

// Whether the kernel answers about each path within the limit. A path that does not exist is an answer.
export async function answers(paths: readonly string[], o: { signal?: AbortSignal; ms?: number } = {}): Promise<Unanswered | null> {
  const ms = o.ms ?? limitMs();
  const list = [...new Set(paths)].slice(0, 32);
  let first: Unanswered | null = null, next = 0;
  // A few at a time, none begun once one is not answered: the rest of a stalled call is not asked.
  const worker = async () => {
    while (!first && next < list.length) { const u = await probe(list[next++]!, ms, o.signal); first ??= u; }
  };
  await Promise.all(Array.from({ length: Math.min(ASKED, stuckMax(), list.length) }, worker));
  return first;
}

async function probe(path: string, ms: number, signal?: AbortSignal): Promise<Unanswered | null> {
  const at = Date.now();
  const seen = known(path);
  if (seen) return { path, mount: mountOf(seen.path), waited_ms: at - seen.since, why: "still" };
  // (The pool has no thread to spare: even a path that would answer could not be asked.)
  if (stuckCalls() >= stuckMax()) return { path, mount: mountOf(path), waited_ms: 0, why: "many" };
  const call = stat(path).then(() => "answered" as const, () => "answered" as const);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onStop = () => {};
  const limit = new Promise<"limit">((r) => { timer = setTimeout(() => r("limit"), ms); });
  const stopped = new Promise<"stopped">((r) => { onStop = () => r("stopped"); signal?.addEventListener("abort", onStop, { once: true }); if (signal?.aborted) r("stopped"); });
  try {
    const got = await Promise.race([call, limit, stopped]);
    if (got === "answered") return null;
    const waited = Date.now() - at;
    if (got === "stopped" && waited < SLOW_MS) return { path, mount: mountOf(path), waited_ms: waited, why: got };
    // The call is still in the pool: its target is stuck until it returns.
    const mine = remember(path, at, call);
    // Where the path really is: waited for when the call ends on its limit, found out meanwhile when a stop ends it.
    const found = rekey(mine, path);
    if (got === "limit") await found;
    return { path, mount: mountOf(live(mine).path), waited_ms: waited, why: got };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onStop);
  }
}

// A call that did not return: its target is stuck, under the mount the text of the path names for now.
function remember(path: string, since: number, call: Promise<unknown>): Stuck {
  const key = keyOf(path);
  const e = stuck.get(key) ?? { key, since, path, calls: 0, links: new Set<string>() };
  stuck.set(key, e);
  hang(e, call);
  return e;
}
function hang(e: Stuck, call: Promise<unknown>) {
  e.calls++;
  void call.then(() => {
    const l = live(e);
    if (--l.calls > 0) return;
    if (stuck.get(l.key) === l) stuck.delete(l.key);
    for (const k of l.links) if (via.get(k) === l.key) via.delete(k);
  });
}
// Moves what was remembered under the path's text to the mount the path resolves to, and notes the links on the way.
async function rekey(e: Stuck, path: string): Promise<void> {
  const w = await whereIs(path, (p) => hang(live(e), p));
  const from = live(e);
  if (stuck.get(from.key) !== from) return;
  const to = keyOf(w.at);
  const into = to === from.key ? from : stuck.get(to);
  if (into && into !== from) {
    // Another entry is already that mount: this one is part of it.
    into.calls += from.calls; into.since = Math.min(into.since, from.since);
    for (const k of from.links) into.links.add(k);
    stuck.delete(from.key); from.into = into; from.calls = 0;
  } else if (!into) {
    stuck.delete(from.key); from.key = to; from.path = w.at; stuck.set(to, from);
  }
  const target = live(e);
  target.path = w.at;
  for (const k of w.links) if (!stuck.has(k)) { via.set(k, target.key); target.links.add(k); }
}

// The modification times of many files (-1 where one is not there), asked in the pool a few dozen at a time
// and within the limit as a whole. What was not answered in time is -1, and `stalled` says so.
export async function mtimes(paths: readonly string[], ms = limitMs()): Promise<{ times: number[]; stalled?: string }> {
  const times = new Array<number>(paths.length).fill(-1);
  let next = 0, over = false;
  const worker = async () => {
    while (!over && next < paths.length) {
      const i = next++;
      times[i] = await stat(paths[i]!).then((s) => s.mtimeMs, () => -1);
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<"limit">((r) => { timer = setTimeout(() => r("limit"), ms); });
  const got = await Promise.race([Promise.all(Array.from({ length: Math.min(64, paths.length) }, worker)).then(() => "done" as const), limit]);
  clearTimeout(timer);
  if (got === "done") return { times };
  over = true;
  return { times, stalled: `The times of some files did not come within ${Math.round(ms / 1000)} s (a file system that stopped answering): the list may be out of order.` };
}

// What a refused call tells the model.
export function unansweredText(u: Unanswered, ms = limitMs()): string {
  const where = u.mount === "/" ? u.path : `${u.path} (on the mount ${u.mount})`;
  const s = (n: number) => `${Math.max(1, Math.round(n / 1000))} s`;
  if (u.why === "still") return `${where} has not answered for ${s(u.waited_ms)} and still does not: its file system is stalled or offline. Nothing was read or written. Try again when it is back, or work on another path.`;
  if (u.why === "many") return `Several paths are waiting on file systems that stopped answering, so ${where} was not tried. Nothing was read or written. Try again later.`;
  return `${where} did not answer within ${s(u.why === "limit" ? ms : u.waited_ms)}: its file system is stalled or offline, so the call never started. Nothing was read or written. Try again when it is back, or work on another path.`;
}

// What a stop adds to its result when it came while a path was not answering.
export const stoppedWaiting = (u: Unanswered) => `The call had not started: ${u.path}${u.mount === "/" ? "" : ` (on the mount ${u.mount})`} had not answered for ${Math.round(u.waited_ms / 1000)} s, so its file system is stalled or offline. Nothing was read or written.`;

// The paths a call names, for the question above: what the gate reads from its input (a file tool's path keys,
// a patch's files, any path an MCP tool is given), and the folder it runs in. A shell command's own words are
// judged by the gate, off the loop (src/safety/looking.ts).
export function callPaths(call: Pick<ToolCall, "tool" | "input" | "ctx">, input: unknown = call.input): string[] {
  const out = new Set<string>([call.ctx.cwd]);
  const cwd = call.tool.cwdOf?.(call.ctx, input) ?? call.ctx.cwd;
  const cls = classify(call.tool, input, cwd);
  if (cls.kind === "shell") return [...out];
  if ((cls.kind === "read" || cls.kind === "edit" || cls.kind === "other") && cls.paths) for (const p of cls.paths) out.add(p);
  for (const p of pathsNamed(input)) out.add(atCwd(call.ctx.cwd, p.replace(/^~(?=\/|$)/, homeDir())));
  return [...out];
}
