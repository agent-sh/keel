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
import { agyHome, agySessions, readAgy } from "./agy.ts";
import { hermesDb, hermesPending, hermesSessions, readHermes } from "./hermes.ts";
import type { Found, Harness, Read } from "./types.ts";
import { haystack, keyHash, kindsOf, offered, order, pageLimit, readCursor, select, wordsOf, writeCursor, type ListQuery } from "./offer.ts";
import * as perm from "../../server/routes/permissions.ts";

export const HARNESSES: { harness: Harness; label: string; store: () => string; resume?: string }[] = [
  { harness: "claude", label: "Claude Code", store: claudeRoot },
  { harness: "codex", label: "Codex", store: codexHome },
  { harness: "keel", label: "Keel (Rust)", store: keelDb },
  { harness: "agy", label: "Antigravity", store: agyHome },
  { harness: "hermes", label: "Hermes", store: hermesDb },
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS import_index (path TEXT PRIMARY KEY, harness TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, found TEXT);
CREATE INDEX IF NOT EXISTS import_index_h ON import_index(harness);
CREATE TABLE IF NOT EXISTS import_links (session_id TEXT PRIMARY KEY, harness TEXT NOT NULL, source_id TEXT NOT NULL, source_path TEXT NOT NULL, items INTEGER NOT NULL, source_size INTEGER NOT NULL, source_mtime INTEGER NOT NULL, imported_ms INTEGER NOT NULL, synced_ms INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS import_links_src ON import_links(harness, source_id);
CREATE TABLE IF NOT EXISTS import_live (session_id TEXT PRIMARY KEY, drive_id TEXT NOT NULL, since_ms INTEGER NOT NULL);
`;

// The version of what the readers record for a file: a row an older reader
// wrote is read again, so a field added later (such as the model) fills in.
const READER_V = 2;

// What a listing filters, orders and counts by, kept beside each file's
// serialized row so a page is found in SQL and only its rows are decoded:
// the source's id, its kind and folder, the sort values, the text the search
// reads (lower case), whether another machine is offered it, and its key's
// hash (what a cursor sums). All of them come from the row by `columns`.
const COLUMNS = ["sid TEXT", "kind TEXT", "cwd TEXT", "title TEXT", "updated_ms REAL", "size_bytes REAL", "hay TEXT", "offered INTEGER", "kh INTEGER"] as const;
const columns = (f: Found | null): (string | number | null)[] =>
  f ? [f.id, f.kind, f.cwd ?? null, f.title, f.updated_ms, f.size_bytes, haystack(f), offered(f) ? 1 : 0, keyHash(f)] : [null, null, null, null, null, null, null, null, null];
const isIndexed = (h?: Harness): h is "claude" | "codex" => h === "claude" || h === "codex";

// A row of the index as a listing orders it, before it is decoded.
type IndexKey = { rowid: number; path: string; harness: Harness; id: string; updated_ms: number; size_bytes: number; title: string };

export type Link = { session_id: string; harness: Harness; source_id: string; source_path: string; items: number; source_size: number; source_mtime: number; imported_ms: number; synced_ms: number; digest: string | null };

// Fleet import links encode the source machine as `<machine>:<absolute path>`.
export const sourceMachine = (path: string) => /^(m[0-9a-f]{8}):\//.exec(path)?.[1];

// What the copy holds of its source, so an update can tell the source went on
// (the same events, more after them) from a source that rewound or switched
// branch (earlier events changed), whose later events must not be appended.
export const digestOf = (events: { kind: string; data: any }[]) => String(Bun.hash(JSON.stringify(events.map((e) => [e.kind, e.data]))));

// An update or an open refused for a reason the owner can act on.
const refuse = (message: string) => Object.assign(new Error(message), { status: 409 });
export const WENT_ON = "the Keel session went on since it was copied, so it is not updated: open it, or make a new copy";

export type { ListQuery } from "./offer.ts";

const sourceStat = (f: Found) => {
  try { const s = statSync(f.harness === "keel" || f.harness === "hermes" ? f.path.split("#")[0]! : f.path); return { size: s.size, mtime: Math.round(s.mtimeMs) }; } catch { return null; }
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
  private agyCache: { at: number; rows: Found[] } | null = null;
  private hermesCache: { at: number; rows: Found[] } | null = null;
  complete = false;
  // How many serialized rows of the index were decoded: a page costs its rows, a lookup one.
  decodes = 0;

  constructor(private store: Store) {
    store.migrate(SCHEMA);
    if (!store.columnExists("import_links", "digest")) store.db.exec("ALTER TABLE import_links ADD COLUMN digest TEXT");
    if (!store.columnExists("import_index", "v")) store.db.exec("ALTER TABLE import_index ADD COLUMN v INTEGER NOT NULL DEFAULT 0");
    for (const c of COLUMNS) if (!store.columnExists("import_index", c.split(" ")[0]!)) store.db.exec(`ALTER TABLE import_index ADD COLUMN ${c}`);
    store.db.exec("CREATE INDEX IF NOT EXISTS import_index_sid ON import_index(harness, sid)");
    // The order the list is read in most (newest first, ties by path): a page is the next rows of this index.
    store.db.exec("CREATE INDEX IF NOT EXISTS import_index_order ON import_index(updated_ms DESC, path, harness, sid)");
    // An index written before these columns: filled once from the rows it holds, no file is read again.
    // A row whose serialized form cannot be read is marked for the walk to read its file again.
    const old = store.db.query<{ path: string; found: string }, []>("SELECT path, found FROM import_index WHERE found IS NOT NULL AND kh IS NULL").all();
    if (old.length) {
      const set = store.db.query(`UPDATE import_index SET ${COLUMNS.map((c) => `${c.split(" ")[0]} = ?`).join(", ")} WHERE path = ?`);
      const again = store.db.query("UPDATE import_index SET found = NULL, v = 0 WHERE path = ?");
      store.db.transaction(() => {
        for (const r of old) {
          let cols: ReturnType<typeof columns> | undefined;
          try { const f = JSON.parse(r.found); if (f && typeof f === "object" && typeof f.id === "string" && typeof f.path === "string") cols = columns(f); } catch {}
          if (cols) set.run(...cols, r.path);
          else again.run(r.path);
        }
      })();
    }
  }

  private decode(found: string): Found {
    this.decodes++;
    return JSON.parse(found);
  }

  // Walk the file stores; read only new or changed files. Yields to the event
  // loop between files so the daemon keeps answering.
  refresh(): Promise<void> {
    if (this.building) return this.building;
    this.building = (async () => {
      const db = this.store.db;
      const known = new Map(db.query<{ path: string; size: number; mtime: number; v: number }, []>("SELECT path, size, mtime, v FROM import_index").all().map((r) => [r.path, r]));
      const seen = new Set<string>();
      let n = 0;
      let walked = 0;
      for (const [harness, files, found] of [["claude", claudeFiles(), claudeFound], ["codex", codexFiles(), codexFound]] as const) {
        for (const f of files) {
          // The walk alone (a stat per file) yields too, not only the reads.
          if (++walked % 1000 === 0) await new Promise((r) => setTimeout(r, 0));
          seen.add(f.path);
          const k = known.get(f.path);
          const mtime = Math.round(f.mtime);
          if (k && k.size === f.size && k.mtime === mtime && k.v === READER_V) continue;
          let row: Found | null = null;
          try { row = found(f.path, f.size, f.mtime); } catch {}
          this.record(f.path, harness, f.size, mtime, row);
          if (++n % 200 === 0) await new Promise((r) => setTimeout(r, 0));
        }
      }
      // Hermes's one database: its prompts read a slice at a time.
      for (let i = 0; i < 10_000; i++) {
        try { hermesSessions(undefined, 40); } catch { break; }
        if (!hermesPending) break;
        await new Promise((r) => setTimeout(r, 0));
      }
      this.hermesCache = null;
      const gone = [...known.keys()].filter((p) => !seen.has(p));
      const del = db.query("DELETE FROM import_index WHERE path = ?");
      for (const p of gone) del.run(p);
      this.complete = true;
      this.builtAt = Date.now();
    })().finally(() => { this.building = null; });
    return this.building;
  }

  // Where the index stands, read without starting a walk: one runs now, a
  // whole one has finished since the index was last emptied, and when.
  status() {
    return { building: !!this.building, complete: this.complete, built_ms: this.builtAt || null };
  }

  // Empty the index and read every file again.
  rebuild(): Promise<void> {
    const emptied = () => { this.store.db.run("DELETE FROM import_index"); this.complete = false; this.builtAt = 0; };
    // A walk under way goes on writing rows: it ends first, then the index is emptied and walked.
    if (this.building) return this.building.then(() => this.rebuild());
    emptied();
    return this.refresh();
  }

  // One file's row of the index: what its reader found (null when it holds no
  // conversation), with the columns a listing reads.
  record(path: string, harness: "claude" | "codex", size: number, mtime: number, row: Found | null) {
    const names = COLUMNS.map((c) => c.split(" ")[0]!);
    this.store.db
      .query(`INSERT INTO import_index (path, harness, size, mtime, found, v, ${names.join(", ")}) VALUES (?, ?, ?, ?, ?, ${READER_V}, ${names.map(() => "?").join(", ")})
        ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, found = excluded.found, v = excluded.v, ${names.map((c) => `${c} = excluded.${c}`).join(", ")}`)
      .run(path, harness, size, mtime, row ? JSON.stringify(row) : null, ...columns(row));
  }

  // One file's row as it is now: a file that changed since the last walk (a
  // session still running) or a row an older reader wrote is read again, so an
  // import takes the model and prompts the file holds today.
  private current(path: string, harness: "claude" | "codex"): Found | undefined {
    let st;
    try { st = statSync(path); } catch { return undefined; }
    const mtime = Math.round(st.mtimeMs);
    const k = this.store.db.query<{ size: number; mtime: number; v: number; found: string | null }, [string]>("SELECT size, mtime, v, found FROM import_index WHERE path = ?").get(path);
    if (k && k.size === st.size && k.mtime === mtime && k.v === READER_V) return k.found ? this.decode(k.found) : undefined;
    let row: Found | null = null;
    try { row = (harness === "claude" ? claudeFound : codexFound)(path, st.size, st.mtimeMs); } catch {}
    this.record(path, harness, st.size, mtime, row);
    return row ?? undefined;
  }

  invalidate() {
    this.keelCache = null;
    this.agyCache = null;
    this.hermesCache = null;
  }

  // Up to `ms` of a refresh before answering; the rest goes on in the background.
  // A listing within REFRESH_MS of the last walk (a search typed key by key)
  // reads the index as it is; `force` walks again.
  async fresh(ms = 1000, force = false) {
    if (!force && this.complete && Date.now() - this.builtAt < REFRESH_MS) return;
    // A walk already under way may have passed a folder before a file landed in
    // it: a forced look waits for that walk and walks again.
    const r = force && this.building ? this.building.then(() => this.refresh()) : this.refresh();
    await Promise.race([r, new Promise((res) => setTimeout(res, ms))]);
  }

  private keel(): Found[] {
    if (this.keelCache && Date.now() - this.keelCache.at < 5000) return this.keelCache.rows;
    let rows: Found[] = [];
    try { rows = keelSessions(); } catch {}
    this.keelCache = { at: Date.now(), rows };
    return rows;
  }

  // Antigravity lists its conversations in its own databases: read like the
  // Rust Keel's, cached for a few seconds.
  private agy(): Found[] {
    if (this.agyCache && Date.now() - this.agyCache.at < 5000) return this.agyCache.rows;
    let rows: Found[] = [];
    try { rows = agySessions(); } catch {}
    this.agyCache = { at: Date.now(), rows };
    return rows;
  }

  // Hermes keeps every session in one database: read like the Rust Keel's.
  private hermes(): Found[] {
    if (this.hermesCache && Date.now() - this.hermesCache.at < 5000) return this.hermesCache.rows;
    let rows: Found[] = [];
    try { rows = hermesSessions(undefined, 50); } catch {}
    this.hermesCache = { at: Date.now(), rows };
    return rows;
  }

  // The sessions of the stores that list themselves (the Rust Keel, Antigravity, Hermes): few, read whole.
  private side(harness?: Harness): Found[] {
    const out: Found[] = [];
    if (!harness || harness === "keel") out.push(...this.keel());
    if (!harness || harness === "agy") out.push(...this.agy());
    if (!harness || harness === "hermes") out.push(...this.hermes());
    return out;
  }

  // Every session, the whole index decoded: for a caller that needs them all
  // (a port of a store). A listing and a lookup read the index's columns instead.
  all(harness?: Harness): Found[] {
    const out: Found[] = [];
    if (!harness || isIndexed(harness)) {
      const rows = harness
        ? this.store.db.query<{ found: string }, [string]>("SELECT found FROM import_index WHERE found IS NOT NULL AND harness = ?").all(harness)
        : this.store.db.query<{ found: string }, []>("SELECT found FROM import_index WHERE found IS NOT NULL").all();
      for (const r of rows) out.push(this.decode(r.found));
    }
    out.push(...this.side(harness));
    return out;
  }

  harnesses() {
    const counted = new Map(this.store.db.query<{ harness: string; total: number; interactive: number }, []>("SELECT harness, COUNT(*) AS total, COALESCE(SUM(kind = 'interactive'), 0) AS interactive FROM import_index WHERE found IS NOT NULL GROUP BY harness").all().map((r) => [r.harness, r]));
    const side = this.side();
    return HARNESSES.map((h) => {
      const mine = side.filter((f) => f.harness === h.harness);
      const store = h.store();
      return {
        harness: h.harness, label: h.label, store, installed: existsSync(store),
        total: (counted.get(h.harness)?.total ?? 0) + mine.length, interactive: (counted.get(h.harness)?.interactive ?? 0) + mine.filter((f) => f.kind === "interactive").length,
      };
    });
  }

  // One page of the list. `offered`: only what this machine gives another
  // one (never a transcript under a credentials folder or name), left out
  // before the rows are counted and cut into pages.
  // The same rows, order, total and cursors as `page` of offer.ts over every
  // session, found without decoding the index: its columns filter, order and
  // count in SQL, the few sessions of the other stores are merged in by the
  // same order, and only the rows of the page are decoded.
  list(q: ListQuery & { offered?: boolean }, max = 500) {
    const db = this.store.db;
    const scope = q.offered ? "offered" : "";
    const limit = pageLimit(q, max);
    const c = readCursor(q, scope);
    const sort = q.sort ?? "updated";
    const cmp = order(sort);
    const side = select(q.offered ? this.side(q.harness).filter(offered) : this.side(q.harness), q);
    const index = { complete: this.complete, building: !!this.building };

    const where = ["found IS NOT NULL"];
    const args: (string | number)[] = [];
    if (q.harness) { where.push("harness = ?"); args.push(q.harness); }
    const kinds = kindsOf(q.show);
    if (kinds) { where.push(`kind IN (${kinds.map(() => "?").join(", ")})`); args.push(...kinds); }
    if (q.cwd) { where.push("cwd = ?"); args.push(q.cwd); }
    for (const w of wordsOf(q.q)) { where.push("instr(hay, ?) > 0"); args.push(w); }
    if (q.offered) where.push("offered = 1");
    const W = where.join(" AND ");
    const KEY = "rowid, path, harness, sid AS id, updated_ms, size_bytes, title";
    const indexed = !q.harness || isIndexed(q.harness);

    // The keys of the page (and how many rows there are, and what lies at or
    // before the cursor), from the index's columns.
    let keys: IndexKey[] = [];
    let total = 0, before = 0, sum = 0, after = 0;
    if (indexed && sort === "title") {
      // A title orders by the locale's rules, which SQLite does not know: the
      // matching rows' keys are ordered here. Their serialized rows stay undecoded.
      const all = db.query<IndexKey & { kh: number }, any[]>(`SELECT ${KEY}, kh FROM import_index WHERE ${W}`).all(...args).sort(cmp);
      total = all.length;
      let at = 0;
      if (c) { let lo = 0, hi = all.length; while (lo < hi) { const mid = (lo + hi) >>> 1; if (cmp(all[mid]!, c.row) > 0) hi = mid; else lo = mid + 1; } at = lo; }
      for (let i = 0; i < at; i++) sum += all[i]!.kh;
      before = at;
      after = total - at;
      keys = all.slice(at, at + limit);
    } else if (indexed) {
      const col = sort === "size" ? "size_bytes" : "updated_ms";
      // After the cursor's row: a lower sort value, or the same one and a later path (then harness and id).
      const AFTER = `(${col} < ? OR (${col} = ? AND (path > ? OR (path = ? AND (harness > ? OR (harness = ? AND sid > ?))))))`;
      const v = c ? (sort === "size" ? c.row.size_bytes : c.row.updated_ms) : 0;
      const at = c ? [v, v, c.row.path, c.row.path, c.row.harness, c.row.harness, c.row.id] : [];
      // One pass counts the rows of the listing and, with a cursor, those at or before it and the sum of their keys.
      const n = c
        ? db.query<{ n: number; b: number; s: number }, any[]>(`SELECT COUNT(*) AS n, COALESCE(SUM(NOT ${AFTER}), 0) AS b, COALESCE(SUM(CASE WHEN NOT ${AFTER} THEN kh END), 0) AS s FROM import_index WHERE ${W}`).get(...at, ...at, ...args)!
        : { ...db.query<{ n: number }, any[]>(`SELECT COUNT(*) AS n FROM import_index WHERE ${W}`).get(...args)!, b: 0, s: 0 };
      total = n.n;
      before = n.b;
      sum = n.s;
      after = total - before;
      // The page itself: the next rows in the list's order. `col <= ?` lets
      // the index of that order start at the cursor instead of at the top.
      // A search reads every row for its words whatever the order: one pass over
      // the table and a sort of the few that match is quicker than the index's row-by-row walk.
      const from = wordsOf(q.q).length ? "import_index NOT INDEXED" : "import_index";
      keys = db.query<IndexKey, any[]>(`SELECT ${KEY} FROM ${from} WHERE ${W}${c ? ` AND ${col} <= ? AND ${AFTER}` : ""} ORDER BY ${col} DESC, path, harness, sid LIMIT ?`).all(...args, ...(c ? [v] : []), ...at, limit);
    }

    // The other stores' sessions take their places by the same order.
    const sideAfter = c ? side.filter((f) => cmp(f, c.row) > 0) : side;
    for (const f of side) if (!sideAfter.includes(f)) sum += keyHash(f);
    before += side.length - sideAfter.length;
    total += side.length;
    const merged = [...keys.map((k) => ({ k, f: undefined as Found | undefined })), ...sideAfter.map((f) => ({ k: f as IndexKey | Found, f }))].sort((a, b) => cmp(a.k, b.k)).slice(0, limit);
    const more = after + sideAfter.length > merged.length;
    // The rows up to the cursor are the ones the pages before gave, or the page says so.
    const changed = !!c && (before !== c.seen || sum !== c.sum);
    for (const m of merged) sum += keyHash(m.k);

    // Only now are the page's rows decoded.
    const take = merged.flatMap((m) => (m.f ? [] : [(m.k as IndexKey).rowid]));
    const found = new Map(take.length ? db.query<{ rowid: number; found: string }, any[]>(`SELECT rowid, found FROM import_index WHERE rowid IN (${take.map(() => "?").join(", ")})`).all(...take).map((r) => [r.rowid, r.found]) : []);
    const sessions = merged.flatMap((m) => { const f = m.f ?? (found.has((m.k as IndexKey).rowid) ? this.decode(found.get((m.k as IndexKey).rowid)!) : undefined); return f ? [{ ...f, imported: this.importedAs(f) }] : []; });
    return {
      sessions, total,
      ...(more && merged.length ? { next_cursor: writeCursor(q, merged.at(-1)!.k, before + merged.length, sum, scope) } : {}),
      ...(changed ? { changed: true as const } : {}),
      index,
    };
  }

  find(harness: Harness, id: string): Found | undefined {
    if (!isIndexed(harness)) return this.side(harness).find((f) => f.id === id);
    // The one row, by its harness and id: no other row is decoded.
    const hit = this.store.db.query<{ path: string; found: string }, [string, string]>("SELECT path, found FROM import_index WHERE harness = ? AND sid = ? AND found IS NOT NULL ORDER BY rowid LIMIT 1").get(harness, id);
    return hit ? this.current(hit.path, harness) ?? this.decode(hit.found) : undefined;
  }

  // A transcript named by its path (the drive list knows sessions by their file).
  // A harness the caller names is checked the same way whether the file was
  // indexed or not: a file of another harness is not read as this one.
  byPath(path: string, harness?: Harness): Found | undefined {
    const hit = this.store.db.query<{ harness: string; found: string | null }, [string]>("SELECT harness, found FROM import_index WHERE path = ?").get(path);
    if (hit?.found) return !harness || hit.harness === harness ? this.current(path, hit.harness as "claude" | "codex") : undefined;
    if (harness === "agy" || path.endsWith("/.system_generated/logs/transcript_full.jsonl")) return this.side("agy").find((f) => f.path === path);
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
    if (f.harness === "agy") return readAgy(f);
    if (f.harness === "hermes") return readHermes(f);
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

  // The copies of a source, newest first. A source id can appear on more
  // than one machine. The link names the source machine even if its copy moves.
  // Local transcripts can also move files: keep the old link when its file is gone.
  links(harness: Harness, id: string, path?: string, machine?: string): Link[] {
    return this.store.db.query<Link, [string, string]>("SELECT * FROM import_links WHERE harness = ? AND source_id = ? ORDER BY imported_ms DESC").all(harness, id)
      .filter((l) => sourceMachine(l.source_path) === machine && this.store.session(l.session_id) &&
        (machine || !path || l.source_path === path || !sourceStat({ harness, path: l.source_path } as Found)));
  }

  link(sessionId: string): Link | undefined {
    return this.store.db.query<Link, [string]>("SELECT * FROM import_links WHERE session_id = ?").get(sessionId) ?? undefined;
  }

  private importedAs(f: Found) {
    const l = this.links(f.harness, f.id, f.path)[0];
    if (!l) return undefined;
    const st = sourceStat(f);
    return { session_id: l.session_id, synced_ms: l.synced_ms, grew: !!st && (st.size !== l.source_size || st.mtime !== l.source_mtime), went_on: this.wentOn(l.session_id) };
  }

  // The copy went on in Keel (a turn taken there, or one running now): the
  // source's later turns would land after its own, so it is not updated.
  wentOn(sessionId: string): boolean {
    return !!this.store.db.query("SELECT 1 FROM events WHERE session_id = ? AND kind = 'turn_start' LIMIT 1").get(sessionId);
  }

  // The source's events at the head of the copy, each at the time the source
  // gives it. One the source does not date takes the time of the one before
  // it (now, when it is the first), so the order in time stays the order of
  // the conversation.
  private copy(sessionId: string, events: Read["events"]) {
    let last: number | undefined;
    for (const e of events) {
      if (Number.isFinite(e.ts) && e.ts > 0) last = e.ts;
      this.store.append(sessionId, e.kind, e.data, undefined, last);
    }
  }

  // A new keel-bun session from a source, or the events the source gained
  // since an earlier import appended to that session.
  // `from`: a transcript another machine read (its daemon sent what it read);
  // the link names that machine, and the session's tools run there.
  // Open never reads the source (the copy stands on its own); `session_id`
  // names which copy when there are several.
  async import(f: Found, o: { mode?: "new" | "update" | "open"; model: string; workspace: string; title?: string; session_id?: string; from?: { machine: string; read: Read } }): Promise<{ action: "created" | "updated" | "opened"; session: Session; imported_events: number; read?: Read }> {
    const copies = this.links(f.harness, f.id, f.path, o.from?.machine);
    const prior = o.session_id ? copies.find((l) => l.session_id === o.session_id) : copies[0];
    if (o.session_id && !prior) throw refuse(`${o.session_id} is not a copy of ${f.id}`);
    if (prior && o.mode === "open") return { action: "opened", session: this.store.session(prior.session_id)!, imported_events: 0 };
    const r = o.from?.read ?? (await this.read(f));
    // The file read now must be the session the listing named: a file replaced
    // by another session since is not copied under the first one's name.
    if (r.found.id !== f.id) throw refuse(`the file now holds another session (${r.found.id}), not ${f.id}: look at the list again`);
    const st = (o.from ? undefined : sourceStat(f)) ?? { size: f.size_bytes, mtime: f.updated_ms };
    // From here to the return nothing waits: what was true before the read
    // (the copies, a copy's head and link) is looked at again, and the events
    // and the link are written as one transaction or not at all.
    if (prior && o.mode === "update") {
      const s = this.store.session(prior.session_id);
      const link = this.link(prior.session_id);
      if (!s || !link) throw refuse("the copy was removed while its original was read");
      // A turn that started while the original was read: its later turns would land after the copy's own.
      if (this.wentOn(s.id)) throw Object.assign(refuse(WENT_ON), { session_id: s.id, reason: "went_on" });
      // Only a source that kept what was copied and went on is updated; one
      // that rewound or switched branch would splice two conversations.
      if (!link.digest) throw Object.assign(refuse("this copy was made before Keel kept a record of what it copied, so an update cannot be checked: open the copy, or make a new one"), { session_id: s.id });
      if (link.digest !== digestOf(r.events.slice(0, link.items)))
        throw Object.assign(refuse("the original changed what was copied before (it rewound or went on another branch), so its later turns are not appended: open the copy, or make a new one"), { session_id: s.id });
      // Nothing new, also when another update took the same events while this one read.
      if (r.events.length <= link.items) return { action: "opened", session: s, imported_events: 0, read: r };
      const more = r.events.slice(link.items);
      this.store.atomic(s.id, () => {
        this.copy(s.id, more);
        this.store.db.query("UPDATE import_links SET items = ?, digest = ?, source_size = ?, source_mtime = ?, synced_ms = ? WHERE session_id = ?").run(r.events.length, digestOf(r.events), st.size, st.mtime, Date.now(), s.id);
      });
      return { action: "updated", session: this.store.session(s.id)!, imported_events: more.length, read: r };
    }
    // A second copy is made only when asked for: an import that found none
    // before its read opens the one another import made meanwhile.
    const made = o.mode === "new" ? undefined : this.links(f.harness, f.id, f.path, o.from?.machine)[0];
    if (made) return { action: "opened", session: this.store.session(made.session_id)!, imported_events: 0, read: r };
    const label = HARNESSES.find((h) => h.harness === f.harness)!.label;
    const found = r.found;
    const id = this.store.db.transaction(() => {
      const s = this.store.createSession({ title: o.title ?? found.title, model: o.model, workspace: o.workspace });
      if (o.from) this.store.db.query("UPDATE sessions SET machine = ? WHERE id = ?").run(o.from.machine, s.id);
      this.copy(s.id, r.events);
      const counts = r.counts;
      const summary = `Imported from ${label}${o.from ? " on another machine" : ""} (${f.id}): ${counts.prompts} prompts, ${counts.assistant_messages} replies, ${counts.tool_calls} tool calls. The original is unchanged.`;
      this.store.append(s.id, "note", { text: [summary, ...r.notes].join(" "), imported: true });
      const now = Date.now();
      this.store.db
        .query("INSERT INTO import_links (session_id, harness, source_id, source_path, items, digest, source_size, source_mtime, imported_ms, synced_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(s.id, f.harness, f.id, o.from ? `${o.from.machine}:${f.path}` : f.path, r.events.length, digestOf(r.events), st.size, st.mtime, now, now);
      // It goes on in the permission mode it ran in at the source (high-risk commands still ask in every mode).
      // Last, so nothing is told of a session that is then undone.
      if (found.perm_mode) perm.gate?.setPerm(s.id, { mode: found.perm_mode });
      return s.id;
    })();
    return { action: "created", session: this.store.session(id)!, imported_events: r.events.length, read: r };
  }
}
