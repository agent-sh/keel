import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { RUNNING_MAX, runningOf, runningText } from "./running.ts";

test("the list holds at most twenty entries, agents first, and counts the rest", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE agents (id TEXT, parent_id TEXT, title TEXT, status TEXT, created INTEGER)");
  for (let n = 0; n < 25; n++) db.run("INSERT INTO agents VALUES (?, 'p', ?, 'running', ?)", [`a${n}`, `task ${n}\nsecond line`, n]);
  const r = runningOf({ db } as any, "p");
  expect(r.agents.length).toBe(RUNNING_MAX);
  expect(r.more).toBe(5);
  const text = runningText(r);
  expect(text).toContain("- a0 running: task 0 second line");
  expect(text).not.toContain("a20 ");
  expect(text).toContain("(5 more not listed)");
  expect(runningText(runningOf({ db: new Database(":memory:") } as any, "p"))).toBe("");
});
