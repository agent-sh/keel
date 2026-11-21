// How long the daemon keeps what only grows: spilled tool output (long
// results, command logs, fetched pages, under <state>/spill) and the usage
// records (one row per model call and per tool call). The owner sets each in
// days, or never (0). What is past it is counted first (`due`), shown in
// Settings, and removed by the owner's click or by the daily cleanup, which
// names its time a day ahead: nothing goes that the page did not list first.
import type { Dirent } from "node:fs";
import { readdir, rmdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ErrorTracker } from "../core/errors.ts";
import type { Store } from "../core/store.ts";
import type { Engine } from "../engine/turn.ts";
import { jobLive, jobsOf } from "../tools/jobs.ts";
import { onSettings, registerSettings, settings } from "./settings.ts";

const DAY = 86_400_000;

// Spilled output: 30 days, the age the page already offers for deleting
// archived sessions. A file that old is long out of every model's context,
// and its command can be run again. Usage records: a year, so a month can be
// set beside the same month a year before; the Usage page itself looks back
// a month. 0 is never (a removed key is the default again, so never is a
// value of its own).
const daysOrNever = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
registerSettings(
  "retention",
  { spill_days: 30, usage_days: 365 },
  (v) => (!daysOrNever(v.spill_days) ? "spill_days is a whole number of days, 0 for never" : !daysOrNever(v.usage_days) ? "usage_days is a whole number of days, 0 for never" : undefined),
);

const TABLES = ["telemetry_calls", "telemetry_tools"] as const;
// Rows removed per step: a step is a few milliseconds, and the loop turns between two.
const STEP = 500;

export type Due = {
  // `before_ms`: what was last touched (a file) or made (a record) before this is past the setting; null when the setting is never.
  spill: { before_ms: number | null; files: number; bytes: number; sessions: number; busy_sessions: number };
  usage: { before_ms: number | null; calls: number; tools: number };
  // When the daily cleanup next removes what is past the settings.
  next_ms: number;
};

export class Retention {
  private running?: Promise<Removed>;

  constructor(private store: Store, private engine: Pick<Engine, "isRunning">, private errors: Pick<ErrorTracker, "capture">) {
    store.db.run("CREATE TABLE IF NOT EXISTS admin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // A changed setting is seen for a day before the cleanup acts on it.
    let was = JSON.stringify(settings().retention);
    this.stop = onSettings((s) => {
      const now = JSON.stringify(s.retention);
      if (now !== was) this.setNext(Date.now() + DAY);
      was = now;
    });
  }
  // Ends its watch of the settings (a hot reload makes a new one).
  readonly stop: () => void;

  private get spillRoot() { return join(this.store.stateDir, "spill"); }

  // When the cleanup next runs. The first time this daemon has the feature
  // that is a day from now: the page lists what is due before any of it goes.
  next(): number {
    const r = this.store.db.query<{ value: string }, []>("SELECT value FROM admin_meta WHERE key = 'retention_next_ms'").get();
    const n = Number(r?.value);
    return Number.isFinite(n) && n > 0 ? n : this.setNext(Date.now() + DAY);
  }
  private setNext(ms: number) {
    this.store.db.run("INSERT INTO admin_meta (key, value) VALUES ('retention_next_ms', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(ms)]);
    return ms;
  }

  // The usage tables are made by the module that writes them.
  private has(table: string) {
    return !!this.store.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  }

  // A session whose files are in use: a turn of it runs, or a command of it is alive.
  private busy(id: string) {
    return !!this.engine.isRunning?.(id) || jobsOf(id).some(jobLive);
  }

  // The files under spill/ last written before `before`, by session folder.
  // A busy session's folder is left out whole.
  private async spillBefore(before: number) {
    const out: { files: { path: string; bytes: number }[]; sessions: Set<string>; busy: number } = { files: [], sessions: new Set(), busy: 0 };
    let ids: string[] = [];
    try { ids = await readdir(this.spillRoot); } catch { return out; } // no spill folder yet
    for (const id of ids) {
      if (this.busy(id)) { out.busy++; continue; }
      let entries: Dirent[] = [];
      try { entries = await readdir(join(this.spillRoot, id), { recursive: true, withFileTypes: true }); } catch { continue; } // not a folder, or gone meanwhile
      for (const e of entries) {
        if (!e.isFile()) continue;
        const path = join(e.parentPath ?? (e as unknown as { path: string }).path, e.name);
        try {
          const st = await stat(path);
          if (st.mtimeMs < before) { out.files.push({ path, bytes: st.size }); out.sessions.add(id); }
        } catch {} // gone meanwhile
      }
    }
    return out;
  }

  // What is past the settings now.
  async due(now = Date.now()): Promise<Due> {
    const s = settings().retention;
    const spillCut = s.spill_days ? now - s.spill_days * DAY : null, usageCut = s.usage_days ? now - s.usage_days * DAY : null;
    const spill = spillCut === null ? undefined : await this.spillBefore(spillCut);
    const count = (t: string) => (usageCut === null || !this.has(t) ? 0 : this.store.db.query<{ n: number }, [number]>(`SELECT COUNT(*) AS n FROM ${t} WHERE ts < ?`).get(usageCut)!.n);
    return {
      spill: { before_ms: spillCut, files: spill?.files.length ?? 0, bytes: spill?.files.reduce((n, f) => n + f.bytes, 0) ?? 0, sessions: spill?.sessions.size ?? 0, busy_sessions: spill?.busy ?? 0 },
      usage: { before_ms: usageCut, calls: count(TABLES[0]), tools: count(TABLES[1]) },
      next_ms: this.next(),
    };
  }

  // Removes what is older than the given instants: the ones a listing named,
  // so what goes is what was listed. Neither may be later than its setting
  // allows now, and a setting of never removes nothing. One run at a time.
  remove(cut: { spill_before_ms?: number | null; usage_before_ms?: number | null }, now = Date.now()): Promise<Removed> {
    return (this.running ??= this.removeNow(cut, now).finally(() => (this.running = undefined)));
  }

  private async removeNow(cut: { spill_before_ms?: number | null; usage_before_ms?: number | null }, now: number): Promise<Removed> {
    const s = settings().retention;
    const within = (asked: number | null | undefined, days: number | null) => (typeof asked === "number" && days ? Math.min(asked, now - days * DAY) : null);
    const spillCut = within(cut.spill_before_ms, s.spill_days), usageCut = within(cut.usage_before_ms, s.usage_days);
    const done: Removed = { spill_files: 0, spill_bytes: 0, usage_calls: 0, usage_tools: 0 };
    if (spillCut !== null) {
      const found = await this.spillBefore(spillCut);
      const dirs = new Set<string>();
      for (const f of found.files) {
        try {
          await unlink(f.path);
          done.spill_files++;
          done.spill_bytes += f.bytes;
          for (let d = join(f.path, ".."); d.length > this.spillRoot.length; d = join(d, "..")) dirs.add(d);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.errors.capture("server", e, { at: "retention", path: f.path });
        }
      }
      // Folders the removal emptied, deepest first; one that still holds a file stays.
      for (const d of [...dirs].sort((a, b) => b.length - a.length)) await rmdir(d).catch(() => {});
    }
    if (usageCut !== null) {
      for (const [t, key] of [[TABLES[0], "usage_calls"], [TABLES[1], "usage_tools"]] as const) {
        if (!this.has(t)) continue;
        const del = this.store.db.query<unknown, [number]>(`DELETE FROM ${t} WHERE id IN (SELECT id FROM ${t} WHERE ts < ? ORDER BY ts LIMIT ${STEP})`);
        for (;;) {
          const n = del.run(usageCut).changes;
          done[key] += n;
          if (n < STEP) break;
          await new Promise((r) => setImmediate(r));
        }
      }
    }
    return done;
  }

  // The daily cleanup: once its time has come, what is past the settings goes, and the next one is a day later.
  async tick(now = Date.now()): Promise<Removed | undefined> {
    if (now < this.next()) return;
    this.setNext(now + DAY);
    const s = settings().retention;
    return this.remove({ spill_before_ms: s.spill_days ? now - s.spill_days * DAY : null, usage_before_ms: s.usage_days ? now - s.usage_days * DAY : null }, now);
  }
}

export type Removed = { spill_files: number; spill_bytes: number; usage_calls: number; usage_tools: number };
