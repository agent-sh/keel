// Whether a session may reach the memory store's tools: an agent follows the
// sessions above it, and a switch that cannot be read is off.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { memoryOn } from "./tacit.ts";

test("an agent of a memory-off session is off, however deep; a switch that cannot be read is off", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "keel-memory-on-")));
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT"); // agents.ts adds it in the daemon
  const mk = (parent?: string) => {
    const s = store.createSession({ model: "p:m", workspace: "/w" });
    if (parent) store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(parent, s.id);
    return s.id;
  };
  const root = mk(), child = mk(root), grandchild = mk(child);
  expect(memoryOn(store, grandchild)).toBe(true); // no switch anywhere
  // The table as the store's integration keeps it (tacit.ts).
  store.db.exec("CREATE TABLE memory_flags (session_id TEXT PRIMARY KEY, use_memory INTEGER NOT NULL DEFAULT 1, feed_memory INTEGER NOT NULL DEFAULT 1)");
  const set = (id: string, on: boolean) => store.db.query("INSERT OR REPLACE INTO memory_flags (session_id, use_memory) VALUES (?, ?)").run(id, on ? 1 : 0);
  set(root, false);
  expect([memoryOn(store, root), memoryOn(store, child), memoryOn(store, grandchild)]).toEqual([false, false, false]);
  // Its own switch on does not undo the owner's off above it.
  set(child, true);
  expect(memoryOn(store, grandchild)).toBe(false);
  store.db.exec("DROP TABLE memory_flags; CREATE VIEW memory_flags AS SELECT 1 AS nope");
  expect(memoryOn(store, mk())).toBe(false);
});
