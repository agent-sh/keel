// The daily sweep's figures and offers on fixture rows, and the file changes an offer makes.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tempTree } from "../../test/env.ts";
import { Store } from "../core/store.ts";
import { allHooks } from "../engine/hooks.ts";
import { memoryMeter } from "../integrations/memory-meter.ts";
import { nativeLog } from "../integrations/native-log.ts";
import { dropNote, offersFrom, sweep, Sweeps, tidyIndex, DAY, type FactRow, type RecordRow } from "./sweep.ts";

const hooksAtStart = allHooks().length;
afterAll(() => { allHooks().length = hooksAtStart; });

const now = 1_800_000_000_000;
const put = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };

function fixture() {
  const dir = tempTree("sweep-");
  const store = new Store(join(dir, "state"));
  afterAll(() => store.db.close());
  memoryMeter(store);
  const log = nativeLog(store);
  const sweeps = new Sweeps(store);
  store.db.exec("CREATE TABLE IF NOT EXISTS helper_records (key TEXT PRIMARY KEY, value TEXT NOT NULL, kind TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]', topics TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL, ts INTEGER NOT NULL, updated INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0)");
  store.db.exec("CREATE TABLE IF NOT EXISTS momentum_acts (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL, action TEXT NOT NULL)");
  const sql = async (q: string, p: (string | number | null)[] = []) => store.db.query(q).all(...p) as any[];
  return { dir, store, log, sweeps, sql };
}

test("the card's figures per system come from the day's rows, and a system with nothing says null", async () => {
  const { dir, store, log, sql } = fixture();
  const tm = store.db.query("INSERT INTO telemetry_memory (session_id, ts, path, outcome, facts, tokens, used, rules, followed, broken) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const at = now - 3_600_000;
  // The store: two recalls with 10 facts, a turn named 4 of them; one empty ask; one that timed out. An older day's row is outside.
  tm.run("s1", at, "store_prompt", "added", 6, 300, 3, 1, 1, 0);
  tm.run("s1", at, "store_tool", "added", 4, 120, 1, 0, 0, 0);
  tm.run("s1", at, "store_prompt", "empty", 0, 0, null, 0, 0, 0);
  tm.run("s1", at, "store_tool", "timeout", 0, 0, null, 0, 0, 0);
  tm.run("s1", now - 2 * DAY, "store_prompt", "added", 100, 9999, 0, 0, 0, 0);
  // The helper's records: one recall a turn used, one it did not.
  tm.run("s2", at, "helper", "added", 1, 20, 1, 0, 0, 0);
  tm.run("s2", at, "helper", "added", 1, 20, 0, 0, 0, 0);
  const rec = store.db.query("INSERT INTO helper_records (key, value, kind, source, ts, updated, used) VALUES (?, ?, 'fact', ?, ?, ?, ?)");
  rec.run("pref.old", "likes tea", "helper", now - 90 * DAY, now - 60 * DAY, 0);
  rec.run("pref.mine", "typed by the owner", "owner", now - 90 * DAY, now - 60 * DAY, 0);
  rec.run("pref.used", "used", "helper", now - 90 * DAY, now - 60 * DAY, 3);
  // Native memory: three sessions loaded the Claude folder, one read a file and one wrote one.
  const nd = join(dir, "claude-mem");
  for (const s of ["a", "b", "c"]) log.note(s, "claude", "loaded", nd, 800, at);
  log.note("a", "claude", "read", join(nd, "x.md"), 0, at);
  log.note("b", "claude", "wrote", join(nd, "y.md"), 0, at);
  put(join(nd, "MEMORY.md"), "- [x](x.md): one\n");
  put(join(nd, "x.md"), "---\ntype: user\n---\nx");
  // Momentum: two nudges; the turn after the first ended on its own, the owner stopped the one after the second.
  const s = store.createSession({ model: "p:m", workspace: dir });
  const act = store.db.query("INSERT INTO momentum_acts (session_id, ts, action) VALUES (?, ?, 'steer')");
  act.run(s.id, at); act.run(s.id, at + 5000);
  store.append(s.id, "turn_end", { reason: "end_turn" }, undefined, at + 1000);
  store.append(s.id, "turn_end", { reason: "interrupted" }, undefined, at + 6000);
  const card = await sweep({ sql, store, tacit: { on: true, falls: 1 }, momentum: { on: true }, now });
  const by = Object.fromEntries(card.systems.map((x) => [x.id, x]));
  expect(by.tacit!.figures).toMatchObject({ asked: 4, recalls: 2, empty: 1, missed: 1, facts: 10, tokens: 420, named: 4, checked: 10, rules: 1, followed: 1, falls: 1 });
  expect(by.tacit!.helped).toBe(0.4);
  expect(by.helper!.figures).toMatchObject({ recalls: 2, recalls_used: 1, checked: 2, records: 3, unused: 2, stale: 1 });
  expect(by.helper!.helped).toBe(0.5);
  expect(by.claude!.figures).toMatchObject({ loads: 3, sessions: 3, reads: 1, writes: 1, notes: 1, unindexed: 0 });
  expect(by.claude!.helped).toBe(0.333);
  expect(by.codex!.helped).toBeNull();
  expect(by.codex!.on).toBe(false);
  expect(by.momentum!.figures).toMatchObject({ acts: 2, steer: 2, ended: 1, interrupted: 1 });
  expect(by.momentum!.helped).toBe(0.5);
  expect(card.offers.map((o) => o.kind)).toEqual(["drop_record"]);
});

test("offers: a stale record, a fact never named, a rule that never fired, an index to tidy, a stale note; three at most, two of a kind", () => {
  const rec = (key: string, source: string, used: number, days: number): RecordRow => ({ key, value: key, kind: "fact", source, ts: now - 200 * DAY, updated: now - days * DAY, used });
  const fact = (name: string, o: Partial<FactRow>): FactRow => ({ name, given: 8, sessions: 4, checked: 8, used: 0, rule: 0, followed: 0, broken: 0, tokens: 400, last: now, ...o });
  const facts = [fact("never-named", {}), fact("named", { used: 2 }), fact("dead-rule", { rule: 1, tokens: 900 }), fact("judged-rule", { rule: 1, followed: 3 }), fact("rare", { given: 2 }), fact("few-sessions", { sessions: 1 })];
  const records = [rec("a.old", "helper", 0, 40), rec("a.new", "helper", 0, 3), rec("a.mine", "owner", 0, 99), rec("a.used", "helper", 5, 99), rec("b.old", "helper", 0, 70), rec("c.old", "helper", 0, 50)];
  const native = [{ dir: "/m", notes: [
    { file: "u.md", bytes: 9, mtime: now - 300 * DAY, type: "user", indexed: true },
    { file: "p.md", bytes: 9, mtime: now - 300 * DAY, type: "project", indexed: true },
    { file: "q.md", bytes: 9, mtime: now - 10 * DAY, type: "project", indexed: false },
  ], index: { lines: 3, bytes: 90, over: false, missing: ["gone.md"] } }];
  const all = offersFrom({ facts, records, native, now, sweep: "w" });
  expect(all.length).toBe(3);
  // Highest value first, never three of a kind: the oldest records, the rule that cost most, the stale note.
  const kinds = all.map((o) => o.kind);
  expect(kinds.filter((k) => k === "drop_record").length).toBeLessThanOrEqual(2);
  expect(all.map((o) => o.id)).toEqual(["w:0", "w:1", "w:2"]);
  expect(all.every((o) => o.state === "open")).toBe(true);
  // A narrower look: only the facts.
  const only = offersFrom({ facts, records: [], native: [], now, sweep: "x" });
  expect(only.map((o) => o.target.name)).toEqual(["dead-rule", "never-named"]);
  expect(only[0]!.title).toContain("rule that never fired");
  expect(only[1]!.title).toContain("never helped");
  // A note the log shows was read is not stale.
  const read = offersFrom({ facts: [], records: [], native, reads: new Set(["/m/p.md"]), now, sweep: "y" });
  expect(read.map((o) => o.kind)).toEqual(["tidy_index"]);
  const stale = offersFrom({ facts: [], records: [], native: [{ ...native[0]!, notes: native[0]!.notes.map((n) => ({ ...n, indexed: true })), index: null }], now, sweep: "z" });
  expect(stale.map((o) => [o.kind, o.target.file])).toEqual([["drop_note", "p.md"]]);
});

test("tidying an index lists the unlisted notes by their description and drops dead lines; a stale note is moved aside, not deleted", () => {
  const dir = tempTree("sweep-notes-");
  put(join(dir, "MEMORY.md"), "- [a](a.md): kept\n- [gone](gone.md): dead\n");
  put(join(dir, "a.md"), "---\ndescription: A\n---\n");
  put(join(dir, "b.md"), "---\nname: b\ndescription: The b note\ntype: project\n---\nbody");
  tidyIndex(dir, ["b.md", "a.md", "../escape.md"], ["gone.md"]);
  expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toBe("- [a](a.md): kept\n- [b](b.md): The b note\n");
  expect(dropNote(dir, "b.md")).toContain(".dropped");
  expect(existsSync(join(dir, "b.md"))).toBe(false);
  expect(readFileSync(join(dir, ".dropped", "b.md"), "utf8")).toContain("body");
  expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toBe("- [a](a.md): kept\n");
  expect(() => dropNote(dir, "MEMORY.md")).toThrow();
  expect(() => dropNote(dir, "../x.md")).toThrow();
});

test("a stored card keeps its offers' state and the helped share of each day for the trend", () => {
  const { sweeps } = fixture();
  const offer = (id: string) => ({ id, kind: "drop_record" as const, system: "helper" as const, title: "t", why: "w", state: "open" as const, target: { key: "k" } });
  sweeps.save({ id: "c1", ts: 1, since: 0, until: 1, systems: [{ id: "tacit", label: "t", on: true, figures: {}, helped: 0.5 }], offers: [] });
  sweeps.save({ id: "c2", ts: 2, since: 1, until: 2, systems: [{ id: "tacit", label: "t", on: true, figures: {}, helped: 0.7 }], offers: [offer("c2:0")] });
  expect(sweeps.latest()!.id).toBe("c2");
  expect(sweeps.setOffer("c2:0", { state: "dismissed" })!.state).toBe("dismissed");
  expect(sweeps.get("c2")!.offers[0]!.state).toBe("dismissed");
  expect(sweeps.history().map((h) => h.helped.tacit)).toEqual([0.5, 0.7]);
  expect(sweeps.setOffer("c9:0", {})).toBeNull();
});
