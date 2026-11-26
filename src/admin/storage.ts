// What the daemon keeps on disk, and keeping it in bounds: sizes per kind and
// per session (measured off the request path), deleting old archived sessions
// in two steps (list, then delete what is still that old and unchanged),
// leftovers of deleted sessions, the owner's archive policy, and backups of
// the durable state that are checked when written and can be restored.
import { checkpointerOf } from "../core/checkpoint.ts";
import { NOT_EMPTIED, TRIED } from "../core/checkpoint-shared.ts";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeOwnFile } from "../core/ownfile.ts";
import { CHECKED, checkDatabase, checkedOf, configFiles, DB_FILES, listBackups, materialize, syncPath, verify, verifyFiles, type Backup, type BackupDone, type BackupJob, type CheckDone, type CheckJob, type CheckResult, type Checked } from "./backup.ts";
import type { Bus } from "../core/bus.ts";
import type { ErrorTracker } from "../core/errors.ts";
import { gitSync } from "../core/git.ts";
import type { Store } from "../core/store.ts";
import type { OutsideMark } from "../core/types.ts";
import { logOf, witnessed } from "../core/log-pages.ts";
import { storeFd, storePath } from "../core/store-files.ts";
import type { Engine } from "../engine/turn.ts";
import { jobsOf, leftText, jobLive, stopJob, stopJobs } from "../tools/jobs.ts";
import { DEFAULT_RETENTION, retained } from "./retain.ts";
import { daysOrNull, registerSettings, settings } from "./settings.ts";
import { pumpLines, readText, outputOf } from "../core/proc.ts";
import { readsOf } from "../server/reads.ts";
import { timed } from "./stall.ts";

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
  // `keep`: how large a delta may be (at most 1/keep of the store). `recent` and `days`: which backups stay (src/admin/retain.ts).
  { keep: 5, before_restart: true, ...DEFAULT_RETENTION },
  (v) => (!Number.isInteger(v.keep) || v.keep < 1 ? "keep is a whole number of at least 1" : typeof v.before_restart !== "boolean" ? "before_restart is true or false"
    : !Number.isInteger(v.recent) || v.recent < 1 ? "recent is a whole number of at least 1: the newest backups that are kept"
    : !Number.isInteger(v.days) || v.days < 0 || v.days > 366 ? "days is a whole number from 0 to 366: the newest backup of each of that many days is kept" : undefined),
);

// Folders under the state folder by what they hold. Durable state is the
// database and the small JSON files; the rest can be rebuilt or is disposable.
const DIRS = {
  spilled_output_bytes: "spill", checkpoints_bytes: "checkpoints", worktrees_bytes: "worktrees", reports_bytes: "reports", backups_bytes: "backups", plugins_bytes: "plugins",
  memory_transcripts_bytes: "transcripts", uploads_bytes: "attachments", artifacts_bytes: "artifacts", logs_bytes: "logs",
} as const;

// A report older than this is measured again when asked for: what it says is
// what is on disk now, and calls close together share one measurement.
export const REPORT_MAX_AGE_MS = 60_000;

// The state folder whole and each folder directly in it, in one du run, so
// the parts add up to the total: a file with two names (an upload and its
// copy in a backup) is counted once, where du met it first.
async function duTop(dir: string): Promise<{ total: number; dirs: Map<string, number> }> {
  const p = Bun.spawn(["du", "-b", "-d1", "--", dir], { stdout: "pipe", stderr: "ignore" });
  const { out: text } = await outputOf(p);
  const dirs = new Map<string, number>();
  let total = 0;
  for (const line of text.split("\n")) {
    const m = /^(\d+)\t(.+)$/.exec(line);
    if (!m) continue;
    if (m[2] === dir) total = Number(m[1]);
    else dirs.set(basename(m[2]!), Number(m[1]));
  }
  return { total, dirs };
}

async function du(paths: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const have = paths.filter((p) => existsSync(p));
  if (!have.length) return out;
  const p = Bun.spawn(["du", "-sb", "--", ...have], { stdout: "pipe", stderr: "ignore" });
  const { out: text } = await outputOf(p);
  for (const line of text.split("\n")) {
    const m = /^(\d+)\t(.+)$/.exec(line);
    if (m) out.set(m[2]!, Number(m[1]));
  }
  return out;
}

export type StorageReport = Awaited<ReturnType<Storage["measure"]>>;
type OutsideHarness = OutsideMark["harness"];

// The report as a caller is shown it: one not shown the sessions another harness runs (peer-scope.ts blindTo)
// gets every count and size without them, and none of them by name.
export function shownReport(r: StorageReport, sees: boolean) {
  const { outside_share: o, ...rest } = r;
  if (sees) return r;
  const less = (g: { count: number; transcript_bytes: number }, x: { count: number; transcript_bytes: number }) => ({ count: g.count - x.count, transcript_bytes: g.transcript_bytes - x.transcript_bytes });
  return { ...rest, sessions: less(r.sessions, o.sessions), archived_sessions: less(r.archived_sessions, o.archived_sessions), by_session: r.by_session.filter((s) => !s.outside) };
}
// `ext`: a copy of another harness's session (src/integrations/outside/); absent in a scan kept from before it was read.
type ScanRow = { id: string; title: string; archived: number; updated: number; parent_id: string | null; bytes: number; attach: number; ext?: number };
type CheckpointSession = { id: string; title: string; archived: boolean; subagent: boolean; checkpoints: number; checkpoint_bytes: number; updated_ms: number };

// The day's check (Storage.checkNow): how often it is made, how often it is looked at, and how
// soon the check as a restore would take it is begun again after a backup cut it.
const DAY_MS = 24 * 3_600_000;
const DAY_LOOK_MS = 3_600_000;
const DEEP_RETRY_MS = 3_600_000;

export class Storage {
  private last?: StorageReport;
  private measuring?: Promise<StorageReport>;

  // `config`: the owner's config folder, which a backup carries with the state. Named by the daemon; none, none carried.
  // The write-ahead log grows while a backup holds its snapshot (the
  // daemon's writes wait in it). What the file goes back to once it is
  // emptied again is the store's limit (src/core/store.ts), or the
  // checkpoint thread's while that works (src/core/checkpoint.ts): nothing
  // is set here.
  constructor(private store: Store, private engine: Engine, private bus: Bus, private errors: ErrorTracker, private config?: string) {}

  get dir() { return this.store.stateDir; }

  // Something changed what is on disk (a backup, a retention's removal): the sizes of the next report are measured.
  stale() { this.diskStale = true; }
  private diskStale = false;

  // The report. Its sizes on disk (the total and every folder's) are
  // measured again when they are a minute old: one du run, off the loop.
  // What is read from the database (each session's transcript and
  // attachments: every event's length) is read once, and again when asked
  // for with `refresh` or after sessions were deleted; on a large store
  // that read takes seconds.
  // The read of every event is kept with the store, so the first report of
  // a start does not wait for it either (5 s on a store of 300,000 events):
  // it is made from the sessions as they were read last (`scanned_ms` says
  // when) and everything on disk as it is now, and the events are read
  // again behind it, once a start.
  report(refresh = false): Promise<StorageReport> {
    return this.reportOf(refresh).then((r) => this.tagged(r));
  }

  // Which of the largest sessions are copies of another harness's session (src/integrations/outside/), as
  // their rows say now: read at each report, since a report's sessions are kept from an earlier read.
  private tagged(r: StorageReport): StorageReport {
    const ids = r.by_session.map((s) => s.id);
    if (!ids.length) return r;
    let of: Map<string, OutsideHarness>;
    try {
      of = new Map(this.store.db.query<{ id: string; h: OutsideHarness }, [string]>(
        "SELECT id, json_extract(outside, '$.harness') AS h FROM sessions WHERE outside IS NOT NULL AND id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids)).map((x) => [x.id, x.h]));
    } catch { return r; }
    return { ...r, by_session: r.by_session.map((s) => ({ ...s, outside: of.get(s.id) })) };
  }

  private reportOf(refresh: boolean): Promise<StorageReport> {
    if (!this.last && !refresh && !this.rescanned && !this.measuring) {
      this.rescanned = true;
      const kept = this.keptScan();
      if (kept) {
        return (this.measuring = this.measure(kept).then((r) => (this.last = r)).finally(() => {
          this.measuring = undefined;
          // Behind the answer: when it is done the next report has this start's numbers.
          void this.measure().then((r) => { this.last = r; }).catch((e) => this.errors.capture("server", e, { at: "storage report" }));
        }));
      }
    }
    if (this.last && !refresh && !this.diskStale && Date.now() - this.last.measured_ms < REPORT_MAX_AGE_MS) return Promise.resolve(this.last);
    const prev = refresh ? undefined : this.last;
    return (this.measuring ??= (prev ? this.measureDisk(prev) : this.measure()).then((r) => ((this.diskStale = false), (this.last = r))).finally(() => (this.measuring = undefined)));
  }
  private rescanned = false;

  private keptScan(): { scanned_ms: number; rows: ScanRow[] } | undefined {
    try {
      const row = this.store.db.query<{ value: string }, []>("SELECT value FROM admin_meta WHERE key = 'storage_scan'").get();
      const k = row ? (JSON.parse(row.value) as { scanned_ms: number; rows: ScanRow[] }) : undefined;
      return k && typeof k.scanned_ms === "number" && Array.isArray(k.rows) ? k : undefined;
    } catch { return undefined; }
  }

  // The sizes on disk of a report, measured again; the rest of it as it was.
  private async measureDisk(prev: StorageReport): Promise<StorageReport> {
    const top = await duTop(this.dir);
    const dbBytes = ["keel.db", "keel.db-wal", "keel.db-shm"].reduce((n, f) => n + (existsSync(join(this.dir, f)) ? statSync(join(this.dir, f)).size : 0), 0);
    const dirs = Object.fromEntries(Object.entries(DIRS).map(([k, d]) => [k, top.dirs.get(d) ?? 0])) as Record<keyof typeof DIRS, number>;
    return { ...prev, measured_ms: Date.now(), database_bytes: dbBytes, total_bytes: top.total, other_bytes: Math.max(0, top.total - dbBytes - Object.values(dirs).reduce((n, b) => n + b, 0)), ...dirs };
  }

  // `kept`: the sessions as an earlier read of every event found them, in place of that read.
  private async measure(kept?: { scanned_ms: number; rows: ScanRow[] }) {
    // Every event of the store is read for its size: off the loop (src/server/reads.ts).
    const rows = kept?.rows ?? await readsOf(this.store).sql<ScanRow>(`
      SELECT s.id, s.title, s.archived, s.updated, s.parent_id, s.outside IS NOT NULL AS ext,
        COALESCE((SELECT SUM(length(e.data)) FROM events e WHERE e.session_id = s.id), 0) AS bytes,
        COALESCE((SELECT SUM(length(json_extract(i.value, '$.data'))) FROM events e, json_each(e.data, '$.images') i WHERE e.session_id = s.id AND e.kind = 'user'), 0) AS attach
      FROM sessions s`);
    const scanned = kept?.scanned_ms ?? Date.now();
    // Kept with the store (before the folder is measured, so the report still adds up to what is on disk):
    // what the first report of the next start is made from.
    if (!kept) {
      try {
        this.store.migrate("CREATE TABLE IF NOT EXISTS admin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        this.store.db.query("INSERT OR REPLACE INTO admin_meta (key, value) VALUES ('storage_scan', ?)").run(JSON.stringify({ scanned_ms: scanned, rows }));
      } catch (e) { this.errors.capture("server", e, { at: "storage report kept" }); }
    }
    const spillDirs = rows.map((r) => join(this.dir, "spill", r.id));
    const cps = this.checkpointRows();
    const shadowDirs = [...new Set(cps.map((c) => c.shadow))];
    // Two du runs: du counts a file once per run, so a folder measured after
    // its parent in the same run would read as empty.
    const [top, inner] = await Promise.all([duTop(this.dir), du([...spillDirs, ...shadowDirs])]);
    const sizes = new Map([...[...top.dirs].map(([name, n]) => [join(this.dir, name), n] as const), ...inner]);
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
      // When every event was read for the sessions' sizes (the sizes on disk are measured more often: measured_ms).
      scanned_ms: scanned,
      state_dir: this.dir,
      database_bytes: dbBytes,
      // What du says of the whole folder. `other_bytes`: what no kind above
      // names (the settings and listing files, the page, a folder a feature added).
      total_bytes: top.total,
      other_bytes: Math.max(0, top.total - dbBytes - Object.values(dirs).reduce((n, b) => n + b, 0)),
      sessions: group((r) => !r.archived && !r.parent_id),
      archived_sessions: group((r) => !!r.archived && !r.parent_id),
      subagent_sessions: group((r) => !!r.parent_id),
      // What of the two above is copies of another harness's sessions: taken out for a caller not shown them
      // (src/server/routes/admin.ts, peer-scope.ts blindTo).
      outside_share: { sessions: group((r) => !!r.ext && !r.archived && !r.parent_id), archived_sessions: group((r) => !!r.ext && !!r.archived && !r.parent_id) },
      attachments_bytes: Math.round(rows.reduce((n, r) => n + r.attach, 0) * 0.75), // base64 in the store
      ...dirs,
      leftovers: { count: leftovers.length, bytes: [...leftoverSizes.values()].reduce((n, b) => n + b, 0) },
      checkpoint_folders: [...folders.values()].sort((a, b) => b.bytes - a.bytes).map(({ list, ...f }) => ({ ...f, session_list: list })),
      orphan_checkpoints: cps.filter((c) => c.gone).reduce((n, c) => n + c.n, 0),
      by_session: rows
        .map((r) => {
          const spill = sizes.get(join(this.dir, "spill", r.id)) ?? 0;
          const cp = cpOf.get(r.id) ?? { count: 0, bytes: 0 };
          return { id: r.id, title: r.title, archived: !!r.archived, subagent: !!r.parent_id, outside: undefined as OutsideHarness | undefined, transcript_bytes: r.bytes, spill_bytes: spill, checkpoints: cp.count, checkpoint_bytes: cp.bytes, bytes: r.bytes + spill + cp.bytes, updated_ms: r.updated };
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
        const r = timed(() => `running git ${args[0]} on a checkpoint store`, () => gitSync(dir, args, { mode: "own", gitDir: dir, input, timeout: 600_000 }));
        if (r.code !== 0) throw new Error(`git ${args[0]} in ${dir}: ${r.err.trim().slice(0, 300)}`);
        return r.out;
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
    await this.engine.interrupt(id, "delete");
    // Nothing that comes due while its commands are stopped starts a turn in it, and it goes with no turn running.
    await this.engine.whileClosing([id], async () => {
      await Promise.all(jobsOf(id).filter(jobLive).map((j) => stopJob(j, "was stopped: its session was deleted")));
      while (this.engine.isRunning(id)) await this.engine.interrupt(id, "delete");
    });
    if (!this.store.session(id)) return;
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
      // (The owner's archive policy is over the owner's list, which holds the sessions another harness runs.)
      for (const s of this.store.sessions({ outside: true })) {
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
  // A later check that runs gives way to it (a restart waits on its backup):
  // its process is ended, what it had found is kept, and it is asked for
  // again once this process has had the time a restart takes.
  backup(reason: string): Promise<Backup> {
    this.cancelCheck?.();
    this.asked++; // a check that has not begun yet does not begin before this backup
    const run = this.backing.then(() => (this.asked--, this.backupNow(reason, { compare: this.untold || this.compareDue() }) as Promise<Backup>));
    this.backing = run.catch(() => {});
    return run;
  }
  private asked = 0;

  // The backup a restart waits on: the changes since the last full backup,
  // never a full one. The write-ahead log tells which pages changed since the
  // backup before it (src/admin/backup.ts) and only those are read; where it
  // does not (it started again unseen), every page is compared, as a
  // restart's backup always was, so the store as it stood before the restart
  // can still be restored. A full backup (the first one, one whose changes
  // outgrew a delta) is not made here: it is owed, in a note beside the
  // backups, and the daemon that starts after the restart makes it
  // (checkLeft). The note is on the disk before this returns: a restart whose
  // backup can neither be made nor be owed fails here, and is called off.
  // A backup that is being made then is waited for (a compare takes
  // seconds), and the restart's own follows it. Except the full backup the
  // daemon owes from the restart before: that one can take as long as the
  // store is large, the restart does not wait for it, and it stays owed.
  backupQuick(reason: string): Promise<Backup | { owed: string }> {
    this.cancelCheck?.();
    if (this.owing) return Promise.resolve().then(() => this.owe("a full backup was being made when the restart asked for its own"));
    this.asked++;
    const run = this.backing.then(() => (this.asked--, this.backupNow(reason, { quick: true, compare: this.untold })));
    this.backing = run.catch(() => {});
    return run;
  }
  // A full backup the daemon makes by itself (the one owed to the last restart, one made because the
  // changes had grown) is being made, or waits its turn.
  private owing = 0;
  // The newest backup holds a large share of the store as changes: a full one is due.
  private fullDue = false;
  // (From how many pages a delta counts as grown, where a test sets another number: src/admin/backup.ts.)
  grownPages?: number;

  // The note of a backup that is owed to a restart, and its removal once a backup is made.
  private get owedPath() { return join(this.backupRoot, OWED); }
  private owe(why: string): { owed: string } {
    mkdirSync(this.backupRoot, { recursive: true });
    writeFileSync(this.owedPath, JSON.stringify({ since_ms: Date.now(), why }), { mode: 0o600 });
    syncPath(this.owedPath);
    syncPath(this.backupRoot);
    return { owed: why };
  }
  owed(): { since_ms: number; why: string } | undefined {
    try { return JSON.parse(readFileSync(this.owedPath, "utf8")); } catch { return undefined; }
  }

  // What the log told is checked by a compare of every page (the backup
  // made then holds what the compare found, whatever the log told): when as
  // many deltas in a row were made from the log as leave one compared backup
  // among those that are kept, and once a week. Never the backup a restart
  // waits on: the next one that may be slow.
  private compareDue(now = Date.now()): boolean {
    const list = this.backups().filter((b) => !b.unreadable);
    const run = list.findIndex((b) => !b.told);
    const told = run < 0 ? list.length : run;
    if (!told) return false;
    const keep = settings().backup.keep as number;
    return told >= Math.max(1, keep - 1) || now - (list[told]?.created_ms ?? 0) >= COMPARE_EVERY_MS;
  }
  // A compare found pages the log had not named: until the daemon restarts every backup compares.
  private untold = false;

  // `full`: a full backup whatever changed. `quick`: a delta, else it is owed.
  // `compare`: every page is compared, whatever the log told.
  private async backupNow(reason: string, how: { full?: boolean; quick?: boolean; compare?: boolean } = {}): Promise<Backup | { owed: string }> {
    // Two backups in the same millisecond get distinct names (-1, -2, ...).
    const base = `keel-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    let stamp = base.slice(5);
    for (let n = 1; existsSync(join(this.backupRoot, `keel-${stamp}`)) || existsSync(join(this.backupRoot, `.keel-${stamp}.partial`)); n++) stamp = `${base.slice(5)}-${n}`;
    const tmp = join(this.backupRoot, `.keel-${stamp}.partial`);
    const final = join(this.backupRoot, `keel-${stamp}`);
    const db = storePath(this.dir);
    let done: BackupDone;
    try {
      mkdirSync(tmp, { recursive: true });
      // The worker reads the database file itself once the write-ahead log is
      // emptied into it: asked for here, between two writes of the daemon.
      // Without a checkpoint thread the daemon's own connection empties the
      // log, and gives up at once when a reader or a writer is in the way
      // (its usual wait for a lock would hold the loop). The loop is the
      // only writer then, so what the log held is read here before it is
      // emptied, and its end written down (src/core/log-pages.ts). Where a
      // thread exists and does not answer (it is starting, or it failed) it
      // may still write, so nothing is written down: the next backup compares.
      const checkpoint = () => {
        const empty = () => this.store.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
        try { this.store.noWait(() => (checkpointerOf(this.store) ? empty() : witnessed(db, empty))); } catch {} // not emptied: the worker sees that
      };
      // With one, the thread copies the log and holds the daemon's writes back for the worker's snapshot: the loop is not held at all.
      // (The thread reads the log's pages itself, and writes down each of its ends.)
      const viaThread = (gate: Int32Array) => checkpointerOf(this.store)?.snapshot(gate);
      // The read thread's connection would keep the log from being emptied
      // while a read of it runs: its reads are held until the worker has its
      // snapshot (a read already running is waited for, ten seconds at most).
      const release = await readsOf(this.store).hold(READS_HOLD_MS);
      const rowsSeen = logOf(db).newest();
      done = await inWorker<BackupDone>({
        stateDir: this.dir, root: this.backupRoot, tmp, reason, keep: settings().backup.keep,
        ...(how.full ? { full: true as const } : {}), ...(how.quick ? { quick: true as const } : {}), ...(how.compare ? { compare: true as const } : {}),
        ...(rowsSeen !== undefined ? { rowsSeen } : {}), ...(this.config ? { config: resolve(this.config) } : {}), ...(this.grownPages !== undefined ? { grownPages: this.grownPages } : {}),
        // (The thread writes the rows of the log's last frames a moment after the snapshot it held the writes for.)
        ...(checkpointerOf(this.store) ? { logWaitMs: LOG_WAIT_MS } : {}),
      }, { checkpoint, viaThread, snapped: release }).finally(release);
      if (done.owed) {
        rmSync(tmp, { recursive: true, force: true });
        return this.owe(done.owed);
      }
      if (done.skipped.length) this.errors.capture?.("server", new Error(`the backup left out ${done.skipped.length} config file${done.skipped.length === 1 ? "" : "s"} it could not read: ${done.skipped.map((s) => s.name).join(", ")}`), { at: "backup config", dir: done.config });
      // What a backup still does on the loop after its worker: its name
      // (a sync of the folder), and below the removal of older ones.
      timed(() => "giving a backup its name", () => {
        renameSync(tmp, final);
        syncPath(this.backupRoot); // the name itself is on disk
        // The next backup asks the log from this one's place: the rows before it go.
        if (done.forget) logOf(db).forget(done.forget);
      });
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
    // A backup that may read the whole store settles what a restart left owed.
    if (!how.quick) rmSync(this.owedPath, { force: true });
    if (done.missed) this.missed(done.missed, basename(final));
    // The changes since the last full backup have grown: each backup holds them all again. A full
    // one is made soon, by the daemon itself and never while a restart waits (later).
    this.fullDue = !!done.grown;
    await this.prune();
    this.diskStale = true;
    return this.backups().find((b) => b.name === basename(final))!;
  }

  // A compare found pages that changed and that the log had not named since
  // the backup `since`. The backup made now holds them (it compared). The
  // deltas made from what the log told, back from `since` to the last backup
  // that compared, may lack a page: each is marked, never called whole, and
  // nothing more is made from the log by this daemon.
  private missed(m: { pages: number; since: string }, made: string) {
    this.untold = true;
    const list = this.backups();
    const marked: string[] = [];
    for (let i = list.findIndex((b) => b.name === m.since); i >= 0 && i < list.length && list[i]!.told; i++) {
      const why = `the write-ahead log did not name every page that changed (found when the backup ${made} compared every page), so this backup may lack one`;
      try {
        writeFileSync(join(list[i]!.path, CHECKED), JSON.stringify({ checked_ms: Date.now(), ok: false, why } satisfies Checked), { mode: 0o600 });
        syncPath(join(list[i]!.path, CHECKED));
        marked.push(list[i]!.name);
      } catch {}
    }
    this.errors.capture?.("server", new Error(
      `The store's log did not name ${m.pages} page${m.pages === 1 ? "" : "s"} that changed since the backup ${m.since}. The backup ${made} compared every page and holds them. `
      + (marked.length ? `${marked.length === 1 ? `The backup ${marked[0]} was` : `${marked.length} backups (${marked.join(", ")}) were`} made from what the log told and may lack a page: marked, and not counted as whole. ` : "")
      + "Until the daemon restarts every backup compares every page."), { at: "backup pages" });
  }

  // The backups a later check is owed: deltas that were checked for their pages only.
  private unchecked() {
    return this.backups().filter((b) => !b.unreadable && b.kind && b.checked === "pages" && !b.failed && !b.base_missing);
  }

  // The later check, `ms` from now (one timer: a later call moves it).
  checkLater(ms = CHECK_AFTER_BACKUP_MS) {
    if (this.stopped) return;
    clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => {
      this.checkTimer = undefined;
      this.later().catch((e) => this.errors.capture?.("server", e, { at: "backup check" }));
    }, ms);
    this.checkTimer.unref?.();
  }
  // What follows a backup or a start, with nobody waiting: the backup a
  // restart left owed, or the compare that is due; then the check.
  private async later() {
    const owed = this.owed();
    const own = async (reason: string, run: () => Promise<unknown>, said: string) => {
      try { await run(); } catch (e) { this.errors.capture?.("server", new Error(`${said} failed: ${(e as Error).message}`, { cause: e }), { at: "backup" }); }
    };
    if (owed) {
      this.owing++;
      try { await own("after a restart", () => this.backup("after a restart"), "The backup owed to the last restart"); } finally { this.owing--; }
    }
    // (A full backup that is due compares nothing: the compare waits for the changes made over it.)
    if (this.fullDue && !this.stopped) {
      this.owing++;
      const full = () => { const run = this.backing.then(() => this.backupNow("a new full backup", { full: true })); this.backing = run.catch(() => {}); return run; };
      try { await own("a new full backup", full, "The full backup that was due"); } finally { this.owing--; }
    } else if (!owed && this.compareDue()) await own("a compare of every page", () => this.backup("a compare of every page"), "The backup that compares every page");
    await this.checkBackups(true);
  }
  // At a start: backups an earlier process left unchecked (it restarted
  // right after making one, or was killed before its check) are checked
  // soon, so restarts close together do not leave them unchecked for good.
  // And the day's check (checkNow) is looked at once an hour, whether or
  // not a backup is made: a daemon that makes none for days still reads
  // the ones it keeps.
  // And a backup the restart before this start left owed is made then.
  checkLeft() {
    if (this.unchecked().length || this.dayDue() || this.owed() || this.compareDue()) this.checkLater(CHECK_AT_START_MS);
    clearInterval(this.dayTimer);
    this.dayTimer = setInterval(() => { if (!this.checkTimer && this.dayDue()) this.checkLater(0); }, DAY_LOOK_MS);
    this.dayTimer.unref?.();
  }
  private dayTimer?: ReturnType<typeof setInterval>;
  // Whether the day's check has something to do (the same facts checkNow decides from).
  private dayDue(now = Date.now()): boolean {
    const kept = this.backups().filter((b) => !b.unreadable && !b.failed && !b.base_missing);
    if (!kept.length) return false;
    const stamps = kept.map((b) => checkedOf(b.path));
    const last = (k: "deep_ms" | "again_ms") => Math.max(0, ...stamps.map((c) => c?.[k] ?? 0));
    return (now - last("deep_ms") >= DAY_MS && now - this.deepTried() >= DEEP_RETRY_MS) || (kept.length > 1 && now - last("again_ms") >= DAY_MS);
  }
  // When the check as a restore would take it was last begun (kept beside the backups: a restart does not forget it).
  private deepTried(set?: number): number {
    const path = join(this.backupRoot, ".deep-tried");
    if (set !== undefined) { try { writeFileSync(path, String(set), { mode: 0o600 }); } catch {} return set; }
    try { return Number(readFileSync(path, "utf8")) || 0; } catch { return 0; }
  }
  // No check is started or left running by this one (a hot reload makes another).
  stopChecks() {
    this.stopped = true;
    clearInterval(this.dayTimer);
    clearTimeout(this.checkTimer);
    this.checkTimer = undefined;
    this.cancelCheck?.();
  }
  private stopped = false;
  private checkTimer?: ReturnType<typeof setTimeout>;
  private cancelCheck?: () => void;

  // The check that follows a backup (src/admin/backup.ts says which backup
  // was checked for what), all of it in a process of its own
  // (backup-check.ts): SQLite's integrity check of the store as it is now,
  // then each kept backup that was not read back whole yet. Each result is
  // written beside its manifest as it comes.
  // - A backup that does not read back is marked, and so is its full backup
  //   when that is what is damaged; nothing more is built on that full
  //   backup, and a full backup is made at once, so a backup known whole
  //   exists again without waiting for the next restart.
  // - A store that fails SQLite's check: every delta of this run is marked
  //   with that (never called whole), and no full backup is tried: it would
  //   be refused for the same reason.
  // Either is reported in Errors once a run. Run a while after a start that
  // finds backups unchecked, after a backup that was asked for, and never
  // while a restart waits: a backup that is asked for ends it (`cut`).
  // `day`: with the day's check when it is due (the timers ask for it; see checkNow).
  checkBackups(day = false): Promise<{ checked: number; failed: string[]; store_ok: boolean | null; full?: string; cut?: true }> {
    const run = this.backing.then(() => this.checkNow(day));
    this.backing = run.catch(() => {});
    return run;
  }

  private async checkNow(day: boolean): Promise<{ checked: number; failed: string[]; store_ok: boolean | null; full?: string; cut?: true }> {
    const unchecked = this.unchecked();
    // The day's check, besides the backups that wait to be called whole.
    // Both read backups that were known whole: a file that went bad on the
    // disk since is found within days, not at the restore that needs it.
    // - The kept backup read longest ago is read back to its hash again,
    //   one a day: every kept backup in turn, with nothing written.
    // - The newest backup, of whatever kind, is checked as a restore would
    //   take it (written out, SQLite's check, its counts): that costs the
    //   store's size in writes, so it is made once a day, last in the run
    //   (a backup that cuts the run cuts only it), and after a cut not
    //   again within the hour, however many backups are made meanwhile.
    const now = Date.now();
    const kept = this.backups().filter((b) => !b.unreadable && !b.failed && !b.base_missing);
    const stamp = new Map(kept.map((b) => [b.path, checkedOf(b.path)]));
    const last = (k: "deep_ms" | "again_ms") => Math.max(0, ...kept.map((b) => stamp.get(b.path)?.[k] ?? 0));
    const readAt = (b: Backup) => Math.max(stamp.get(b.path)?.checked_ms ?? 0, b.created_ms ?? 0);
    const waits = (b: Backup) => unchecked.some((u) => u.path === b.path);
    const newest = [...kept].sort((x, y) => (y.created_ms ?? 0) - (x.created_ms ?? 0))[0];
    const deep = day && newest && now - last("deep_ms") >= DAY_MS && now - this.deepTried() >= DEEP_RETRY_MS ? newest : undefined;
    const again = day && now - last("again_ms") >= DAY_MS ? kept.filter((b) => !waits(b) && b.path !== deep?.path).sort((x, y) => readAt(x) - readAt(y))[0] : undefined;
    const due = [...unchecked.filter((b) => b.path !== deep?.path), ...(again ? [again] : []), ...(deep ? [deep] : [])];
    if (!due.length) return { checked: 0, failed: [], store_ok: null };
    // Again once the backup it gives way to is made, where its restart did not come.
    const cut = (checked: number) => {
      if (checked) this.diskStale = true;
      this.checkLater(CHECK_AFTER_BACKUP_MS);
      return { checked, failed: [], store_ok: null, cut: true as const };
    };
    if (this.asked) return cut(0);
    const write = (dir: string, c: Checked) => {
      if (!existsSync(join(dir, "manifest.json"))) return; // pruned meanwhile
      // (What an earlier check found of it stays: when it was last read as a restore would, and read again.)
      const had = checkedOf(dir);
      writeFileSync(join(dir, CHECKED), JSON.stringify({ ...(had?.deep_ms ? { deep_ms: had.deep_ms } : {}), ...(had?.again_ms ? { again_ms: had.again_ms } : {}), ...c }), { mode: 0o600 });
      syncPath(join(dir, CHECKED));
    };
    let checked = 0;
    // (A backup that failed has no stamp of a check it passed.)
    const part = (r: CheckResult) => {
      checked++;
      const at = Date.now();
      write(r.dir, { checked_ms: at, ok: r.ok, ...(r.why ? { why: r.why } : {}), ...(r.ok && r.deep ? { deep_ms: at } : {}), ...(r.ok && r.dir === again?.path ? { again_ms: at } : {}) });
    };
    let done: CheckDone;
    try {
      if (deep) this.deepTried(now);
      // (The store's own check goes with the backups that wait to be called whole: a run made for the day's check alone does not repeat it.)
      const known = [again, deep].filter((b): b is Backup => !!b && !waits(b)).map((b) => b.path);
      done = await checkInProcess({ check: due.map((b) => b.path), ...(unchecked.length ? { stateDir: this.dir } : {}), ...(deep ? { deep: deep.path } : {}), ...(known.length ? { known } : {}) }, part, (end) => (this.cancelCheck = end));
    } catch (e) {
      if (!(e instanceof Cancelled)) throw e;
      return cut(checked);
    } finally {
      this.cancelCheck = undefined;
    }
    const failed = done.backups.filter((r) => !r.ok);
    for (const b of done.bases) if (!b.ok) write(b.dir, { checked_ms: Date.now(), ok: false, ...(b.why ? { why: b.why } : {}) });
    this.diskStale = true;
    const names = failed.map((r) => basename(r.dir));
    let full: Backup | undefined;
    if (done.store && !done.store.ok) {
      this.errors.capture?.("server", new Error(`the database did not pass SQLite's integrity check: ${done.store.why}. ${names.length === 1 ? `The backup ${names[0]} holds` : `${names.length} backups (${names.join(", ")}) hold`} its pages as they were and may hold the damage: marked, and not counted as whole. No full backup can be made of the database as it is: one is refused, and so is a restart that waits on it.`), { at: "backup check" });
    } else if (failed.length) {
      let why: string | undefined;
      try { full = (await this.backupNow("after a backup failed its check", { full: true })) as Backup; } catch (e) { why = (e as Error).message; }
      const whole = this.backups().find((b) => b.newest_whole)?.name;
      this.errors.capture?.("server", new Error(
        `${names.length === 1 ? `the backup ${names[0]} does` : `${names.length} backups (${names.join(", ")}) do`} not read back: ${failed[0]!.why}. `
        + (full ? `A full backup was made now: ${full.name}.` : `A full backup could not be made now: ${why}. ${whole ? `The newest backup known whole is ${whole}.` : "No backup is known whole."}`)), { at: "backup check" });
    }
    return { checked: done.backups.length, failed: names, store_ok: done.store?.ok ?? null, ...(full ? { full: full.name } : {}) };
  }

  // What is not kept (src/admin/retain.ts) is removed off the loop: a backup holds files of gigabytes, whose
  // unlinking takes the disk's time.
  private async prune() {
    const { recent, days } = settings().backup as { recent: number; days: number };
    const list = this.backups().filter((b) => !b.unreadable);
    const keep = retained(list, Date.now(), { recent, days });
    const gone = list.filter((b) => !keep.has(b.name)).map((b) => b.name);
    // A partial copy left by a crash during a backup.
    if (existsSync(this.backupRoot)) for (const d of readdirSync(this.backupRoot)) if (d.endsWith(".partial")) gone.push(d);
    await Promise.all(gone.map((n) => rm(join(this.backupRoot, n), { recursive: true, force: true }).catch((e) => this.errors.capture?.("server", e, { at: "removing an older backup", name: n }))));
    return gone.length;
  }

  backups(): Backup[] { return listBackups(this.backupRoot); }
}

// Set by the build: the worker's bundle as text. The binary has no source
// file to start a worker from; run from source, the worker is its file.
declare const __KEEL_BACKUP_WORKER_JS__: string | undefined;

// A backup's worker, or a check's process, that gives no answer in this
// long is ended. (The slowest backup measured on a 1.7 GB store under load
// took two and a half minutes; the limit is ten times that.)
const WORKER_MS = 30 * 60_000;
const HOLD_MS = 25;
const READS_HOLD_MS = 10_000;
// The later check, after a start that finds backups an earlier process left
// unchecked: once the turns the start continued have their requests out.
const CHECK_AT_START_MS = 20_000;
// And after a backup made by this process: a restart that waited on it has
// ended the process long before, so the check runs only where none came.
const CHECK_AFTER_BACKUP_MS = 120_000;
// How long a backup waits for the rows of the log's last frames, which the checkpoint thread writes right after the snapshot.
const LOG_WAIT_MS = 500;
// The note of a backup owed to a restart, beside the backups.
const OWED = ".owed";
// A compare of every page at least this often, while deltas are made from what the log tells.
const COMPARE_EVERY_MS = 7 * DAY;
// A check that was ended for a backup: not a failure.
class Cancelled extends Error {}

// The later check in a process of its own (backup-check.ts says why not a
// thread): this program again, with the job on its stdin. `part`: one
// backup's result, as it comes. `cancel` is given what ends it at once; the
// promise then fails with Cancelled.
async function checkInProcess(job: CheckJob, part: (r: CheckResult) => void, cancel: (end: () => void) => void): Promise<CheckDone> {
  // The binary is its own program; run from source, the program is main.ts.
  const self = typeof __KEEL_BACKUP_WORKER_JS__ === "string" ? [process.execPath] : [process.execPath, fileURLToPath(new URL("../main.ts", import.meta.url))];
  const p = Bun.spawn([...self, "backup-check"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let cancelled = false;
  cancel(() => { cancelled = true; p.kill("SIGKILL"); });
  const limit = setTimeout(() => p.kill("SIGKILL"), WORKER_MS);
  try {
    p.stdin.write(JSON.stringify(job));
    await p.stdin.end();
    const said = readText(p.stderr).catch(() => "");
    let done: CheckDone | undefined, failed: string | undefined;
    await pumpLines(p.stdout, (line) => {
      if (!line || cancelled) return; // a line the end cut is not read
      const m = JSON.parse(line) as { t: "part"; part: CheckResult } | { t: "done"; done: CheckDone } | { t: "failed"; error: string };
      if (m.t === "part") part(m.part);
      else if (m.t === "done") done = m.done;
      else failed = m.error;
    }, "backup check").catch((e) => { if (!cancelled) throw e; });
    const code = await p.exited;
    if (cancelled) throw new Cancelled("ended for a backup");
    if (done) return done;
    throw new Error(failed ?? `the backup check ended without an answer (${p.signalCode ?? `exit ${code}`})${(await said).trim() ? `: ${(await said).trim().slice(-300)}` : ""}`);
  } finally {
    clearTimeout(limit);
  }
}

// Runs a backup in a worker of its own and ends the worker. A worker that
// dies without an answer, or gives none within WORKER_MS, fails the job: a
// restart that waits on its backup is then called off, not left waiting.
// `checkpoint`: asked by the worker, to empty the log.
// `snapped`: called once the worker has tried its snapshot (it has it, or will make the backup from a copy).
function inWorker<T>(job: BackupJob, on: { checkpoint?: () => void; viaThread?: (gate: Int32Array) => Promise<boolean> | undefined; snapped?: () => void } = {}): Promise<T> {
  const { checkpoint, viaThread, snapped } = on;
  return new Promise((ok, fail) => {
    const built = typeof __KEEL_BACKUP_WORKER_JS__ === "string" ? URL.createObjectURL(new Blob([__KEEL_BACKUP_WORKER_JS__], { type: "text/javascript" })) : undefined;
    const w = new Worker(built ?? new URL("./backup-worker.ts", import.meta.url).href);
    const end = (f: () => void) => {
      clearTimeout(limit);
      w.terminate();
      if (built) URL.revokeObjectURL(built);
      f();
    };
    const limit = setTimeout(() => end(() => fail(new Error(`the backup worker gave no answer in ${WORKER_MS / 60_000} minutes`))), WORKER_MS);
    // The worker takes its snapshot between two writes of the daemon: the
    // log is emptied here, and the daemon holds still until the worker has
    // its read transaction (never longer than HOLD_MS, after which the
    // worker finds out by itself and asks again).
    const gate = new Int32Array(new SharedArrayBuffer(4));
    w.onmessage = (e: MessageEvent<{ t: "checkpoint" } | { t: "done"; done: T } | { t: "failed"; error: string }>) => {
      const m = e.data;
      if (m.t === "checkpoint") {
        const held = viaThread?.(gate);
        if (held) { void held.then(() => { if (Atomics.load(gate, 0) === TRIED) snapped?.(); }); return; }
        // No checkpoint thread: the one part of a backup the loop is held for, named should it be long (src/admin/stall.ts).
        timed(() => "emptying the store's log and holding still for a backup's snapshot", () => {
          checkpoint?.();
          Atomics.store(gate, 0, NOT_EMPTIED);
          Atomics.notify(gate, 0);
          Atomics.wait(gate, 0, NOT_EMPTIED, HOLD_MS);
        });
        if (Atomics.load(gate, 0) === TRIED) snapped?.();
      } else end(() => (m.t === "done" ? ok(m.done) : fail(new Error(m.error))));
    };
    w.onerror = (e) => end(() => fail(new Error(`the backup worker failed: ${e.message}`)));
    // The database file is read through this process's kept descriptor (src/core/store-files.ts):
    // a thread made per backup opens none of its own. No file yet: the worker's read fails as it did.
    let dbFd: number | undefined, shmFd: number | undefined, walFd: number | undefined;
    try { dbFd = storeFd(storePath(job.stateDir)); } catch {}
    try { shmFd = storeFd(`${storePath(job.stateDir)}-shm`); } catch {}
    try { walFd = storeFd(`${storePath(job.stateDir)}-wal`); } catch {}
    w.postMessage({ job: { ...job, dbFd, shmFd, walFd }, gate });
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
    for (const f of copied) { copyFileSync(join(backupDir, f), at(stage, f)); syncPath(at(stage, f)); }
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
    syncPath(at(stage));
    mkdirSync(at(aside), { recursive: true });
    for (const [from, to] of pending.moves) renameSync(at(from), at(to));
    // The renames themselves on disk before the note of the swap goes.
    syncPath(at(aside));
    syncPath(stateDir);
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
