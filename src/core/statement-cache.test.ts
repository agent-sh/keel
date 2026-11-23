import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cacheStatements } from "./statement-cache.ts";

test("a statement is compiled once per text, past the twenty bun:sqlite keeps", () => {
  const db = new Database(":memory:");
  cacheStatements(db, 100);
  db.exec("CREATE TABLE t (a INTEGER)");
  db.query("INSERT INTO t (a) VALUES (?)").run(7);
  const texts = Array.from({ length: 60 }, (_, i) => `SELECT a + ${i} AS n FROM t`);
  const first = texts.map((q) => db.query(q));
  for (const [i, q] of texts.entries()) expect(db.query(q)).toBe(first[i]!);
  expect((db.query(texts[59]!).get() as { n: number }).n).toBe(66);
  // Past the bound the one used longest ago is compiled again; the others stay.
  const small = new Database(":memory:");
  cacheStatements(small, 2);
  const a = small.query("SELECT 1"), b = small.query("SELECT 2");
  small.query("SELECT 1");
  small.query("SELECT 3");
  expect(small.query("SELECT 1")).toBe(a);
  expect(small.query("SELECT 2")).not.toBe(b);
});
