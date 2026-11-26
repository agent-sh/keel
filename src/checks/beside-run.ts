// The checks beside an agent at work (the decisions are in src/checks/beside.ts).
// After a step of an agent's turn that may have changed its files, its lane
// waits out the window, then its tree is taken (the ledger's look,
// src/checks/ledger.ts) and, when the tree is new, a copy of it is checked out
// in a folder of Keel's own (one per agent, updated in place: only the files
// that changed are written), with the agent's installed packages (a check's
// `inputs`) linked in. The repository's `beside` checks run there one after
// another, off the loop, at a low priority, behind every other command of the
// heavy pool (src/tools/heavy.ts, "beside"), in the agent's own sandbox (or
// on the owner's host, when this machine has no room and one is set). Each run
// is a row of the ledger on that tree; a red one reaches a working agent as
// one harness input at its next step, and the session that started a finished
// one in its failures notice (toWhom in beside.ts).
import { during } from "../admin/activity.ts";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { settings } from "../admin/settings.ts";
import { localTime } from "../core/clock.ts";
import { git } from "../core/git.ts";
import { contains } from "../core/paths.ts";
import { outputOf } from "../core/proc.ts";
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import type { ToolCall } from "../engine/hooks.ts";
import { pool } from "../tools/heavy.ts";
import { toolEnv } from "../tools/jobs.ts";
import { howToRun, limitFor, LOCKS, quote } from "./before.ts";
import { INSTALL_MS, mainTop, packagesFor, readsIn, runCommand, type Ran } from "./before-run.ts";
import * as cache from "./package-cache.ts";
import { setupLineOf } from "../landing/pairs.ts";
import { timed } from "../admin/stall.ts";
import { BESIDE_DIR, besideOf, changed, commandOf, covers, dueAt, failureOf, finished, fresh, hostLoadOf, limitOf, noticeText, parentWords, perFile, PICK_MAX, placeOf, refsIn, scratchName, setupKey, started, sweepable, testFilesOf, testsFor, toTell, toWhom, turnEnded, WINDOW_MS, type AgentState, type Lane, type Red, type Refs, type Setup } from "./beside.ts";
import { countsOf } from "./counts.ts";
import { baseFor, inFlight } from "./runs.ts";
import { baseOf, holdCheckCache, inputsOf, keyOf, namedFor, objectsOf, ofSession, onTree, record, repoOf, treeOf, type Repo } from "./ledger.ts";
import type { Check } from "./named.ts";

type Deps = {
  store: Store; capture: (e: unknown, ctx: object) => void;
  perm: (sessionId: string) => { mode: string; sandbox: string } | undefined;
  // `shown`: folders out of `workspace` the run reads (the real places the copy's links to installed packages point at).
  confine: (sessionId: string, workspace: string, tool: string, shown?: string[]) => { wrap: (argv: string[]) => string[]; sandbox: string } | undefined;
  // Where the agent of a session stands (undefined: the session is no agent's).
  agentOf: (sessionId: string) => AgentState | undefined;
  // The harness input to a working agent, stored once under `key`: false when it no longer works (nothing sent).
  tellAgent: (sessionId: string, text: string, key: string) => Promise<boolean>;
  // A red of a finished agent, to the session that started it: its failures notice, with its next input.
  tellParent: (sessionId: string, cls: string, message: string) => void;
  // (A test's own window; the owner's setting otherwise.)
  windowMs?: number;
};
let d: Deps | undefined;
const dir = () => join(d!.store.stateDir, ...BESIDE_DIR);

// Kept by the process, not the module: a module loaded again (a dev daemon's reload) keeps the lanes.
// `refs`: what a test file reaches, by its blob (the same file in every agent's copy is read once).
// `rates`: what a test file of a check took in its last run here, by repository and check.
// `since`: when a lane's run that gave its slot back first asked for one, so the run after it keeps its place in
// the line. `dropped`: runs that got their slot after the agent had changed its files again: the copy they would
// check was no longer the agent's, and the slot went back unused.
const kept = ((globalThis as any).__keelBeside3 ??= { lanes: new Map(), timers: new Map(), dirty: new Set(), refs: new Map(), rates: new Map(), since: new Map(), stats: { runs: 0, cpu_ms: 0, ms: 0, told: 0, skipped: 0, dropped: 0 } }) as {
  lanes: Map<string, Lane>; timers: Map<string, ReturnType<typeof setTimeout>>; dirty: Set<string>; refs: Map<string, Refs>; rates: Map<string, number>;
  since: Map<string, number>;
  stats: { runs: number; cpu_ms: number; ms: number; told: number; skipped: number; dropped: number };
};
const { lanes, timers, dirty, refs, rates, since, stats } = kept;
// As many test files as a few repositories of this size hold, kept by content.
const REFS_MAX = 20_000;
// What the checks beside agents cost since the daemon started (the resources view reads it).
export const besideStats = () => ({ ...stats, lanes: lanes.size, running: [...lanes.values()].filter((l) => l.running).length });

// The owner's setting (checks.beside): the window, and a host to run on when this machine has no room.
type Setting = { window_s: number; host: string | null; host_path: string[] };
export function setting(): Setting {
  const b = (settings().checks?.beside ?? {}) as Partial<Setting>;
  return { window_s: typeof b.window_s === "number" ? b.window_s : WINDOW_MS / 1000, host: typeof b.host === "string" && b.host ? b.host : null, host_path: Array.isArray(b.host_path) ? b.host_path.filter((p) => typeof p === "string") : [] };
}
export function checkSetting(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object" || Array.isArray(v)) return "beside is an object (window_s, host, host_path)";
  const b = v as Record<string, unknown>;
  if (b.window_s !== undefined && !(typeof b.window_s === "number" && b.window_s >= 0 && b.window_s <= 3600)) return "beside.window_s is seconds, 0 to 3600";
  if (b.host !== undefined && b.host !== null && !(typeof b.host === "string" && /^[\w.@-]{1,120}$/.test(b.host))) return "beside.host is an ssh host name, or null";
  if (b.host_path !== undefined && !(Array.isArray(b.host_path) && b.host_path.every((p) => typeof p === "string" && /^[\w./~$-]{1,200}$/.test(p)))) return "beside.host_path is a list of folders on the host's PATH";
  return undefined;
}

// What a restart left: the copies of the files go (they are made again from the tree).
export function bindBeside(deps: Deps) {
  d = deps;
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  // (A lane that was running belongs to a module loaded before: its run still ends it.)
  try { for (const n of readdirSync(dir())) if (![...lanes.keys()].some((id) => n.startsWith(scratchName(id)))) rmSync(join(dir(), n), { recursive: true, force: true }); } catch {} // none yet
}

// The checks beside a session's agent, when its repository names any.
function namedBeside(s: Session): { repo: Repo; checks: Check[] } | undefined {
  const repo = repoOf(s.workspace);
  const checks = repo ? besideOf(namedFor(repo)?.checks ?? []) : [];
  return repo && checks.length ? { repo, checks } : undefined;
}
const isAgent = (s: Session) => !!s.parent_id && !s.machine && !!d?.agentOf(s.id);

// A call that may have changed files: an edit, a patch, a command. A working agent's step is where a red
// kept for it is told (it waited on a wait of its own when the run ended).
export function afterCall(s: Session, call: ToolCall) {
  if (!d || !isAgent(s)) return;
  if (call.tool.kind === "edit" || call.tool.kind === "shell" || call.tool.appliesPatch) dirty.add(s.id);
  if (lanes.get(s.id)?.owed) void settleOwed(s.id);
}
// A step ended: when it may have changed files, the window starts (or goes on).
export function afterStep(s: Session) {
  if (!d || !dirty.delete(s.id)) return;
  if (!namedBeside(s)) return;
  lanes.set(s.id, changed(lanes.get(s.id) ?? fresh(), Date.now()));
  schedule(s.id);
}
// Its turn ended: what waits runs now; with nothing running or waiting, its copy goes. A red kept for it
// is settled once the turn's end is known (a finished agent's goes to the session that started it).
export function afterTurn(s: Session) {
  if (!d) return;
  const l = lanes.get(s.id);
  if (!l) return;
  lanes.set(s.id, turnEnded(l));
  if (sweepable(lanes.get(s.id)!)) sweep(s.id);
  schedule(s.id);
  if (l.owed) setTimeout(() => void settleOwed(s.id), 1_000).unref?.();
}
// The agent's record changed (it ended, parked or went on): a red kept for it goes where it stands now.
export function agentChanged(sessionId: string) {
  if (lanes.get(sessionId)?.owed) void settleOwed(sessionId);
}
// A session that is gone: its lane and its copy go.
export function forget(sessionId: string) {
  clearTimeout(timers.get(sessionId));
  timers.delete(sessionId);
  dirty.delete(sessionId);
  since.delete(sessionId);
  if (lanes.get(sessionId)?.running) return; // its run removes them when it ends
  lanes.delete(sessionId);
  sweep(sessionId);
}
// The copy of an agent's files and its tool folder go (made again by its next change).
function sweep(id: string) {
  if (!d) return;
  const scratch = join(dir(), scratchName(id));
  void rm(scratch, { recursive: true, force: true }).catch(() => {});
  void rm(`${scratch}.tool`, { recursive: true, force: true }).catch(() => {});
}

function schedule(id: string) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  const l = lanes.get(id);
  const due = l ? dueAt(l, d?.windowMs ?? setting().window_s * 1000) : null;
  if (due === null) return;
  const t = setTimeout(() => { timers.delete(id); go(id); }, Math.max(0, due - Date.now()));
  (t as any).unref?.();
  timers.set(id, t);
}

function go(id: string) {
  const l = lanes.get(id);
  if (!l || l.running) return;
  lanes.set(id, started(l));
  let tree: string | null = null, told: string | null | undefined, said: string | null | undefined;
  void run(id).then((r) => { tree = r.tree; told = r.told; said = r.said; }, (e) => d?.capture(e, { at: "checks beside", session: id })).finally(() => {
    const now = lanes.get(id);
    if (!now) return;
    lanes.set(id, finished(now, tree, told, said));
    if (sweepable(lanes.get(id)!)) sweep(id);
    schedule(id);
  });
}

// A red kept for the agent goes where it stands now: to it when it works, to the session that started it
// when it ended, nowhere when the owner stopped it; kept while it waits on its own.
async function settleOwed(id: string) {
  const l = lanes.get(id);
  const owed = l?.owed;
  if (!owed || !d) return;
  const to = toWhom(d.agentOf(id));
  if (to === "later") return;
  lanes.set(id, { ...l!, owed: null });
  if (to === "agent") {
    // A key already taken (409) holds this tree's red as told: an earlier run, or an earlier daemon, sent it.
    const sent = await d.tellAgent(id, owed.text, owed.key).catch((e) => { if (e?.status !== 409) d!.capture(e, { at: "checks beside: telling the agent", session: id }); return true; });
    if (sent) { stats.told++; return; }
    // It ended meanwhile: where it stands now.
    const now = lanes.get(id);
    if (now) { lanes.set(id, { ...now, owed }); return settleOwed(id); }
    return;
  }
  if (to === "parent") { d.tellParent(id, owed.cls, owed.message); stats.told++; }
}

// One run of a lane: the tree it checked (null: none was read) and the failure told (undefined: as it was).
type Done = { tree: string | null; told?: string | null; said?: string | null };
async function run(id: string): Promise<Done> {
  const held: string[] = [];
  try { return await during("task", () => runIn(id, held), "checks beside an agent"); } finally { for (const k of held) cache.release(k); }
}
async function runIn(id: string, held: string[]): Promise<Done> {
  const s = d!.store.session(id);
  if (!s || s.archived) return { tree: null };
  // The owner stopped it, or the tree above it: nothing runs for it.
  if (toWhom(d!.agentOf(id)) === "none") return { tree: null };
  const named = namedBeside(s);
  if (!named) return { tree: null };
  const release = holdCheckCache(named.repo);
  try { return await runOnTree(id, s, named, held); } finally { release(); }
}
async function runOnTree(id: string, s: Session, { repo, checks }: { repo: Repo; checks: Check[] }, held: string[]): Promise<Done> {
  const lane = lanes.get(id)!;
  const look = await treeOf(repo);
  if (!look?.tree) return { tree: null };
  const tree = look.tree;
  if (tree === lane.tree) { stats.skipped++; return { tree }; }
  const at = Date.now();
  const scratch = join(dir(), scratchName(id));
  const tool = `${scratch}.tool`;
  const copy = await copyTree(repo, tree, look.head, scratch, checks);
  if (!copy) return { tree };
  const change = await changesOf(repo, tree, look.head, scratch, lane.tree);
  // Nothing of the agent's own: the files are the base's, which are not its to fix.
  if (!change.length) { stats.skipped++; return { tree }; }
  await readRefs(scratch, copy, checks);
  // The base's installed packages for the copy when the agent has none of its own (it unlinked them), as a
  // fails-before run has them (packagesFor): linked from the repository's checkout or the cache, else installed once.
  const pk = await provide(id, repo, scratch, tool, checks, held);
  const setups: (Setup & { check: Check; command: string; t0: number; log: string | null })[] = [];
  const reds: Red[] = [];
  const ran: string[] = [];
  const carry: string[] = [];
  let where: string | undefined;
  for (const check of checks) {
    const rate = `${repo.scope}\0${check.name}`;
    let tests: string[] = [], of = 0;
    if (check.tests?.length) {
      const all = timed(() => "checks beside: the tests a change touches", () => testsFor(change, testFilesOf(check, copy.files), (p) => refs.get(copy.blobs.get(p) ?? ""), lane.carry));
      if (!all.length) continue; // the change touches none of its tests
      of = all.length;
      tests = all.slice(0, PICK_MAX);
    }
    const command = commandOf(check, tests);
    const key = keyOf(check.dir, command);
    const inputs = inputsOf(repo.top, check.inputs) ?? null;
    // Run on these files already (by the agent itself, or before): not again.
    if (onTree(key, tree, inputs).length) { stats.skipped++; continue; }
    // The agent's own run of this check on these files is on its way: it reads its own result, and a run beside
    // it would do the same work at the same time. (Asked again when the run has its place in the pool's line.)
    const by = (c: string) => covers(check, tests, c);
    const covered = () => onTree(key, tree, inputs).length > 0 || inFlight(id, check.name, tree, inputs, by);
    if (inFlight(id, check.name, tree, inputs, by)) { stats.skipped++; continue; }
    // What its test files took here before; a check of the whole tree, what the session's own runs of it took.
    const own = () => ofSession(id, 0, 200).filter((r) => r.name === check.name && (r.result === "pass" || r.result === "fail")).map((r) => r.ended - r.started);
    const limitMs = tests.length ? limitOf(tests.length, rates.get(rate)) : limitFor(own());
    // Longer than a result beside the work is worth: the agent's own run is the check.
    if (limitMs === null) { stats.skipped++; continue; }
    const t0 = Date.now();
    // The packages it reads could not be had: not run, and not the agent's red.
    const lacks = pk.failed.get(check.dir);
    if (lacks) { ran.push(check.name); setups.push({ name: check.name, line: lacks, check, command, t0, log: null }); continue; }
    const r = await runCheck(id, s, check, command, scratch, tool, limitMs, repo, pk.shown, covered);
    // The agent changed its files while this waited for its slot: nothing more runs on this copy, and the lane's tree stays
    // the one checked last, so the next run checks the change since then.
    if (r === "stale") { stats.dropped++; return { tree: null }; }
    if (!r) continue;
    ran.push(!tests.length ? check.name : of > tests.length ? `${check.name} (the ${tests.length} most direct of the ${of} test files the change touches)` : `${check.name} (${tests.length} test file${tests.length === 1 ? "" : "s"})`);
    if (r.where) where = r.where;
    stats.runs++;
    stats.ms += r.ran.ms;
    stats.cpu_ms += r.ran.cpu_ms ?? 0;
    if (tests.length) { const f = perFile(r.ran.timedOut ? Math.max(r.ran.ms, limitMs) : r.ran.ms, tests.length); if (f) rates.set(rate, f); }
    const counts = countsOf(r.ran.out);
    const result = r.ran.timedOut || r.ran.signal ? "stopped" : r.ran.code === 0 ? "pass" : "fail";
    // What the copy lacks (a package, a type file, a program) is the setup's, said once on the agent's timeline
    // (below): not a result of the check, not a red of the agent's, and never told to its parent.
    const missing = result === "fail" ? setupLineOf(r.ran.out, r.ran.code) : undefined;
    if (missing) { setups.push({ name: check.name, line: missing, check, command, t0, log: r.log }); continue; }
    const row = record({ name: check.name, command, dir: check.dir, repo: repo.scope, tree, head: look.head, session_id: id, call_id: null, by: "beside", result, exit: r.ran.timedOut ? null : r.ran.code, pass: counts?.pass ?? null, fail: counts?.fail ?? null, started: t0, ended: Date.now(), log: r.log, from_run: null, inputs, top: repo.top, cpu_ms: r.ran.cpu_ms });
    if (result !== "fail") continue;
    if (tests.length) carry.push(...failedFiles(r.ran.out, tests));
    // How it fares on the base, when the ledger knows: a check red there too is not the change's.
    const base = row ? await baseFor(row, repo).catch(() => undefined) : undefined;
    reds.push({ name: check.name, command, exit: r.ran.code, pass: counts?.pass ?? null, fail: counts?.fail ?? null, failure: timed(() => "checks beside: what a failure says", () => failureOf(r.ran.out)), ...(base && !base.startsWith("not run on") ? { base } : {}) });
  }
  lanes.set(id, { ...lanes.get(id)!, carry });
  // Every check that ran passed: nothing is said, and a failure found again later is told again.
  if (!ran.length) return { tree };
  // A setup failure is said once, until a run has none.
  const said = setupKey(setups);
  if (said !== null && said !== (lanes.get(id) ?? lane).said) {
    for (const x of setups) record({ name: x.name, command: x.command, dir: x.check.dir, repo: repo.scope, tree, head: look.head, session_id: id, call_id: null, by: "beside", result: "stopped", exit: null, pass: null, fail: null, started: x.t0, ended: Date.now(), log: x.log, from_run: null, inputs: null, top: repo.top, note: x.line });
  }
  const t = toTell(lanes.get(id) ?? lane, reds);
  if (!reds.length) return { tree, told: null, said };
  if (!t.tell) return { tree, told: t.told, said };
  const text = noticeText(reds, { tree, at: localTime(at).slice(0, 5), ran, where });
  lanes.set(id, { ...lanes.get(id)!, owed: { text, key: `beside:${tree}`, ...parentWords(reds, tree) } });
  await settleOwed(id);
  return { tree, told: t.told, said };
}

// The test files whose tests failed, from a runner that names each file before its tests (bun: `path:`),
// else the first half of the files the run took. Run again with the next selection until they pass.
function failedFiles(out: string, tests: readonly string[]): string[] {
  const set = new Set(tests);
  const got = new Set<string>();
  let file: string | undefined;
  for (const l of out.split("\n")) {
    const h = /^(\S+):$/.exec(l.trim());
    if (h) { const f = h[1]!.replace(/^\.\//, ""); file = set.has(f) ? f : undefined; continue; }
    if (file && /^\(fail\) /.test(l)) got.add(file);
  }
  return got.size ? [...got] : tests.slice(0, Math.ceil(PICK_MAX / 2));
}

// What each test file of the beside checks reaches (src/checks/beside.ts refsIn), read off the loop's long
// stretches: a file at a time, and once a content (an agent's copy of the same file is read once).
async function readRefs(scratch: string, copy: Copy, checks: readonly Check[]) {
  if (refs.size > REFS_MAX) refs.clear();
  for (const check of checks) {
    if (!check.tests?.length) continue;
    for (const t of testFilesOf(check, copy.files)) {
      const blob = copy.blobs.get(t);
      if (!blob || refs.has(blob)) continue;
      let text: string;
      try { text = await Bun.file(join(scratch, t)).text(); } catch { continue; } // gone meanwhile
      refs.set(blob, refsIn(text, t));
    }
  }
}

// One check on the copy: on this machine through the heavy pool (behind every other command), or on the
// owner's host when this machine has no room and one is set. Undefined: it could not run (said nowhere:
// the agent's own run of the check says what it says). "stale": the agent changed its files while it waited.
async function runCheck(id: string, s: Session, check: Check, command: string, scratch: string, tool: string, limitMs: number, repo: Repo, shown: readonly string[] = [], covered: () => boolean = () => false): Promise<{ ran: Ran; log: string; where?: string } | "stale" | undefined> {
  const cwd = check.dir === "." ? scratch : join(scratch, check.dir);
  if (!existsSync(cwd)) { since.delete(id); return undefined; }
  const cfg = setting();
  const heavy = pool.heavy(command);
  const localFree = !heavy || pool.room(heavy.cost).free > 0;
  const hostLoad = !localFree && cfg.host ? hostLoadOf(await sshOut(cfg.host, "cat /proc/loadavg; nproc", 15_000).catch(() => "")) : undefined;
  const place = placeOf({ localFree, host: cfg.host, hostLoad, share: 0.83 });
  let ran: Ran | { error: string };
  if (place === "host") ran = await onHost(cfg, id, scratch, check, command, limitMs, linksOf([check]));
  else {
    // In the agent's own sandbox, as its own commands run: never with more reach than they have. The places the
    // copy's links to installed packages point at are shown to it (a link into a folder it cannot see breaks).
    const confined = d!.confine(id, scratch, tool, [...linkTargets(repo, [check]), ...shown]);
    if ("refused" in howToRun(d!.perm(id), confined)) { since.delete(id); return undefined; }
    // A kept place is from a run that gave way for newer files; one older than half an hour belongs to a run that
    // never came (it stopped early), so it is dropped rather than put ahead of the line with a wait of hours.
    const kept = since.get(id);
    const asked = kept !== undefined && Date.now() - kept < 30 * 60_000 ? kept : Date.now();
    const slot = await pool.take({ session: id, who: "beside", command, since: asked });
    if (slot === "aborted") return undefined;
    // The agent changed its files while this waited (its lane holds a change no run has taken): the slot goes back
    // unused, and the run of the newer files asks in this one's place.
    // Only a run that waited gives way: one granted at once (or not heavy) runs on the files it copied.
    if (slot && slot.waitedMs > 0 && stale(id)) { slot.release(); if (lanes.has(id)) since.set(id, asked); return "stale"; }
    since.delete(id);
    // The line may have been long: the agent's own run of it may have come in the meantime.
    if (covered()) { slot?.release(); stats.skipped++; return undefined; }
    mkdirSync(tool, { recursive: true });
    try {
      ran = await runCommand({ cwd, tool, env: { ...toolEnv(id), CI: "1" }, command, limitMs, wrap: confined?.wrap, unit: `keel-beside-${process.pid}-${Date.now() % 1_000_000}-${stats.runs}`, session: s.id, mark: "beside" });
    } finally { slot?.release(); }
  }
  if ("error" in ran) return undefined;
  const logs = join(dir(), "..", "beside-logs");
  mkdirSync(logs, { recursive: true });
  const log = join(logs, `${scratchName(id)}-${check.name.replace(/[^\w.-]/g, "_")}-${Date.now()}.log`);
  await Bun.write(log, `$ ${command}\n${ran.out}`);
  return { ran, log, ...(place === "host" ? { where: cfg.host! } : {}) };
}

// A lane whose agent changed its files after its running run took them.
const stale = (id: string) => (lanes.get(id)?.first ?? null) !== null;

// --- the base's packages for the copy

// The checks' folders each get the base's installed packages when the copy has none (the agent's own, linked by
// copyTree, are used first), the way a fails-before run has them (packagesFor in src/checks/before-run.ts), in the
// agent's sandbox. `shown`: the folders out of the copy the run reads them from. `failed`: by check folder, why
// they are not there when an install failed (the check is not run: that is the setup's, not the agent's red).
// Cache entries it holds are in `held`, released when the run ends.
async function provide(id: string, repo: Repo, scratch: string, tool: string, checks: readonly Check[], held: string[]): Promise<{ shown: string[]; failed: Map<string, string> }> {
  const out = { shown: [] as string[], failed: new Map<string, string>() };
  const confined = d!.confine(id, scratch, tool);
  const readable = confined ? (p: string) => readsIn(confined.wrap, p, scratch) : undefined;
  const env: Record<string, string> = { ...toolEnv(id), CI: "1" };
  for (const dir of new Set(checks.map((c) => c.dir))) {
    if (dir === "*") continue;
    const got = await packagesFor({ scratch, checkDir: dir, sources: [repo.top, mainTop(repo)], path: env.PATH ?? process.env.PATH ?? "", common: repo.common, again: false, readable, how: `beside:${confined?.sandbox ?? "unconfined"}` }, async (cwd, command) => {
      const slot = await pool.take({ session: id, who: "beside", command });
      if (slot === "aborted") return { exit: null, why: "it was stopped" };
      mkdirSync(tool, { recursive: true });
      try {
        const r = await runCommand({ cwd, tool, env, command, limitMs: INSTALL_MS, wrap: confined?.wrap, unit: `keel-beside-${process.pid}-${Date.now() % 1_000_000}-${stats.runs}`, session: id, mark: "beside" });
        return "error" in r ? { exit: null, why: r.error } : { exit: r.timedOut ? null : r.code, why: r.timedOut ? "it ran past its limit and was stopped" : "" };
      } finally { slot?.release(); }
    });
    if (got.held) held.push(got.held);
    for (const p of got.shown ?? []) if (!out.shown.includes(p)) out.shown.push(p);
    if (got.failed) out.failed.set(dir, `the base's packages could not be installed here: ${got.why ?? ""}`.slice(0, 200));
  }
  return out;
}

// --- the copy of the files

const ownGit = (scratch: string, args: string[], o: { input?: string; timeout?: number } = {}) =>
  git(scratch, args, { mode: "own", gitDir: join(scratch, ".git"), workTree: scratch, timeout: o.timeout ?? 120_000, input: o.input });

// The tree checked out in Keel's own folder for the agent: a repository of its own whose objects are the
// repository's and the ledger's (through alternates), with the agent's commit as its HEAD, so a check that
// asks git sees the agent's files as changes over it. Only what differs from the last copy is written;
// what a check left there goes. The links to the check's inputs (installed packages) point at the
// agent's own. The tree's files, from the top; undefined when it could not be made.
// The first folder of each input a check names (`node_modules` of `node_modules/../bun.lock`): linked into the copy.
const linksOf = (checks: readonly Check[]) => [...new Set(checks.flatMap((c) => c.inputs.map((i) => i.split("/").find((p) => p && p !== ".") ?? "")).filter((p) => p && !isAbsolute(p) && contains("/top", join("/top", p))))];
// Where each link points: the real place of the agent's own folder (one that is itself a link is followed to its end).
const realTarget = (repo: Repo, l: string) => { try { return realpathSync(join(repo.top, l)); } catch { return undefined; } };
const linkTargets = (repo: Repo, checks: readonly Check[]) => linksOf(checks).map((l) => realTarget(repo, l)).filter((p): p is string => !!p);
type Copy = { files: string[]; blobs: Map<string, string> };
async function copyTree(repo: Repo, tree: string, head: string | null, scratch: string, checks: readonly Check[]): Promise<Copy | undefined> {
  const objects = objectsOf(repo);
  const links = linksOf(checks);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!existsSync(join(scratch, ".git", "HEAD"))) {
        await rm(scratch, { recursive: true, force: true });
        mkdirSync(scratch, { recursive: true });
        const init = await git(scratch, ["init", "-q"], { mode: "plain", timeout: 30_000 });
        if (init.code !== 0) throw new Error(`git init: ${init.err.trim()}`);
      }
      await Bun.write(join(scratch, ".git", "objects", "info", "alternates"), `${join(repo.common, "objects")}\n${objects ? `${objects}\n` : ""}`);
      const steps: string[][] = [["read-tree", "--reset", "-u", tree], ["update-index", "-q", "--refresh"]];
      for (const a of steps) { const r = await ownGit(scratch, a); if (r.code !== 0 && a[0] !== "update-index") throw new Error(`git ${a[0]}: ${r.err.trim().split("\n").at(-1)}`); }
      // Files a check changed since the last copy are written again.
      const mod = await ownGit(scratch, ["diff-files", "--name-only", "-z"]);
      if (mod.out) { const r = await ownGit(scratch, ["checkout-index", "-f", "-z", "--stdin"], { input: mod.out }); if (r.code !== 0) throw new Error(`git checkout-index: ${r.err.trim()}`); }
      // What a check left that is not in the tree goes (the links stay).
      await ownGit(scratch, ["clean", "-fdxq", ...links.flatMap((l) => ["-e", `/${l}`])]);
      if (head) await ownGit(scratch, ["update-ref", "--no-deref", "HEAD", head]);
      for (const l of links) {
        const from = realTarget(repo, l), to = join(scratch, l);
        // The agent has none of its own: a link an earlier run made to the base's packages goes, so each run decides again.
        if (!from) { try { if (lstatSync(to).isSymbolicLink()) rmSync(to, { force: true }); } catch {} continue; } // none there

        let now: string | undefined;
        try { now = readlinkSync(to); } catch {} // none yet
        if (now === from) continue;
        if (now !== undefined) rmSync(to, { force: true });
        if (!existsSync(to)) try { symlinkSync(from, to); } catch {} // made meanwhile
      }
      const ls = await ownGit(scratch, ["ls-files", "-s", "-z"]);
      const files: string[] = [];
      const blobs = new Map<string, string>();
      for (const e of ls.out.split("\0")) {
        const tab = e.indexOf("\t");
        if (tab < 0) continue;
        const path = e.slice(tab + 1);
        files.push(path);
        blobs.set(path, e.split(" ")[1] ?? "");
      }
      return { files, blobs };
    } catch (e) {
      if (attempt) { d!.capture(e, { at: "checks beside: the copy of the files" }); return undefined; }
      await rm(scratch, { recursive: true, force: true }); // made again from nothing
    }
  }
  return undefined;
}

// What a run checks: the files of the latest change, the tree's difference from the one checked last
// (`since`), and for the first run the agent's whole change, over its base (the merge base of its commit with
// the base branch), else over its own commit; deleted files too (a test that imports one is touched). None
// when the tree changes nothing over the base: its files are not the agent's to fix.
async function changesOf(repo: Repo, tree: string, head: string | null, scratch: string, since: string | null): Promise<string[]> {
  const base = await baseOf(repo);
  let from: string | undefined;
  if (base && head) from = (await git(repo.top, ["merge-base", head, base.name], { read: true, timeout: 30_000 })).out.trim() || undefined;
  from ??= head ?? undefined;
  if (!from) return [];
  const diff = async (a: string) => {
    const r = await ownGit(scratch, ["diff-tree", "-r", "-z", "--name-only", "--no-renames", a, tree]);
    return r.code === 0 ? r.out.split("\0").filter(Boolean) : undefined;
  };
  const whole = (await diff(`${from}^{tree}`)) ?? [];
  if (!whole.length || !since || since === tree) return whole;
  const step = await diff(since);
  return step?.length ? step : whole;
}

// --- the owner's host

const SSH = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
async function sshOut(host: string, script: string, timeout: number): Promise<string> {
  const p = Bun.spawn(["ssh", ...SSH, host, script], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout, killSignal: "SIGKILL" });
  return (await outputOf(p, { where: "ssh" })).out;
}
// The copy sent to the host (its installed packages left there), the lockfile's install run there when the
// lockfile changed, then the check, at a low priority. The host's own folder for the agent is under its
// ~/.cache/keel-beside.
async function onHost(cfg: Setting, id: string, scratch: string, check: Check, command: string, limitMs: number, links: string[]): Promise<Ran | { error: string }> {
  const host = cfg.host!;
  const rdir = `.cache/keel-beside/${scratchName(id)}`;
  const started = performance.now();
  // (The links to this machine's packages are not sent: the host installs its own, and keeps them.)
  const sync = Bun.spawn(["rsync", "-a", "--delete", "--exclude=/.git", "--exclude=/node_modules", "--exclude=/.keel-lock", ...links.map((l) => `--exclude=/${l}`), "-e", `ssh ${SSH.join(" ")}`, `${scratch}/`, `${host}:${rdir}/`], { stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 300_000, killSignal: "SIGKILL" });
  const { err, code: synced } = await outputOf(sync, { where: "rsync" });
  if (synced !== 0) return { error: `rsync to ${host}: ${err.trim().split("\n").at(-1) ?? ""}` };
  const lock = LOCKS.find((l) => existsSync(join(scratch, l.file)));
  const mark = lock ? Bun.hash(readFileSync(join(scratch, lock.file))).toString(36) : "";
  const path = cfg.host_path.map((p) => p.replace(/^~(?=\/|$)/, "$HOME")).join(":");
  const install = lock ? `if [ "$(cat .keel-lock 2>/dev/null)" != ${mark} ]; then ${lock.install} >/dev/null 2>&1 && echo ${mark} > .keel-lock; fi; ` : "";
  const cd = check.dir === "." ? "" : `cd ${quote(check.dir)} && `;
  const script = `${path ? `PATH="${path}:$PATH"; ` : ""}cd ${quote(rdir)} && ${install}${cd}CI=1 nice -n 10 bash -c ${quote(command)} 2>&1`;
  const p = Bun.spawn(["ssh", ...SSH, host, script], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: limitMs, killSignal: "SIGKILL" });
  const { out, err: errOut, code } = await outputOf(p, { where: "ssh", cap: 256 * 1024, keep: "tail" });
  const ms = Math.round(performance.now() - started);
  const timedOut = p.signalCode === "SIGKILL" && ms >= limitMs;
  // (ssh's own 255: the host could not be reached, or the link broke.)
  if (code === 255 && !out) return { error: `ssh ${host}: ${errOut.trim().split("\n").at(-1) ?? ""}` };
  return { code: timedOut ? null : code, signal: timedOut || p.signalCode == null ? null : String(p.signalCode), timedOut, out: (out + errOut).slice(-256 * 1024), ms, cpu_ms: null };
}

// (For a test: the lanes as they are.)
export const laneOf = (id: string) => lanes.get(id);
