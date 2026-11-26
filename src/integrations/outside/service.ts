// Sessions the owner runs in Claude Code, Codex or Antigravity on this machine, in Keel's
// record while they run: a session whose transcript grows while Keel watches
// gets a session here, read-only, in the list and on the home screen as a
// session of its harness, with the state its own records say (working while
// it writes, waiting when it asks, done when its turn ended, stale when it
// went silent with no process to vouch for it), its usage and cost from its
// replies, the files its calls changed and its failed calls in the session's
// failures. One press copies it into Keel: the import path makes (or brings
// up to date) a copy that goes on here.
//
// Cost: one inotify watch per folder, and only folders that held a session in
// the last `days` days (src/integrations/outside/settings.ts): Claude Code's
// projects folder and each recent project folder, Codex's sessions folder and
// its recent year, month and day folders, each Antigravity store's folder of conversations (brain) and the
// logs folder of each recent conversation, each harness's own folder (its
// prompt history, history.jsonl, which names a session that starts or resumes
// in an older folder) and Claude Code's folder of running sessions. A file is
// read from its start once, when it is first seen growing, then only by what
// it gained. A session's transcript is copied into its view while a page shows
// it or asks for it: the first copy reads the file in parts with the loop
// turning between them, each later one reads only what the file gained and
// appends the events it adds; a source that rewound is read again and goes on
// as a new branch. Nothing is written to the other harness's folders.
import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Store } from "../../core/store.ts";
import type { Bus } from "../../core/bus.ts";
import type { OutsideMark, StoredEvent, Usage } from "../../core/types.ts";
import { onSettings } from "../../admin/settings.ts";
import { priceOf } from "../../providers/pricing.ts";
import type { Price } from "../../providers/types.ts";
import { ClaudeChain, ClaudeConvert, claudeFound, claudeRoot } from "../import/claude.ts";
import { CodexConvert, codexFound, codexHome } from "../import/codex.ts";
import { AgyConvert, agyFoundAt, agyHome, agyListed, agyPlace, STORES as AGY_STORES } from "../import/agy.ts";
import { offered } from "../import/offer.ts";
import { itemsOf, storedData, type Found } from "../import/types.ts";
import { filesStored } from "../import/service.ts";
import { agyWord, aged, readerOf, splitGrown, total, withOwnWord, type Failed, type Facts, type OutsideHarness, type Reader } from "./facts.ts";
import { excluded, outsideSettings, type OutsideSettings } from "./settings.ts";
import { claudeHolder, claudeLive, codexHolder, recordHolder, codexKeepsLocks, FREE, readClaudeRecord, readLocks, type Holder, type Lock } from "./writer.ts";

export const LABEL: Record<OutsideHarness, string> = { claude: "Claude Code", codex: "Codex", agy: "Antigravity" };

// A transcript's conversation as its harness's list names it (null: none yet, looked at again when it grows).
const foundOf = (h: OutsideHarness, path: string, size: number, mtime: number): Found | null =>
  h === "claude" ? claudeFound(path, size, mtime) : h === "agy" ? agyFoundAt(path) : codexFound(path, size, mtime);
const AGY_FILE = "transcript_full.jsonl";

// outside_events: the events a copy stored, in its order, with the hash of each as it was read
// (a later read compares only what may have changed and appends the rest), and `items`: the blocks
// or results it held when stored (a stored event never grows: Builder.sealed).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS outside_sessions (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  harness TEXT NOT NULL,
  source_id TEXT NOT NULL,
  path TEXT NOT NULL,
  files TEXT NOT NULL DEFAULT '[]',
  usage TEXT NOT NULL DEFAULT '{}',
  failures INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS outside_sessions_src ON outside_sessions(harness, source_id);
CREATE TABLE IF NOT EXISTS outside_events (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  items INTEGER,
  PRIMARY KEY (session_id, n)
) WITHOUT ROWID;
`;

// A file is read in parts of this size: a long transcript first seen growing is read without holding the loop.
const PART = 1 << 20;
// Text of events copied between two turns of the loop, at most (as src/engine/compact.ts paces), and
// no longer than SLICE_MS: storing a megabyte of small events takes tens of milliseconds.
const PACE_BYTES = 1 << 20;
// Work done between two turns of the loop while a long transcript is converted or compared.
const SLICE_MS = 8;
const DAY = 86_400_000;
// A file that grew is looked at once more this long after: the watcher folds a burst of writes into
// one event, and a write that lands just after that event was taken is told by none (seen in Bun's
// fs.watch: the last record of a burst went unread until the next write). It stops once a look finds
// nothing new.
const AGAIN_MS = 100;
// While a page shows a session, who holds it is read again this often: a terminal opened or closed on it
// writes nothing Keel is told of (a lock is taken or let go). It is what a person switching windows
// notices; a send reads it again anyway, right before anything starts.
const HOLDER_MS = 2000;
// While the source works, its last event can still grow (a reply's next block, a round's next result)
// and is held back. Once the file has had no write this long it is copied as it is: a tool result
// the model now thinks over, a call that runs for minutes. A reply's records and a round's results
// are written within milliseconds of each other; anything later goes to an event of its own.
const QUIET_MS = 1000;

type Tracked = {
  path: string;
  harness: OutsideHarness;
  offset: number;          // the bytes read so far
  rest: string;            // a last line the writer had not finished
  decoder: TextDecoder;
  reader: Reader;
  found?: Found;
  ignored?: boolean;       // not an interactive session (a subagent, a headless run), or deleted here: never shown
  session?: string;
  synced: number;          // the offset its transcript was last copied at
  failures: number;
  mtime: number;           // the file's last change, as last seen
  mark?: string;           // what the row was last told, to write only a change
  aging?: ReturnType<typeof setTimeout>;
  again?: ReturnType<typeof setTimeout>;
  status?: string;         // Antigravity: the run status its list keeps of the conversation, as last read
};

// A transcript followed into its session's view: the conversion's state, so a growth converts only
// what it adds. `base`: events the conversion no longer holds (stored, and nothing later can change
// them); `ids` and `hashes`: every stored event's id and hash, by its place.
type Live = {
  offset: number;
  rest: string;
  decoder: TextDecoder;
  chain?: ClaudeChain;
  conv: ClaudeConvert | CodexConvert | AgyConvert;
  base: number;
  ids: string[];
  hashes: string[];
  items: (number | null)[];
};

type Row = { session_id: string; harness: OutsideHarness; source_id: string; path: string; files: string; usage: string; failures: number };
type OwnWord = { pid: number; status?: string; waitingFor?: string; procStart?: string; kind?: string; entrypoint?: string; pidDomain?: string };

export type OutsideDeps = {
  store: Store;
  bus: Bus;
  workspace: string;
  price?: (model: string, harness: OutsideHarness) => Price | undefined;
  viewed?: (sessionId: string) => boolean;
  failed?: (sessionId: string, f: Failed, harness: OutsideHarness) => void;
  trouble?: (e: unknown, at: string) => void;
  // The settings, read when used (a test gives its own).
  settings?: () => OutsideSettings;
  // Whether a Keel session holds a copy of the source (an import or a take-over): a source with a copy has
  // no session of its own here, it shows on the copy (its mark and, while it runs, its state).
  copied?: (harness: OutsideHarness, sourceId: string) => boolean;
  // Whether Keel's own child answers in the session now (src/integrations/outside/codex-app.ts).
  ours?: (sessionId: string) => boolean;
};

export type OutsideStatus = {
  enabled: boolean;
  days: number;
  roots: { harness: OutsideHarness; path: string; watched: boolean }[];
  watches: number;
  tracked: number;
  sessions: number;
  reads: number;
  bytes: number;
  first_reads: number;
  first_bytes: number;
  copies: number;
  copy_ms: number;
  copy_bytes: number;
  full_copies: number;
  // Looks at /proc/locks (who holds a Codex thread): one a tick for the rows pages show, one for each other read.
  lock_reads: number;
  unwatched?: string;
};

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const turn = () => new Promise<void>((ok) => setImmediate(ok));
// Claude Code's folder of a project: its path with every character but letters and digits as "-".
const claudeSlug = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

// What its records say, and where Claude Code's own word on the running session differs, that word.
// A Claude Code that keeps those words (`keeps`) and keeps none for this session runs it no more: a turn
// its records leave open ended with its process. `vouched`: a running process says it is live.
// Codex has no word of its own on its state, only its writer lock: a thread whose lock a process holds is
// vouched for, and where Codex keeps locks (`keeps`) a thread whose lock nothing holds runs no more.
function withOwn(t: Tracked, own: Map<string, OwnWord>, keeps: boolean, holder: Holder): { facts: Facts; vouched: boolean } {
  const facts = t.reader.facts();
  if (!t.found) return { facts, vouched: false };
  const ended = (f: Facts) => (f.state !== "done" ? withOwnWord(f, { status: "idle" }, f.last_ts || Date.now()) : f);
  if (t.harness === "codex") {
    if (holder.kind !== "free") return { facts, vouched: true };
    return { facts: keeps ? ended(facts) : facts, vouched: false };
  }
  // Antigravity's run status in its list is its word: idle ends a turn its steps leave open, running holds one its
  // steps ended (a reply being made). Not a process that vouches: a run killed leaves its status as it was.
  if (t.harness === "agy") {
    const w = agyWord(t.status);
    return { facts: w?.status === "busy" && facts.state === "waiting" ? facts : withOwnWord(facts, w, facts.last_ts || Date.now()), vouched: false };
  }
  const w = own.get(t.found.id);
  if (w && claudeLive(w)) return { facts: withOwnWord(facts, w), vouched: true };
  return { facts: keeps ? ended(facts) : facts, vouched: false };
}

// Work over many items, the loop turning every few milliseconds.
async function paced<T>(items: T[], fn: (x: T) => void, live: () => boolean) {
  let t0 = performance.now();
  for (const x of items) {
    fn(x);
    if (performance.now() - t0 > SLICE_MS) { await turn(); if (!live()) return false; t0 = performance.now(); }
  }
  return true;
}

export class Outside {
  // One watch a folder, however many want to hear of it.
  private watchers = new Map<string, { w: FSWatcher; ons: Set<(event: string, name: string) => void> }>();
  private files = new Map<string, Tracked>();
  private live = new Map<string, Live>();
  private pending = new Set<string>();
  private flushing: Promise<void> | null = null;
  private copies = new Map<string, { running: Promise<void> | null; again: boolean; due: number; timer?: ReturnType<typeof setTimeout>; quiet?: ReturnType<typeof setTimeout> }>();
  private own = new Map<string, OwnWord>();   // Claude Code's word on a session, by its id
  private since = 0;
  // Claude Code here keeps a record of each session it runs (seen one): a session with none has ended.
  private keeps = false;
  private stopped = false;
  private on = false;
  // Folders watched because they are recent, with the check that says they still are.
  private recent = new Map<string, { off?: () => void; still: () => Promise<boolean> }>();
  private prune?: ReturnType<typeof setInterval>;
  private holders?: ReturnType<typeof setInterval>;
  private unsettle?: () => void;
  private cfg: OutsideSettings;
  stats: OutsideStatus = { enabled: false, days: 0, roots: [], watches: 0, tracked: 0, sessions: 0, reads: 0, bytes: 0, first_reads: 0, first_bytes: 0, copies: 0, copy_ms: 0, copy_bytes: 0, full_copies: 0, lock_reads: 0 };

  constructor(private d: OutsideDeps) {
    d.store.migrate(SCHEMA);
    this.cfg = this.settings();
  }

  private settings(): OutsideSettings {
    return this.d.settings?.() ?? outsideSettings();
  }

  // The roots, as this daemon reads them (scratch ones under a test).
  roots() {
    const claude = claudeRoot();
    return { claude, claudeHome: dirname(claude), claudeRunning: join(dirname(claude), "sessions"), codexHome: codexHome(), codex: join(codexHome(), "sessions"), agy: AGY_STORES.map((n) => join(agyHome(), n)) };
  }

  start() {
    this.since = Date.now();
    this.cfg = this.settings();
    this.unsettle ??= onSettings(() => this.settled());
    // A session this record showed of a source that was copied before is gone: the copy carries it.
    for (const r of this.d.store.db.query<{ harness: OutsideHarness; source_id: string }, []>("SELECT harness, source_id FROM outside_sessions").all()) {
      if (this.d.copied?.(r.harness, r.source_id)) this.copiedNow(r.harness, r.source_id);
    }
    if (this.cfg.enabled) this.begin();
    // A session that worked or waited when the daemon stopped is read again: it may have ended since.
    for (const row of this.d.store.db.query<{ path: string; harness: OutsideHarness }, []>(
      "SELECT o.path, o.harness FROM outside_sessions o JOIN sessions s ON s.id = o.session_id WHERE s.archived = 0 AND json_extract(s.outside, '$.state') != 'done'").all()) {
      if (this.cfg.enabled && existsSync(row.path)) this.schedule(row.path, row.harness);
    }
  }

  private begin() {
    if (this.stopped || this.on) return;
    this.on = true;
    const r = this.roots();
    this.root(r.claude, (dir) => this.claudeRoot(dir));
    this.root(r.codex, (dir) => this.codexDir(dir, 0, false));
    this.root(r.claudeRunning, (dir) => this.runningDir(dir));
    this.root(r.claudeHome, (dir) => this.history(dir, "claude"));
    this.root(r.codexHome, (dir) => this.history(dir, "codex"));
    for (const store of r.agy) {
      this.root(join(store, "brain"), (dir) => this.agyBrain(dir));
      this.root(store, (dir) => this.agyStore(dir));
    }
    this.stats.roots = [{ harness: "claude", path: r.claude, watched: false }, { harness: "codex", path: r.codex, watched: false }, ...r.agy.map((store) => ({ harness: "agy" as const, path: join(store, "brain"), watched: false }))];
    // A folder that held its last session more than `days` ago is let go (once a day).
    this.prune = setInterval(() => void this.pruneOld(), DAY);
    (this.prune as any).unref?.();
    // Who holds a session a page shows, read again (a row tells only a change).
    this.holders = setInterval(() => this.tick(), HOLDER_MS);
    (this.holders as any).unref?.();
  }

  // Who holds each row a page shows, read again: one look at /proc/locks for all of them.
  private tick() {
    let locks: Lock[] | undefined;
    for (const t of this.files.values()) {
      if (!t.session || !t.found || !this.d.viewed?.(t.session)) continue;
      if (t.harness === "codex") locks ??= this.locks();
      this.tell(t, locks);
    }
  }

  private locks(): Lock[] {
    this.stats.lock_reads++;
    return readLocks();
  }

  // Every watch closed; the sessions stay as they are.
  private halt() {
    this.on = false;
    clearInterval(this.prune);
    clearInterval(this.holders);
    for (const { w } of this.watchers.values()) try { w.close(); } catch {}
    this.watchers.clear();
    this.heard.clear();
    this.recent.clear();
    for (const t of this.files.values()) { clearTimeout(t.aging); clearTimeout(t.again); }
    this.files.clear();
    this.live.clear();
    this.pending.clear();
  }

  stop() {
    this.stopped = true;
    this.unsettle?.();
    this.halt();
    for (const c of this.copies.values()) { clearTimeout(c.timer); clearTimeout(c.quiet); }
  }

  // The owner changed a setting: watching turned off or on, folders excluded, the days or the stale time.
  private settled() {
    const was = this.cfg;
    const now = (this.cfg = this.settings());
    if (!now.enabled) { if (this.on) this.halt(); return; }
    if (!this.on) { this.begin(); return; }
    if (now.days !== was.days) { void this.pruneOld(); this.rescan(); }
    if (now.exclude.join("\n") !== was.exclude.join("\n") || now.stale_minutes !== was.stale_minutes) {
      for (const t of this.files.values()) if (t.found) { t.mark = undefined; this.schedule(t.path, t.harness); }
    }
  }

  // The folders walked again (after the days grew): a folder recent now is watched.
  private rescan() {
    const r = this.roots();
    if (this.heard.has(r.claude)) this.claudeWalk(r.claude);
    if (this.heard.has(r.codex)) this.codexWalk(r.codex, 0);
    for (const store of r.agy) if (this.heard.has(join(store, "brain"))) this.agyWalk(join(store, "brain"));
  }

  status(): OutsideStatus {
    const watched = new Set(this.watchers.keys());
    return {
      ...this.stats,
      enabled: this.on,
      days: this.cfg.days,
      roots: this.stats.roots.map((r) => ({ ...r, watched: watched.has(r.path) })),
      watches: this.watchers.size,
      tracked: this.files.size,
      sessions: (this.d.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM outside_sessions").get()?.n ?? 0),
    };
  }

  // ---- watching

  // A listener of a folder; the answer takes it away again (the watch goes with its last listener).
  private watchDir(dir: string, on: (event: string, name: string) => void): (() => void) | undefined {
    if (this.stopped || !this.on) return undefined;
    let had = this.watchers.get(dir);
    if (!had) {
      try {
        const ons = new Set<(event: string, name: string) => void>();
        const w = watch(dir, { persistent: false }, (event, name) => { if (name) for (const f of [...ons]) f(event, String(name)); });
        w.on("error", () => { this.watchers.delete(dir); this.heard.delete(dir); try { w.close(); } catch {} });
        this.watchers.set(dir, (had = { w, ons }));
      } catch (e: any) {
        // Out of watches (ENOSPC) or a folder that went: said once, the rest is still watched.
        if (e?.code !== "ENOENT" && !this.stats.unwatched) { this.stats.unwatched = `${dir}: ${e?.message ?? e}`; this.d.trouble?.(e, "watching another harness's folder"); }
        return undefined;
      }
    }
    const ons = had.ons;
    ons.add(on);
    return () => {
      ons.delete(on);
      if (ons.size || this.watchers.get(dir)?.ons !== ons) return;
      try { this.watchers.get(dir)!.w.close(); } catch {}
      this.watchers.delete(dir);
    };
  }

  // A root that is not there yet is waited for in the nearest folder above it that is.
  private root(dir: string, ready: (dir: string) => void, depth = 0) {
    if (isDir(dir)) return ready(dir);
    const parent = dirname(dir);
    if (parent === dir || depth >= 3) return;
    this.root(parent, (p) => {
      let off: (() => void) | undefined;
      let done = false;
      const check = () => {
        if (done || !isDir(dir)) return false;
        done = true;
        off?.();
        this.root(dir, ready, depth);
        return true;
      };
      off = this.watchDir(p, (_e, name) => { if (name === basename(dir)) check(); });
      // (It may have come between the look and the watch.)
      check();
    }, depth + 1);
  }

  // A folder that went (its parent's watch says so): its watch is closed at once. The kernel gives a
  // new folder the number of a watch that ended, and a watch left open on a removed folder then hears
  // the new folder's files under the old name.
  private gone(dir: string) {
    if (isDir(dir)) return;
    const had = this.watchers.get(dir);
    if (had) { try { had.w.close(); } catch {} this.watchers.delete(dir); }
    this.heard.delete(dir);
    this.recent.delete(dir);
    for (const [p, t] of this.files) if (dirname(p) === dir) { clearTimeout(t.aging); clearTimeout(t.again); this.files.delete(p); }
    for (const d of [...this.heard]) if (d.startsWith(`${dir}/`)) this.gone(d);
  }

  // A folder is listened to once, however often it is named (its creation, a walk of its parent).
  private heard = new Set<string>();
  private once(dir: string) {
    if (this.heard.has(dir)) return false;
    this.heard.add(dir);
    return true;
  }

  private cutoff() {
    return Date.now() - this.cfg.days * DAY;
  }

  // Whether a folder held a session file changed since the cutoff (its own change first: a file added or removed).
  private async freshIn(dir: string, match: (name: string) => boolean): Promise<boolean> {
    const since = this.cutoff();
    try { if ((await stat(dir)).mtimeMs >= since) return true; } catch { return false; }
    let names: string[] = [];
    try { names = await readdir(dir); } catch { return false; }
    for (const n of names) {
      if (!match(n)) continue;
      try { if ((await stat(join(dir, n))).mtimeMs >= since) return true; } catch {}
    }
    return false;
  }

  // A recent folder watched, with what says it still is (the daily prune asks).
  private keep(dir: string, still: () => Promise<boolean>, listen: () => (() => void) | undefined) {
    if (!this.once(dir)) return;
    this.recent.set(dir, { off: listen(), still });
  }

  private async pruneOld() {
    for (const [dir, r] of [...this.recent]) {
      if (await r.still()) continue;
      // A folder whose session is live here stays.
      if ([...this.files.values()].some((t) => dirname(t.path) === dir && t.session && !t.ignored)) continue;
      r.off?.();
      this.recent.delete(dir);
      this.heard.delete(dir);
    }
  }

  private claudeRoot(root: string) {
    if (!this.once(root)) return;
    // A project folder made now is new: watched.
    this.watchDir(root, (_e, name) => {
      if (name.includes(".")) return;
      if (isDir(join(root, name))) this.claudeProject(join(root, name));
      else this.gone(join(root, name));
    });
    this.claudeWalk(root);
  }

  private claudeWalk(root: string) {
    void (async () => {
      let names: string[] = [];
      try { names = await readdir(root); } catch {}
      for (const n of names) {
        if (n.includes(".") || !this.on) continue;
        const dir = join(root, n);
        if (await this.freshIn(dir, (x) => x.endsWith(".jsonl"))) this.claudeProject(dir);
      }
    })().catch((e) => this.d.trouble?.(e, "walking another harness's folders"));
  }

  // A project folder's own transcripts (a session's subagents are in folders below it: not watched).
  private claudeProject(dir: string) {
    this.keep(dir, () => this.freshIn(dir, (x) => x.endsWith(".jsonl")),
      () => this.watchDir(dir, (event, name) => { if (event === "change" && name.endsWith(".jsonl")) this.schedule(join(dir, name), "claude"); }));
  }

  // Codex keeps sessions/<year>/<month>/<day>/rollout-*.jsonl; a resumed session writes to its old file.
  // A year, month or day folder is watched while its name is within the days (new folders come under
  // it), and a day folder with a rollout changed since then too (a resumed session's).
  private codexDir(dir: string, depth: number, made: boolean) {
    const name = (d: number) => d === 0 ? "" : d === 1 ? basename(dir) : d === 2 ? `${basename(dirname(dir))}-${basename(dir)}` : `${basename(dirname(dirname(dir)))}-${basename(dirname(dir))}-${basename(dir)}`;
    const named = depth === 0 || made || name(depth) >= this.cutName(depth);
    const listen = () => this.watchDir(dir, (event, n) => {
      const p = join(dir, n);
      if (event === "change" && n.startsWith("rollout-") && n.endsWith(".jsonl")) this.schedule(p, "codex");
      else if (depth < 3 && !n.includes(".")) { if (isDir(p)) this.codexDir(p, depth + 1, true); else this.gone(p); }
    });
    const recentFiles = () => depth === 3 ? this.freshIn(dir, (x) => x.startsWith("rollout-") && x.endsWith(".jsonl")) : Promise.resolve(false);
    const still = async () => (depth === 0 || name(depth) >= this.cutName(depth)) || (await recentFiles());
    if (depth === 0) { if (this.once(dir)) listen(); }
    else if (named) this.keep(dir, still, listen);
    if (depth >= 3) {
      if (!named) void recentFiles().then((y) => { if (y) this.keep(dir, still, listen); });
      return;
    }
    this.codexWalk(dir, depth);
  }

  // Under an old folder only a day folder with a recent rollout is watched (its parents get no new folders).
  private codexWalk(dir: string, depth: number) {
    void (async () => {
      let names: string[] = [];
      try { names = await readdir(dir); } catch {}
      for (const n of names) if (!n.includes(".") && this.on) this.codexDir(join(dir, n), depth + 1, false);
    })().catch((e) => this.d.trouble?.(e, "walking another harness's folders"));
  }

  private cutName(depth: number) {
    const cut = new Date(this.cutoff());
    const pad = (n: number) => String(n).padStart(2, "0");
    return [String(cut.getFullYear()), `${cut.getFullYear()}-${pad(cut.getMonth() + 1)}`, `${cut.getFullYear()}-${pad(cut.getMonth() + 1)}-${pad(cut.getDate())}`][depth - 1]!;
  }

  // Antigravity: <store>/brain/<conversation>/.system_generated/logs/transcript_full.jsonl. A conversation made now
  // is new: its logs folder is waited for and watched; of the ones there, those whose transcript changed within the
  // days.
  private agyBrain(brain: string) {
    if (!this.once(brain)) return;
    this.watchDir(brain, (_e, name) => {
      if (name.includes(".")) return;
      if (isDir(join(brain, name))) this.agyConversation(join(brain, name), true);
      else this.gone(join(brain, name, ".system_generated", "logs"));
    });
    this.agyWalk(brain);
  }

  private agyWalk(brain: string) {
    void (async () => {
      let names: string[] = [];
      try { names = await readdir(brain); } catch {}
      const since = this.cutoff();
      for (const n of names) {
        if (n.includes(".") || !this.on) continue;
        try { if ((await stat(join(brain, n, ".system_generated", "logs", AGY_FILE))).mtimeMs >= since) this.agyConversation(join(brain, n), false); } catch {}
      }
    })().catch((e) => this.d.trouble?.(e, "walking another harness's folders"));
  }

  // A conversation's logs folder, watched while its transcript is recent (`made`: the conversation is new, and its
  // transcript is read once its folder comes, as its first steps may be written before the watch).
  private agyConversation(conv: string, made: boolean) {
    const logs = join(conv, ".system_generated", "logs");
    this.root(logs, (dir) => {
      this.keep(dir, () => this.freshIn(dir, (x) => x === AGY_FILE), () => this.watchDir(dir, (_e, name) => { if (name === AGY_FILE) this.schedule(join(dir, name), "agy"); }));
      if (made && existsSync(join(dir, AGY_FILE))) this.schedule(join(dir, AGY_FILE), "agy");
    });
  }

  // A store's list (conversation_summaries.db and its log) changed: the run status of its conversations shown
  // here is read again, in one look a moment after the burst of writes.
  private agyLook?: ReturnType<typeof setTimeout>;
  private agyStores = new Set<string>();
  private agyStore(store: string) {
    if (!this.once(`${store}#list`)) return;
    this.watchDir(store, (_e, name) => {
      if (!name.startsWith("conversation_summaries.db")) return;
      this.agyStores.add(store);
      if (this.agyLook) return;
      this.agyLook = setTimeout(() => { this.agyLook = undefined; this.agyStatuses(); }, 250);
      (this.agyLook as any).unref?.();
    });
  }

  private agyStatuses() {
    const stores = [...this.agyStores];
    this.agyStores.clear();
    for (const store of stores) {
      const ts = [...this.files.values()].filter((t) => t.harness === "agy" && t.found && t.session && agyPlace(t.path)?.store === store);
      if (!ts.length) continue;
      const rows = agyListed(store, ts.map((t) => t.found!.id));
      if (!rows) continue;
      for (const t of ts) {
        const status = rows.get(t.found!.id)?.status;
        if (status !== t.status) { t.status = status; this.tell(t); }
      }
    }
  }

  // Each harness's prompt history (history.jsonl in its own folder), read from its end: a prompt names
  // its session, and a session in a folder not watched (older than the days) is found by it.
  private history(home: string, harness: OutsideHarness) {
    if (!this.once(`${home}#history`)) return;
    const path = join(home, "history.jsonl");
    let offset = (() => { try { return statSync(path).size; } catch { return 0; } })();
    let rest = "";
    const decoder = new TextDecoder();
    let reading = false, again = false;
    const read = async () => {
      if (reading) { again = true; return; }
      reading = true;
      try {
        do {
          again = false;
          let size: number;
          try { size = statSync(path).size; } catch { return; }
          if (size < offset) { offset = 0; rest = ""; }
          if (size === offset) continue;
          const bytes = new Uint8Array(await Bun.file(path).slice(offset, Math.min(size, offset + PART)).arrayBuffer());
          offset += bytes.length;
          const got = splitGrown(rest, decoder.decode(bytes, { stream: true }));
          rest = got.rest;
          for (const r of got.records) {
            if (harness === "claude") this.named("claude", typeof r?.sessionId === "string" ? r.sessionId : undefined, typeof r?.project === "string" ? r.project : undefined, true);
            else if (typeof r?.session_id === "string") this.named("codex", r.session_id, undefined, true);
          }
          if (offset < size) again = true;
        } while (again && this.on);
      } finally { reading = false; }
    };
    this.watchDir(home, (_e, name) => { if (name === "history.jsonl") void read().catch((e) => this.d.trouble?.(e, "reading another harness's prompt history")); });
  }

  // A session its harness named (a prompt in its history, a record of its running process): its folder
  // is watched when it was not (older than the days), and its file read when it just grew (`grew`).
  private named(harness: OutsideHarness, id: string | undefined, cwd: string | undefined, grew: boolean) {
    for (const t of this.files.values()) if (t.harness === harness && t.found?.id === id) return;
    if (harness === "claude") {
      const root = this.roots().claude;
      let dir = cwd ? join(root, claudeSlug(cwd)) : undefined;
      if (id && !(dir && isDir(dir))) {
        dir = undefined;
        let names: string[] = [];
        try { names = readdirSync(root); } catch {}
        for (const n of names) if (existsSync(join(root, n, `${id}.jsonl`))) { dir = join(root, n); break; }
      }
      // (A project's first session: its folder comes, and the projects folder's watch sees it.)
      if (!dir || !isDir(dir)) return;
      const known = this.heard.has(dir);
      this.claudeProject(dir);
      if (!grew) return;
      if (id) { if (existsSync(join(dir, `${id}.jsonl`))) this.schedule(join(dir, `${id}.jsonl`), "claude"); }
      else if (!known) {
        // No id in the history (an older Claude Code): its newest transcript is the one just written to.
        let newest: { p: string; m: number } | undefined;
        for (const n of readdirSync(dir)) if (n.endsWith(".jsonl")) { try { const m = statSync(join(dir, n)).mtimeMs; if (!newest || m > newest.m) newest = { p: join(dir, n), m }; } catch {} }
        if (newest) this.schedule(newest.p, "claude");
      }
      return;
    }
    if (!id) return;
    const file = this.codexFile(id);
    if (!file) return;
    this.codexDir(dirname(file), 3, true);
    if (grew) this.schedule(file, "codex");
  }

  // A Codex rollout by its session id, newest folders first.
  private codexFile(id: string): string | undefined {
    const root = this.roots().codex;
    const down = (dir: string) => { try { return readdirSync(dir).filter((n) => !n.includes(".")).sort().reverse(); } catch { return []; } };
    for (const y of down(root)) for (const m of down(join(root, y))) for (const d of down(join(root, y, m))) {
      const dir = join(root, y, m, d);
      let names: string[] = [];
      try { names = readdirSync(dir); } catch { continue; }
      const n = names.find((x) => x.startsWith("rollout-") && x.endsWith(`${id}.jsonl`));
      if (n) return join(dir, n);
    }
    return undefined;
  }

  // Claude Code's record of each running session, <pid>.json: its own word on its state.
  private runningDir(dir: string) {
    if (!this.once(dir)) return;
    const read = (name: string) => {
      if (!/^\d+\.json$/.test(name)) return;
      const pid = Number(name.slice(0, -5));
      const r = readClaudeRecord(join(dir, name));
      if (!r) {
        for (const [id, w] of this.own) if (w.pid === pid) { this.own.delete(id); this.ownChanged(id); }
        return;
      }
      if (!r.sessionId) return;
      this.keeps = true;
      const had = this.own.has(r.sessionId);
      this.own.set(r.sessionId, { pid, status: r.status, waitingFor: r.waitingFor, procStart: r.procStart, kind: r.kind, entrypoint: r.entrypoint, pidDomain: r.pidDomain });
      this.ownChanged(r.sessionId);
      let cwd: unknown;
      try { cwd = JSON.parse(readFileSync(join(dir, name), "utf8"))?.cwd; } catch {}
      if (!had && claudeLive(r)) this.named("claude", r.sessionId, typeof cwd === "string" ? cwd : undefined, false);
    };
    this.watchDir(dir, (_e, name) => read(name));
    let names: string[] = [];
    try { names = readdirSync(dir); } catch {}
    for (const n of names) read(n);
  }

  private ownChanged(sourceId: string) {
    for (const t of this.files.values()) if (t.harness === "claude" && t.found?.id === sourceId && t.session) this.tell(t);
  }

  private schedule(path: string, harness: OutsideHarness) {
    if (!this.on) return;
    if (!this.files.has(path)) this.files.set(path, { path, harness, offset: 0, rest: "", decoder: new TextDecoder(), reader: readerOf(harness), synced: -1, failures: 0, mtime: 0 });
    this.pending.add(path);
    this.kick();
  }

  private kick() {
    this.flushing ??= (async () => {
      // (Writes of the same moment are one read.)
      await turn();
      while (this.pending.size && !this.stopped) {
        const paths = [...this.pending];
        this.pending.clear();
        for (const p of paths) {
          const t = this.files.get(p);
          if (t) await this.grow(t).catch((e) => this.d.trouble?.(e, "reading another harness's session"));
        }
      }
    })().finally(() => { this.flushing = null; if (this.pending.size && !this.stopped) this.kick(); });
  }

  // ---- reading what a file gained

  private async grow(t: Tracked) {
    let size: number, mtime: number;
    try { const st = statSync(t.path); size = st.size; mtime = st.mtimeMs; } catch { this.files.delete(t.path); return; }
    if (t.ignored) return;
    t.mtime = mtime;
    if (!t.found) {
      const f = foundOf(t.harness, t.path, size, mtime);
      // No conversation yet: looked at again when it grows.
      if (!f) return;
      if (f.kind !== "interactive" || !offered(f)) { t.ignored = true; t.reader = readerOf(t.harness); return; }
      t.found = f;
    }
    if (size < t.offset) Object.assign(t, { offset: 0, rest: "", decoder: new TextDecoder(), reader: readerOf(t.harness), synced: -1 });
    // Antigravity's run status, read with what the transcript gained (its list changes with it).
    if (t.harness === "agy" && t.session) { const at = agyPlace(t.path); const rows = at && agyListed(at.store, [t.found.id]); if (rows) t.status = rows.get(t.found.id)?.status; }
    if (size === t.offset) { this.tell(t); return; }
    const first = t.offset === 0;
    const file = Bun.file(t.path);
    while (t.offset < size) {
      const end = Math.min(size, t.offset + PART);
      const bytes = new Uint8Array(await file.slice(t.offset, end).arrayBuffer());
      if (!bytes.length) break;
      const { records, rest } = splitGrown(t.rest, t.decoder.decode(bytes, { stream: true }));
      t.rest = rest;
      for (const r of records) t.reader.push(r);
      t.offset += bytes.length;
      this.stats.bytes += bytes.length;
      if (first) this.stats.first_bytes += bytes.length;
      if (t.offset < size) await turn();
    }
    this.stats.reads++;
    if (first) this.stats.first_reads++;
    if (!t.again) { t.again = setTimeout(() => { t.again = undefined; this.schedule(t.path, t.harness); }, AGAIN_MS); (t.again as any).unref?.(); }
    this.tell(t);
    // Its transcript is copied while a page shows it, or when one asks (details): a list row needs none of it.
    if (t.session && this.d.viewed?.(t.session)) this.later(t.session);
  }

  // What a source's records say now, with the staleness the settings give.
  private factsOf(t: Tracked, locks?: Lock[]) {
    const holder = this.holderOf(t, locks);
    const keeps = t.harness === "codex" ? codexKeepsLocks(this.roots().codexHome) : this.keeps;
    const { facts: said, vouched } = withOwn(t, this.own, keeps, holder);
    const staleMs = this.cfg.stale_minutes * 60_000;
    const seen = Math.max(said.last_ts || 0, t.mtime || 0);
    return { facts: aged(said, seen, staleMs, vouched), said, vouched, seen, staleMs, holder };
  }

  // Who holds a source now, as this record knows it: Keel's own child, else Claude Code's record of its
  // running session (watched), else the holder of Codex's writer lock (read now).
  private holderOf(t: Tracked, locks?: Lock[]): Holder {
    if (!t.found) return FREE;
    if (t.session && this.d.ours?.(t.session)) return { kind: "keel" };
    // (Antigravity says nothing of the process that writes a conversation.)
    if (t.harness === "agy") return FREE;
    if (t.harness === "codex") return codexHolder(this.roots().codexHome, t.found.id, locks ?? this.locks());
    const w = this.own.get(t.found.id);
    return w && claudeLive(w) ? recordHolder(w) : FREE;
  }

  // Who holds a session now, read from its harness's records at this moment (never an earlier read):
  // what a send decides by.
  holderNow(sessionId: string): Holder | undefined {
    const row = this.row(sessionId);
    if (!row) return undefined;
    if (this.d.ours?.(sessionId)) return { kind: "keel" };
    if (row.harness === "agy") return FREE;
    return row.harness === "codex" ? codexHolder(this.roots().codexHome, row.source_id, this.locks()) : claudeHolder(this.roots().claudeRunning, row.source_id);
  }

  // The row told again (Keel's child began or ended in it).
  retell(sessionId: string) {
    for (const t of this.files.values()) if (t.session === sessionId) { this.tell(t); return; }
  }

  // A source that was copied into Keel loses its session here: the copy carries it.
  private fold(t: Tracked) {
    const row = this.d.store.db.query<{ session_id: string }, [string, string]>("SELECT session_id FROM outside_sessions WHERE harness = ? AND source_id = ?").get(t.harness, t.found!.id);
    const id = t.session ?? row?.session_id;
    t.session = undefined;
    t.mark = undefined;
    if (!id) return;
    this.live.delete(id);
    const x = this.d.store.session(id);
    if (!x?.outside) return;
    this.d.store.deleteSession(id);
    this.d.bus.emit({ t: "session", session: { ...x, archived: true, phase: "idle" }, deleted: true });
  }

  // Told that a copy of a source was made: the session this record showed of it goes.
  copiedNow(harness: OutsideHarness, sourceId: string) {
    for (const t of this.files.values()) if (t.harness === harness && t.found?.id === sourceId) { this.fold(t); return; }
    // (Not followed in this run: its session of an earlier run, if any.)
    const row = this.d.store.db.query<{ session_id: string }, [string, string]>("SELECT session_id FROM outside_sessions WHERE harness = ? AND source_id = ?").get(harness, sourceId);
    const x = row && this.d.store.session(row.session_id);
    if (x?.outside) { this.d.store.deleteSession(x.id); this.d.bus.emit({ t: "session", session: { ...x, archived: true, phase: "idle" }, deleted: true }); }
  }

  // What the source of a copy is doing now, from its records: it is running (working or waiting) or it is not.
  // Nothing when this daemon does not follow it.
  runningOf(harness: OutsideHarness, sourceId: string): { state: OutsideMark["state"]; since: number; waiting_for?: string } | undefined {
    for (const t of this.files.values()) {
      if (t.harness !== harness || t.found?.id !== sourceId) continue;
      const { facts } = this.factsOf(t);
      return { state: facts.state, since: facts.since || t.mtime, ...(facts.waiting_for ? { waiting_for: facts.waiting_for } : {}) };
    }
    return undefined;
  }

  // The session's row from what its records say now: made the first time, then written only when it changed.
  // `locks`: the look at /proc/locks a tick made for every row it tells (else one is made now).
  private tell(t: Tracked, locks?: Lock[]) {
    const f = t.found!;
    clearTimeout(t.aging);
    // A folder the owner excluded: not made, not told.
    if (excluded(f.cwd, this.cfg.exclude)) return;
    const { facts, said, vouched, seen, staleMs, holder } = this.factsOf(t, locks);
    // Told again when it would go stale with no record before then.
    if (facts !== said || vouched || (said.state !== "working" && said.state !== "waiting")) t.aging = undefined;
    else { t.aging = setTimeout(() => this.tell(t), Math.max(0, seen + staleMs - Date.now()) + 50); (t.aging as any).unref?.(); }
    // A source a Keel session holds a copy of is that copy's mark, not a row of its own.
    if (this.d.copied?.(t.harness, f.id)) { this.fold(t); return; }
    const id = t.session ?? this.made(t, facts);
    if (!id) return;
    const s = this.d.store.session(id);
    // The owner deleted it: not made again while this daemon runs.
    if (!s) { t.session = undefined; t.ignored = true; this.live.delete(id); return; }
    // Archived: its row is left as it was (and its failures wait in the reader) until it is brought back.
    if (s.archived) return;
    const failed = t.reader.takeFailures().filter((x) => x.ts >= this.since);
    for (const x of failed) this.d.failed?.(id, x, t.harness);
    t.failures += failed.length;
    const mark: OutsideMark = {
      harness: t.harness, source_id: f.id, state: facts.state, ...(facts.waiting_for ? { waiting_for: facts.waiting_for } : {}),
      since: facts.since || Date.now(), ...(facts.model ? { model: facts.model } : {}), files: facts.files.length, failures: t.failures,
      holder, ...(facts.doing ? { doing: facts.doing } : {}),
    };
    const usage = total(facts.usage, (m) => (u) => priceOf(u, this.d.price?.(m, t.harness)));
    const told = JSON.stringify([mark, usage]);
    if (told === t.mark) return;
    t.mark = told;
    this.d.store.db.query("UPDATE outside_sessions SET files = ?, usage = ?, failures = ?, path = ? WHERE session_id = ?").run(JSON.stringify(facts.files), JSON.stringify(facts.usage), t.failures, t.path, id);
    const next = this.d.store.updateSession(id, { outside: mark, usage, ...(facts.model && facts.model !== s.model ? { model: facts.model } : {}) });
    this.d.bus.emit({ t: "session", session: next });
  }

  // The session of a source: the one made before (a restart, a session resumed later), else a new one.
  private made(t: Tracked, facts: Facts): string | undefined {
    const f = t.found!;
    const row = this.d.store.db.query<{ session_id: string; failures: number }, [string, string]>("SELECT session_id, failures FROM outside_sessions WHERE harness = ? AND source_id = ?").get(t.harness, f.id);
    if (row && this.d.store.session(row.session_id)) {
      t.session = row.session_id;
      t.failures = row.failures;
      return t.session;
    }
    if (row) this.d.store.db.query("DELETE FROM outside_sessions WHERE session_id = ?").run(row.session_id);
    const workspace = f.cwd && isDir(f.cwd) ? f.cwd : this.d.workspace;
    const id = this.d.store.db.transaction(() => {
      const s = this.d.store.createSession({ title: f.title || `${LABEL[t.harness]} session`, model: facts.model ?? f.model ?? t.harness, workspace });
      // Marked in the write that makes it: nothing reads it as a session of Keel's own, even for a moment (src/core/outside.ts).
      this.d.store.updateSession(s.id, { outside: { harness: t.harness, source_id: f.id, state: facts.state, since: facts.since || Date.now(), files: 0, failures: 0 } });
      this.d.store.db.query("INSERT INTO outside_sessions (session_id, harness, source_id, path) VALUES (?, ?, ?, ?)").run(s.id, t.harness, f.id, t.path);
      return s.id;
    })();
    t.session = id;
    return id;
  }

  // ---- its transcript, in Keel's view

  // A session's copies of its transcript: one at a time, and while a page shows it as it grows, at
  // most a tenth of the time.
  private slot(id: string) {
    let c = this.copies.get(id);
    if (!c) this.copies.set(id, (c = { running: null, again: false, due: 0 }));
    return c;
  }

  private run(id: string): Promise<void> {
    const c = this.slot(id);
    const t0 = performance.now();
    c.running = this.copy(id).catch((e) => this.d.trouble?.(e, "copying another harness's transcript")).finally(() => {
      c.due = Date.now() + (performance.now() - t0) * 9;
      c.running = null;
      if (c.again) { c.again = false; this.later(id); }
    });
    return c.running;
  }

  // The copy held its last event back while the source wrote: once the file has been quiet for
  // QUIET_MS it is looked at again (a write before then moves the file's time and holds it again).
  private whenQuiet(id: string, mtime: number) {
    const c = this.slot(id);
    if (c.quiet) return;
    c.quiet = setTimeout(() => {
      c.quiet = undefined;
      if (!this.stopped && this.d.viewed?.(id)) this.later(id);
    }, Math.max(0, mtime + QUIET_MS - Date.now()) + 10);
    (c.quiet as any).unref?.();
  }

  // As the source grows under a page that shows it.
  private later(id: string) {
    const c = this.slot(id);
    if (c.running) { c.again = true; return; }
    if (c.timer) return;
    c.timer = setTimeout(() => { c.timer = undefined; void this.run(id); }, Math.max(0, c.due - Date.now()));
  }

  // Up to date now (a page asked for the session's view).
  async sync(id: string): Promise<void> {
    const c = this.slot(id);
    while (c.running) await c.running;
    if (c.timer) { clearTimeout(c.timer); c.timer = undefined; }
    await this.run(id);
  }

  // A conversion from the file's start, with what the session stored so far.
  private fresh(row: Row, had?: Live): Live {
    const stored = had ?? (() => {
      const rows = this.d.store.db.query<{ event_id: string; hash: string; items: number | null }, [string]>("SELECT event_id, hash, items FROM outside_events WHERE session_id = ? ORDER BY n").all(row.session_id);
      return { ids: rows.map((r) => r.event_id), hashes: rows.map((r) => r.hash), items: rows.map((r) => r.items) };
    })();
    this.stats.full_copies++;
    const l: Live = {
      offset: 0, rest: "", decoder: new TextDecoder(), base: 0, ids: stored.ids, hashes: stored.hashes, items: stored.items,
      ...(row.harness === "claude" ? { chain: new ClaudeChain(), conv: new ClaudeConvert() } : row.harness === "agy" ? { conv: new AgyConvert(row.path) } : { conv: new CodexConvert() }),
    };
    // The same records convert to the events stored: what an event held when stored is all it holds.
    l.items.forEach((n, i) => { if (n !== null) l.conv.b.sealed.set(i, n); });
    return l;
  }

  // What the file gained since the conversion last read it, in parts, the loop turning between them.
  private async readInto(l: Live, path: string, size: number, mtime: number, ok: () => boolean) {
    const file = Bun.file(path);
    while (l.offset < size) {
      const bytes = new Uint8Array(await file.slice(l.offset, Math.min(size, l.offset + PART)).arrayBuffer());
      if (!bytes.length || !ok()) return false;
      const { records, rest } = splitGrown(l.rest, l.decoder.decode(bytes, { stream: true }));
      l.rest = rest;
      l.offset += bytes.length;
      this.stats.copy_bytes += bytes.length;
      if (l.chain) l.chain.push(records);
      else if (!(await paced(records, (r) => l.conv.push(r, mtime), ok))) return false;
      if (l.offset < size) { await turn(); if (!ok()) return false; }
    }
    return true;
  }

  private async copy(sessionId: string) {
    const row = this.row(sessionId);
    if (!row) return;
    let st;
    try { st = statSync(row.path); } catch { return; }
    const store = this.d.store;
    const ok = () => !this.stopped && !!store.session(sessionId) && !store.session(sessionId)!.archived;
    if (!ok()) return;
    const t = this.files.get(row.path);
    const t0 = performance.now();
    const at = t?.offset ?? -1;
    let l = this.live.get(sessionId);
    if (!l || st.size < l.offset) this.live.set(sessionId, (l = this.fresh(row, l)));
    if (!(await this.readInto(l, row.path, st.size, st.mtimeMs, ok))) return;
    if (l.chain) {
      let seg = l.chain.advance();
      // The owner rewound and went on from an earlier message: the branch is read again from the start.
      if (seg === "rewound") {
        this.live.set(sessionId, (l = this.fresh(row, l)));
        if (!(await this.readInto(l, row.path, st.size, st.mtimeMs, ok))) return;
        seg = l.chain!.advance();
        if (seg === "rewound") seg = [];
      }
      const conv = l.conv;
      if (!(await paced(seg, (r) => conv.push(r, st.mtimeMs), ok))) return;
    }
    if (l.conv instanceof AgyConvert) {
      // A step written again under a number the conversion took (Antigravity went back to it): read again from the
      // start, and the copy goes on from where the two part, as another branch.
      if (l.conv.rewound) {
        this.live.set(sessionId, (l = this.fresh(row, l)));
        if (!(await this.readInto(l, row.path, st.size, st.mtimeMs, ok))) return;
      }
    }
    if (this.live.get(sessionId) !== l) return;
    // While it works, its last event may still grow (a reply's next block, a round's next result): it waits.
    // While it waits on the owner or is done, nothing more comes to it: the question it asks is shown.
    const working = (t ? this.factsOf(t).said.state : store.session(sessionId)?.outside?.state) === "working";
    const quiet = Date.now() - st.mtimeMs >= QUIET_MS;
    if (l.conv instanceof AgyConvert) {
      // Steps behind a gap wait for it to fill (a result is written before the step that made its call): only a turn
      // that ended passes it over, or the cap on held steps. A quiet file does not: parallel calls' results come
      // seconds apart. Looked at again once the file is quiet, when the turn's state may have moved.
      l.conv.settle(!working);
      if (l.conv.held) this.whenQuiet(sessionId, st.mtimeMs);
    }
    const events = l.conv.b.events;
    const base = l.base, len = base + events.length, stored = l.ids.length;
    const held = working && !quiet && len > base;
    const ready = held ? len - 1 : len;
    // Looked at again once the file is quiet, while a page shows it.
    if (held) this.whenQuiet(sessionId, st.mtimeMs);
    const texts: string[] = [];
    const text = (i: number) => (texts[i - base] ??= JSON.stringify([events[i - base]!.kind, events[i - base]!.data]));
    const hash = (i: number) => String(Bun.hash(text(i)));
    // The events it holds against the ones stored: the first that differs is where the copy goes on from.
    let k = base;
    const end = Math.min(len, stored);
    let tc = performance.now();
    for (; k < end; k++) {
      if (hash(k) !== l.hashes[k]) break;
      if (performance.now() - tc > SLICE_MS) { await turn(); if (!ok() || this.live.get(sessionId) !== l) return; tc = performance.now(); }
    }
    // A stored event differs only in the one still growing: it waits for that event to be whole.
    const from = k < stored ? k : stored;
    if (from >= ready) { if (t) t.synced = at; return; }
    // Slices of the events a transaction, the loop turning in between.
    let last: number | undefined;
    for (let j = from; j < ready;) {
      if (!ok() || this.live.get(sessionId) !== l) return;
      const made: StoredEvent[] = [];
      store.atomic(sessionId, () => {
        if (j < l.ids.length) {
          // Each under the one before it: a source that rewound goes on from where the two part, as another branch.
          store.db.query("DELETE FROM outside_events WHERE session_id = ? AND n >= ?").run(sessionId, j);
          l.ids.length = j;
          l.hashes.length = j;
          l.items.length = j;
          for (const n of [...l.conv.b.sealed.keys()]) if (n >= j) l.conv.b.sealed.delete(n);
        }
        const put = store.db.query("INSERT INTO outside_events (session_id, n, event_id, hash, items) VALUES (?, ?, ?, ?, ?)");
        const t1 = performance.now();
        for (let bytes = 0; j < ready && bytes < PACE_BYTES && performance.now() - t1 < SLICE_MS; j++) {
          const e = events[j - base]!;
          bytes += text(j).length;
          if (Number.isFinite(e.ts) && e.ts > 0) last = e.ts;
          const data = filesStored(storedData(e, (n) => l.ids[j - n]));
          const ev = store.append(sessionId, e.kind, data, j ? l.ids[j - 1]! : null, last);
          const items = itemsOf(e) ?? null;
          put.run(sessionId, j, ev.id, hash(j), items);
          l.ids.push(ev.id);
          l.hashes.push(hash(j));
          l.items.push(items);
          if (items !== null) l.conv.b.sealed.set(j, items);
          made.push(ev);
        }
      });
      for (const e of made) this.d.bus.emit({ t: "event", event: e });
      if (j < ready) await turn();
    }
    // What nothing later can change is let go: the conversion keeps from its last message on.
    let keepFrom = l.ids.length - 1;
    while (keepFrom > base && events[keepFrom - base]!.kind !== "user" && events[keepFrom - base]!.kind !== "assistant") keepFrom--;
    if (keepFrom > base) { events.splice(0, keepFrom - base); l.base = l.conv.b.base = keepFrom; }
    if (t) t.synced = at;
    this.stats.copies++;
    this.stats.copy_ms += performance.now() - t0;
    const s = store.session(sessionId);
    if (s) this.d.bus.emit({ t: "session", session: s });
  }

  row(sessionId: string): Row | undefined {
    return this.d.store.db.query<Row, [string]>("SELECT session_id, harness, source_id, path, files, usage, failures FROM outside_sessions WHERE session_id = ?").get(sessionId) ?? undefined;
  }

  // What the session's view shows beside its transcript, after the transcript caught up with its source.
  async details(sessionId: string) {
    const row = this.row(sessionId);
    if (!row) return undefined;
    const t = this.files.get(row.path);
    if (!t || t.synced !== t.offset) await this.sync(sessionId);
    const facts = t?.reader.facts();
    const files: string[] = facts?.files ?? JSON.parse(row.files);
    const usage: Record<string, Usage> = facts?.usage ?? JSON.parse(row.usage);
    const by = Object.entries(usage).map(([model, u]) => ({ model, usage: u, cost: priceOf(u, this.d.price?.(model, row.harness)) ?? null }));
    return { harness: row.harness, label: LABEL[row.harness], source_id: row.source_id, path: row.path, live: !!t, files, usage: by, holder: this.holderNow(sessionId) ?? FREE };
  }

  // The source a session shows, for the import that copies it into Keel.
  source(sessionId: string): Found | undefined {
    const row = this.row(sessionId);
    if (!row) return undefined;
    let st;
    try { st = statSync(row.path); } catch { return undefined; }
    const f = foundOf(row.harness, row.path, st.size, st.mtimeMs);
    return f?.id === row.source_id ? f : undefined;
  }
}
