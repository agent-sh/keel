// The language servers the daemon runs, and what an edit did to a file's
// diagnostics. One server per language, project root, session folder and
// sandbox profile: sessions of one folder with the same confinement share
// it, and a session confined otherwise never talks to a server that runs
// with more than its own commands get. A server starts at the first edit of
// a file it serves, ends when nobody used it for a while or its configuration
// changed, and is started again with a growing pause after it failed.
//
// An edit is two questions to the server: the file's diagnostics as it was
// (asked before the tool runs, not waited for), and as it is afterwards. The
// wait for the second is bounded; an answer that comes later is kept and
// goes with a later result of the session.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { readText } from "../core/proc.ts";
import { track } from "../mcp/procs.ts";
import { LspClient, readDoc } from "./client.ts";
import { type Diag, diffDiagnostics, type FileDiff } from "./diff.ts";
import { configMark, definitions, findCommand, languageOf, rootFor, serves, type ServerDef, type ServerOverride } from "./servers.ts";

export type Perm = { sandbox: "off" | "workspace-write" | "read-only"; network: boolean };
export type Sess = { id: string; workspace: string };

export type ManagerDeps = {
  stateDir?: string;
  overrides: () => Record<string, ServerOverride>;
  // Whether the owner trusts this repository to run its language servers.
  trusted: (root: string) => true | string;
  // The command as the session's own commands run: inside its sandbox, or
  // refused when the session is confined and this machine cannot confine.
  confine: (argv: string[], perm: Perm, workspace: string) => { argv: string[] } | { refuse: string };
  env: (sessionId: string) => Record<string, string>;
  // A server started, ended or failed (for the errors table and the page).
  onChange?: (e: { what: "started" | "ended" | "failed"; id: string; root: string; session: string; why?: string }) => void;
  idleMs?: number;
  // No server starts while the machine has less memory available than this (MB).
  minFreeMb?: () => number;
  // Whether diagnostics are on in a session's folder (off: its servers end).
  wanted?: (workspace: string) => boolean;
};

type State = "starting" | "running" | "stopped" | "failed" | "missing" | "refused" | "untrusted";
type Entry = {
  key: string; def: ServerDef; root: string; workspace: string; perm: Perm;
  client: LspClient | null; state: State; error?: string;
  startedBy: string; sessions: Set<string>; lastUsed: number;
  failures: number[]; retryAt: number; mark: string; argv: string[]; from?: "workspace" | "path";
  stale: boolean; scannedAt: number; head?: string; seen: Set<string>; gone: Set<string>; scan?: Promise<void>;
};

// After a failure the next start waits this long, by how many failed in the last ten minutes.
export const BACKOFF_MS = [1_000, 5_000, 30_000, 120_000, 600_000];
export const backoff = (failures: number[], now: number) => {
  const recent = failures.filter((t) => now - t < 600_000).length;
  return recent ? BACKOFF_MS[Math.min(recent, BACKOFF_MS.length) - 1]! : 0;
};
const IDLE_MS = 5 * 60_000;
// The memory the machine can still give, in MB (Linux; elsewhere unknown, and no start is held).
const availableMb = (): number | null => {
  try { const m = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync("/proc/meminfo", "utf8")); return m ? Math.floor(Number(m[1]) / 1024) : null; } catch { return null; }
};
const RESCAN_MS = 30_000;
// Other files of the session checked again after an edit (an edit here can break a file edited before).
const BESIDE = 5;
const GIT = ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

type Asked = { path: string; entry: Entry; client: LspClient; base: Promise<Diag[] | null> | Diag[] | null; existed: boolean; beside?: boolean };
type Late = { server: string; base: Diag[]; after: Diag[] };
type SessState = { owed: Map<string, Diag[]>; told: Map<string, { key: string; diags: Diag[]; at: number }>; late: Map<string, Late> };

export type Outcome = { files: FileDiff[]; pending: string[]; servers: string[]; ms: number; cold: boolean; answered: number };

export type ServerView = {
  id: string; label: string; extensions: string[]; enabled: boolean; auto: boolean; own: boolean; runs: string;
  found: { command: string[]; from: "workspace" | "path"; root: string } | null; missing?: string;
  elsewhere: number; // its servers running for other folders
  running: { root: string; state: State; error?: string; pid?: number; since?: number; ready_ms?: number | null; server?: string; pull?: boolean; docs?: number; sessions: number; started_by: string; sandbox: string; busy?: boolean; retry_in_ms?: number; argv: string[] }[];
};

export class LspManager {
  private entries = new Map<string, Entry>();
  private calls = new Map<string, { session: string; asked: Asked[]; t0: number; cold: boolean }>();
  private sess = new Map<string, SessState>();
  private timer: ReturnType<typeof setInterval>;

  constructor(private d: ManagerDeps) {
    this.timer = setInterval(() => this.sweep(), 30_000);
    (this.timer as any).unref?.();
  }

  private state(id: string): SessState {
    let s = this.sess.get(id);
    if (!s) this.sess.set(id, (s = { owed: new Map(), told: new Map(), late: new Map() }));
    return s;
  }

  private defs() { return definitions(this.d.overrides()); }

  // Servers nobody used for the idle time end; so does one whose definition was turned off.
  private sweep() {
    const now = Date.now();
    const on = new Set(this.defs().filter((d) => d.enabled).map((d) => d.id));
    for (const e of this.entries.values()) {
      if (!e.client || e.client.ended) continue;
      if (!on.has(e.def.id) || this.d.wanted?.(e.workspace) === false) void e.client.stop("stopped: turned off");
      else if (now - e.lastUsed > (this.d.idleMs ?? IDLE_MS)) void e.client.stop("stopped: idle");
    }
    // Calls whose tool never came back (a turn stopped mid-call).
    for (const [id, c] of this.calls) if (now - c.t0 > 3600_000) this.calls.delete(id);
  }

  // The server for a file, started when it is not running. Null: there is
  // none to ask (not found, not trusted, failed and waiting), and the entry says why.
  private ensure(def: ServerDef, root: string, s: Sess, perm: Perm): Entry | null {
    const key = [def.id, root, s.workspace, perm.sandbox, perm.network ? "net" : "nonet"].join("\0");
    let e = this.entries.get(key);
    if (!e) this.entries.set(key, (e = { key, def, root, workspace: s.workspace, perm, client: null, state: "stopped", startedBy: s.id, sessions: new Set(), lastUsed: 0, failures: [], retryAt: 0, mark: "", argv: [], stale: false, scannedAt: 0, seen: new Set(), gone: new Set() }));
    e.def = def;
    e.lastUsed = Date.now();
    e.sessions.add(s.id);
    if (e.client && !e.client.ended) {
      if (configMark(def, root) === e.mark) return e;
      void e.client.stop("stopped: its configuration changed");
      e.client = null;
    }
    if (e.state === "failed" && Date.now() < e.retryAt) return null;
    // A program that was not there a moment ago is not looked for again at every edit.
    if (e.state === "missing" && Date.now() < e.retryAt) return null;
    const trust = this.d.trusted(root);
    if (trust !== true) { e.state = "untrusted"; e.error = trust; return null; }
    const found = findCommand(def, root, this.d.env(s.id).PATH);
    if ("missing" in found) { e.state = "missing"; e.error = found.missing; e.retryAt = Date.now() + 30_000; return null; }
    const need = this.d.minFreeMb?.() ?? 0;
    const free = need ? availableMb() : null;
    if (free !== null && free < need) { e.state = "refused"; e.error = `not started: the machine has ${free} MB of memory available, under the ${need} MB a server is started with (diagnostics.min_free_mb)`; return null; }
    const run = this.d.confine(found.argv, perm, s.workspace);
    if ("refuse" in run) { e.state = "refused"; e.error = run.refuse; return null; }
    e.argv = run.argv;
    e.from = found.from;
    e.mark = configMark(def, root);
    e.startedBy = s.id;
    e.scannedAt = Date.now();
    e.stale = false;
    e.head = undefined;
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
          if (entry.client !== client && entry.client) return;
          if (why.startsWith("stopped")) { entry.state = "stopped"; entry.error = undefined; }
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
      e.scan = this.rescan(e, true);
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

  // Files changed on disk by something that is not an edit tool (a command,
  // another program): a server keeps its own copy of every file it read and
  // is told which ones to read again. The repository says which differ from
  // its head; a head that moved (a checkout, a pull) starts the server anew.
  private async rescan(e: Entry, first = false): Promise<void> {
    const client = e.client;
    if (!client || client.ended) return;
    const since = e.scannedAt;
    e.scannedAt = Date.now();
    e.stale = false;
    const git = async (args: string[]): Promise<string | null> => {
      try {
        const p = Bun.spawn([...GIT, "-C", e.root, ...args], { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: 2000 });
        const out = await readText(p.stdout);
        return (await p.exited) === 0 ? out : null;
      } catch { return null; }
    };
    const head = (await git(["rev-parse", "HEAD"]))?.trim();
    if (!head) return; // not a repository: nothing says what changed
    if (e.head && e.head !== head) { e.head = head; return void client.stop("stopped: the checkout moved"); }
    e.head = head;
    const listed = await git(["ls-files", "-m", "-o", "-d", "--exclude-standard", "-z"]);
    if (listed === null || client.ended) return;
    const changes: { path: string; type: "created" | "changed" | "deleted" }[] = [];
    const now = new Set<string>();
    for (const rel of new Set(listed.split("\0").filter(Boolean))) {
      const path = join(e.root, rel);
      if (!serves(e.def, path)) continue;
      now.add(path);
      let mtime = 0;
      try { mtime = statSync(path).mtimeMs; } catch {}
      if (!mtime) {
        if (!e.gone.has(path)) { e.gone.add(path); e.seen.delete(path); if (!first) changes.push({ path, type: "deleted" }); }
        continue;
      }
      e.gone.delete(path);
      const known = e.seen.has(path);
      e.seen.add(path);
      if (first || (known && mtime < since - 2000)) continue;
      // A document this client holds is given again as it is on disk.
      if (client.has(path)) { const text = await readDoc(path); if (text !== null) client.sync(path, text, languageOf(e.def, path)); continue; }
      changes.push({ path, type: known ? "changed" : "created" });
      if (changes.length >= 500) break;
    }
    // A file that differed from the head and no longer does was put back: read again too.
    for (const path of [...e.seen]) if (!now.has(path)) { e.seen.delete(path); if (!first) changes.push({ path, type: "changed" }); }
    for (const path of [...e.gone]) if (!now.has(path)) { e.gone.delete(path); if (!first) changes.push({ path, type: "created" }); }
    client.changed(changes);
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
    let cold = false;
    for (const path of [...new Set(paths)]) {
      for (const def of defs) {
        if (!serves(def, path)) continue;
        const root = rootFor(def, path, s.workspace);
        if (!root) continue;
        const was = this.entries.get([def.id, root, s.workspace, perm.sandbox, perm.network ? "net" : "nonet"].join("\0"))?.client;
        const e = this.ensure(def, root, s, perm);
        if (!e?.client) continue;
        if (e.client !== was) cold = true;
        if (e.stale || Date.now() - e.scannedAt > RESCAN_MS) e.scan = this.rescan(e);
        if (e.scan) await Promise.race([e.scan, Bun.sleep(1000)]);
        const client = e.client;
        if (!client || client.ended) continue;
        const text = await readDoc(path);
        const existed = existsSync(path);
        // A file the edit creates had no diagnostics; one that cannot be sent (binary, too large) is not asked about.
        if (text === null && existed) continue;
        const base = text === null ? [] : client.diagnostics(path, client.sync(path, text, languageOf(def, path)));
        asked.push({ path, entry: e, client, base, existed });
      }
    }
    if (asked.length) this.calls.set(callId, { session: s.id, asked, t0: Date.now(), cold });
  }

  // The call did not change anything (it failed, or never ran).
  drop(callId: string) { this.calls.delete(callId); }

  // After the edit ran: the files as they are now, asked again, and the
  // answers that came within `waitMs`. Null: no server serves the call's files.
  async after(s: Sess, callId: string, waitMs: number): Promise<Outcome | null> {
    const call = this.calls.get(callId);
    this.calls.delete(callId);
    if (!call) return null;
    const st = this.state(s.id);
    const t0 = Date.now();
    const edited = new Set(call.asked.map((a) => a.path));
    const asked: Asked[] = [...call.asked];
    // Files this session was told about before, in the same servers: an edit here can break them.
    for (const e of new Set(call.asked.map((a) => a.entry))) {
      if (!e.client?.pull) continue;
      const beside = [...st.told.entries()].filter(([p, t]) => t.key === e.key && !edited.has(p)).sort((a, b) => b[1].at - a[1].at).slice(0, BESIDE);
      for (const [path, t] of beside) asked.push({ path, entry: e, client: e.client, base: t.diags, existed: true, beside: true });
    }
    type Job = { a: Asked; base: Diag[] | null; after: Diag[] | null | undefined };
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
      const version = a.client.sync(a.path, text, languageOf(a.entry.def, a.path));
      const answer = a.client.diagnostics(a.path, version);
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
    const servers = new Set<string>();
    let answered = 0;
    for (const job of jobs) {
      const { a } = job;
      const rel = relative(s.workspace, a.path) || a.path;
      if (job.after === undefined) {
        // Not answered in time. What the file had before this edit is owed to the comparison made when the answer comes.
        if (a.beside) continue;
        pending.push(rel.startsWith("..") ? a.path : rel);
        servers.add(a.entry.def.id);
        // What the file had before this edit stays the comparison's start, also for an edit that comes before the answer.
        void Promise.resolve(a.base).then((b) => { if (b && !st.owed.has(a.path)) st.owed.set(a.path, b); }, () => {});
        continue;
      }
      if (job.after === null) continue; // the server ended, or the file moved on
      answered++;
      // An earlier edit of the file whose answer never reached the model: compared from before that one.
      const base = st.owed.get(a.path) ?? job.base ?? job.after;
      st.owed.delete(a.path);
      st.late.delete(a.path);
      st.told.set(a.path, { key: a.entry.key, diags: job.after, at: Date.now() });
      const diff = diffDiagnostics(base, job.after);
      if (diff.added.length || diff.fixed.length) { files.push({ path: rel.startsWith("..") ? a.path : rel, diff, after: a.beside ? [] : job.after }); servers.add(a.entry.def.id); }
    }
    if (st.told.size > 200) st.told.delete(st.told.keys().next().value!);
    return { files, pending, servers: [...servers], ms: Date.now() - t0, cold: call.cold, answered };
  }

  // An answer that came after its call's result was written.
  private arrived(sessionId: string, a: Asked, base: Diag[] | null, after: Diag[] | null) {
    if (after === null || a.beside) return;
    const st = this.state(sessionId);
    const from = st.owed.get(a.path) ?? base ?? after;
    st.owed.set(a.path, from);
    st.late.set(a.path, { server: a.entry.def.id, base: from, after });
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
      st.late.set(path, { server: e.def.id, base: st.owed.get(path) ?? told.diags, after: diags });
    }
  }
  private inCall(path: string) {
    for (const c of this.calls.values()) if (c.asked.some((a) => a.path === path)) return true;
    return false;
  }

  // Late answers of a session, taken once: for the files named, or all of
  // them (`paths` undefined: an edit's result carries whatever is owed).
  takeLate(s: Sess, paths?: string[]): { files: FileDiff[]; servers: string[] } {
    const st = this.sess.get(s.id);
    const files: FileDiff[] = [];
    const servers = new Set<string>();
    if (!st?.late.size) return { files, servers: [] };
    for (const [path, l] of [...st.late]) {
      if (paths && !paths.includes(path)) continue;
      st.late.delete(path);
      st.owed.delete(path);
      const entry = st.told.get(path);
      st.told.set(path, { key: entry?.key ?? "", diags: l.after, at: Date.now() });
      const diff = diffDiagnostics(l.base, l.after);
      if (!diff.added.length && !diff.fixed.length) continue;
      const rel = relative(s.workspace, path) || path;
      files.push({ path: rel.startsWith("..") ? path : rel, diff, after: l.after });
      servers.add(l.server);
    }
    return { files, servers: [...servers] };
  }

  hasLate(sessionId: string): boolean { return !!this.sess.get(sessionId)?.late.size; }

  // A session is gone: what was kept for it goes, and servers only it used idle out.
  release(sessionId: string) {
    this.sess.delete(sessionId);
    for (const e of this.entries.values()) e.sessions.delete(sessionId);
    for (const [id, c] of this.calls) if (c.session === sessionId) this.calls.delete(id);
  }

  // A session's sandbox changed: its next edit asks a server confined as it is now.
  permChanged(sessionId: string) {
    const st = this.sess.get(sessionId);
    if (st) { st.told.clear(); st.owed.clear(); st.late.clear(); }
    for (const e of this.entries.values()) e.sessions.delete(sessionId);
  }

  async restart(id: string, root: string): Promise<number> {
    let n = 0;
    for (const e of this.entries.values()) {
      if (e.def.id !== id || e.root !== root) continue;
      e.failures = [];
      e.retryAt = 0;
      if (e.state === "failed" || e.state === "missing" || e.state === "refused" || e.state === "untrusted") e.state = "stopped";
      if (e.client && !e.client.ended) { await e.client.stop("stopped: restarted by the owner"); n++; }
    }
    return n;
  }

  // The servers that can serve a folder, and the ones running anywhere, for the settings page.
  list(cwd: string): ServerView[] {
    const now = Date.now();
    return this.defs().map((d) => {
      const sample = `${cwd}/x${Object.keys(d.extensions)[0] ?? ""}`;
      const root = rootFor(d, sample, cwd);
      const found = root ? findCommand(d, root) : { missing: `no ${d.roots.join(", ")} in this folder` };
      const mine = [...this.entries.values()].filter((e) => e.def.id === d.id);
      const here = (e: Entry) => e.workspace === cwd || e.root === cwd || e.root === root || e.root.startsWith(cwd + "/") || cwd.startsWith(e.root + "/");
      return {
        id: d.id, label: d.label, extensions: Object.keys(d.extensions), enabled: d.enabled, auto: d.auto, own: d.own, runs: d.runs,
        found: root && !("missing" in found) ? { command: found.argv, from: found.from, root } : null,
        ...("missing" in found ? { missing: found.missing } : {}),
        elsewhere: mine.filter((e) => !here(e) && e.client && !e.client.ended).length,
        running: mine.filter((e) => here(e) && (e.state !== "stopped" || e.error)).map((e) => ({
          root: e.root, state: e.state, error: e.error, sessions: e.sessions.size, started_by: e.startedBy,
          sandbox: e.perm.sandbox === "off" ? "off" : `${e.perm.sandbox}${e.perm.network ? "" : ", no network"}`,
          argv: e.argv,
          ...(e.client && !e.client.ended ? { pid: e.client.pid, since: e.client.started, ready_ms: e.client.readyMs, server: [e.client.serverInfo.name, e.client.serverInfo.version].filter(Boolean).join(" ") || undefined, pull: e.client.pull, docs: e.client.openDocs, busy: e.client.busy } : {}),
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
