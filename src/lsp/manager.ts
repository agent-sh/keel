// The language servers the daemon runs, and what an edit did to a file's
// diagnostics. One server per language, project root, session folder and
// sandbox profile: sessions of one folder with the same confinement share
// it, and a session confined otherwise never talks to a server that runs
// with more than its own commands get. A server starts at the first edit of
// a file it serves, when the session's mode would run that program as a
// command without asking (src/lsp/servers.ts startRule); it ends when nobody
// used it for a while, when its configuration changed, when the daemon holds
// too many or they hold too much memory, and is started again with a growing
// pause after it failed.
//
// An edit is two questions to the server: the file's diagnostics as it was
// (asked before the tool runs, not waited for), and as it is afterwards. The
// wait for the second is bounded; an answer that comes later is kept and
// goes with a later result of the session.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { git } from "../core/git.ts";
import { track } from "../mcp/procs.ts";
import { LspClient, readDoc } from "./client.ts";
import { changedLines, type Diag, diffDiagnostics, type FileDiff } from "./diff.ts";
import { configMark, type Def, definitions, findCommand, languageOf, rootFor, serves, type ServerOverride, startRule } from "./servers.ts";

export type Perm = { mode: string; sandbox: "off" | "workspace-write" | "read-only"; network: boolean };
export type Sess = { id: string; workspace: string };

export type ManagerDeps = {
  stateDir?: string;
  overrides: () => Record<string, ServerOverride>;
  // Whether the owner trusted this folder's language servers in so many words.
  trusted: (dir: string) => boolean;
  // The command as the session's own commands run (inside its sandbox, or
  // refused when the session is confined and this machine cannot confine),
  // in a scope of its own that holds it to `memoryMb`.
  // `own`: the program is the owner's or the machine's (found on PATH, in a toolchain's folder, or the owner's own
  // command), not one the workspace holds: a sandbox shows it with what its command line names.
  confine: (argv: string[], perm: Perm, workspace: string, memoryMb: number, own?: boolean) => { argv: string[] } | { refuse: string };
  env: (sessionId: string) => Record<string, string>;
  // A server started, ended or failed (for the errors table and the page).
  onChange?: (e: { what: "started" | "ended" | "failed"; id: string; root: string; session: string; why?: string }) => void;
  idleMs?: number;
  // No server starts while the machine has less memory available than this (MB), or is short of memory.
  minFreeMb?: () => number;
  // Servers alive at once, and the memory they may hold together (MB): the least recently used ends first.
  maxServers?: () => number;
  maxMemoryMb?: () => number;
  // Whether diagnostics are on in a session's folder (off: its servers end).
  wanted?: (workspace: string) => boolean;
};

type State = "starting" | "running" | "stopped" | "failed" | "missing" | "refused" | "untrusted";
type Entry = {
  key: string; def: Def; root: string; workspace: string; perm: Perm;
  client: LspClient | null; state: State; error?: string;
  startedBy: string; sessions: Set<string>; lastUsed: number;
  failures: number[]; retryAt: number; mark: string; argv: string[]; from?: "workspace" | "path"; loads?: boolean;
  stale: boolean; scannedAt: number; head?: string; repo?: boolean; seen: Set<string>; gone: Set<string>; scan?: Promise<"restart" | void>;
  rssMb: number;
};

// After a failure the next start waits this long, by how many failed in the last ten minutes.
export const BACKOFF_MS = [1_000, 5_000, 30_000, 120_000, 600_000];
export const backoff = (failures: number[], now: number) => {
  const recent = failures.filter((t) => now - t < 600_000).length;
  return recent ? BACKOFF_MS[Math.min(recent, BACKOFF_MS.length) - 1]! : 0;
};
const IDLE_MS = 5 * 60_000;
// One server's memory: its scope's limit, and the size past which the daemon ends one that has no scope.
export const SERVER_MEMORY_MB = 1536;
export const MAX_SERVERS = 4;
export const MAX_MEMORY_MB = 3072;
const proc = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
// Whether the machine is short of memory: less available than `needMb`, or
// its tasks stalled on memory a tenth of the last ten seconds (the kernel's
// own measure; swapping shows there before the available figure falls).
export function memoryShort(needMb: number, meminfo = proc("/proc/meminfo"), pressure = proc("/proc/pressure/memory")): string | null {
  if (needMb <= 0) return null;
  const free = /^MemAvailable:\s+(\d+) kB/m.exec(meminfo);
  if (free && Math.floor(Number(free[1]) / 1024) < needMb) return `the machine has ${Math.floor(Number(free[1]) / 1024)} MB of memory available, under the ${needMb} MB a server is started with (diagnostics.min_free_mb)`;
  const some = /^some .*?avg10=([\d.]+)/m.exec(pressure);
  if (some && Number(some[1]) >= 10) return `the machine is short of memory (its tasks waited on memory ${some[1]}% of the last ten seconds)`;
  return null;
}
// A process and everything under it, in MB of resident memory.
function rssTreeMb(pid: number): number {
  let kb = 0;
  const seen = new Set<number>();
  const walk = (p: number) => {
    if (seen.has(p) || seen.size > 500) return;
    seen.add(p);
    kb += Number(/^VmRSS:\s+(\d+)/m.exec(proc(`/proc/${p}/status`))?.[1] ?? 0);
    let tids: string[] = [];
    try { tids = readdirSync(`/proc/${p}/task`); } catch { return; }
    for (const t of tids) for (const c of proc(`/proc/${p}/task/${t}/children`).split(" ")) if (Number(c)) walk(Number(c));
  };
  walk(pid);
  return Math.round(kb / 1024);
}
const RESCAN_MS = 30_000;
// Other files of the session checked again after an edit (an edit here can break a file edited before).
const BESIDE = 5;
// The repository's own word on what differs, through the daemon's one way
// to run git (src/core/git.ts): the repository's config is not in force
// there, so no monitor, hook, filter or other program it names runs.
async function gitOut(root: string, args: string[]): Promise<string | null> {
  const r = await git(root, args, { read: true, timeout: 2000 }).catch(() => null);
  return r && r.code === 0 ? r.out : null;
}
// Whether `root` is in a repository's work tree, and its head ("" before the first commit).
export async function repoHead(root: string): Promise<{ repo: boolean; head: string }> {
  if ((await gitOut(root, ["rev-parse", "--is-inside-work-tree"]))?.trim() !== "true") return { repo: false, head: "" };
  return { repo: true, head: (await gitOut(root, ["rev-parse", "--verify", "-q", "HEAD"]))?.trim() ?? "" };
}
const names = (out: string) => out.split("\0").filter(Boolean);
// The files under `root` that differ from the head: changed or deleted in the
// work tree (by size and time only: `ls-files -m` would read a changed file
// through a clean filter), staged (a file moved or removed with git, a new
// one added), and untracked. Null: the repository could not say.
export async function repoDiffers(root: string, head: string): Promise<string[] | null> {
  const tracked = await gitOut(root, ["diff-files", "--name-only", "--no-renames", "--relative", "-z"]);
  const staged = head ? await gitOut(root, ["diff-index", "--cached", "--name-only", "--no-renames", "--relative", "-z", "HEAD"]) : "";
  const untracked = await gitOut(root, ["ls-files", "-o", "--exclude-standard", "-z"]);
  if (tracked === null || staged === null || untracked === null) return null;
  return [...new Set([...names(tracked), ...names(staged), ...names(untracked)])];
}
// The files under `root` that two commits differ in. Null: they cannot be compared.
export async function repoBetween(root: string, from: string, to: string): Promise<string[] | null> {
  const out = from && to ? await gitOut(root, ["diff", "--name-only", "--no-renames", "--relative", "-z", from, to]) : null;
  return out === null ? null : names(out);
}
// A file's size and change time: whether the text read from it is still what is on disk.
const markOf = (path: string): string | null => { try { const st = statSync(path); return st.isFile() ? `${st.size}:${st.mtimeMs}` : null; } catch { return null; } };

// `was`: the file's text before the edit, which says which lines the edit rewrote.
type Asked = { path: string; entry: Entry; client: LspClient; base: Promise<Diag[] | null> | Diag[] | null; was?: string; beside?: boolean };
// `asked`: the model was told this file is not checked yet, so a clean answer is said too.
type Late = { server: string; base: Diag[]; after: Diag[]; asked: boolean };
type SessState = { owed: Map<string, Diag[]>; told: Map<string, { key: string; diags: Diag[]; at: number }>; late: Map<string, Late>; down: Set<string> };

// `unchecked`: files a server serves that it could not be asked about.
export type Outcome = { files: FileDiff[]; pending: string[]; unchecked: string[]; servers: string[]; ms: number; cold: boolean; answered: number };

export type ServerView = {
  id: string; label: string; extensions: string[]; enabled: boolean; auto: boolean; own: boolean; runs: string;
  found: { command: string[]; from: "workspace" | "path"; loads: boolean; root: string } | null; missing?: string;
  elsewhere: number; // its servers running for other folders
  running: { root: string; state: State; error?: string; pid?: number; since?: number; ready_ms?: number | null; server?: string; pull?: boolean; docs?: number; rss_mb?: number; sessions: number; started_by: string; sandbox: string; busy?: boolean; retry_in_ms?: number; argv: string[] }[];
};

export class LspManager {
  private entries = new Map<string, Entry>();
  private calls = new Map<string, { session: string; asked: Asked[]; down: Map<string, string[]>; t0: number; cold: boolean }>();
  private sess = new Map<string, SessState>();
  private timer: ReturnType<typeof setInterval>;

  constructor(private d: ManagerDeps) {
    this.timer = setInterval(() => this.sweep(), 30_000);
    (this.timer as any).unref?.();
  }

  private state(id: string): SessState {
    let s = this.sess.get(id);
    if (!s) this.sess.set(id, (s = { owed: new Map(), told: new Map(), late: new Map(), down: new Set() }));
    return s;
  }

  private defs() { return definitions(this.d.overrides()); }
  private alive(): Entry[] { return [...this.entries.values()].filter((e) => e.client && !e.client.ended); }
  private rel(s: Sess, path: string) { const r = relative(s.workspace, path) || path; return r.startsWith("..") ? path : r; }

  // What the servers hold now: how many are alive, and their memory together.
  totals(): { alive: number; rss_mb: number; max_servers: number; max_memory_mb: number; server_memory_mb: number } {
    const live = this.alive();
    for (const e of live) e.rssMb = rssTreeMb(e.client!.pid);
    return { alive: live.length, rss_mb: live.reduce((n, e) => n + e.rssMb, 0), max_servers: this.d.maxServers?.() ?? MAX_SERVERS, max_memory_mb: this.d.maxMemoryMb?.() ?? MAX_MEMORY_MB, server_memory_mb: SERVER_MEMORY_MB };
  }

  // Servers end here: one nobody used for the idle time, one turned off, one
  // whose folder is gone, one grown past a server's memory, and the least
  // recently used ones while all of them together hold more than the daemon gives them.
  sweep() {
    const now = Date.now();
    const on = new Set(this.defs().filter((d) => d.enabled).map((d) => d.id));
    for (const e of this.alive()) {
      e.rssMb = rssTreeMb(e.client!.pid);
      if (!on.has(e.def.id) || this.d.wanted?.(e.workspace) === false) void e.client!.stop("stopped: turned off");
      else if (!existsSync(e.root) || !existsSync(e.workspace)) void e.client!.stop("stopped: its folder is gone");
      else if (now - e.lastUsed > (this.d.idleMs ?? IDLE_MS)) void e.client!.stop("stopped: idle");
      else if (e.rssMb > SERVER_MEMORY_MB) void e.client!.stop(`stopped: it held ${e.rssMb} MB, over the ${SERVER_MEMORY_MB} MB one server gets`);
    }
    const max = this.d.maxMemoryMb?.() ?? MAX_MEMORY_MB;
    const live = this.alive().filter((e) => !e.client!.stopping).sort((a, b) => a.lastUsed - b.lastUsed);
    let total = live.reduce((n, e) => n + e.rssMb, 0);
    for (const e of live.slice(0, -1)) {
      if (total <= max) break;
      void e.client!.stop(`stopped: the language servers held ${total} MB together, over ${max} MB (diagnostics.max_memory_mb)`);
      total -= e.rssMb;
    }
    // Calls whose tool never came back (a turn stopped mid-call).
    for (const [id, c] of this.calls) if (now - c.t0 > 3600_000) this.calls.delete(id);
  }

  private keyOf(def: Def, root: string, s: Sess, perm: Perm) { return [def.id, root, s.workspace, perm.sandbox, perm.network ? "net" : "nonet"].join("\0"); }

  // The server for a file, started when it is not running. Null: there is
  // none to ask (not found, not allowed to start, failed and waiting), and the entry says why.
  private ensure(def: Def, root: string, s: Sess, perm: Perm): Entry | null {
    // A worktree that was removed, a folder that was deleted: nothing starts for it.
    if (!existsSync(root) || !existsSync(s.workspace)) return null;
    const key = this.keyOf(def, root, s, perm);
    let e = this.entries.get(key);
    if (!e) this.entries.set(key, (e = { key, def, root, workspace: s.workspace, perm, client: null, state: "stopped", startedBy: s.id, sessions: new Set(), lastUsed: 0, failures: [], retryAt: 0, mark: "", argv: [], stale: false, scannedAt: 0, seen: new Set(), gone: new Set(), rssMb: 0 }));
    e.def = def;
    e.perm = perm;
    e.lastUsed = Date.now();
    e.sessions.add(s.id);
    const live = !!e.client && !e.client.ended;
    if ((e.state === "failed" || e.state === "missing") && Date.now() < e.retryAt) return null;
    // What would start, and whether this session may have it started: asked at every edit, also of a server already running.
    const found = live && e.from ? { argv: [] as string[], from: e.from, loads: !!e.loads } : findCommand(def, root, s.workspace, this.d.env(s.id).PATH);
    // A program that was not there a moment ago is not looked for again at every edit.
    if ("missing" in found) { e.state = "missing"; e.error = found.missing; e.retryAt = Date.now() + 30_000; return null; }
    const rule = startRule({ mode: perm.mode, sandbox: perm.sandbox, trusted: this.d.trusted(root), from: found.from, loads: found.loads });
    if ("wait" in rule) { if (!live) { e.state = "untrusted"; e.error = rule.wait; } return null; }
    if (live) {
      if (configMark(def, root) === e.mark) return e;
      void e.client!.stop("stopped: its configuration changed");
      e.client = null;
      return this.ensure(def, root, s, perm);
    }
    const short = memoryShort(this.d.minFreeMb?.() ?? 0);
    if (short) { e.state = "refused"; e.error = `not started: ${short}`; return null; }
    // Room for it: the least recently used server ends first, and starts again at the next edit of its root.
    const others = this.alive().filter((x) => x !== e && !x.client!.stopping).sort((a, b) => a.lastUsed - b.lastUsed);
    const max = Math.max(1, this.d.maxServers?.() ?? MAX_SERVERS);
    for (const x of others.slice(0, Math.max(0, others.length + 1 - max))) void x.client!.stop(`stopped: no more than ${max} of the language servers are alive at once (diagnostics.max_servers), and this one was used least recently`);
    const run = this.d.confine(found.argv, perm, s.workspace, SERVER_MEMORY_MB, found.from === "path");
    if ("refuse" in run) { e.state = "refused"; e.error = run.refuse; return null; }
    e.argv = run.argv;
    e.from = found.from;
    e.loads = found.loads;
    e.mark = configMark(def, root);
    e.startedBy = s.id;
    e.scannedAt = Date.now();
    e.stale = false;
    e.head = undefined;
    e.repo = undefined;
    e.seen = new Set();
    e.gone = new Set();
    const entry = e;
    try {
      const client = new LspClient({
        name: def.id, argv: run.argv, cwd: root, root, confined: perm.sandbox !== "off",
        env: { ...this.d.env(s.id), ...def.env, KEEL_LSP: def.id },
        initialization: def.initialization, settings: def.settings,
        onPush: (path, _version, diags) => this.pushed(entry, path, diags),
        onEnd: (why, started) => {
          // The ended client is let go of: nothing it held stays reachable from its entry.
          if (entry.client === client) entry.client = null;
          else if (entry.client) return;
          if (why.startsWith("stopped")) { entry.state = "stopped"; entry.error = why.replace(/^stopped:? ?/, "") || undefined; }
          else {
            entry.failures.push(Date.now());
            entry.retryAt = Date.now() + backoff(entry.failures, Date.now());
            entry.state = "failed";
            entry.error = started ? why : `it did not start: ${why}`;
          }
          this.d.onChange?.({ what: why.startsWith("stopped") ? "ended" : "failed", id: def.id, root, session: entry.startedBy, why });
        },
      });
      e.client = client;
      // What differs from the head already: the server reads those as they are now.
      e.scan = this.refresh(e, true);
      e.state = "starting";
      e.error = undefined;
      track(this.d.stateDir, client.process, `lsp:${def.id}`);
      void client.ready.then(() => { if (entry.client === client && !client.ended) { entry.state = "running"; this.d.onChange?.({ what: "started", id: def.id, root, session: s.id }); } }, () => {});
      return e;
    } catch (err) {
      e.failures.push(Date.now());
      e.retryAt = Date.now() + backoff(e.failures, Date.now());
      e.state = "failed";
      e.error = `it did not start: ${(err as Error).message}`;
      this.d.onChange?.({ what: "failed", id: def.id, root, session: s.id, why: e.error });
      return null;
    }
  }

  // The disk as it is now, for a server that keeps its own copy of every
  // file it read. Every document this client holds is given again when its
  // size or change time moved (a command rewrote it), and closed when it is
  // gone. For the other files the repository says which differ from its
  // head; a head that moved names the files between the two commits, and
  // only those that changed on disk since the last look are named to the
  // server (a commit of the session's own work changes none, so it restarts
  // nothing). Where nothing says what changed (no repository, a history that
  // cannot be compared, too many files), the answer is "restart".
  private async refresh(e: Entry, first = false): Promise<"restart" | void> {
    const client = e.client;
    if (!client || client.ended) return;
    const since = e.scannedAt;
    const ran = e.stale;
    e.scannedAt = Date.now();
    e.stale = false;
    const changes: { path: string; type: "created" | "changed" | "deleted" }[] = [];
    if (!first) for (const d of client.open()) {
      const mark = markOf(d.path);
      if (mark === null) { client.close(d.path); changes.push({ path: d.path, type: "deleted" }); this.forget(d.path); }
      else if (mark !== d.mark) { const text = await readDoc(d.path); if (text !== null) client.sync(d.path, text, languageOf(e.def, d.path), mark); }
    }
    const at = await repoHead(e.root);
    e.repo = at.repo;
    if (!e.repo) { client.changed(changes); return ran && !first ? "restart" : undefined; }
    const head = at.head;
    let moved = false;
    if (e.head !== undefined && e.head !== head) {
      const between = await repoBetween(e.root, e.head, head);
      e.head = head;
      if (!between || between.length > 500) return "restart";
      for (const rel of between) {
        const path = join(e.root, rel);
        if (!serves(e.def, path) || client.has(path)) continue;
        let mtime = 0;
        try { mtime = statSync(path).mtimeMs; } catch {}
        if (!mtime) changes.push({ path, type: "deleted" });
        else if (mtime >= since - 2000) changes.push({ path, type: "changed" });
      }
      moved = true;
    }
    e.head = head;
    const listed = await repoDiffers(e.root, head);
    if (listed === null || client.ended) return;
    // After a move the lists start over: what differed from the old head says nothing about the new one.
    const quiet = first || moved;
    if (moved) { e.seen = new Set(); e.gone = new Set(); }
    const now = new Set<string>();
    for (const rel of listed) {
      const path = join(e.root, rel);
      if (!serves(e.def, path)) continue;
      now.add(path);
      let mtime = 0;
      try { mtime = statSync(path).mtimeMs; } catch {}
      if (!mtime) {
        if (!e.gone.has(path)) { e.gone.add(path); e.seen.delete(path); if (!quiet) changes.push({ path, type: "deleted" }); }
        continue;
      }
      e.gone.delete(path);
      const known = e.seen.has(path);
      e.seen.add(path);
      // A name the server has not been told of is told whatever its time (a moved file keeps its old one).
      if (first || client.has(path) || ((known || moved) && mtime < since - 2000)) continue;
      changes.push({ path, type: known || moved ? "changed" : "created" });
      if (changes.length >= 500) break;
    }
    // A file that differed from the head and no longer does was put back: read again too.
    for (const path of [...e.seen]) if (!now.has(path)) { e.seen.delete(path); if (!quiet) changes.push({ path, type: "changed" }); }
    for (const path of [...e.gone]) if (!now.has(path)) { e.gone.delete(path); if (!quiet) changes.push({ path, type: "created" }); }
    client.changed(changes);
  }

  // A file is gone from disk: no session is owed anything about it.
  private forget(path: string) {
    for (const st of this.sess.values()) { st.told.delete(path); st.owed.delete(path); st.late.delete(path); }
  }

  // A command ran in a session's folder: the servers there may hold files that are older than the disk.
  markStale(workspace: string) {
    for (const e of this.entries.values()) if (e.workspace === workspace || e.root.startsWith(workspace + "/") || workspace.startsWith(e.root + "/")) e.stale = true;
  }

  // Before an edit runs: each file it names is given to its server as it is
  // now, and its diagnostics are asked. Waits for the disk, never for a server.
  async before(s: Sess, perm: Perm, callId: string, paths: string[]): Promise<void> {
    const defs = this.defs().filter((d) => d.enabled);
    const asked: Asked[] = [];
    const down = new Map<string, string[]>();
    let cold = false;
    for (const path of [...new Set(paths)]) {
      for (const def of defs) {
        if (!serves(def, path)) continue;
        const root = rootFor(def, path, s.workspace);
        if (!root) continue;
        const was = this.entries.get(this.keyOf(def, root, s, perm))?.client;
        let e = this.ensure(def, root, s, perm);
        if (e?.client && (e.stale || Date.now() - e.scannedAt > RESCAN_MS)) e.scan = this.refresh(e);
        if (e?.client && e.scan && (await Promise.race([e.scan, Bun.sleep(1000)])) === "restart") {
          // Nothing says which files a command changed: the server reads them all again.
          e.scan = undefined;
          await e.client.stop("stopped: files changed under it");
          e = this.ensure(def, root, s, perm);
        }
        const client = e?.client;
        if (!e || !client || client.ended) {
          // A server that failed or was refused: the file is not checked, and the session hears it once.
          const st = this.entries.get(this.keyOf(def, root, s, perm))?.state;
          if (st === "failed" || st === "refused") down.set(def.id, [...(down.get(def.id) ?? []), path]);
          continue;
        }
        if (client !== was) cold = true;
        const text = await readDoc(path);
        // A file the edit creates had no diagnostics; one that cannot be sent (binary, too large) is not asked about.
        if (text === null && existsSync(path)) continue;
        const base = text === null ? [] : client.diagnostics(path, client.sync(path, text, languageOf(def, path), markOf(path) ?? ""));
        asked.push({ path, entry: e, client, base, ...(text !== null ? { was: text } : {}) });
      }
    }
    if (asked.length || down.size) this.calls.set(callId, { session: s.id, asked, down, t0: Date.now(), cold });
  }

  // The call did not change anything (it failed, or never ran).
  drop(callId: string) { this.calls.delete(callId); }

  // After the edit ran: the files as they are now, asked again, and the
  // answers that came within `waitMs` (a server still starting is given the
  // same time to be ready first). Null: no server serves the call's files.
  // `hold`: the call's result has no room for a block. Nothing is returned,
  // and what the servers answer is kept for a later result (takeLate).
  async after(s: Sess, callId: string, waitMs: number, hold = false): Promise<Outcome | null> {
    const call = this.calls.get(callId);
    this.calls.delete(callId);
    if (!call) return null;
    const st = this.state(s.id);
    const t0 = Date.now();
    const servers = new Set<string>();
    const unchecked: string[] = [];
    // A server that is down: said once per session, not at every edit.
    for (const [id, paths] of call.down) if (!st.down.has(id)) { st.down.add(id); servers.add(id); unchecked.push(...paths.map((p) => this.rel(s, p))); }
    const edited = new Set(call.asked.map((a) => a.path));
    const asked: Asked[] = [...call.asked];
    // A server still starting is given the wait's time to be ready first: what it can be asked is known only then.
    const starting = [...new Set(call.asked.map((a) => a.client))].filter((c) => c.readyMs === null && !c.ended);
    if (starting.length) await Promise.race([Promise.all(starting.map((c) => c.ready.catch(() => {}))), Bun.sleep(waitMs)]);
    for (const a of call.asked) st.down.delete(a.entry.def.id);
    // Files this session was told about before, in the same servers: an edit here can break them.
    for (const e of new Set(call.asked.map((a) => a.entry))) {
      if (!e.client?.pull) continue;
      const beside = [...st.told.entries()].filter(([p, t]) => t.key === e.key && !edited.has(p)).sort((a, b) => b[1].at - a[1].at).slice(0, BESIDE);
      for (const [path, t] of beside) asked.push({ path, entry: e, client: e.client, base: t.diags, beside: true });
    }
    type Job = { a: Asked; base: Diag[] | null; after: Diag[] | null | undefined; now?: string };
    const jobs: Job[] = [];
    const waits: Promise<void>[] = [];
    let closed = false; // the wait is over: an answer from here on is a late one
    for (const a of asked) {
      const job: Job = { a, base: null, after: undefined };
      const text = await readDoc(a.path);
      if (text === null) {
        // Deleted by the edit (or no longer text): the server lets go of it.
        if (!existsSync(a.path)) { a.client.close(a.path); a.client.changed([{ path: a.path, type: "deleted" }]); st.told.delete(a.path); st.owed.delete(a.path); }
        continue;
      }
      const version = a.client.sync(a.path, text, languageOf(a.entry.def, a.path), markOf(a.path) ?? "");
      const answer = a.client.diagnostics(a.path, version);
      job.now = text;
      jobs.push(job);
      waits.push(Promise.all([a.base, answer]).then(([base, after]) => {
        job.base = base;
        job.after = after;
        if (closed) this.arrived(s.id, job.a, base, after);
      }).catch(() => { job.after = null; }));
    }
    await Promise.race([Promise.all(waits), Bun.sleep(waitMs)]);
    closed = true;
    const files: FileDiff[] = [];
    const pending: string[] = [];
    let answered = 0;
    for (const job of jobs) {
      const { a } = job;
      const rel = this.rel(s, a.path);
      if (job.after === undefined) {
        // Not answered in time. What the file had before this edit is owed to the comparison made when the answer comes.
        if (a.beside) continue;
        pending.push(rel);
        servers.add(a.entry.def.id);
        // What the file had before this edit stays the comparison's start, also for an edit that comes before the answer.
        void Promise.resolve(a.base).then((b) => { if (b && !st.owed.has(a.path)) st.owed.set(a.path, b); }, () => {});
        continue;
      }
      if (job.after === null) {
        // The server ended under the question: the file is not checked, and the result says so.
        if (!a.beside) { unchecked.push(rel); servers.add(a.entry.def.id); }
        continue;
      }
      answered++;
      // An earlier edit of the file whose answer never reached the model: compared from before that one.
      const owed = st.owed.get(a.path);
      const base = owed ?? job.base;
      if (hold) { this.arrived(s.id, a, job.base, job.after); continue; }
      st.owed.delete(a.path);
      st.late.delete(a.path);
      st.told.set(a.path, { key: a.entry.key, diags: job.after, at: Date.now() });
      // Nothing to compare with (the question about the file as it was got no answer): said, never passed over.
      if (!base) { if (!a.beside) { unchecked.push(rel); servers.add(a.entry.def.id); } continue; }
      // The lines this edit rewrote, when the comparison starts at this edit's own "before".
      const diff = diffDiagnostics(base, job.after, !owed && a.was !== undefined && job.now !== undefined ? changedLines(a.was, job.now) : null);
      if (diff.added.length || diff.fixed.length || diff.still.length) { files.push({ path: rel, diff, after: a.beside ? [] : job.after }); servers.add(a.entry.def.id); }
    }
    if (st.told.size > 200) st.told.delete(st.told.keys().next().value!);
    if (hold || (!jobs.length && !unchecked.length)) return null;
    return { files, pending, unchecked, servers: [...servers], ms: Date.now() - t0, cold: call.cold, answered };
  }

  // An answer that came after its call's result was written.
  private arrived(sessionId: string, a: Asked, base: Diag[] | null, after: Diag[] | null) {
    if (after === null || a.beside) return;
    const st = this.state(sessionId);
    const from = st.owed.get(a.path) ?? base;
    // Nothing to compare with: the file's state is known from here on, and nothing is claimed about the edit.
    if (!from) { st.told.set(a.path, { key: a.entry.key, diags: after, at: Date.now() }); return; }
    st.owed.set(a.path, from);
    st.late.set(a.path, { server: a.entry.def.id, base: from, after, asked: true });
  }

  // A server that pushes may refine a version's diagnostics after its first
  // push (a compiler run it started on save): what it adds to what a session
  // was told goes with that session's next result.
  private pushed(e: Entry, path: string, diags: Diag[]) {
    if (e.client?.pull) return;
    for (const [id, st] of this.sess) {
      const told = st.told.get(path);
      if (!told || told.key !== e.key || !e.sessions.has(id) || this.inCall(path)) continue;
      const diff = diffDiagnostics(told.diags, diags);
      if (!diff.added.some((d) => d.severity <= 2)) continue;
      st.late.set(path, { server: e.def.id, base: st.owed.get(path) ?? told.diags, after: diags, asked: st.late.get(path)?.asked ?? false });
    }
  }
  private inCall(path: string) {
    for (const c of this.calls.values()) if (c.asked.some((a) => a.path === path)) return true;
    return false;
  }

  // Late answers of a session, taken once: for the files named, or all of
  // them (`paths` undefined: an edit's result carries whatever is owed).
  // `clean`: files the model was told are not checked yet, that have nothing new.
  takeLate(s: Sess, paths?: string[]): { files: FileDiff[]; clean: string[]; servers: string[] } {
    const st = this.sess.get(s.id);
    const files: FileDiff[] = [];
    const clean: string[] = [];
    const servers = new Set<string>();
    if (!st?.late.size) return { files, clean, servers: [] };
    for (const [path, l] of [...st.late]) {
      if (paths && !paths.includes(path)) continue;
      st.late.delete(path);
      st.owed.delete(path);
      const entry = st.told.get(path);
      st.told.set(path, { key: entry?.key ?? "", diags: l.after, at: Date.now() });
      const diff = diffDiagnostics(l.base, l.after);
      if (!diff.added.length && !diff.fixed.length) { if (l.asked) { clean.push(this.rel(s, path)); servers.add(l.server); } continue; }
      files.push({ path: this.rel(s, path), diff, after: l.after });
      servers.add(l.server);
    }
    return { files, clean, servers: [...servers] };
  }

  hasLate(sessionId: string): boolean { return !!this.sess.get(sessionId)?.late.size; }

  // A session is gone: what was kept for it goes, and servers only it used idle out.
  release(sessionId: string) {
    this.sess.delete(sessionId);
    for (const e of this.entries.values()) e.sessions.delete(sessionId);
    for (const [id, c] of this.calls) if (c.session === sessionId) this.calls.delete(id);
  }

  // A session's sandbox or mode changed: its next edit asks a server confined as it is now.
  permChanged(sessionId: string) {
    const st = this.sess.get(sessionId);
    if (st) { st.told.clear(); st.owed.clear(); st.late.clear(); st.down.clear(); }
    for (const e of this.entries.values()) e.sessions.delete(sessionId);
  }

  // The owner starts a server again: it ends now, and a failure's pause is cleared.
  async restart(id: string, root: string): Promise<number> {
    let n = 0;
    for (const e of this.entries.values()) {
      if (e.def.id !== id || e.root !== root) continue;
      e.failures = [];
      e.retryAt = 0;
      if (e.state !== "starting" && e.state !== "running") { e.state = "stopped"; e.error = undefined; }
      if (e.client && !e.client.ended) { await e.client.stop("stopped: restarted by the owner"); n++; }
    }
    return n;
  }

  // The servers that can serve a folder, and the ones running for it, for the settings page.
  list(cwd: string): ServerView[] {
    const now = Date.now();
    return this.defs().map((d) => {
      const sample = `${cwd}/x${Object.keys(d.extensions)[0] ?? ""}`;
      const root = rootFor(d, sample, cwd);
      // As the owner turning it on would find it (a candidate that waits for that is shown).
      const found = root ? findCommand({ ...d, explicit: true }, root, cwd) : { missing: `no ${d.roots.join(", ")} in this folder` };
      const mine = [...this.entries.values()].filter((e) => e.def.id === d.id);
      const here = (e: Entry) => e.workspace === cwd || e.root === cwd || e.root === root || e.root.startsWith(cwd + "/") || cwd.startsWith(e.root + "/");
      return {
        id: d.id, label: d.label, extensions: Object.keys(d.extensions), enabled: d.enabled, auto: d.auto, own: d.own, runs: d.runs,
        found: root && !("missing" in found) ? { command: found.argv, from: found.from, loads: found.loads, root } : null,
        ...("missing" in found ? { missing: found.missing } : {}),
        elsewhere: mine.filter((e) => !here(e) && e.client && !e.client.ended).length,
        running: mine.filter((e) => here(e) && (e.state !== "stopped" || e.error)).map((e) => ({
          root: e.root, state: e.state, error: e.error, sessions: e.sessions.size, started_by: e.startedBy,
          sandbox: e.perm.sandbox === "off" ? "off" : `${e.perm.sandbox}${e.perm.network ? "" : ", no network"}`,
          argv: e.argv,
          ...(e.client && !e.client.ended ? { pid: e.client.pid, since: e.client.started, ready_ms: e.client.readyMs, server: [e.client.serverInfo.name, e.client.serverInfo.version].filter(Boolean).join(" ") || undefined, pull: e.client.pull, docs: e.client.openDocs, busy: e.client.busy, rss_mb: (e.rssMb = rssTreeMb(e.client.pid)) } : {}),
          ...(e.state === "failed" && e.retryAt > now ? { retry_in_ms: e.retryAt - now } : {}),
        })),
      };
    });
  }

  // Every server ends: the daemon stops, or its routes are loaded again.
  dispose() {
    clearInterval(this.timer);
    for (const e of this.entries.values()) if (e.client && !e.client.ended) void e.client.stop("stopped: the daemon is stopping");
    this.entries.clear();
    this.calls.clear();
    this.sess.clear();
  }
}
