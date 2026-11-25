import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { firstFree, holderOf, portEnv, rangeOf, RANGE_END, RANGE_FROM, RANGE_SIZE, SCHEMA } from "./session-ports.ts";

const mk = (ids: string[]) => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, archived INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0)");
  db.exec(SCHEMA);
  for (const id of ids) db.query("INSERT INTO sessions (id) VALUES (?)").run(id);
  return db;
};

describe("a session's port range", () => {
  test("two sessions never overlap, and a session keeps its range", () => {
    const db = mk(["a", "b"]);
    const a = rangeOf(db, "a")!, b = rangeOf(db, "b")!;
    expect(a).toBe(RANGE_FROM);
    expect(Math.abs(a - b)).toBeGreaterThanOrEqual(RANGE_SIZE);
    expect(rangeOf(db, "a")).toBe(a);
    expect(rangeOf(db, "b")).toBe(b);
  });
  test("the range survives the daemon: the store holds it", () => {
    const db = mk(["a", "b"]);
    rangeOf(db, "a");
    const b = rangeOf(db, "b")!;
    // (A new daemon is a new reader of the same rows: nothing is kept in memory.)
    expect(db.query("SELECT base FROM session_ports WHERE session_id = 'b'").get()).toEqual({ base: b });
    expect(rangeOf(db, "b")).toBe(b);
  });
  test("a deleted session's range is free again", () => {
    const db = mk(["a", "b"]);
    const a = rangeOf(db, "a")!;
    rangeOf(db, "b");
    db.query("DELETE FROM sessions WHERE id = 'a'").run();
    db.query("INSERT INTO sessions (id) VALUES ('c')").run();
    expect(rangeOf(db, "c")).toBe(a);
  });
  test("when every range is held, an archived session's is taken over, else none", () => {
    const db = mk(["old", "new"]);
    const all = Math.floor((RANGE_END - RANGE_FROM) / RANGE_SIZE);
    for (let i = 0; i < all; i++) db.query("INSERT INTO sessions (id, updated) VALUES (?, ?)").run(`s${i}`, i + 10);
    for (let i = 0; i < all; i++) rangeOf(db, `s${i}`);
    expect(rangeOf(db, "new")).toBeNull();
    db.query("UPDATE sessions SET archived = 1 WHERE id IN ('s5', 's9')").run();
    const was = rangeOf(db, "s5")!;
    expect(rangeOf(db, "new")).toBe(was);
    expect(holderOf(db, was + 3)?.session_id).toBe("new");
  });
  test("the holder of a port is the session whose range holds it", () => {
    const db = mk(["a", "b"]);
    rangeOf(db, "a");
    const b = rangeOf(db, "b")!;
    expect(holderOf(db, b + 9)).toEqual({ session_id: "b", base: b });
    expect(holderOf(db, 3000)).toBeNull();
    expect(holderOf(db, RANGE_END + 5)).toBeNull();
  });
  test("firstFree and the environment", () => {
    expect(firstFree(new Set([RANGE_FROM, RANGE_FROM + 10]))).toBe(RANGE_FROM + 20);
    expect(portEnv(20010)).toEqual({ KEEL_PORT: "20010", KEEL_PORT_END: "20019" });
    expect(portEnv(null)).toEqual({});
  });
});
