// The helper's memory store: keyed records in SQLite, held in a hash index
// (records.ts) for lookups. The older remembered list (helper_memory: free
// text items with ids) is moved into records once, each under a key made
// from its kind and first words.
import type { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { detect } from "../safety/secrets.ts";
import { fill, itemsAt, keyFor, KEY_CHARS, MEMORY_KINDS, normKey, RecordIndex, shapes, terms, VALUE_CHARS, type MemoryKind, type MemoryRecord, type MemorySource } from "./records.ts";

export type PutInput = { key?: unknown; value?: unknown; text?: unknown; kind?: unknown; aliases?: unknown; topics?: unknown };
type Row = { key: string; value: string; kind: string; aliases: string; topics: string; source: string; ts: number; updated: number; used: number };

// One import reads at most this much of a file and makes at most this many records.
export const IMPORT_BYTES = 8 * 1024 * 1024;
export const IMPORT_RECORDS = 5_000;

const bad = (m: string) => Object.assign(new Error(m), { status: 400 });
const fromRow = (r: Row): MemoryRecord => ({ ...r, kind: r.kind as MemoryKind, source: r.source as MemorySource, aliases: JSON.parse(r.aliases), topics: JSON.parse(r.topics) });

export class Memory {
  readonly index: RecordIndex;

  constructor(readonly db: Database, private changed: () => void = () => {}) {
    db.exec(`CREATE TABLE IF NOT EXISTS helper_records (key TEXT PRIMARY KEY, value TEXT NOT NULL, kind TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]', topics TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL, ts INTEGER NOT NULL, updated INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0)`);
    this.index = new RecordIndex(db.query<Row, []>("SELECT * FROM helper_records").all().map(fromRow));
    this.migrate();
  }

  // The free-text list of before: each item becomes a record and the old table goes.
  private migrate() {
    const old = this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'helper_memory'").get();
    if (!old?.n) return;
    const items = this.db.query<{ id: string; ts: number; updated: number; kind: string; text: string; source: string; used: number }, []>("SELECT * FROM helper_memory ORDER BY ts").all();
    this.db.transaction(() => {
      for (const m of items) {
        const kind = (MEMORY_KINDS as string[]).includes(m.kind) ? (m.kind as MemoryKind) : "fact";
        const key = keyFor(kind, m.text, (k) => this.index.byKey.has(k));
        this.write({ key, value: m.text, kind, aliases: [], topics: [], source: m.source === "owner" ? "owner" : "helper", ts: m.ts, updated: m.updated, used: m.used ?? 0 });
      }
      this.db.exec("DROP TABLE helper_memory");
    })();
  }

  list(): MemoryRecord[] {
    return this.index.all().sort((a, b) => b.updated - a.updated || a.key.localeCompare(b.key, undefined, { numeric: true }));
  }

  private write(r: MemoryRecord) {
    this.db.query("INSERT INTO helper_records (key, value, kind, aliases, topics, source, ts, updated, used) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, kind = excluded.kind, aliases = excluded.aliases, topics = excluded.topics, source = excluded.source, updated = excluded.updated")
      .run(r.key, r.value, r.kind, JSON.stringify(r.aliases), JSON.stringify(r.topics), r.source, r.ts, r.updated, r.used);
    this.index.set(r);
  }

  // One record checked and made ready, not written: a key (given, or made
  // from its kind and first words), one short value, no secret.
  private prepare(p: PutInput, source: MemorySource, prev?: MemoryRecord): MemoryRecord {
    const value = String(p.value ?? p.text ?? prev?.value ?? "").replace(/\s+/g, " ").trim();
    if (!value) throw bad("value is the fact to keep");
    if (value.length > VALUE_CHARS) throw bad(`a record's value is at most ${VALUE_CHARS} characters: keep one fact per record and split the rest under more keys`);
    const kind = (p.kind ?? prev?.kind ?? "fact") as MemoryKind;
    if (!MEMORY_KINDS.includes(kind)) throw bad(`kind is one of ${MEMORY_KINDS.join(", ")}`);
    const aliases = p.aliases === undefined ? prev?.aliases ?? [] : terms(p.aliases);
    const topics = p.topics === undefined ? prev?.topics ?? [] : terms(p.topics);
    if (detect([value, ...aliases].join("\n")).length) throw bad("that looks like a secret (a key, token or password): it is not kept");
    let key = p.key === undefined || p.key === null || p.key === "" ? "" : normKey(p.key);
    if (p.key && !key) throw bad(`key "${String(p.key).slice(0, 40)}" has no letters or digits`);
    if (!key) key = prev?.key ?? keyFor(kind, value, (k) => this.index.byKey.has(k));
    const now = Date.now();
    const old = this.index.byKey.get(key);
    return { key, value, kind, aliases, topics, source: source === "owner" ? "owner" : old?.source === "owner" && source === "helper" ? "owner" : source, ts: old?.ts ?? now, updated: now, used: old?.used ?? 0 };
  }

  // Records written by key (a new key adds, a known one is replaced; a field
  // left out keeps its value). All or none: one bad record writes nothing.
  // An import (`lenient`) skips the records that fail instead, and counts them.
  put(list: PutInput[], source: MemorySource, lenient = false): MemoryRecord[] & { skipped?: number } {
    if (!list.length) throw bad("records is a list of { key, value } to keep");
    const ready: MemoryRecord[] & { skipped?: number } = [];
    let skipped = 0;
    for (const p of list) {
      try {
        const r = this.prepare(p, source, p.key ? this.index.get(String(p.key)) : undefined);
        const at = ready.findIndex((x) => x.key === r.key);
        if (at >= 0) ready[at] = r; else ready.push(r);
      } catch (e) {
        if (!lenient) throw list.length > 1 ? bad(`${String(p.key ?? p.value ?? "").slice(0, 60)}: ${(e as Error).message}`) : e;
        skipped++;
      }
    }
    this.db.transaction(() => { for (const r of ready) this.write(r); })();
    if (ready.length) this.changed();
    ready.skipped = skipped;
    return ready;
  }

  // One record changed by the owner, its key renamed when a new one is given.
  edit(key: string, p: PutInput): MemoryRecord {
    const prev = this.index.get(key);
    if (!prev) throw Object.assign(new Error(`no record ${key}`), { status: 404 });
    const next = this.prepare({ ...p, key: p.key ?? prev.key }, "owner", prev);
    if (next.key !== prev.key && this.index.byKey.has(next.key)) throw bad(`a record ${next.key} exists`);
    this.db.transaction(() => {
      if (next.key !== prev.key) this.drop([prev.key], false);
      this.write({ ...next, ts: prev.ts, used: prev.used });
    })();
    this.changed();
    return this.index.byKey.get(next.key)!;
  }

  drop(keys: string[], notify = true): MemoryRecord[] {
    const out: MemoryRecord[] = [];
    const q = this.db.query("DELETE FROM helper_records WHERE key = ?");
    for (const k of keys) {
      const r = this.index.resolve(k).record;
      if (!r) continue;
      q.run(r.key);
      this.index.remove(r.key);
      out.push(r);
    }
    if (out.length && notify) this.changed();
    return out;
  }

  touch(keys: string[]) {
    const q = this.db.query("UPDATE helper_records SET used = used + 1 WHERE key = ?");
    for (const k of keys) {
      q.run(k);
      const r = this.index.byKey.get(k);
      if (r) r.used++;
    }
  }

  // A JSON or JSON-lines file made into records once, so later turns look a
  // fact up instead of reading the file again. Without `key` and `value`
  // templates it only describes the file: its lists of objects, their size
  // and fields, and a sample item.
  importFile(o: { path: string; cwd: string; items?: string; key?: string; value?: string; aliases?: string[]; topics?: string[]; kind?: string }): { shape?: ReturnType<typeof shapes>; written?: number; skipped?: number; sample?: MemoryRecord[] } {
    const path = isAbsolute(o.path) ? o.path : resolve(o.cwd, o.path);
    const size = statSync(path).size;
    if (size > IMPORT_BYTES) throw bad(`${path} is ${Math.round(size / 1048576)} MB; an import reads at most ${IMPORT_BYTES / 1048576} MB`);
    const text = readFileSync(path, "utf8");
    let doc: unknown;
    try { doc = JSON.parse(text); } catch {
      try { doc = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)); } catch { throw bad(`${path} is neither JSON nor JSON lines`); }
    }
    if (!o.key || !o.value) return { shape: shapes(doc) };
    if (!o.key.includes("{")) throw bad("key is a template naming an item's field, such as mail.label.{id}");
    // The top level is "" (also written as ".", "$" or quoted).
    const at = o.items === undefined ? undefined : String(o.items).replace(/^["'`]+|["'`]+$/g, "").replace(/^\$?\.?$/, "").replace(/^\$\./, "");
    const found = at !== undefined ? itemsAt(doc, at) : itemsAt(doc, shapes(doc, 1)[0]?.path ?? "");
    if (!found) throw bad(`no list of objects at ${o.items ?? "the top"}; call without key and value to see the file's lists`);
    if (found.length > IMPORT_RECORDS) throw bad(`${found.length} items: an import makes at most ${IMPORT_RECORDS} records; pick a narrower list`);
    const list: PutInput[] = [];
    const keys = new Set<string>();
    let skipped = 0;
    let same = 0;
    for (const it of found) {
      const key = fill(o.key, it);
      const value = fill(o.value, it, false);
      if (!key || !value || normKey(key).length >= KEY_CHARS) { skipped++; continue; }
      // Two items under one key would leave only the last: the template must tell them apart.
      if (keys.has(normKey(key))) { same++; continue; }
      keys.add(normKey(key));
      const aliases = (o.aliases ?? []).map((a) => fill(a, it, false)).filter(Boolean);
      list.push({ key, value: value.slice(0, VALUE_CHARS), kind: o.kind ?? "reference", aliases, topics: o.topics ?? [] });
    }
    if (!list.length) throw bad(`no item had every field the templates name (${skipped} skipped)`);
    if (same) throw bad(`${same} of ${found.length} items share a key with another under ${o.key}: nothing imported. Build the key from a field that differs per item (a name with its id, or the id alone)`);
    const written = this.put(list, "import", true);
    return { written: written.length, skipped: skipped + (written.skipped ?? 0), sample: written.slice(0, 3) };
  }
}
