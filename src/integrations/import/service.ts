// Sessions of other harnesses on this machine: an index of what their stores
// hold (kept in keel-bun's database, refreshed from file sizes and times, so a
// store is walked once and a file is read again only when it changed), a
// preview, and an import that copies a session into a new keel-bun session.
// The source is only read; an import is linked to it, so the next import of
// the same source opens or updates that session instead of making another.
import { existsSync, statSync } from "node:fs";
import type { Store } from "../../core/store.ts";
import type { Session } from "../../core/types.ts";
import { claudeFiles, claudeFound, claudeRoot, readClaude } from "./claude.ts";
import { codexFiles, codexFound, codexHome, readCodex } from "./codex.ts";
import { keelDb, keelSessions, readKeel } from "./keel.ts";
import type { Found, Harness, Read } from "./types.ts";

export const HARNESSES: { harness: Harness; label: string; store: () => string; resume?: string }[] = [
  { harness: "claude", label: "Claude Code", store: claudeRoot },
  { harness: "codex", label: "Codex", store: codexHome },
  { harness: "keel", label: "Keel (Rust)", store: keelDb },
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS import_index (path TEXT PRIMARY KEY, harness TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, found TEXT);
CREATE INDEX IF NOT EXISTS import_index_h ON import_index(harness);
CREATE TABLE IF NOT EXISTS import_links (session_id TEXT PRIMARY KEY, harness TEXT NOT NULL, source_id TEXT NOT NULL, source_path TEXT NOT NULL, items INTEGER NOT NULL, source_size INTEGER NOT NULL, source_mtime INTEGER NOT NULL, imported_ms INTEGER NOT NULL, synced_ms INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS import_links_src ON import_links(harness, source_id);
CREATE TABLE IF NOT EXISTS import_live (session_id TEXT PRIMARY KEY, drive_id TEXT NOT NULL, since_ms INTEGER NOT NULL);
`;

export type Link = { session_id: string; harness: Harness; source_id: string; source_path: string; items: number; source_size: number; source_mtime: number; imported_ms: number; synced_ms: number };

export type ListQuery = { harness?: Harness; q?: string; cwd?: string; show?: string; sort?: "updated" | "size" | "title"; limit?: number; cursor?: number };

const sourceStat = (f: Found) => {
  try { const s = statSync(f.harness === "keel" ? f.path.split("#")[0]! : f.path); return { size: s.size, mtime: Math.round(s.mtimeMs) }; } catch { return null; }
};

const REFRESH_MS = 30_000;

let shared: Imports | undefined;
// One per daemon: the import routes and the take-over share the index and the links.
export const sharedImports = (store: Store) => (shared ??= new Imports(store));

// A model id without its provider and region prefixes: bedrock:global.anthropic.claude-x-5 -> claude-x-5.
const bare = (id: string) => id.replace(/^[\w-]+:/, "").replace(/^(us|eu|apac|global)\./, "").replace(/^(anthropic|openai|google|meta|mistral)\./, "");

// The source's model when a provider lists it, else the owner's default.
export async function modelFor(providers: { models(): Promise<any[]>; defaultModel(): Promise<string | undefined | null> }, f: Found): Promise<string | undefined> {
  const listed = await providers.models().catch(() => []);
  const want = f.model && bare(f.model);
  return (want && (listed as any[]).find((m) => m.id === f.model || bare(m.id) === want)?.id) || (await providers.defaultModel()) || undefined;
}

export class Imports {
  private building: Promise<void> | null = null;
  private builtAt = 0;
  private keelCache: { at: number; rows: Found[] } | null = null;
  complete = false;

  constructor(private store: Store) {
    store.migrate(SCHEMA);
  }

  // Walk the file stores; read only new or changed files. Yields to the event
  // loop between files so the daemon keeps answering.
  refresh(): Promise<void> {
    if (this.building) return this.building;
    this.building = (async () => {
      const db = this.store.db;
      const known = new Map(db.query<{ path: string; size: number; mtime: number }, []>("SELECT path, size, mtime FROM import_index").all().map((r) => [r.path, r]));
      const seen = new Set<string>();
      const put = db.query("INSERT INTO import_index (path, harness, size, mtime, found) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, found = excluded.found");
      let n = 0;
      let walked = 0;
      for (const [harness, files, found] of [["claude", claudeFiles(), claudeFound], ["codex", codexFiles(), codexFound]] as const) {
        for (const f of files) {
          // The walk alone (a stat per file) yields too, not only the reads.
          if (++walked % 1000 === 0) await new Promise((r) => setTimeout(r, 0));
          seen.add(f.path);
          const k = known.get(f.path);
          const mtime = Math.round(f.mtime);
          if (k && k.size === f.size && k.mtime === mtime) continue;
          let row: Found | null = null;
          try { row = found(f.path, f.size, f.mtime); } catch {}
          put.run(f.path, harness, f.size, mtime, row ? JSON.stringify(row) : null);
          if (++n % 200 === 0) await new Promise((r) => setTimeout(r, 0));
        }
      }
      const gone = [...known.keys()].filter((p) => !seen.has(p));
      const del = db.query("DELETE FROM import_index WHERE path = ?");
      for (const p of gone) del.run(p);
      this.complete = true;
      this.builtAt = Date.now();
    })().finally(() => { this.building = null; });
    return this.building;
  }

  invalidate() {
    this.keelCache = null;
  }

  // Up to `ms` of a refresh before answering; the rest goes on in the background.
  // A listing within REFRESH_MS of the last walk (a search typed key by key)
  // reads the index as it is; `force` walks again.
  async fresh(ms = 1000, force = false) {
    if (!force && this.complete && Date.now() - this.builtAt < REFRESH_MS) return;
    const r = this.refresh();
    await Promise.race([r, new Promise((res) => setTimeout(res, ms))]);
  }

  private keel(): Found[] {
    if (this.keelCache && Date.now() - this.keelCache.at < 5000) return this.keelCache.rows;
    let rows: Found[] = [];
    try { rows = keelSessions(); } catch {}
    this.keelCache = { at: Date.now(), rows };
    return rows;
  }

  all(harness?: Harness): Found[] {
    const out: Found[] = [];
    if (!harness || harness !== "keel") {
      const rows = harness
        ? this.store.db.query<{ found: string }, [string]>("SELECT found FROM import_index WHERE found IS NOT NULL AND harness = ?").all(harness)
        : this.store.db.query<{ found: string }, []>("SELECT found FROM import_index WHERE found IS NOT NULL").all();
      for (const r of rows) out.push(JSON.parse(r.found));
    }
    if (!harness || harness === "keel") out.push(...this.keel());
    return out;
  }

  harnesses() {
    const all = this.all();
    return HARNESSES.map((h) => {
      const mine = all.filter((f) => f.harness === h.harness);
      const store = h.store();
      return {
        harness: h.harness, label: h.label, store, installed: existsSync(store),
        total: mine.length, interactive: mine.filter((f) => f.kind === "interactive").length,
      };
    });
  }

  list(q: ListQuery) {
    const words = (q.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const show = new Set((q.show ?? "").split(",").filter(Boolean));
    let rows = this.all(q.harness).filter((f) => {
      if (f.kind !== "interactive" && !show.has("all") && !show.has(f.kind === "subagent" ? "subagents" : "headless")) return false;
      if (q.cwd && f.cwd !== q.cwd) return false;
      if (words.length) {
        const hay = `${f.title} ${f.cwd ?? ""} ${f.first_prompt ?? ""} ${f.last_prompt ?? ""} ${f.id}`.toLowerCase();
        if (!words.every((w) => hay.includes(w))) return false;
      }
      return true;
    });
    const sort = q.sort ?? "updated";
    rows.sort((a, b) => (sort === "size" ? b.size_bytes - a.size_bytes : sort === "title" ? a.title.localeCompare(b.title) : b.updated_ms - a.updated_ms));
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
    const at = q.cursor ?? 0;
    const page = rows.slice(at, at + limit).map((f) => ({ ...f, imported: this.importedAs(f) }));
    return { sessions: page, total: rows.length, next_cursor: at + limit < rows.length ? at + limit : undefined, index: { complete: this.complete, building: !!this.building } };
  }

  find(harness: Harness, id: string): Found | undefined {
    return this.all(harness).find((f) => f.id === id);
  }

  // A transcript named by its path (the drive list knows sessions by their file).
  byPath(path: string, harness?: Harness): Found | undefined {
    const hit = this.store.db.query<{ found: string | null }, [string]>("SELECT found FROM import_index WHERE path = ?").get(path);
    if (hit?.found) return JSON.parse(hit.found);
    let st;
    try { st = statSync(path); } catch { return undefined; }
    const h = harness ?? (/\/rollout-[^/]*\.jsonl$/.test(path) ? "codex" : path.endsWith(".jsonl") ? "claude" : undefined);
    if (h === "claude") return claudeFound(path, st.size, st.mtimeMs) ?? undefined;
    if (h === "codex") return codexFound(path, st.size, st.mtimeMs) ?? undefined;
    return undefined;
  }

  async read(f: Found): Promise<Read> {
    if (f.harness === "claude") return readClaude(f.path);
    if (f.harness === "codex") return readCodex(f.path);
    return readKeel(f.id);
  }

  // The copies told that their original still runs, by the agent view's id of
  // it: the page shows "still runs" with Take over now, a later list settles it.
  liveSource(sessionId: string): { id: string; since_ms: number } | null {
    const r = this.store.db.query<{ drive_id: string; since_ms: number }, [string]>("SELECT drive_id, since_ms FROM import_live WHERE session_id = ?").get(sessionId);
    return r ? { id: r.drive_id, since_ms: r.since_ms } : null;
  }
  liveSources(): { session_id: string; drive_id: string }[] {
    return this.store.db.query<{ session_id: string; drive_id: string }, []>("SELECT session_id, drive_id FROM import_live").all().filter((r) => this.store.session(r.session_id));
  }
  putLive(sessionId: string, driveId: string) {
    this.store.db.query("INSERT INTO import_live (session_id, drive_id, since_ms) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET drive_id = excluded.drive_id").run(sessionId, driveId, Date.now());
  }
  clearLive(sessionId: string) {
    this.store.db.query("DELETE FROM import_live WHERE session_id = ?").run(sessionId);
  }

  links(harness: Harness, id: string): Link[] {
    return this.store.db.query<Link, [string, string]>("SELECT * FROM import_links WHERE harness = ? AND source_id = ? ORDER BY imported_ms DESC").all(harness, id)
      .filter((l) => this.store.session(l.session_id));
  }

  link(sessionId: string): Link | undefined {
    return this.store.db.query<Link, [string]>("SELECT * FROM import_links WHERE session_id = ?").get(sessionId) ?? undefined;
  }

  private importedAs(f: Found) {
    const l = this.links(f.harness, f.id)[0];
    if (!l) return undefined;
    const st = sourceStat(f);
    return { session_id: l.session_id, synced_ms: l.synced_ms, grew: !!st && (st.size !== l.source_size || st.mtime !== l.source_mtime), went_on: this.wentOn(l.session_id) };
  }

  // The copy went on in Keel (a turn taken there, or one running now): the
  // source's later turns would land after its own, so it is not updated.
  wentOn(sessionId: string): boolean {
    return !!this.store.db.query("SELECT 1 FROM events WHERE session_id = ? AND kind = 'turn_start' LIMIT 1").get(sessionId);
  }

  // A new keel-bun session from a source, or the events the source gained
  // since an earlier import appended to that session.
  // `from`: a transcript another machine read (its daemon sent what it read);
  // the link names that machine, and the session's tools run there.
  async import(f: Found, o: { mode?: "new" | "update" | "open"; model: string; workspace: string; title?: string; from?: { machine: string; read: Read } }): Promise<{ action: "created" | "updated" | "opened"; session: Session; imported_events: number; read: Read }> {
    const r = o.from?.read ?? (await this.read(f));
    const st = (o.from ? undefined : sourceStat(f)) ?? { size: f.size_bytes, mtime: f.updated_ms };
    const prior = this.links(f.harness, f.id)[0];
    if (prior && (o.mode === "open" || o.mode === "update")) {
      const s = this.store.session(prior.session_id)!;
      if (o.mode === "open" || r.events.length <= prior.items) return { action: "opened", session: s, imported_events: 0, read: r };
      const more = r.events.slice(prior.items);
      for (const e of more) this.store.append(s.id, e.kind, e.data);
      this.store.db.query("UPDATE import_links SET items = ?, source_size = ?, source_mtime = ?, synced_ms = ? WHERE session_id = ?").run(r.events.length, st.size, st.mtime, Date.now(), s.id);
      return { action: "updated", session: this.store.session(s.id)!, imported_events: more.length, read: r };
    }
    const label = HARNESSES.find((h) => h.harness === f.harness)!.label;
    const s = this.store.createSession({ title: o.title ?? f.title, model: o.model, workspace: o.workspace });
    if (o.from) this.store.db.query("UPDATE sessions SET machine = ? WHERE id = ?").run(o.from.machine, s.id);
    for (const e of r.events) this.store.append(s.id, e.kind, e.data);
    const counts = r.counts;
    const summary = `Imported from ${label}${o.from ? " on another machine" : ""} (${f.id}): ${counts.prompts} prompts, ${counts.assistant_messages} replies, ${counts.tool_calls} tool calls. The original is unchanged.`;
    this.store.append(s.id, "note", { text: [summary, ...r.notes].join(" "), imported: true });
    const now = Date.now();
    this.store.db
      .query("INSERT INTO import_links (session_id, harness, source_id, source_path, items, source_size, source_mtime, imported_ms, synced_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(s.id, f.harness, f.id, o.from ? `${o.from.machine}:${f.path}` : f.path, r.events.length, st.size, st.mtime, now, now);
    return { action: "created", session: this.store.session(s.id)!, imported_events: r.events.length, read: r };
  }
}
