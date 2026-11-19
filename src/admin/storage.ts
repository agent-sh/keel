// What the daemon keeps on disk, and keeping it in bounds: sizes per kind and
// per session (measured off the request path), deleting old archived sessions
// in two steps (list, then delete what is still that old and unchanged),
// leftovers of deleted sessions, the owner's archive policy, and backups of
// the durable state that are checked when written and can be restored.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Bus } from "../core/bus.ts";
import type { ErrorTracker } from "../core/errors.ts";
import type { Store } from "../core/store.ts";
import type { Engine } from "../engine/turn.ts";
import { jobsOf, running, stopJob } from "../tools/jobs.ts";
import { daysOrNull, registerSettings, settings } from "./settings.ts";

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
  const text = await new Response(p.stdout).text();
  await p.exited;
  for (const line of text.split("\n")) {
    const m = /^(\d+)\t(.+)$/.exec(line);
    if (m) out.set(m[2]!, Number(m[1]));
  }
  return out;
}

export type StorageReport = Awaited<ReturnType<Storage["measure"]>>;

export class Storage {
  private last?: StorageReport;
  private measuring?: Promise<StorageReport>;

  constructor(private store: Store, private engine: Engine, private bus: Bus, private errors: ErrorTracker) {}

  get dir() { return this.store.stateDir; }

  report(refresh = false): Promise<StorageReport> {
    if (this.last && !refresh) return Promise.resolve(this.last);
    return (this.measuring ??= this.measure().then((r) => (this.last = r)).finally(() => (this.measuring = undefined)));
  }

  private async measure() {
    const db = this.store.db;
    const rows = db.query<{ id: string; title: string; archived: number; updated: number; parent_id: string | null; bytes: number; attach: number }, []>(`
      SELECT s.id, s.title, s.archived, s.updated, s.parent_id,
        COALESCE((SELECT SUM(length(e.data)) FROM events e WHERE e.session_id = s.id), 0) AS bytes,
        COALESCE((SELECT SUM(length(json_extract(i.value, '$.data'))) FROM events e, json_each(e.data, '$.images') i WHERE e.session_id = s.id AND e.kind = 'user'), 0) AS attach
      FROM sessions s`).all();
    const spillDirs = rows.map((r) => join(this.dir, "spill", r.id));
    const cps = this.checkpointRows();
    const shadowDirs = [...new Set(cps.map((c) => c.shadow))];
    const sizes = await du([...Object.values(DIRS).map((d) => join(this.dir, d)), ...spillDirs, ...shadowDirs]);
    // A folder's checkpoints live in one shadow repository; a session's part is
    // its share of that folder's checkpoints (an estimate: they share objects).
    const perShadow = new Map<string, number>();
    for (const c of cps) perShadow.set(c.shadow, (perShadow.get(c.shadow) ?? 0) + c.n);
    const cpOf = new Map(cps.map((c) => [c.session_id, { count: c.n, bytes: Math.round(((sizes.get(c.shadow) ?? 0) * c.n) / (perShadow.get(c.shadow) || 1)) }]));
    const folders = new Map<string, { workspace: string; bytes: number; checkpoints: number; sessions: number }>();
    for (const c of cps) {
      const f = folders.get(c.shadow) ?? { workspace: c.workspace, bytes: sizes.get(c.shadow) ?? 0, checkpoints: 0, sessions: 0 };
      f.checkpoints += c.n;
      f.sessions++;
      folders.set(c.shadow, f);
    }
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
      checkpoint_folders: [...folders.values()].sort((a, b) => b.bytes - a.bytes),
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
      const refs = [...old.map((r) => `delete ${r}`), ...trees.map((t) => `update refs/keel/keep/${t.id} ${t.tree}`)];
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
    await Promise.all(jobsOf(id).filter(running).map((j) => stopJob(j, "was stopped: its session was deleted")));
    rmSync(join(this.dir, "spill", id), { recursive: true, force: true });
    this.store.deleteSession(id);
    this.bus.emit({ t: "session", session: { ...s, archived: true, phase: "idle" } });
  }

  // Archived sessions archived at least `days` ago (subagents' go with their parent).
  candidates(days: number) {
    const cut = Date.now() - days * DAY;
    return this.store.db
      .query<{ id: string; title: string; updated: number; bytes: number }, [number]>(
        `SELECT s.id, s.title, s.updated, COALESCE((SELECT SUM(length(data)) FROM events e WHERE e.session_id = s.id), 0) AS bytes
         FROM sessions s WHERE s.archived = 1 AND s.parent_id IS NULL AND s.updated <= ? ORDER BY s.updated`,
      )
      .all(cut)
      .map((r) => ({ id: r.id, title: r.title, updated_ms: r.updated, bytes: r.bytes }));
  }

  // Deletes the listed sessions that are still that old and unchanged since listed.
  async cleanup(days: number, list: { id: string; updated_ms: number }[]) {
    const now = new Map(this.candidates(days).map((c) => [c.id, c]));
    const deleted: string[] = [];
    const skipped: { id: string; why: string }[] = [];
    for (const want of list) {
      const c = now.get(want.id);
      if (!c) { skipped.push({ id: want.id, why: this.store.session(want.id) ? "no longer archived that long" : "already gone" }); continue; }
      if (c.updated_ms !== want.updated_ms) { skipped.push({ id: want.id, why: "changed since it was listed" }); continue; }
      // Its subagents' sessions go with it.
      for (const sub of this.store.db.query<{ id: string }, [string]>("SELECT id FROM sessions WHERE parent_id = ?").all(want.id)) await this.removeSession(sub.id);
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

  // A consistent copy of the database (VACUUM INTO, safe while the daemon
  // writes) and the JSON settings files, checked by opening the copy before it
  // counts: integrity, and the same sessions and events as the source.
  backup(reason: string) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const tmp = join(this.backupRoot, `.keel-${stamp}.partial`);
    const final = join(this.backupRoot, `keel-${stamp}`);
    mkdirSync(tmp, { recursive: true });
    try {
      const counts = this.counts(this.store.db);
      this.store.db.run(`VACUUM INTO '${join(tmp, "keel.db").replace(/'/g, "''")}'`);
      const files: string[] = ["keel.db"];
      for (const f of readdirSync(this.dir)) {
        if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
        copyFileSync(join(this.dir, f), join(tmp, f));
        files.push(f);
      }
      const check = verify(tmp);
      if (!check.ok) throw new Error(`the backup did not check out: ${check.why}`);
      if (check.sessions !== counts.sessions || check.events < counts.events) throw new Error(`the backup holds ${check.sessions} sessions and ${check.events} events, the store ${counts.sessions} and ${counts.events}`);
      const manifest = {
        created_ms: Date.now(), reason, sessions: check.sessions, events: check.events,
        files: files.map((f) => ({ name: f, bytes: statSync(join(tmp, f)).size, sha256: createHash("sha256").update(readFileSync(join(tmp, f))).digest("hex") })),
      };
      writeFileSync(join(tmp, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      renameSync(tmp, final);
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
    this.prune();
    this.last = undefined;
    return this.backups().find((b) => b.name === basename(final))!;
  }

  private counts(db: Database) {
    return {
      sessions: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions").get()!.n,
      events: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()!.n,
    };
  }

  private prune() {
    const keep = settings().backup.keep as number;
    for (const b of this.backups().slice(keep)) rmSync(join(this.backupRoot, b.name), { recursive: true, force: true });
    // A partial copy left by a crash during a backup.
    if (existsSync(this.backupRoot)) for (const d of readdirSync(this.backupRoot)) if (d.endsWith(".partial")) rmSync(join(this.backupRoot, d), { recursive: true, force: true });
  }

  backups() {
    if (!existsSync(this.backupRoot)) return [];
    return readdirSync(this.backupRoot)
      .filter((d) => d.startsWith("keel-") && existsSync(join(this.backupRoot, d, "manifest.json")))
      .map((name) => {
        const m = JSON.parse(readFileSync(join(this.backupRoot, name, "manifest.json"), "utf8"));
        return { name, path: join(this.backupRoot, name), created_ms: m.created_ms as number, reason: m.reason as string, sessions: m.sessions as number, events: m.events as number, bytes: (m.files as { bytes: number }[]).reduce((n, f) => n + f.bytes, 0) };
      })
      .sort((a, b) => b.created_ms - a.created_ms);
  }
}

export const shadowDir = (stateDir: string, workspace: string) =>
  join(stateDir, "checkpoints", createHash("sha256").update(workspace).digest("hex").slice(0, 16) + ".git");

// Opens a backup's database read-only and checks it: SQLite's integrity check,
// the files against the manifest, and what it holds.
export function verify(dir: string): { ok: true; sessions: number; events: number } | { ok: false; why: string } {
  const path = join(dir, "keel.db");
  if (!existsSync(path)) return { ok: false, why: "no keel.db in it" };
  const mf = join(dir, "manifest.json");
  if (existsSync(mf)) {
    const m = JSON.parse(readFileSync(mf, "utf8"));
    for (const f of m.files as { name: string; sha256: string }[]) {
      if (!existsSync(join(dir, f.name))) return { ok: false, why: `${f.name} is missing` };
      if (createHash("sha256").update(readFileSync(join(dir, f.name))).digest("hex") !== f.sha256) return { ok: false, why: `${f.name} changed since the backup was made` };
    }
  }
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const r = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
    if (r?.integrity_check !== "ok") return { ok: false, why: `integrity check: ${r?.integrity_check}` };
    const sessions = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions").get()!.n;
    const events = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()!.n;
    return { ok: true, sessions, events };
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  } finally {
    db?.close();
  }
}

// Puts a backup in place of the state (the daemon must be stopped). The
// current files are kept beside it, so a restore can be undone.
export function restore(stateDir: string, backupDir: string) {
  const check = verify(backupDir);
  if (!check.ok) throw new Error(`the backup cannot be restored: ${check.why}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const aside = join(stateDir, `before-restore-${stamp}`);
  mkdirSync(aside, { recursive: true });
  for (const f of ["keel.db", "keel.db-wal", "keel.db-shm"]) if (existsSync(join(stateDir, f))) renameSync(join(stateDir, f), join(aside, f));
  for (const f of readdirSync(backupDir)) {
    if (f === "manifest.json") continue;
    if (f.endsWith(".json") && existsSync(join(stateDir, f))) copyFileSync(join(stateDir, f), join(aside, f));
    copyFileSync(join(backupDir, f), join(stateDir, f));
  }
  return { ...check, aside };
}
