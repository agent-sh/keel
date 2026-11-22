// The label a statement of the store's connection carries while it runs: its
// text without any value, and what it costs on the path of every query.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { labelText, onLabels, statementCell } from "./statement-label.ts";
import { Store } from "./store.ts";

// A label holds words of a fixed vocabulary only: SQL's own, and the schema's names. Whatever else the
// text holds is `?`, so a value cannot reach a label however it is written.
test("a label is built from SQL's words and the schema's names, and everything else is ?", () => {
  const schema = new Set(["events", "session_id", "seq", "kind", "sessions", "title", "id"]);
  const label = (sql: string) => labelText(sql, (w) => schema.has(w.toLowerCase()) || ["select", "from", "where", "and", "in", "limit", "update", "set", "vacuum", "into", "count", "as"].includes(w.toLowerCase()));
  expect(label("SELECT *  FROM events\n WHERE session_id = ? AND seq > 12 AND kind IN ('turn_end', 'it''s') LIMIT 4096"))
    .toBe("SELECT * FROM events WHERE session_id = ? AND seq > ? AND kind IN (?, ?) LIMIT ?");
  // An alias is not in the vocabulary either.
  expect(label("SELECT COUNT(*) AS n FROM events e WHERE e.session_id = ?")).toBe("SELECT COUNT(*) AS ? FROM events ? WHERE ?.session_id = ?");
  // A value in any kind of quotes, in a comment, after an apostrophe in a comment, or bare: none of its words is in the label.
  for (const sql of [
    `UPDATE sessions SET title = "sk-live-1 hunter2" WHERE id = ?`,
    "UPDATE sessions SET title = `sk-live-1 hunter2` WHERE id = ?",
    "UPDATE sessions SET title = [sk-live-1 hunter2] WHERE id = ?",
    "-- don't log this: 'sk-live-1 hunter2'\nUPDATE sessions SET title = ? WHERE id = ?",
    "/* it's hunter2 */ UPDATE sessions SET title = 'sk-live-1' WHERE id = ?",
    "UPDATE sessions SET title = x'736b2d6c697665' || hunter2 WHERE id = 0x1f",
    `VACUUM INTO '/home/someone/hunter2/keel.db'`,
  ]) {
    const made = label(sql);
    expect([sql, /sk|live|hunter|someone|home|keel|736b|don|log|this|it\b/i.test(made)]).toEqual([sql, false]);
    expect(made).toMatch(/^(\? )?(UPDATE sessions SET title = \?|VACUUM INTO \?)/);
  }
  expect(label(`UPDATE sessions SET title = "sk-live-1 hunter2" WHERE id = ?`)).toBe("UPDATE sessions SET title = ? WHERE id = ?");
  // A `--` inside a string is the string's, and an apostrophe in a comment is the comment's: the label reads as the statement does.
  expect(label("UPDATE sessions SET title = 'a -- b', kind = 'hunter2' WHERE id = ?")).toBe("UPDATE sessions SET title = ?, kind = ? WHERE id = ?");
  expect(label("SELECT id FROM events -- it's the newest 'hunter2'\n WHERE seq > 4")).toBe("SELECT id FROM events WHERE seq > ?");
  expect(label("SELECT id /* don't */ FROM events WHERE kind = '/* not a comment */'")).toBe("SELECT id FROM events WHERE kind = ?");
  // A name the schema does not hold is not shown either, and a long text is cut.
  expect(label("SELECT secret_column FROM events")).toBe("SELECT ? FROM events");
  expect(label(`SELECT ${"id, ".repeat(100)}seq FROM events`).length).toBe(160);
});

test("the store's connection says which statement it is in, and puts back what stood before", () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-label-"));
  const store = new Store(dir);
  const labels = new Map<number, string>();
  const stop = onLabels((id, text) => labels.set(id, text));
  try {
    const now = () => labels.get(statementCell[0]!);
    expect(statementCell[0]).toBe(0);
    const id = store.createSession({ model: "p:m", workspace: "/" }).id;
    // Outside a transaction a statement puts back what stood before it.
    store.db.query("SELECT 1").get();
    expect(now()).toBeUndefined();
    expect(statementCell[0]).toBe(0);
    // Inside a transaction the last statement's label stands (the commit after it is named by it), and the one before comes back after.
    let during: string | undefined, begun: string | undefined;
    store.db.transaction(() => {
      begun = now();
      store.db.query("SELECT COUNT(*) AS total_rows FROM events WHERE session_id = ?").get(id);
      during = now();
    })();
    expect(begun).toBe("BEGIN (the start of a transaction: a write waits here for the store's write lock)");
    expect(during).toBe("SELECT COUNT(*) AS ? FROM events WHERE session_id = ?");
    expect(statementCell[0]).toBe(0);
    // A statement that throws puts the cell back too.
    expect(() => store.db.query("SELECT * FROM no_such_table").get()).toThrow();
    expect(() => store.db.run("INSERT INTO sessions (id) VALUES (NULL)")).toThrow();
    expect(statementCell[0]).toBe(0);
    // No label holds a value: the texts are the statements' own, with their literals out.
    // The schema's names are in the vocabulary, the ones a later statement made too; a value is not, written into the text or bound.
    store.append(id, "note", { text: "zqxvalue 90210" });
    store.db.run("UPDATE sessions SET title = 'zqxvalue 90210' WHERE id = ?", [id]);
    store.db.exec("CREATE TABLE made_later (zqx_col TEXT)");
    store.db.run(`INSERT INTO made_later (zqx_col) VALUES ("zqxvalue")`);
    expect([...labels.values()].some((t) => /zqxvalue|90210/.test(t))).toBe(false);
    expect([...labels.values()]).toContain("UPDATE sessions SET title = ? WHERE id = ?");
    expect([...labels.values()]).toContain("INSERT INTO made_later (zqx_col) VALUES (?)");
    expect([...labels.values()].some((t) => t.startsWith("INSERT INTO events"))).toBe(true);
    // Reading the schema's names leaves no statement open: the connection closes, and its close empties the log.
    stop();
    store.db.close(true);
    expect(existsSync(join(dir, "keel.db-wal")) ? statSync(join(dir, "keel.db-wal")).size : 0).toBe(0);
  } finally {
    stop();
    try { store.db.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
