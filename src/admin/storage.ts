// What the daemon keeps on disk, and keeping it in bounds: sizes per kind and
// per session (measured off the request path), deleting old archived sessions
// in two steps (list, then delete what is still that old and unchanged),
// leftovers of deleted sessions, the owner's archive policy, and backups of
// the durable state that are checked when written and can be restored.
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { writeOwnFile } from "../core/ownfile.ts";
import { checkDatabase, configFiles, DB_FILES, listBackups, materialize, verify, verifyFiles, type Backup, type BackupDone, type BackupJob } from "./backup.ts";
import type { Bus } from "../core/bus.ts";
import type { ErrorTracker } from "../core/errors.ts";
import type { Store } from "../core/store.ts";
import type { Engine } from "../engine/turn.ts";
import { jobsOf, leftText, jobLive, stopJob, stopJobs } from "../tools/jobs.ts";
import { daysOrNull, registerSettings, settings } from "./settings.ts";
import { readText } from "../core/proc.ts";
import { readsOf } from "../server/reads.ts";

export { backupConfig, configFiles, HASH_CHUNK, hashFile, verify } from "./backup.ts";

const DAY = 86_400_000;

registerSettings(
  "archive",
  { archive_idle_days: null, delete_archived_days: null },
  (v) => (!daysOrNull(v.archive_idle_days) ? "archive_idle_days is a whole number of days or null"
    : !daysOrNull(v.delete_archived_days) ? "delete_archived_days is a whole number of days or null" : undefined),
);
registerSettings(
  "backup",
  { keep: 5, before_restart: true },
  (v) => (!Number.isInteger(v.keep) || v.keep < 1 ? "keep is a whole number of at least 1" : typeof v.before_restart !== "boolean" ? "before_restart is true or false" : undefined),
);

// Folders under the state folder by what they hold. Durable state is the
// database and the small JSON files; the rest can be rebuilt or is disposable.
const DIRS = { spilled_output_bytes: "spill", checkpoints_bytes: "checkpoints", worktrees_bytes: "worktrees", reports_bytes: "reports", backups_bytes: "backups", plugins_bytes: "plugins" } as const;

async function du(paths: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const have = paths.filter((p) => existsSync(p));
  if (!have.length) return out;
  const p = Bun.spawn(["du", "-sb", "--", ...have], { stdout: "pipe", stderr: "ignore" });
  const text = await readText(p.stdout);
  await p.exited;
  for (const line of text.split("\n")) {
    const m = /^(\d+)\t(.+)$/.exec(line);
    if (m) out.set(m[2]!, Number(m[1]));
  }
  return out;
}

export type StorageReport = Awaited<ReturnType<Storage["measure"]>>;
type CheckpointSession = { id: string; title: string; archived: boolean; subagent: boolean; checkpoints: number; checkpoint_bytes: number; updated_ms: number };

export class Storage {
  private last?: StorageReport;
  private measuring?: Promise<StorageReport>;

  // `config`: the owner's config folder, which a backup carries with the state. Named by the daemon; none, none carried.
  constructor(private store: Store, private engine: Engine, private bus: Bus, private errors: ErrorTracker, private config?: string) {}

  get dir() { return this.store.stateDir; }

  report(refresh = false): Promise<StorageReport> {
    if (this.last && !refresh) return Promise.resolve(this.last);
    return (this.measuring ??= this.measure().then((r) => (this.last = r)).finally(() => (this.measuring = undefined)));
  }

  private async measure() {
    // Every event of the store is read for its size: off the loop (src/server/reads.ts).
    const rows = await readsOf(this.store).sql<{ id: string; title: string; archived: number; updated: number; parent_id: string | null; bytes: number; attach: number }>(`
      SELECT s.id, s.title, s.archived, s.updated, s.parent_id,
        COALESCE((SELECT SUM(length(e.data)) FROM events e WHERE e.session_id = s.id), 0) AS bytes,
        COALESCE((SELECT SUM(length(json_extract(i.value, '$.data'))) FROM events e, json_each(e.data, '$.images') i WHERE e.session_id = s.id AND e.kind = 'user'), 0) AS attach
      FROM sessions s`);
    const spillDirs = rows.map((r) => join(this.dir, "spill", r.id));
    const cps = this.checkpointRows();
    const shadowDirs = [...new Set(cps.map((c) => c.shadow))];
    // Two du runs: du counts a file once per run, so a folder measured after
    // its parent in the same run would read as empty.
    const [top, inner] = await Promise.all([du(Object.values(DIRS).map((d) => join(this.dir, d))), du([...spillDirs, ...shadowDirs])]);
    const sizes = new Map([...top, ...inner]);
    // A folder's checkpoints live in one shadow repository; a session's part is
    // its share of that folder's checkpoints (an estimate: they share objects).
    const perShadow = new Map<string, number>();
    for (const c of cps) perShadow.set(c.shadow, (perShadow.get(c.shadow) ?? 0) + c.n);
    const cpOf = new Map(cps.map((c) => [c.session_id, { count: c.n, bytes: Math.round(((sizes.get(c.shadow) ?? 0) * c.n) / (perShadow.get(c.shadow) || 1)) }]));
    // Every session with checkpoints is listed under its folder, so any of them
    // can be dropped, not only the largest sessions.
    const byId = new Map(rows.map((r) => [r.id, r]));
    const folders = new Map<string, { workspace: string; bytes: number; checkpoints: number; sessions: number; list: CheckpointSession[] }>();
    for (const c of cps) {
      if (c.gone) continue;
      const f = folders.get(c.shadow) ?? { workspace: c.workspace, bytes: sizes.get(c.shadow) ?? 0, checkpoints: 0, sessions: 0, list: [] };
      f.checkpoints += c.n;
      f.sessions++;
      const r = byId.get(c.session_id);
      f.list.push({ id: c.session_id, title: r?.title ?? "", archived: !!r?.archived, subagent: !!r?.parent_id, checkpoints: c.n, checkpoint_bytes: cpOf.get(c.session_id)?.bytes ?? 0, updated_ms: r?.updated ?? 0 });
      folders.set(c.shadow, f);
    }
    for (const f of folders.values()) f.list.sort((a, b) => b.updated_ms - a.updated_ms);
    const dbBytes = ["keel.db", "keel.db-wal", "keel.db-shm"].reduce((n, f) => n + (existsSync(join(this.dir, f)) ? statSync(join(this.dir, f)).size : 0), 0);
    const group = (pred: (r: (typeof rows)[number]) => boolean) => {
      const list = rows.filter(pred);
      return { count: list.length, transcript_bytes: list.reduce((n, r) => n + r.bytes, 0) };
    };
    const known = new Set(rows.map((r) => r.id));
    const leftovers = existsSync(join(this.dir, "spill")) ? readdirSync(join(this.dir, "spill")).filter((d) => !known.has(d)) : [];
    const leftoverSizes = await du(leftovers.map((d) => join(this.dir, "spill", d)));
    const dirs = Object.fromEntries(Object.entries(DIRS).map(([k, d]) => [k, sizes.get(join(this.dir, d)) ?? 0])) as Record<keyof typeof DIRS, number>;
    return {
      measured_ms: Date.now(),
      state_dir: this.dir,
      database_bytes: dbBytes,
      total_bytes: dbBytes + Object.values(dirs).reduce((n, b) => n + b, 0),
      sessions: group((r) => !r.archived && !r.parent_id),
      archived_sessions: group((r) => !!r.archived && !r.parent_id),
      subagent_sessions: group((r) => !!r.parent_id),
      attachments_bytes: Math.round(rows.reduce((n, r) => n + r.attach, 0) * 0.75), // base64 in the store
      ...dirs,
      leftovers: { count: leftovers.length, bytes: [...leftoverSizes.values()].reduce((n, b) => n + b, 0) },
      checkpoint_folders: [...folders.values()].sort((a, b) => b.bytes - a.bytes).map(({ list, ...f }) => ({ ...f, session_list: list })),
      orphan_checkpoints: cps.filter((c) => c.gone).reduce((n, c) => n + c.n, 0),
      by_session: rows
        .map((r) => {
          const spill = sizes.get(join(this.dir, "spill", r.id)) ?? 0;
          const cp = cpOf.get(r.id) ?? { count: 0, bytes: 0 };
          return { id: r.id, title: r.title, archived: !!r.archived, subagent: !!r.parent_id, transcript_bytes: r.bytes, spill_bytes: spill, checkpoints: cp.count, checkpoint_bytes: cp.bytes, bytes: r.bytes + spill + cp.bytes, updated_ms: r.updated };
        })
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 50),
    };
  }

  // Checkpoint rows per session with the shadow repository they live in
  // (src/safety/shadow.ts: <state>/checkpoints/<sha256(folder)[:16]>.git).
  private checkpointRows() {
    const db = this.store.db;
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'checkpoints'").get()) return [];
    return db
      .query<{ session_id: string; workspace: string | null; n: number }, []>(
        "SELECT c.session_id, s.workspace, COUNT(*) AS n FROM checkpoints c LEFT JOIN sessions s ON s.id = c.session_id GROUP BY c.session_id",
      )
      .all()
      .map((r) => ({ ...r, gone: r.workspace === null, workspace: r.workspace ?? "", shadow: r.workspace === null ? "" : shadowDir(this.dir, r.workspace) }))
      .filter((r) => r.gone || existsSync(r.shadow));
  }

  // Drops the checkpoints of the given sessions (and those of sessions that no
  // longer exist), then lets git drop what no checkpoint still needs: the trees
  // of the checkpoints that stay are pinned by refs first. Objects younger than
  // an hour are kept, so a snapshot written meanwhile is never cut.
  async removeCheckpoints(sessionIds: string[]) {
    const db = this.store.db;
    const busy = sessionIds.filter((id) => this.engine.isRunning(id));
    if (busy.length) throw Object.assign(new Error("a turn of that session is running; stop it first"), { status: 409 });
    const before = this.checkpointRows();
    const touched = new Set(before.filter((r) => r.gone || sessionIds.includes(r.session_id)).map((r) => r.workspace).filter(Boolean));
    const removed = db.transaction(() => {
      let n = 0;
      for (const id of sessionIds) n += db.query("DELETE FROM checkpoints WHERE session_id = ?").run(id).changes;
      n += db.query("DELETE FROM checkpoints WHERE session_id NOT IN (SELECT id FROM sessions)").run().changes;
      return n;
    })();
    let freed = 0;
    for (const ws of touched) {
      const dir = shadowDir(this.dir, ws);
      if (!existsSync(join(dir, "HEAD"))) continue;
      const size0 = (await du([dir])).get(dir) ?? 0;
      const trees = db.query<{ id: string; tree: string }, [string]>("SELECT c.id, c.tree FROM checkpoints c JOIN sessions s ON s.id = c.session_id WHERE s.workspace = ?").all(ws);
      const git = (args: string[], input?: string) => {
        const r = Bun.spawnSync(["git", ...args], { env: { ...process.env, GIT_DIR: dir }, stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
        if (!r.success) throw new Error(`git ${args[0]} in ${dir}: ${r.stderr.toString().trim().slice(0, 300)}`);
        return r.stdout.toString();
      };
      const old = git(["for-each-ref", "--format=%(refname)", "refs/keel/keep/"]).split("\n").filter(Boolean);
      // One command per ref: git refuses a delete and an update of the same ref
      // (a ref kept by an earlier drop) in one transaction.
      const keep = new Map(trees.map((t) => [`refs/keel/keep/${t.id}`, t.tree]));
      const refs = [...old.filter((r) => !keep.has(r)).map((r) => `delete ${r}`), ...[...keep].map(([r, tree]) => `update ${r} ${tree}`)];
      if (refs.length) git(["update-ref", "--stdin"], refs.join("\n") + "\n");
      git(["-c", "gc.reflogExpire=now", "-c", "gc.reflogExpireUnreachable=now", "gc", "--quiet", "--prune=1.hour.ago"]);
      freed += Math.max(0, size0 - ((await du([dir])).get(dir) ?? 0));
    }
    this.last = undefined;
    return { removed_checkpoints: removed, freed_bytes: freed };
  }

  // A session and what belongs to it: its turn, its commands, its spilled output.
  async removeSession(id: string) {
    const s = this.store.session(id);
    if (!s) return;
    await this.engine.interrupt(id);
    await Promise.all(jobsOf(id).filter(jobLive).map((j) => stopJob(j, "was stopped: its session was deleted")));
    rmSync(join(this.dir, "spill", id), { recursive: true, force: true });
    this.store.deleteSession(id);
    this.bus.emit({ t: "session", session: { ...s, archived: true, phase: "idle" } });
  }

  // A session's descendants (subagents and theirs), nearest first.
  private descendants(id: string) {
    return this.store.db
      .query<{ id: string; title: string; updated: number; phase: string; bytes: number }, [string]>(
        `WITH RECURSIVE d(id) AS (SELECT id FROM sessions WHERE parent_id = ?1 UNION SELECT s.id FROM sessions s JOIN d ON s.parent_id = d.id)
         SELECT s.id, s.title, s.updated, s.phase, COALESCE((SELECT SUM(length(data)) FROM events e WHERE e.session_id = s.id), 0) AS bytes
         FROM sessions s JOIN d ON d.id = s.id`,
      )
      .all(id);
  }

  // Archived sessions archived at least `days` ago, each with the subagent
  // sessions that go with it. `family_updated_ms` is the latest change in the
  // whole family: the delete compares it, so work started in a child after the
  // list was made saves the family.
  candidates(days: number) {
    const cut = Date.now() - days * DAY;
    return this.store.db
      .query<{ id: string; title: string; updated: number; bytes: number }, [number]>(
        `SELECT s.id, s.title, s.updated, COALESCE((SELECT SUM(length(data)) FROM events e WHERE e.session_id = s.id), 0) AS bytes
         FROM sessions s WHERE s.archived = 1 AND s.parent_id IS NULL AND s.updated <= ? ORDER BY s.updated`,
      )
      .all(cut)
      .map((r) => {
        const kids = this.descendants(r.id);
        return {
          id: r.id, title: r.title, updated_ms: r.updated, bytes: r.bytes + kids.reduce((n, k) => n + k.bytes, 0),
          family_updated_ms: Math.max(r.updated, ...kids.map((k) => k.updated)),
          subagents: kids.map((k) => ({ id: k.id, title: k.title, updated_ms: k.updated })),
        };
      });
  }

  // Deletes the listed sessions that are still that old and unchanged since
  // listed, each with its subagents. A family where any session is working, or
  // changed since the list, is skipped whole before anything is interrupted.
  async cleanup(days: number, list: { id: string; updated_ms: number; family_updated_ms?: number }[]) {
    const now = new Map(this.candidates(days).map((c) => [c.id, c]));
    const deleted: string[] = [];
    const skipped: { id: string; why: string }[] = [];
    for (const want of list) {
      const c = now.get(want.id);
      if (!c) { skipped.push({ id: want.id, why: this.store.session(want.id) ? "no longer archived that long" : "already gone" }); continue; }
      if (c.updated_ms !== want.updated_ms) { skipped.push({ id: want.id, why: "changed since it was listed" }); continue; }
      const kids = this.descendants(want.id);
      const live = kids.find((k) => k.phase === "working" || this.engine.isRunning(k.id));
      if (live || this.engine.isRunning(want.id)) { skipped.push({ id: want.id, why: live ? `its subagent ${live.title || live.id} is working` : "a turn is running" }); continue; }
      const listed = want.family_updated_ms ?? want.updated_ms;
      const moved = kids.find((k) => k.updated > listed);
      if (moved) { skipped.push({ id: want.id, why: `its subagent ${moved.title || moved.id} changed since it was listed` }); continue; }
      // Its commands are stopped first; one that would not stop keeps the family.
      const left = await stopJobs([...kids, want].flatMap((k) => jobsOf(k.id).filter(jobLive)), "was stopped: its session was deleted");
      if (left.length) { skipped.push({ id: want.id, why: `a command would not stop: ${leftText(left)}` }); continue; }
      // Deepest first, so no child outlives its parent.
      for (const sub of kids.reverse()) await this.removeSession(sub.id);
      await this.removeSession(want.id);
      deleted.push(want.id);
    }
    this.last = undefined;
    return { deleted, skipped };
  }

  removeLeftovers() {
    const known = new Set(this.store.db.query<{ id: string }, []>("SELECT id FROM sessions").all().map((r) => r.id));
    const dir = join(this.dir, "spill");
    const gone = existsSync(dir) ? readdirSync(dir).filter((d) => !known.has(d)) : [];
    for (const d of gone) rmSync(join(dir, d), { recursive: true, force: true });
    this.last = undefined;
    return { removed: gone.length };
  }

  // The owner's policy, run at start and once a day.
  async applyPolicy() {
    const p = settings().archive;
    let archived = 0, deleted = 0;
    if (p.archive_idle_days) {
      const cut = Date.now() - p.archive_idle_days * DAY;
      for (const s of this.store.sessions()) {
        if (s.parent_id || s.phase === "working" || this.engine.isRunning(s.id) || s.updated > cut) continue;
        this.bus.emit({ t: "session", session: this.store.updateSession(s.id, { archived: true }) });
        archived++;
      }
    }
    if (p.delete_archived_days) {
      const list = this.candidates(p.delete_archived_days);
      deleted = (await this.cleanup(p.delete_archived_days, list)).deleted.length;
    }
    return { archived, deleted };
  }

  // ---- backups ----

  private get backupRoot() { return join(this.dir, "backups"); }
  private backing: Promise<unknown> = Promise.resolve();

  // A backup of the state (src/admin/backup.ts says what it holds), made in a
  // worker: the daemon goes on answering while the database is copied, hashed
  // and checked. One at a time; it settles once the backup is whole, checked
  // and has its name, or fails with nothing left behind.
  backup(reason: string): Promise<Backup> {
    const run = this.backing.then(() => this.backupNow(reason));
    this.backing = run.catch(() => {});
    return run;
  }

  private async backupNow(reason: string): Promise<Backup> {
    // Two backups in the same millisecond get distinct names (-1, -2, ...).
    const base = `keel-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    let stamp = base.slice(5);
    for (let n = 1; existsSync(join(this.backupRoot, `keel-${stamp}`)) || existsSync(join(this.backupRoot, `.keel-${stamp}.partial`)); n++) stamp = `${base.slice(5)}-${n}`;
    const tmp = join(this.backupRoot, `.keel-${stamp}.partial`);
    const final = join(this.backupRoot, `keel-${stamp}`);
    try {
      mkdirSync(tmp, { recursive: true });
      // The worker reads the database file itself once the write-ahead log is
      // emptied into it: asked for here, between two writes of the daemon.
      const checkpoint = () => { try { this.store.db.run("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {} }; // not emptied: the worker sees that
      const done = await inWorker({ stateDir: this.dir, root: this.backupRoot, tmp, reason, keep: settings().backup.keep, ...(this.config ? { config: resolve(this.config) } : {}) }, checkpoint);
      if (done.skipped.length) this.errors.capture?.("server", new Error(`the backup left out ${done.skipped.length} config file${done.skipped.length === 1 ? "" : "s"} it could not read: ${done.skipped.map((s) => s.name).join(", ")}`), { at: "backup config", dir: done.config });
      renameSync(tmp, final);
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
    this.prune();
    this.last = undefined;
    return this.backups().find((b) => b.name === basename(final))!;
  }

  private prune() {
    const keep = settings().backup.keep as number;
    const list = this.backups().filter((b) => !b.unreadable);
    // A full backup stays for as long as a kept backup is read over it.
    const bases = new Set(list.slice(0, keep).map((b) => b.base));
    for (const b of list.slice(keep)) if (!bases.has(b.name)) rmSync(join(this.backupRoot, b.name), { recursive: true, force: true });
    // A partial copy left by a crash during a backup.
    if (existsSync(this.backupRoot)) for (const d of readdirSync(this.backupRoot)) if (d.endsWith(".partial")) rmSync(join(this.backupRoot, d), { recursive: true, force: true });
  }

  backups(): Backup[] { return listBackups(this.backupRoot); }
}

// Set by the build: the worker's bundle as text. The binary has no source
// file to start a worker from; run from source, the worker is its file.
declare const __KEEL_BACKUP_WORKER_JS__: string | undefined;

// Runs one backup job in a worker of its own and ends the worker. A worker
// that dies without an answer fails the backup.
const HOLD_MS = 25;
function inWorker(job: BackupJob, checkpoint: () => void): Promise<BackupDone> {
  return new Promise((ok, fail) => {
    const built = typeof __KEEL_BACKUP_WORKER_JS__ === "string" ? URL.createObjectURL(new Blob([__KEEL_BACKUP_WORKER_JS__], { type: "text/javascript" })) : undefined;
    const w = new Worker(built ?? new URL("./backup-worker.ts", import.meta.url).href);
    const end = (f: () => void) => {
      w.terminate();
      if (built) URL.revokeObjectURL(built);
      f();
    };
    // The worker takes its snapshot between two writes of the daemon: the
    // log is emptied here, and the daemon holds still until the worker has
    // its read transaction (well under a millisecond; never longer than
    // HOLD_MS, after which the worker finds out by itself and asks again).
    const gate = new Int32Array(new SharedArrayBuffer(4));
    w.onmessage = (e: MessageEvent<{ t: "checkpoint" } | { t: "done"; done: BackupDone } | { t: "failed"; error: string }>) => {
      const m = e.data;
      if (m.t === "checkpoint") {
        checkpoint();
        Atomics.store(gate, 0, 1);
        Atomics.notify(gate, 0);
        Atomics.wait(gate, 0, 1, HOLD_MS);
      } else end(() => (m.t === "done" ? ok(m.done) : fail(new Error(m.error))));
    };
    w.onerror = (e) => end(() => fail(new Error(`the backup worker failed: ${e.message}`)));
    w.postMessage({ job, gate });
  });
}

export const shadowDir = (stateDir: string, workspace: string) =>
  join(stateDir, "checkpoints", createHash("sha256").update(workspace).digest("hex").slice(0, 16) + ".git");

// The swap a restore is in the middle of: the names it moves, in order,
// relative to the state folder. Written (and synced) before the first move,
// and removed as soon as the swap is over or undone, before anything else is
// tidied: while it is there, the stage folder is whole.
const PENDING = "restore.pending";
type Pending = { aside: string; stage: string; moves: [from: string, to: string][] };
const STAGE = /^\.restore-[\w-]+\.partial$/;
class NotRestorable extends Error {}
const ASIDE = /^before-restore-[\w-]+$/;

// Puts a backup in place of the state (the daemon must be stopped; the caller
// holds the state folder's claim). The current files are kept beside it, so a
// restore can be undone.
// `config` names a config folder to put the backup's config files back
// into, once the state is in. It is the caller's choice, never a default:
// the state folder says nothing about which config folder goes with it, and
// a backup of a scratch daemon restored into scratch state must not rewrite
// the owner's servers. Each file is put back whole, a file that is there
// keeps its mode, and what it held stays beside it as <name>.prev. A config
// file the backup does not hold is left as it is, and so is a sign-in.
// The backup is copied into the state folder first: what can fail for lack of
// space or a bad file fails with the state untouched. Then it is swapped in by
// renames, written down before the first one. A swap that fails is undone, and
// one that was cut (the process died) is undone by the next restore or the next
// start of the daemon. Either way the state is the one before, or the backup.
export function restore(stateDir: string, backupDir: string, config?: string) {
  if (undoCutRestore(stateDir) === "unreadable") {
    throw new Error(`${PENDING} in ${stateDir} could not be read, so nothing was changed: the state is as it was found. The file is now ${PENDING}.unreadable, and what a restore moved aside is in the before-restore folders. Run keel restore again to put the backup in.`);
  }
  // A backup that holds the database compressed, or as the pages that changed
  // since a full backup, has it written out whole into the stage folder, where
  // it must be the database that was backed up and pass SQLite's check again.
  const files = verifyFiles(backupDir);
  if (!files.ok) throw new Error(`the backup cannot be restored: ${files.why}`);
  const held = files.manifest?.database;
  let check = held ? undefined : verify(backupDir);
  if (check && !check.ok) throw new Error(`the backup cannot be restored: ${check.why}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const aside = `before-restore-${stamp}`, stage = `.restore-${stamp}.partial`;
  const at = (...p: string[]) => join(stateDir, ...p);
  const copied = readdirSync(backupDir).filter((f) => f !== "manifest.json" && f !== "attachments" && f !== "config" && !DB_FILES.has(f));
  const inBackup = held ? [...copied, "keel.db"] : copied;
  try {
    mkdirSync(at(stage), { recursive: true });
    for (const f of copied) copyFileSync(join(backupDir, f), at(stage, f));
    if (held) {
      try { materialize(backupDir, held, at(stage, "keel.db")); } catch (e) { throw new NotRestorable((e as Error).message); }
      check = checkDatabase(at(stage, "keel.db"));
      if (check.ok && (check.sessions !== files.manifest!.sessions || check.events !== files.manifest!.events)) check = { ok: false, why: `it holds ${check.sessions} sessions and ${check.events} events, its manifest says ${files.manifest!.sessions} and ${files.manifest!.events}` };
      if (!check.ok) throw new NotRestorable(check.why);
    }
    // Attachments are stored by content: one already present is the same
    // bytes, and one more changes nothing the state reads.
    const att = join(backupDir, "attachments");
    if (existsSync(att)) for (const id of readdirSync(att)) for (const name of readdirSync(join(att, id))) {
      if (existsSync(at("attachments", id, name))) continue;
      mkdirSync(at("attachments", id), { recursive: true });
      copyFileSync(join(att, id, name), at("attachments", id, name));
    }
  } catch (e) {
    rmSync(at(stage), { recursive: true, force: true });
    if (e instanceof NotRestorable) throw new Error(`the backup cannot be restored: ${e.message}`);
    throw new Error(`the restore failed and the state is as it was: ${(e as Error).message}`, { cause: e });
  }
  if (!check?.ok) throw new Error("the backup cannot be restored"); // not reached: every path above checked it
  // The state's JSON files are what a backup holds of them: one the backup
  // does not have (a settings file written after it) moves aside too, so the
  // restored state reads as it did then, defaults included.
  const live = [...["keel.db", "keel.db-wal", "keel.db-shm"].filter((f) => existsSync(at(f))), ...readdirSync(stateDir).filter((f) => f.endsWith(".json"))];
  const pending: Pending = { aside, stage, moves: [...live.map((f): [string, string] => [f, join(aside, f)]), ...inBackup.map((f): [string, string] => [join(stage, f), f])] };
  // On disk whole before it has its name: a file by that name is never half written.
  const tmp = openSync(at(`${PENDING}.tmp`), "w", 0o600);
  try { writeSync(tmp, JSON.stringify(pending)); fsyncSync(tmp); } finally { closeSync(tmp); }
  renameSync(at(`${PENDING}.tmp`), at(PENDING));
  try {
    mkdirSync(at(aside), { recursive: true });
    for (const [from, to] of pending.moves) renameSync(at(from), at(to));
  } catch (e) {
    let undone = true;
    try { undoCutRestore(stateDir); } catch { undone = false; }
    throw new Error(
      undone ? `the restore failed and the state is as it was: ${(e as Error).message}`
        : `the restore failed part way and could not be undone now: ${(e as Error).message}. The next keel restore, or the next start of the daemon, undoes it.`,
      { cause: e },
    );
  }
  rmSync(at(PENDING));
  rmSync(at(stage), { recursive: true, force: true });
  let put = 0;
  if (config) {
    const from = join(backupDir, "config"), failed: string[] = [];
    for (const rel of configFiles(from).files) {
      const src = join(from, rel), to = join(config, rel);
      try {
        // A file that is there keeps the mode the owner gave it since; a new one gets the backup's.
        if (writeOwnFile(to, readFileSync(src), existsSync(to) ? {} : { mode: statSync(src).mode & 0o777 })) put++;
      } catch (e) {
        failed.push(`${rel}: ${(e as Error).message}`);
      }
    }
    if (failed.length) throw new Error(`the state was restored (what it replaced is in ${at(aside)}) and ${put} config file${put === 1 ? " was" : "s were"} put back, but not ${failed.length === 1 ? "this one" : "these"}:\n  ${failed.join("\n  ")}\nEach file that was replaced has what it held beside it as .prev.`);
  }
  return { ...check, aside: at(aside), config_files: put };
}

// What a restore that was cut left in a state folder (the caller holds the
// folder's claim, so no restore is running in it):
// - restore.pending: the swap stopped in the middle. Every move it made is
//   taken back, last first, so the state is the one before it ("undone"). A
//   move was made when its source is gone and its target is there.
// - a restore.pending that cannot be read was not written by a restore (it
//   is synced before it gets its name): nothing is moved, the file is set
//   aside as restore.pending.unreadable, and the caller says so ("unreadable").
// - no restore.pending: the copies a restore staged and never used, and the
//   empty folders one left, are removed.
export function undoCutRestore(stateDir: string): "undone" | "unreadable" | false {
  const at = (...p: string[]) => join(stateDir, ...p);
  if (!existsSync(at(PENDING))) {
    if (existsSync(stateDir)) for (const d of readdirSync(stateDir)) {
      if (STAGE.test(d) || d === `${PENDING}.tmp`) rmSync(at(d), { recursive: true, force: true });
      else if (ASIDE.test(d) && !readdirSync(at(d)).length) rmSync(at(d), { recursive: true });
    }
    return false;
  }
  const p = readPending(at(PENDING));
  if (!p) {
    renameSync(at(PENDING), at(`${PENDING}.unreadable`));
    return "unreadable";
  }
  for (const [from, to] of p.moves.toReversed()) {
    if (!existsSync(at(from)) && existsSync(at(to))) renameSync(at(to), at(from));
  }
  // First, so that a cut from here on leaves nothing to undo: only folders to sweep.
  rmSync(at(PENDING));
  rmSync(at(p.stage), { recursive: true, force: true });
  // Nothing is left in it once every move is back.
  if (existsSync(at(p.aside)) && !readdirSync(at(p.aside)).length) rmSync(at(p.aside), { recursive: true });
  return "undone";
}

// The swap as a restore writes it, or null: its two folders by their names,
// and every move either a state file into the aside folder or a staged file
// into the state folder, nothing outside it.
function readPending(path: string): Pending | null {
  try {
    const p = JSON.parse(readFileSync(path, "utf8")) as Pending;
    const name = (f: unknown): f is string => typeof f === "string" && f !== "" && f !== "." && f !== ".." && !/[\\/]/.test(f);
    const ok = typeof p.stage === "string" && STAGE.test(p.stage) && typeof p.aside === "string" && ASIDE.test(p.aside) && Array.isArray(p.moves) &&
      p.moves.every((m) => Array.isArray(m) && m.length === 2 && ((name(m[0]) && m[1] === join(p.aside, m[0])) || (name(m[1]) && m[0] === join(p.stage, m[1]))));
    return ok ? p : null;
  } catch { return null; }
}
