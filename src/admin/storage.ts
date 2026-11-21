// What the daemon keeps on disk, and keeping it in bounds: sizes per kind and
// per session (measured off the request path), deleting old archived sessions
// in two steps (list, then delete what is still that old and unchanged),
// leftovers of deleted sessions, the owner's archive policy, and backups of
// the durable state that are checked when written and can be restored.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { GRANT_FILES, writeOwnFile } from "../core/ownfile.ts";
import type { Bus } from "../core/bus.ts";
import type { ErrorTracker } from "../core/errors.ts";
import type { Store } from "../core/store.ts";
import type { Engine } from "../engine/turn.ts";
import { jobsOf, leftText, jobLive, stopJob, stopJobs } from "../tools/jobs.ts";
import { daysOrNull, registerSettings, settings } from "./settings.ts";
import { readText } from "../core/proc.ts";

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
    const db = this.store.db;
    const rows = db.query<{ id: string; title: string; archived: number; updated: number; parent_id: string | null; bytes: number; attach: number }, []>(`
      SELECT s.id, s.title, s.archived, s.updated, s.parent_id,
        COALESCE((SELECT SUM(length(e.data)) FROM events e WHERE e.session_id = s.id), 0) AS bytes,
        COALESCE((SELECT SUM(length(json_extract(i.value, '$.data'))) FROM events e, json_each(e.data, '$.images') i WHERE e.session_id = s.id AND e.kind = 'user'), 0) AS attach
      FROM sessions s`).all();
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

  // A consistent copy of the database (VACUUM INTO, safe while the daemon
  // writes) and the JSON settings files, checked by opening the copy before it
  // counts: integrity, and the same sessions and events as the source.
  backup(reason: string) {
    // Two backups in the same millisecond get distinct names (-1, -2, ...).
    const base = `keel-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    let stamp = base.slice(5);
    for (let n = 1; existsSync(join(this.backupRoot, `keel-${stamp}`)) || existsSync(join(this.backupRoot, `.keel-${stamp}.partial`)); n++) stamp = `${base.slice(5)}-${n}`;
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
      // Uploaded files the prompts refer to (<state>/attachments/<sha256>/<name>).
      // They never change once written, so a hard link is a full copy at no
      // extra space; another filesystem gets a real copy.
      const att = join(this.dir, "attachments");
      if (existsSync(att)) for (const id of readdirSync(att)) {
        if (!/^[0-9a-f]{64}$/.test(id)) continue;
        for (const name of readdirSync(join(att, id))) {
          mkdirSync(join(tmp, "attachments", id), { recursive: true });
          const from = join(att, id, name), to = join(tmp, "attachments", id, name);
          try { linkSync(from, to); } catch { copyFileSync(from, to); }
          files.push(`attachments/${id}/${name}`);
        }
      }
      const carried = this.config ? this.carryConfig(resolve(this.config), tmp) : null;
      const check = verify(tmp);
      if (!check.ok) throw new Error(`the backup did not check out: ${check.why}`);
      if (check.sessions !== counts.sessions || check.events < counts.events) throw new Error(`the backup holds ${check.sessions} sessions and ${check.events} events, the store ${counts.sessions} and ${counts.events}`);
      const manifest: Manifest = {
        created_ms: Date.now(), reason, sessions: check.sessions, events: check.events,
        files: [
          // First, so a keel from before config was carried stops at once (see OLDER_KEEL).
          ...(carried?.files.length ? [{ name: OLDER_KEEL, bytes: 0, sha256: "", older_keel: true as const }] : []),
          ...files.map((f) => ({ name: f, bytes: statSync(join(tmp, f)).size, sha256: hashFile(join(tmp, f)) })),
          ...(carried?.files ?? []),
        ],
        ...(carried ? { config: { dir: carried.dir, skipped: carried.skipped } } : {}),
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

  // The owner's config folder (MCP servers, hooks, skills, plugins, agents,
  // instructions) goes with the state, under config/: each file at its own
  // mode, in folders only the owner can open, so a copy is never easier to
  // read than its original.
  // A file that is as the newest backup of this folder has it (the same
  // size, time and mode) is a second name for that backup's copy, not a new
  // one: a backup's files are never written again, so sharing them is safe,
  // and an unchanged folder costs a listing. (Never a link to the live file:
  // an editor that writes in place would change the backup with it.)
  // A file that cannot be read, or goes away meanwhile, is left out and
  // named in the manifest: nothing in this folder fails a backup, so nothing
  // in it calls off the restart that waits on one.
  private carryConfig(dir: string, tmp: string) {
    const prev = this.backups().find((b) => !b.unreadable && b.config === dir);
    const was = new Map<string, ManifestFile>();
    if (prev) try {
      for (const f of (JSON.parse(readFileSync(join(prev.path, "manifest.json"), "utf8")) as Manifest).files) if (f.name.startsWith("config/")) was.set(f.name, f);
    } catch {} // nothing to share with
    const { files: listed, skipped } = configFiles(dir);
    const files: ManifestFile[] = [];
    for (const rel of listed) {
      const name = `config/${rel}`, from = join(dir, rel), to = join(tmp, name);
      try {
        const st = lstatSync(from);
        if (!st.isFile()) continue; // became a folder or a link since the listing
        const mode = st.mode & 0o777, old = was.get(name);
        mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
        if (old && old.bytes === st.size && old.mtime_ms === st.mtimeMs && old.mode === mode) {
          try {
            linkSync(join(prev!.path, name), to);
            files.push({ ...old });
            continue;
          } catch {} // another filesystem, or that copy is gone: a real copy
        }
        copyFileSync(from, to);
        chmodSync(to, mode);
        files.push({ name, bytes: statSync(to).size, sha256: hashFile(to), mtime_ms: st.mtimeMs, mode });
      } catch (e) {
        rmSync(to, { force: true });
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") skipped.push({ name: rel, why: (e as Error).message });
      }
    }
    if (skipped.length) this.errors.capture?.("server", new Error(`the backup left out ${skipped.length} config file${skipped.length === 1 ? "" : "s"} it could not read: ${skipped.map((s) => s.name).join(", ")}`), { at: "backup config", dir });
    return { dir, files, skipped };
  }

  private counts(db: Database) {
    return {
      sessions: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions").get()!.n,
      events: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()!.n,
    };
  }

  private prune() {
    const keep = settings().backup.keep as number;
    for (const b of this.backups().filter((b) => !b.unreadable).slice(keep)) rmSync(join(this.backupRoot, b.name), { recursive: true, force: true });
    // A partial copy left by a crash during a backup.
    if (existsSync(this.backupRoot)) for (const d of readdirSync(this.backupRoot)) if (d.endsWith(".partial")) rmSync(join(this.backupRoot, d), { recursive: true, force: true });
  }

  // Every backup folder, newest first. One whose manifest cannot be read is
  // listed as such (its time from the folder name) rather than hiding the
  // others, and is never pruned: nothing says what it holds.
  backups(): Backup[] {
    if (!existsSync(this.backupRoot)) return [];
    return readdirSync(this.backupRoot)
      .filter((d) => d.startsWith("keel-") && existsSync(join(this.backupRoot, d, "manifest.json")))
      .map((name): Backup => {
        const path = join(this.backupRoot, name);
        try {
          const m = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8"));
          if (typeof m.created_ms !== "number" || !Array.isArray(m.files)) throw new Error("it lacks created_ms or files");
          return { name, path, created_ms: m.created_ms, reason: m.reason, sessions: m.sessions, events: m.events, bytes: (m.files as { bytes: number }[]).reduce((n, f) => n + f.bytes, 0), ...(typeof m.config?.dir === "string" ? { config: m.config.dir } : {}) };
        } catch (e) {
          return { name, path, created_ms: stampMs(name), reason: "", sessions: null, events: null, bytes: null, unreadable: `manifest.json cannot be read: ${(e as Error).message}` };
        }
      })
      // By the folder's own stamp (when the backup began, the same clock for a
      // readable manifest and a damaged one), then its -N suffix.
      .sort((a, b) => (stampMs(b.name) ?? b.created_ms ?? 0) - (stampMs(a.name) ?? a.created_ms ?? 0) || order(b.name) - order(a.name));
  }
}

// `config`: the config folder the backup carries files of, when it carries any.
type Backup = { name: string; path: string; created_ms: number | null; reason: string; sessions: number | null; events: number | null; bytes: number | null; unreadable?: string; config?: string };

type ManifestFile = { name: string; bytes: number; sha256: string; mtime_ms?: number; mode?: number; older_keel?: true };
type Manifest = { created_ms: number; reason: string; sessions: number; events: number; files: ManifestFile[]; config?: { dir: string; skipped: { name: string; why: string }[] } };

// A backup that carries config files cannot be restored by a keel from
// before it did (it would take config/ for a state file and stop on it).
// That keel checks every file the manifest lists and says which one is
// missing, so the first entry of such a manifest is this sentence: its
// restore then ends with "the backup cannot be restored: a keel that knows
// ... is missing", the state untouched. This keel skips the entry.
const OLDER_KEEL = "a keel that knows backups with a config folder (this one carries it: restore with the keel that made it, or a newer one)";

// keel-2026-11-19T10-00-00-000Z[-N] -> its time, or null; and its N.
const order = (name: string) => Number(/Z-(\d+)$/.exec(name)?.[1] ?? 0);
const stampMs = (name: string) => {
  const m = /^keel-(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z(?:-\d+)?$/.exec(name);
  const t = m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : NaN;
  return Number.isNaN(t) ? null : t;
};

// The files of a config folder a backup carries, as paths inside it: every
// regular file. Left out: links (what they point at is not the folder's), the
// .prev and .tmp files an edit leaves beside a config file, folders that
// are a tool's own store and not configuration (a name that starts with a
// dot: a clone's history, a virtual environment, a cache; and
// node_modules), and a sign-in (GRANT_FILES): its tokens rotate, so an
// older copy no longer signs in and would replace one that does, and a copy
// in every backup would outlive a sign-out.
// `skipped`: what could not be listed (a folder that cannot be opened).
// Something that went away meanwhile is just not there.
export function configFiles(dir: string, under = "", skipped: { name: string; why: string }[] = []): { files: string[]; skipped: { name: string; why: string }[] } {
  const files: string[] = [];
  const gone = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
  let names: string[] = [];
  try { names = readdirSync(join(dir, under)).sort(); } catch (e) {
    if (under && !gone(e)) skipped.push({ name: `${under}/`, why: (e as Error).message });
  }
  for (const name of names) {
    const rel = under ? join(under, name) : name;
    try {
      const st = lstatSync(join(dir, rel));
      if (st.isDirectory()) { if (!name.startsWith(".") && name !== "node_modules") files.push(...configFiles(dir, rel, skipped).files); }
      else if (st.isFile() && !name.endsWith(".prev") && !name.endsWith(".tmp") && !(under === "" && GRANT_FILES.has(name))) files.push(rel);
    } catch (e) {
      if (!gone(e)) skipped.push({ name: rel, why: (e as Error).message });
    }
  }
  return { files, skipped };
}

// What a backup says of the config files it carries: how many, and the
// folder they were read from (null: none, or a backup from before that was
// written down).
export function backupConfig(backupDir: string): { dir: string | null; files: number } {
  let dir: string | null = null;
  try { dir = (JSON.parse(readFileSync(join(backupDir, "manifest.json"), "utf8")) as Manifest).config?.dir ?? null; } catch {}
  return { dir, files: configFiles(join(backupDir, "config")).files.length };
}

export const shadowDir = (stateDir: string, workspace: string) =>
  join(stateDir, "checkpoints", createHash("sha256").update(workspace).digest("hex").slice(0, 16) + ".git");

// A file's SHA-256, read a megabyte at a time into one buffer: the database
// of a backup can be gigabytes, and so can an upload.
export const HASH_CHUNK = 1024 * 1024;
export function hashFile(path: string, read: typeof readSync = readSync): string {
  const hash = createHash("sha256");
  const buf = Buffer.allocUnsafe(HASH_CHUNK);
  const fd = openSync(path, "r");
  try {
    for (let n = read(fd, buf, 0, buf.length, null); n > 0; n = read(fd, buf, 0, buf.length, null)) hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

// Opens a backup's database read-only and checks it: SQLite's integrity check,
// the files against the manifest, and what it holds.
export function verify(dir: string): { ok: true; sessions: number; events: number } | { ok: false; why: string } {
  const path = join(dir, "keel.db");
  if (!existsSync(path)) return { ok: false, why: "no keel.db in it" };
  const mf = join(dir, "manifest.json");
  if (existsSync(mf)) {
    const m = JSON.parse(readFileSync(mf, "utf8"));
    for (const f of m.files as ManifestFile[]) {
      if (f.older_keel) continue; // a sentence for a keel that cannot restore this backup, not a file
      if (!existsSync(join(dir, f.name))) return { ok: false, why: `${f.name} is missing` };
      const sha = hashFile(join(dir, f.name));
      if (sha !== f.sha256) return { ok: false, why: `${f.name} changed since the backup was made` };
      // An attachment's folder is named by its content's hash.
      const a = /^attachments\/([0-9a-f]{64})\//.exec(f.name);
      if (a && a[1] !== sha) return { ok: false, why: `${f.name} does not match its hash` };
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

// The swap a restore is in the middle of: the names it moves, in order,
// relative to the state folder. Written (and synced) before the first move,
// and removed as soon as the swap is over or undone, before anything else is
// tidied: while it is there, the stage folder is whole.
const PENDING = "restore.pending";
type Pending = { aside: string; stage: string; moves: [from: string, to: string][] };
const STAGE = /^\.restore-[\w-]+\.partial$/;
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
  const check = verify(backupDir);
  if (!check.ok) throw new Error(`the backup cannot be restored: ${check.why}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const aside = `before-restore-${stamp}`, stage = `.restore-${stamp}.partial`;
  const at = (...p: string[]) => join(stateDir, ...p);
  const inBackup = readdirSync(backupDir).filter((f) => f !== "manifest.json" && f !== "attachments" && f !== "config");
  try {
    mkdirSync(at(stage), { recursive: true });
    for (const f of inBackup) copyFileSync(join(backupDir, f), at(stage, f));
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
    throw new Error(`the restore failed and the state is as it was: ${(e as Error).message}`, { cause: e });
  }
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
