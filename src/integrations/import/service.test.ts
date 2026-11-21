// What an import does when something goes wrong in the middle or two things
// happen at once: no page can make a write fail half way, or start a turn
// while a transcript is being read.
import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../core/store.ts";
import { Imports } from "./service.ts";

const root = mkdtempSync(join(tmpdir(), "keel-import-service-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
// The stores a walk reads are scratch ones, never this machine's own.
for (const k of ["CLAUDE_DIR", "CODEX_DIR", "AGY_DIR", "HERMES_DIR"]) process.env[`KEEL_IMPORT_${k}`] = join(root, "stores", k.toLowerCase());
process.env.KEEL_IMPORT_KEEL_DB = join(root, "stores", "keel.db");

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
