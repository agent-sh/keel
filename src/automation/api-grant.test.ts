import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { listReach } from "./api-grant.ts";

// A tree: top, its agent a (granted), a's agent b (granted), b's agent c (not), and top's agent d (not).
function tree() {
  const db = new Database(":memory:");
  db.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_id TEXT)");
  db.run("CREATE TABLE agents (id TEXT PRIMARY KEY, session_id TEXT, api TEXT)");
  for (const [id, parent] of [["top", null], ["sa", "top"], ["sb", "sa"], ["sc", "sb"], ["sd", "top"]] as [string, string | null][]) db.query("INSERT INTO sessions VALUES (?, ?)").run(id, parent);
  for (const [id, s, api] of [["a", "sa", "read"], ["b", "sb", "read"], ["c", "sc", null], ["d", "sd", null]] as [string, string, string | null][]) db.query("INSERT INTO agents VALUES (?, ?, ?)").run(id, s, api);
  return db;
}

test("the lists reach a top-level session and the agents a chain of grants from it reaches, and no one else", () => {
  const db = tree();
  expect(listReach(db, "top")).toEqual({ reads: "top" });
  expect(listReach(db, "sa")).toEqual({ reads: "granted" });
  expect(listReach(db, "sb")).toEqual({ reads: "granted" });
  expect(listReach(db, "sc")).toMatchObject({ reads: false, why: expect.stringContaining('api: "read"') });
  expect(listReach(db, "sd")).toMatchObject({ reads: false });
  expect(listReach(db, "gone")).toMatchObject({ reads: false, why: "its session is gone" });
  // The owner revokes a: a has it no more, and b, which a passed it to, loses it with it.
  db.run("UPDATE agents SET api = 'revoked' WHERE id = 'a'");
  expect(listReach(db, "sa")).toMatchObject({ reads: false, why: expect.stringContaining("revoked") });
  expect(listReach(db, "sb")).toMatchObject({ reads: false, why: "the agent above it (a) had its grant revoked by the owner" });
  // A session under another that is no agent (a reviewer's) has no grant to hold.
  db.run("INSERT INTO sessions VALUES ('sr', 'top')");
  expect(listReach(db, "sr")).toMatchObject({ reads: false });
});
