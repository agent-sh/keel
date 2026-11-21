// What an import does when something goes wrong in the middle or two things
// happen at once: no page can make a write fail half way, or start a turn
// while a transcript is being read.
import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ListQuery } from "./offer.ts";
import type { Found } from "./types.ts";

const root = mkdtempSync(join(tmpdir(), "keel-import-service-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
// Nothing of this machine's own is read or written: the config folder and
// the stores a walk reads are scratch ones, named before any Keel source loads.
process.env.KEEL_CONFIG_DIR = join(root, "config");
for (const k of ["CLAUDE_DIR", "CODEX_DIR", "AGY_DIR", "HERMES_DIR"]) process.env[`KEEL_IMPORT_${k}`] = join(root, "stores", k.toLowerCase());
process.env.KEEL_IMPORT_KEEL_DB = join(root, "stores", "keel.db");
const { Store } = await import("../../core/store.ts");
const { CursorError, offered, page } = await import("./offer.ts");
const { Imports } = await import("./service.ts");
type Imports = InstanceType<typeof Imports>;

let n = 0;
const T0 = Date.UTC(2024, 2, 5, 10, 0, 0);
const line = (id: string, i: number, type: "user" | "assistant", text: string) =>
  JSON.stringify({
    cwd: root, sessionId: id, version: "2.1.300", isSidechain: false, userType: "external", entrypoint: "cli", timestamp: new Date(T0 + i * 60_000).toISOString(),
    type, uuid: `${id}-${i}`, parentUuid: i ? `${id}-${i - 1}` : null,
    message: type === "user" ? { role: "user", content: text } : { id: `msg_${i}`, role: "assistant", model: "claude-test", content: [{ type: "text", text }], stop_reason: "end_turn" },
  }) + "\n";

// A store of its own and a Claude Code transcript of two exchanges.
function fixture() {
  const dir = join(root, `case-${++n}`);
  mkdirSync(dir, { recursive: true });
  const store = new Store(join(dir, "state"));
  store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT"); // the fleet adds it in the daemon
  const imports = new Imports(store);
  const id = `5e55107a-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, line(id, 0, "user", "First question") + line(id, 1, "assistant", "First answer") + line(id, 2, "user", "Second question") + line(id, 3, "assistant", "Second answer"));
  const grow = () => appendFileSync(path, line(id, 4, "user", "Third question") + line(id, 5, "assistant", "Third answer"));
  const found = () => imports.byPath(path, "claude")!;
  const o = { model: "m", workspace: dir };
  const count = (table: string) => store.db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM ${table}`).get()!.c;
  return { store, imports, id, path, grow, found, o, count };
}

test("a create that fails half way leaves no copy, and an update that fails leaves the copy as it was", async () => {
  const { store, imports, grow, found, o, count } = fixture();
  const plain = store.redact;
  const failOn = (text: string) => { store.redact = (_s, _k, v) => { if (JSON.stringify(v ?? "").includes(text)) throw new Error("disk full"); return v; }; };
  failOn("Second answer");
  await expect(imports.import(found(), o)).rejects.toThrow("disk full");
  expect([count("sessions"), count("events"), count("import_links")]).toEqual([0, 0, 0]);

  store.redact = plain;
  const made = await imports.import(found(), o);
  expect(made.action).toBe("created");
  const before = { head: store.session(made.session.id)!.head, events: store.events(made.session.id).length, link: imports.link(made.session.id) };
  grow();
  failOn("Third answer");
  await expect(imports.import(found(), { ...o, mode: "update" })).rejects.toThrow("disk full");
  expect({ head: store.session(made.session.id)!.head, events: store.events(made.session.id).length, link: imports.link(made.session.id) }).toEqual(before);
  expect(count("events")).toBe(before.events);

  // The same update, with nothing in its way, takes both events and moves the link.
  store.redact = plain;
  const upd = await imports.import(found(), { ...o, mode: "update" });
  expect([upd.action, upd.imported_events, imports.link(made.session.id)!.items]).toEqual(["updated", 2, 6]);
});

test("two imports of one source at once make one copy", async () => {
  const { imports, found, o, count } = fixture();
  const f = found();
  const both = await Promise.all([imports.import(f, o), imports.import(f, o)]);
  expect(both.map((r) => r.action).sort()).toEqual(["created", "opened"]);
  expect(both[0]!.session.id).toBe(both[1]!.session.id);
  expect([count("sessions"), count("import_links")]).toEqual([1, 1]);
  // Two updates at once append what the source gained once.
  const { store, imports: im, grow, found: fnd, o: oo } = fixture();
  const copy = await im.import(fnd(), oo);
  grow();
  const ups = await Promise.all([im.import(fnd(), { ...oo, mode: "update" }), im.import(fnd(), { ...oo, mode: "update" })]);
  expect(ups.map((r) => r.imported_events).sort()).toEqual([0, 2]);
  expect(store.events(copy.session.id).filter((e) => e.kind === "user")).toHaveLength(3);
});

test("a turn that starts while the original is read stops the update: local read and a read another machine made", async () => {
  const { store, imports, grow, found, o } = fixture();
  const local = await imports.import(found(), o);
  const far = await imports.import(found(), { ...o, mode: "new", from: { machine: "m0123abcd", read: await imports.read(found()) } });
  grow();
  const held = (id: string) => store.events(id).length;

  // The local read is held open; the copy takes a turn meanwhile.
  const read = imports.read.bind(imports);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  imports.read = async (f) => { await gate; return read(f); };
  const pending = imports.import(found(), { ...o, mode: "update" });
  store.append(local.session.id, "turn_start", {});
  const n1 = held(local.session.id);
  release();
  await expect(pending).rejects.toMatchObject({ status: 409, reason: "went_on", session_id: local.session.id });
  expect(held(local.session.id)).toBe(n1);
  imports.read = read;

  // The other machine answered with its read; a turn began here before it arrived.
  const theirs = await imports.read(found());
  store.append(far.session.id, "turn_start", {});
  const n2 = held(far.session.id);
  const link = imports.link(far.session.id);
  await expect(imports.import(found(), { ...o, mode: "update", from: { machine: "m0123abcd", read: theirs } })).rejects.toMatchObject({ status: 409, reason: "went_on" });
  expect(held(far.session.id)).toBe(n2);
  expect(imports.link(far.session.id)).toEqual(link);
});

// ---- the index: a page and a lookup read its columns, not every serialized row.

const TITLES = ["Zebra crossing", "apple pie", "Apple Pie", "école straße", "ÉCOLE", "שלום עולם", "תיקון באג", "😀 party", "naïve résumé", "", "resume", "Résumé", "a b", "A-b", "１２３ wide"];
function generated(n: number): Found[] {
  const rows: Found[] = [];
  for (let i = 0; i < n; i++) {
    const hidden = i % 23 === 9;
    rows.push({
      harness: i % 4 ? "claude" : "codex", id: `gen-${i}`, path: `/idx/${hidden ? "secrets/" : ""}d${i % 31}/${i % 2 ? "é" : "z"}${String(i).padStart(6, "0")}.jsonl`,
      cwd: i % 29 ? `/work/p${i % 13}` : undefined, title: `${TITLES[i % TITLES.length]} ${i % 97}`, first_prompt: i % 5 ? `Fix the ÇA VA parser ${i}` : undefined, last_prompt: i % 7 ? `בדיקה ${i % 50}` : undefined,
      updated_ms: 1_700_000_000_000 + (i % 400) * 1000, size_bytes: 500 + (i % 61), kind: i % 10 === 3 ? "subagent" : i % 10 === 6 ? "headless" : "interactive", model: "m",
    });
  }
  return rows;
}

test("the index pages, counts and looks up like a pass over every session, and decodes only what it returns", () => {
  const dir = join(root, `index-${++n}`);
  mkdirSync(dir, { recursive: true });
  const store = new Store(join(dir, "state"));
  let imports = new Imports(store);
  const rows = generated(10_400);
  store.db.transaction(() => { for (const f of rows) imports.record(f.path, f.harness as "claude" | "codex", f.size_bytes, f.updated_ms, f); })();
  // A file with no conversation in it has a row and is never listed.
  imports.record("/idx/empty.jsonl", "claude", 1, 1, null);
  // The stores that list themselves: a few sessions, placed among the indexed ones by the same order.
  const side: Found[] = Array.from({ length: 40 }, (_, i) => ({ harness: "keel", id: `keel-${i}`, path: `/idx/keel.db#keel-${i}`, cwd: `/work/p${i % 13}`, title: `${TITLES[i % TITLES.length]} keel`, updated_ms: 1_700_000_000_000 + i * 9_000, size_bytes: 500 + i, kind: "interactive" }));
  const stub = (im: Imports) => { (im as any).keel = () => side; };
  stub(imports);
  const everything = [...rows, ...side];

  // Every page of a listing, from the index and from a pass over every session.
  const both = (q: ListQuery & { offered?: boolean }, max = 500, pages = 4) => {
    const ref = q.offered ? everything.filter(offered) : everything;
    let cursor: string | undefined;
    for (let i = 0; i < pages; i++) {
      const want = page(ref, { ...q, cursor }, { max, scope: q.offered ? "offered" : "" });
      const d0 = imports.decodes;
      const got = imports.list({ ...q, cursor }, max);
      expect(got.sessions.map(({ imported: _, ...f }) => f)).toEqual(want.sessions);
      expect([got.total, got.next_cursor, got.changed]).toEqual([want.total, want.next_cursor, want.changed]);
      // Only the page's own rows of the index were decoded.
      expect(imports.decodes - d0).toBe(want.sessions.filter((f) => f.harness !== "keel").length);
      if (!(cursor = want.next_cursor)) break;
    }
  };
  for (const q of [
    {}, { limit: 7 }, { sort: "size" as const, limit: 120 }, { sort: "title" as const, limit: 150 }, { sort: "title" as const, q: "résumé" },
    { q: "שלום" }, { q: "ÉCOLE Straße" }, { q: "ça va 12" }, { q: "😀" }, { q: "gen-1040" }, { q: "no such words anywhere" },
    { show: "all" }, { show: "subagents" }, { show: "headless", sort: "size" as const }, { harness: "codex" as const, limit: 500 }, { harness: "keel" as const, limit: 15 },
    { cwd: "/work/p3" }, { cwd: "/work/p3", q: "apple", show: "all", sort: "title" as const }, { offered: true, limit: 200 }, { offered: true, q: "pie", sort: "size" as const },
  ]) both(q, (q as any).offered ? 200 : 500);
  // A whole listing, page by page: every row once.
  let cursor: string | undefined, seen = 0;
  do { const r = imports.list({ limit: 500, cursor }); seen += r.sessions.length; cursor = r.next_cursor; } while (cursor);
  expect(seen).toBe(everything.filter((f) => f.kind === "interactive").length);

  // The counts per harness, with no row decoded.
  let d0 = imports.decodes;
  const counts = Object.fromEntries(imports.harnesses().map((h) => [h.harness, [h.total, h.interactive]]));
  for (const h of ["claude", "codex", "keel"]) expect(counts[h]).toEqual([everything.filter((f) => f.harness === h).length, everything.filter((f) => f.harness === h && f.kind === "interactive").length]);
  expect(imports.decodes).toBe(d0);
  // One session by its harness and id: its row alone.
  d0 = imports.decodes;
  expect(imports.find("codex", "gen-8000")).toEqual(rows[8000]!);
  expect(imports.find("claude", "gen-8000")).toBeUndefined();
  expect(imports.find("keel", "keel-7")).toEqual(side[7]!);
  expect(imports.decodes - d0).toBe(1);

  // An index written before the columns existed is filled from its rows when the daemon starts.
  store.db.exec("UPDATE import_index SET sid = NULL, kind = NULL, cwd = NULL, title = NULL, updated_ms = NULL, size_bytes = NULL, hay = NULL, offered = NULL, kh = NULL");
  expect(imports.list({}).total).toBe(side.length);
  // Rows that cannot be read (cut text, text that is not a session) do not stop the start: their files are read again by the next walk.
  const raw = store.db.query("INSERT INTO import_index (path, harness, size, mtime, found, v) VALUES (?, 'claude', 1, 1, ?, 2)");
  for (const [path, found] of [["/idx/cut.jsonl", '{"harness":"claude","id":"x'], ["/idx/text.jsonl", '"just text"'], ["/idx/null.jsonl", "null"]]) raw.run(path!, found!);
  imports = new Imports(store);
  stub(imports);
  expect(store.db.query<{ found: string | null; v: number }, []>("SELECT found, v FROM import_index WHERE path IN ('/idx/cut.jsonl', '/idx/text.jsonl', '/idx/null.jsonl')").all()).toEqual([{ found: null, v: 0 }, { found: null, v: 0 }, { found: null, v: 0 }]);
  both({ q: "שלום", sort: "title" });
  both({ offered: true, limit: 200 });
}, 60_000); // ten thousand rows written and read many ways: a busy machine takes its time

test("a copy's events keep the times the source gives them; the receipt and the link say when it was copied", async () => {
  const { store, imports, grow, found, o } = fixture();
  const t0 = Date.now();
  const made = await imports.import(found(), o);
  const at = (i: number) => T0 + i * 60_000; // the fixture dates its records a minute apart, in March 2024
  const evs = () => store.events(made.session.id);
  const talk = () => evs().filter((e) => e.kind === "user" || e.kind === "assistant");
  expect(talk().map((e) => e.ts)).toEqual([at(0), at(1), at(2), at(3)]);
  expect(talk().map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  // The receipt is of the import, not of the conversation.
  const receipt = evs().at(-1)!;
  expect(receipt.data.text).toContain("Imported from Claude Code");
  expect(receipt.ts).toBeGreaterThanOrEqual(t0);
  const link = imports.link(made.session.id)!;
  expect(link.imported_ms).toBeGreaterThanOrEqual(t0);
  expect(store.session(made.session.id)!.updated).toBeGreaterThanOrEqual(t0);

  grow();
  await Bun.sleep(5);
  const t1 = Date.now();
  const upd = await imports.import(found(), { ...o, mode: "update" });
  expect(upd.imported_events).toBe(2);
  expect(talk().map((e) => e.ts)).toEqual([at(0), at(1), at(2), at(3), at(4), at(5)]);
  const synced = imports.link(made.session.id)!;
  expect(synced.synced_ms).toBeGreaterThanOrEqual(t1);
  expect(synced.imported_ms).toBe(link.imported_ms);
  // The copy is the last one worked on, whatever its events' dates.
  expect(store.session(made.session.id)!.updated).toBeGreaterThanOrEqual(t1);
});
