// How long the daemon keeps what only grows: spilled tool output (long
// results, command logs, fetched pages, under <state>/spill) and the usage
// records (one row per model call and per tool call). Nothing is removed
// until the owner has set a retention: both are "never" (0) by default, and
// the page proposes values to accept. What is past a retention is counted
// first (`due`), shown in Settings, and removed by the owner's click or by
// the daily cleanup, which names its time a day ahead.
//
// A setting is read through one guard wherever it is used (`retentionOf`):
// only a whole number of days of at least 1 removes anything. Whatever else a
// hand-edited settings.json holds (-1, 0.5, true, "30") is never, and is
// reported once in Errors by the setting's name. The day's notice holds for
// such an edit too: the values the notice was last given for are kept in the
// state, and a start that reads others puts the next cleanup a day out.
//
// Spilled output goes by its session's last use, not by the file's age: a
// session used yesterday keeps every file it has. A session with a running
// turn or a live command, and a pinned one, keep theirs whatever their age.
// What is removed is written down in the session's spill folder
// (src/tools/spill.ts), so a later read of a removed file says what became
// of it. Usage records of the running month are never removed: the monthly
// spend limit is counted from them.
import type { Dirent } from "node:fs";
import { readdir, rmdir, stat, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ErrorTracker } from "../core/errors.ts";
import type { Store } from "../core/store.ts";
import type { Engine } from "../engine/turn.ts";
import { jobLive, jobsOf } from "../tools/jobs.ts";
import { noteRemoved, REMOVED_NOTE, removedNote } from "../tools/spill.ts";
import { onSettings, registerSettings, settings } from "./settings.ts";

const DAY = 86_400_000;

// 0 is never, and never is the default: a removed key is the default again,
// so never is a value of its own.
const daysOrNever = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
registerSettings(
  "retention",
  { spill_days: 0, usage_days: 0 },
  (v) => (!daysOrNever(v.spill_days) ? "spill_days is a whole number of days, 0 for never" : !daysOrNever(v.usage_days) ? "usage_days is a whole number of days, 0 for never" : undefined),
);

// What the page proposes while nothing is set. Spilled output: 30 days after
// its session was last used, the age the page already offers for deleting
// archived sessions; its command can be run again. Usage records: a year, so
// a month can be set beside the same month a year before.
export const PROPOSED = { spill_days: 30, usage_days: 365 } as const;

// A retention in days as it is acted on: a whole number of at least 1, else 0 (never).
export const daysOf = (v: unknown): number => (Number.isInteger(v) && (v as number) >= 1 ? (v as number) : 0);
const KEYS = ["spill_days", "usage_days"] as const;
export type Days = { spill_days: number; usage_days: number };
// The owner's retention as it is acted on, and which settings hold a value
// that is neither a retention nor never (0, or the key left out).
export function retentionOf(raw: Record<string, unknown> = settings().retention): Days & { invalid: { name: string; value: unknown }[] } {
  const invalid = KEYS.filter((k) => raw[k] !== undefined && raw[k] !== null && raw[k] !== 0 && !daysOf(raw[k])).map((k) => ({ name: `retention.${k}`, value: raw[k] }));
  return { spill_days: daysOf(raw.spill_days), usage_days: daysOf(raw.usage_days), invalid };
}

const TABLES = ["telemetry_calls", "telemetry_tools"] as const;
// Rows removed per step: a step is a few milliseconds (each row also updates
// the usage rollup), and the loop turns between two.
const STEP = 200;

export type Due = {
  // `before_ms`: a session last used before this has spilled output past the
  // setting; a record made before it is past the setting. Null: never.
  // `session_ids`: the sessions whose files were counted; a removal names them.
  spill: { before_ms: number | null; files: number; bytes: number; sessions: number; session_ids: string[]; busy_sessions: number; pinned_sessions: number };
  usage: { before_ms: number | null; calls: number; tools: number };
  // When the daily cleanup next removes what is past the settings.
  next_ms: number;
};
export type Removed = { spill_files: number; spill_bytes: number; usage_calls: number; usage_tools: number };
type Cut = { spill_before_ms?: number | null; usage_before_ms?: number | null; sessions?: string[] };

// The first instant of the running month, as the spend limits count it.
const monthStart = (now: number) => { const d = new Date(now); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };

export class Retention {
  private running?: Promise<Removed>;

  constructor(private store: Store, private engine: Pick<Engine, "isRunning">, private errors: Pick<ErrorTracker, "capture">) {
    store.db.run("CREATE TABLE IF NOT EXISTS admin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // A changed setting is seen for a day before the cleanup acts on it:
    // one saved on the page, and one found in the file at a start.
    this.noticed();
    this.stop = onSettings(() => void this.noticed());
  }
  // Ends its watch of the settings (a hot reload makes a new one).
  readonly stop: () => void;

  // The retention as it is acted on now. A value that is not one is reported, once a value.
  private reported = new Set<string>();
  private now(): Days {
    const r = retentionOf();
    for (const bad of r.invalid) {
      const said = `${bad.name}=${JSON.stringify(bad.value)}`;
      if (this.reported.has(said)) continue;
      this.reported.add(said);
      this.errors.capture("server", new Error(`settings.json: ${bad.name} is ${JSON.stringify(bad.value)}, which is not a whole number of days of at least 1 (0 is never). It is read as never: nothing is removed for it until it is set.`), { at: "retention settings", setting: bad.name });
    }
    return { spill_days: r.spill_days, usage_days: r.usage_days };
  }

  // The day's notice. The values it was last given for are kept in the state
  // (`retention_noticed`; none yet: never, the default). When the retention
  // read now is another one, however it was changed, the next cleanup is a day
  // from now, and the page lists what it will remove until then.
  private noticed(at = Date.now()): Days {
    const cur = this.now();
    const r = this.store.db.query<{ value: string }, []>("SELECT value FROM admin_meta WHERE key = 'retention_noticed'").get();
    let was: Days = { spill_days: 0, usage_days: 0 };
    try { if (r) was = retentionOf(JSON.parse(r.value)); } catch {} // not ours: as if none
    if (was.spill_days !== cur.spill_days || was.usage_days !== cur.usage_days) {
      this.setNext(at + DAY);
      this.store.db.run("INSERT INTO admin_meta (key, value) VALUES ('retention_noticed', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(cur)]);
    }
    return cur;
  }

  private get spillRoot() { return join(this.store.stateDir, "spill"); }

  // When the cleanup next runs: a day after the setting last changed, then
  // daily. With nothing recorded yet it is a day from now.
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

  // The files of sessions last used before `before`, each also last written
  // before it (a command that ended after its session's last turn keeps its
  // log). Left alone: a busy session, a pinned one, a folder no session owns
  // (the Leftovers row removes those), and in every folder the record of a
  // command (jobs/<id>.json, a few hundred bytes: the Terminal panel still
  // lists it) and the note of what was removed. `only`: within these sessions.
  private async spillBefore(before: number, only?: Set<string>) {
    const out = { files: [] as { session: string; path: string; bytes: number }[], sessions: new Set<string>(), busy: 0, pinned: 0 };
    let ids: string[] = [];
    try { ids = await readdir(this.spillRoot); } catch { return out; } // no spill folder yet
    const row = this.store.db.query<{ updated: number; pinned: number | null }, [string]>("SELECT updated, json_extract(settings, '$.pinned_ms') AS pinned FROM sessions WHERE id = ?");
    for (const id of ids) {
      if (only && !only.has(id)) continue;
      const s = row.get(id);
      if (!s || s.updated >= before) continue;
      if (s.pinned) { out.pinned++; continue; }
      if (this.busy(id)) { out.busy++; continue; }
      const dir = join(this.spillRoot, id);
      let entries: Dirent[] = [];
      try { entries = await readdir(dir, { recursive: true, withFileTypes: true }); } catch { continue; } // not a folder, or gone meanwhile
      for (const e of entries) {
        if (!e.isFile()) continue;
        const path = join(e.parentPath ?? (e as unknown as { path: string }).path, e.name);
        const rel = relative(dir, path);
        if (rel === REMOVED_NOTE || /^jobs\/[^/]+\.json$/.test(rel)) continue;
        try {
          const st = await stat(path);
          if (st.mtimeMs < before) { out.files.push({ session: id, path, bytes: st.size }); out.sessions.add(id); }
        } catch {} // gone meanwhile
      }
    }
    return out;
  }

  // What is past the settings now, or past `as` (what the page proposes).
  async due(now = Date.now(), as?: Days): Promise<Due> {
    const s = as ? { spill_days: daysOf(as.spill_days), usage_days: daysOf(as.usage_days) } : this.now();
    const spillCut = s.spill_days ? now - s.spill_days * DAY : null;
    const usageCut = s.usage_days ? Math.min(now - s.usage_days * DAY, monthStart(now)) : null;
    const spill = spillCut === null ? undefined : await this.spillBefore(spillCut);
    const count = (t: string) => (usageCut === null || !this.has(t) ? 0 : this.store.db.query<{ n: number }, [number]>(`SELECT COUNT(*) AS n FROM ${t} WHERE ts < ?`).get(usageCut)!.n);
    return {
      spill: {
        before_ms: spillCut, files: spill?.files.length ?? 0, bytes: spill?.files.reduce((n, f) => n + f.bytes, 0) ?? 0,
        sessions: spill?.sessions.size ?? 0, session_ids: [...(spill?.sessions ?? [])], busy_sessions: spill?.busy ?? 0, pinned_sessions: spill?.pinned ?? 0,
      },
      usage: { before_ms: usageCut, calls: count(TABLES[0]), tools: count(TABLES[1]) },
      next_ms: this.next(),
    };
  }

  // Removes what a listing named: files of the sessions it listed, last used
  // before its instant, and records made before its instant. Neither instant
  // may be later than its setting allows now (and never inside the running
  // month for records); a setting of never removes nothing. One run at a time.
  remove(cut: Cut, now = Date.now()): Promise<Removed> {
    return (this.running ??= this.removeNow(cut, now).finally(() => (this.running = undefined)));
  }

  private async removeNow(cut: Cut, now: number): Promise<Removed> {
    const s = this.now();
    const within = (asked: number | null | undefined, latest: number | null) => (typeof asked === "number" && latest !== null ? Math.min(asked, latest) : null);
    const spillCut = within(cut.spill_before_ms, s.spill_days ? now - s.spill_days * DAY : null);
    const usageCut = within(cut.usage_before_ms, s.usage_days ? Math.min(now - s.usage_days * DAY, monthStart(now)) : null);
    const done: Removed = { spill_files: 0, spill_bytes: 0, usage_calls: 0, usage_tools: 0 };
    if (spillCut !== null) {
      const found = await this.spillBefore(spillCut, cut.sessions ? new Set(cut.sessions) : undefined);
      const dirs = new Set<string>();
      const gone = new Map<string, { names: string[]; bytes: number }>();
      for (const f of found.files) {
        const root = join(this.spillRoot, f.session);
        try {
          await unlink(f.path);
          done.spill_files++;
          done.spill_bytes += f.bytes;
          const g = gone.get(f.session) ?? { names: [], bytes: 0 };
          g.names.push(relative(root, f.path));
          g.bytes += f.bytes;
          gone.set(f.session, g);
          for (let d = join(f.path, ".."); d.length > root.length; d = join(d, "..")) dirs.add(d);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.errors.capture("server", e, { at: "retention", path: f.path });
        }
      }
      // What went is written down where it was: a later read of one of these files says so.
      for (const [id, g] of gone) {
        try { noteRemoved(join(this.spillRoot, id), g.names, g.bytes, s.spill_days, now); } catch (e) { this.errors.capture("server", e, { at: "retention note", session: id }); }
      }
      // Folders the removal emptied, deepest first; one that still holds a file stays.
      for (const d of [...dirs].sort((a, b) => b.length - a.length)) await rmdir(d).catch(() => {});
    }
    if (usageCut !== null) {
      for (const [t, key] of [[TABLES[0], "usage_calls"], [TABLES[1], "usage_tools"]] as const) {
        if (!this.has(t)) continue;
        // The rows named back, not the statement's change count: that one also counts what the rollup's triggers changed.
        const del = this.store.db.query<{ id: number }, [number]>(`DELETE FROM ${t} WHERE id IN (SELECT id FROM ${t} WHERE ts < ? ORDER BY ts LIMIT ${STEP}) RETURNING id`);
        for (;;) {
          const n = del.all(usageCut).length;
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
    const s = this.noticed(now); // a retention not seen for a day yet: its day starts here
    if (now < this.next()) return;
    this.setNext(now + DAY);
    if (!s.spill_days && !s.usage_days) return;
    return this.remove({ spill_before_ms: s.spill_days ? now - s.spill_days * DAY : null, usage_before_ms: s.usage_days ? now - s.usage_days * DAY : null }, now);
  }

  // Which of these paths of a session's spill folder the retention removed.
  removedOf(sessionId: string, paths: string[]): string[] {
    return paths.filter((p) => typeof p === "string" && !!removedNote(p, join(this.spillRoot, sessionId)));
  }
}
