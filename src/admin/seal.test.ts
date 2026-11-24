// The sealed record in a real store: events, cards and outward rows are linked as they are written; an edit,
// a removal or a reorder made in the file is found by what the read thread says; an old store gets its chain
// from its next event; a day's root is made, kept in a file and held against it.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyBundle } from "../core/seal.ts";
import { Store } from "../core/store.ts";
import { EGRESS_SCHEMA } from "../safety/egress-report.ts";
import { patchSettings } from "./settings.ts";
import { closedDay, loadRoots, readRoots, rootsPath, SealRoots } from "./seal.ts";
import { sealBundleTo, sealRoots, sealVerify } from "./seal-read.ts";

setDefaultTimeout(20_000);
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "keel-seal-")); dirs.push(d); return d; };

function made_() { return made(2); }
function made(n = 6) {
  const store = new Store(scratch());
  store.migrate(EGRESS_SCHEMA);
  const s = store.createSession({ model: "m", workspace: "/" });
  for (let i = 1; i <= n; i++) store.append(s.id, i % 2 ? "user" : "assistant", { text: `t${i}` });
  return { store, id: s.id };
}
const verify = (store: Store, id: string, roots?: Record<string, string>) => sealVerify(store.db, { session: id, roots });
const events = (store: Store, id: string) => store.db.query<{ id: string; seq: number }, [string]>("SELECT id, seq FROM events WHERE session_id = ? ORDER BY seq").all(id);

test("events are linked as they are written, and an edit, a removal or a reorder in the file is found", () => {
  const { store, id } = made();
  const ok = verify(store, id);
  expect([ok.ok, ok.chains[0]!.sealed, ok.chains[0]!.from, ok.counts.events]).toEqual([true, 6, "event 1", 6]);
  const e = events(store, id);

  store.db.query("UPDATE events SET data = '{\"text\":\"changed\"}' WHERE id = ?").run(e[2]!.id);
  const edited = verify(store, id);
  expect([edited.ok, edited.chains[0]!.break?.at]).toEqual([false, "event 3"]);
  store.db.query("UPDATE events SET data = '{\"text\":\"t3\"}' WHERE id = ?").run(e[2]!.id);
  expect(verify(store, id).ok).toBe(true);

  const keep = store.db.query<Record<string, any>, [string]>("SELECT * FROM events WHERE id = ?").get(e[3]!.id)!;
  store.db.query("DELETE FROM events WHERE id = ?").run(e[3]!.id);
  expect(verify(store, id).chains[0]!.break?.why).toContain("taken out");
  store.db.query("INSERT INTO events (id, session_id, seq, parent, kind, data, ts, prev) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(keep.id, keep.session_id, keep.seq, keep.parent, keep.kind, keep.data, keep.ts, keep.prev);
  expect(verify(store, id).ok).toBe(true);

  // Reordered: two events change places.
  store.db.exec("PRAGMA ignore_check_constraints = 1");
  store.db.query("UPDATE events SET seq = -1 WHERE id = ?").run(e[1]!.id);
  store.db.query("UPDATE events SET seq = 2 WHERE id = ?").run(e[2]!.id);
  store.db.query("UPDATE events SET seq = 3 WHERE id = ?").run(e[1]!.id);
  expect(verify(store, id).ok).toBe(false);
  store.db.query("UPDATE events SET seq = -1 WHERE id = ?").run(e[1]!.id);
  store.db.query("UPDATE events SET seq = 3 WHERE id = ?").run(e[2]!.id);
  store.db.query("UPDATE events SET seq = 2 WHERE id = ?").run(e[1]!.id);
  expect(verify(store, id).ok).toBe(true);

  // The last events taken out: the head the session keeps names them.
  store.db.query("DELETE FROM events WHERE id = ?").run(e[5]!.id);
  expect(verify(store, id).chains[0]!.break?.at).toBe("event 5");
});

test("a store from before the record gets its chain from its next event, and says where it begins", () => {
  const { store, id } = made(4);
  // As the old build left it: no links, no head.
  store.db.exec("UPDATE events SET prev = NULL");
  store.db.exec("UPDATE sessions SET seal = NULL");
  const old = verify(store, id);
  expect([old.ok, old.chains[0]!.sealed, old.chains[0]!.unsealed]).toEqual([true, 0, 4]);
  store.append(id, "user", { text: "new" });
  store.append(id, "assistant", { text: "newer" });
  const v = verify(store, id);
  expect([v.ok, v.chains[0]!.from, v.chains[0]!.unsealed, v.chains[0]!.sealed]).toEqual([true, "event 5", 4, 2]);
  // An event of the sealed part that lost its link is found.
  store.db.query("UPDATE events SET prev = NULL WHERE seq = 6").run();
  expect(verify(store, id).chains[0]!.break?.at).toBe("event 6");
});

test("cards and outward rows are chained per session, and the ledger's retention leaves the rest whole", () => {
  const { store, id } = made(2);
  const out = (host: string, at: number) => store.addEgress({ at, session: id, turn: null, call: "c", tool: "web", via: null, host, port: 443, bytes: 10, outcome: "sent", status: 200, why: null });
  store.sealCard(id, JSON.stringify({ id: "a1", state: "pending" }), 10);
  store.sealCard(id, JSON.stringify({ id: "a1", state: "allowed" }), 20);
  out("a.example", 100); out("b.example", 200); out("c.example", 300); out("d.example", 400);
  const v = verify(store, id);
  expect([v.ok, v.chains[1]!.rows, v.chains[2]!.rows]).toEqual([true, 2, 4]);
  // Retention takes the oldest rows: the rest is whole and says older rows are gone.
  store.db.query("DELETE FROM egress WHERE ts < 150").run();
  const trimmed = verify(store, id);
  expect([trimmed.ok, trimmed.chains[2]!.trimmed]).toEqual([true, true]);
  // A row taken out of the middle of the ledger is found, and so is one that was changed.
  store.db.query("DELETE FROM egress WHERE ts = 300").run();
  expect(verify(store, id).chains[2]!.break).not.toBeNull();
  const again = made(1);
  again.store.sealCard(again.id, "{}", 1); again.store.sealCard(again.id, "{\"a\":1}", 2);
  again.store.db.query("UPDATE seal_cards SET data = '{\"a\":2}' WHERE id = 2").run();
  expect(verify(again.store, again.id).chains[1]!.break?.at).toBe("card version 2");
  // A deleted session takes its chains of cards and rows with it (the days keep its heads).
  store.deleteSession(id);
  expect(store.db.query("SELECT 1 FROM seal_cards WHERE session_id = ?").get(id)).toBeNull();
});

test("the day's root is made once, kept in a file, held against it, and a bundle verifies alone", async () => {
  const { store, id } = made(5);
  const other = store.createSession({ model: "m", workspace: "/" });
  store.append(other.id, "user", { text: "x" });
  const failed: unknown[] = [];
  const roots = new SealRoots(store, (e) => failed.push(e));
  Bun.sleepSync(3);
  const day1 = Date.now();
  const first = closedDay(day1);
  expect(first).toBe(new Date(day1 - 86_400_000).toISOString().slice(0, 10));
  // The root of the closed day covers every session that moved; none is made twice.
  expect(await roots.tick(day1)).toBe(first);
  expect(await roots.tick(day1 + 60_000)).toBeNull();
  expect(failed).toEqual([]);
  const file = readRoots(rootsPath(store.stateDir))!;
  expect([file.length, file[0]!.sessions]).toEqual([1, 2]);
  expect(sealRoots(store.db, { kept: file }).ok).toBe(true);
  expect(verify(store, id, Object.fromEntries(file.map((r) => [r.day, r.root]))).anchors[0]!.ok).toBe(true);

  // Next day: only the session that moved is in it, and the root follows the one before.
  Bun.sleepSync(3);
  store.append(id, "user", { text: "more" });
  expect(await roots.tick(day1 + 86_400_000)).toBe(closedDay(day1 + 86_400_000));
  const two = readRoots(rootsPath(store.stateDir))!;
  expect([two.length, two[1]!.sessions, two[1]!.prev]).toEqual([2, 1, two[0]!.root]);
  expect(sealRoots(store.db, { kept: two }).ok).toBe(true);

  // The bundle holds the rows, the heads and the path to each day's root, and checks with no store.
  const out = join(scratch(), "bundle.json");
  const wrote = sealBundleTo(store.db, { session: id, path: out })!;
  expect(wrote.bytes).toBe(Buffer.byteLength(readFileSync(out, "utf8")));
  expect(sealBundleTo(store.db, { session: "nobody", path: join(scratch(), "none.json") })).toBeNull();
  const bundle = JSON.parse(readFileSync(out, "utf8"));
  const kept = new Map(two.map((r) => [r.day, r.root]));
  const alone = verifyBundle(bundle, kept);
  expect([alone.ok, alone.anchors.length, alone.chains[0]!.rows]).toEqual([true, 2, 6]);
  const changed = JSON.parse(JSON.stringify(bundle)); changed.events.rows[2].data = "{}";
  expect(verifyBundle(changed, kept).ok).toBe(false);

  // A store rewritten whole (every link and head made again) does not make the roots in the file.
  const forged = made(5);
  expect(forged.store.stateDir).not.toBe(store.stateDir);
  store.db.query("UPDATE events SET data = '{\"text\":\"forged\"}' WHERE id = ?").run(events(store, id)[1]!.id);
  expect(verify(store, id).ok).toBe(false);
  // A day's heads changed in the store: the root no longer follows from them.
  store.db.exec("UPDATE seal_days SET events = zeroblob(32) WHERE day = '" + first + "' AND session_id = '" + id + "'");
  const r = sealRoots(store.db, { kept: two });
  expect([r.ok, r.roots[0]!.ok]).toEqual([false, false]);
  // A root file with a day cut out is found.
  writeFileSync(rootsPath(store.stateDir), readFileSync(rootsPath(store.stateDir), "utf8").split("\n")[0] + "\n");
  expect(sealRoots(store.db, { kept: readRoots(rootsPath(store.stateDir)) }).roots.some((x) => !x.ok)).toBe(true);
});

test("the roots files are read with a time limit, and a copy that is not owed is not looked at", async () => {
  const dir = scratch();
  const fifo = join(dir, "stale-mount");
  const made = Bun.spawnSync(["mkfifo", fifo]);
  if (made.exitCode === 0) {
    // A read that nothing answers (a stale mount blocks like this) ends at its limit, and does not hold the caller.
    const t0 = Date.now();
    await expect(loadRoots(fifo, 150)).rejects.toThrow("did not answer");
    expect(Date.now() - t0).toBeLessThan(3_000);
    closeSync(openSync(fifo, "r+"));
  }
  expect(await loadRoots(join(dir, "none"))).toBeNull();

  const { store } = made_();
  const failed: unknown[] = [];
  const roots = new SealRoots(store, (e) => failed.push(e));
  const mirror = join(dir, "mirror.jsonl");
  try {
    expect(patchSettings({ seal: { mirror } }).ok).toBe(true);
    expect(await roots.tick(Date.now())).not.toBeNull();
    expect(readRoots(mirror)!.length).toBe(1);
    // Nothing is owed now: a mirror that was changed behind the daemon's back is not read or written until a root is made.
    writeFileSync(mirror, "");
    expect(await roots.tick(Date.now() + 60_000)).toBeNull();
    expect(readFileSync(mirror, "utf8")).toBe("");
    expect(failed).toEqual([]);
  } finally {
    patchSettings({ seal: { mirror: "" } });
  }
});

test("a session handed out carries no link: it would change every frame", () => {
  const { store, id } = made(3);
  const row = store.db.query<{ seal: Uint8Array | null }, [string]>("SELECT seal FROM sessions WHERE id = ?").get(id)!;
  expect(row.seal?.length).toBe(32);
  expect(JSON.stringify(store.session(id))).not.toContain("seal");
  expect(Object.keys(store.sessions()[0]!)).not.toContain("seal");
  expect(Object.keys(store.session(id)!)).not.toContain("seal");
  store.append(id, "user", { text: "more" });
  expect(Object.keys(store.session(id)!)).not.toContain("seal");
});
