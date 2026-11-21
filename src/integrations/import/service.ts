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
import { select, type ListQuery } from "./offer.ts";
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

  constructor(private store: Store) {
    store.migrate(SCHEMA);
    if (!store.columnExists("import_links", "digest")) store.db.exec("ALTER TABLE import_links ADD COLUMN digest TEXT");
    if (!store.columnExists("import_index", "v")) store.db.exec("ALTER TABLE import_index ADD COLUMN v INTEGER NOT NULL DEFAULT 0");
  }

  // Walk the file stores; read only new or changed files. Yields to the event
  // loop between files so the daemon keeps answering.
  refresh(): Promise<void> {
    if (this.building) return this.building;
    this.building = (async () => {
      const db = this.store.db;
      const known = new Map(db.query<{ path: string; size: number; mtime: number; v: number }, []>("SELECT path, size, mtime, v FROM import_index").all().map((r) => [r.path, r]));
      const seen = new Set<string>();
      const put = this.put();
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
          put.run(f.path, harness, f.size, mtime, row ? JSON.stringify(row) : null);
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

  private put() {
    return this.store.db.query<unknown, [string, string, number, number, string | null]>(
      `INSERT INTO import_index (path, harness, size, mtime, found, v) VALUES (?, ?, ?, ?, ?, ${READER_V}) ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, found = excluded.found, v = excluded.v`,
    );
  }

  // One file's row as it is now: a file that changed since the last walk (a
  // session still running) or a row an older reader wrote is read again, so an
  // import takes the model and prompts the file holds today.
  private current(path: string, harness: "claude" | "codex"): Found | undefined {
    let st;
    try { st = statSync(path); } catch { return undefined; }
    const mtime = Math.round(st.mtimeMs);
    const k = this.store.db.query<{ size: number; mtime: number; v: number; found: string | null }, [string]>("SELECT size, mtime, v, found FROM import_index WHERE path = ?").get(path);
    if (k && k.size === st.size && k.mtime === mtime && k.v === READER_V) return k.found ? JSON.parse(k.found) : undefined;
    let row: Found | null = null;
    try { row = (harness === "claude" ? claudeFound : codexFound)(path, st.size, st.mtimeMs); } catch {}
    this.put().run(path, harness, st.size, mtime, row ? JSON.stringify(row) : null);
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

  all(harness?: Harness): Found[] {
    const out: Found[] = [];
    if (!harness || (harness !== "keel" && harness !== "agy" && harness !== "hermes")) {
      const rows = harness
        ? this.store.db.query<{ found: string }, [string]>("SELECT found FROM import_index WHERE found IS NOT NULL AND harness = ?").all(harness)
        : this.store.db.query<{ found: string }, []>("SELECT found FROM import_index WHERE found IS NOT NULL").all();
      for (const r of rows) out.push(JSON.parse(r.found));
    }
    if (!harness || harness === "keel") out.push(...this.keel());
    if (!harness || harness === "agy") out.push(...this.agy());
    if (!harness || harness === "hermes") out.push(...this.hermes());
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
    const rows = select(this.all(q.harness), q);
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
    const at = q.cursor ?? 0;
    const page = rows.slice(at, at + limit).map((f) => ({ ...f, imported: this.importedAs(f) }));
    return { sessions: page, total: rows.length, next_cursor: at + limit < rows.length ? at + limit : undefined, index: { complete: this.complete, building: !!this.building } };
  }

  find(harness: Harness, id: string): Found | undefined {
    const f = this.all(harness).find((f) => f.id === id);
    return f && (f.harness === "claude" || f.harness === "codex") ? this.current(f.path, f.harness) ?? f : f;
  }

  // A transcript named by its path (the drive list knows sessions by their file).
  // A harness the caller names is checked the same way whether the file was
  // indexed or not: a file of another harness is not read as this one.
  byPath(path: string, harness?: Harness): Found | undefined {
    const hit = this.store.db.query<{ harness: string; found: string | null }, [string]>("SELECT harness, found FROM import_index WHERE path = ?").get(path);
    if (hit?.found) return !harness || hit.harness === harness ? this.current(path, hit.harness as "claude" | "codex") : undefined;
    if (harness === "agy" || path.endsWith("/.system_generated/logs/transcript_full.jsonl")) return this.all("agy").find((f) => f.path === path);
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
        for (const e of more) this.store.append(s.id, e.kind, e.data);
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
      for (const e of r.events) this.store.append(s.id, e.kind, e.data);
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
