import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { boardFacts } from "./facts.ts";
import { MAX_ROWS, omittedWords } from "./rules.ts";

// The agents table as the board reads it: a tree of one root with `n` agents, the oldest first.
function tree(states: string[]): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE agents (id TEXT PRIMARY KEY, parent_id TEXT, session_id TEXT, title TEXT, type TEXT, model TEXT, status TEXT, created INTEGER, ended INTEGER,
    branch TEXT, worktree TEXT, machine TEXT, reviews TEXT, output_schema TEXT, result TEXT)`);
  const add = db.prepare("INSERT INTO agents VALUES (?, 'root', ?, ?, 'general-purpose', 'm', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL)");
  states.forEach((s, i) => add.run(`ag${i}`, `s${i}`, `agent ${i}`, s, 1000 + i));
  return db;
}

test("a working agent behind newer finished siblings stays on the board", () => {
  for (const working of ["running", "waiting"]) {
    const f = boardFacts(tree([working, ...Array(MAX_ROWS).fill("completed")]), { root: "root" });
    expect(f.total).toBe(MAX_ROWS + 1);
    expect(f.agents.length).toBe(MAX_ROWS);
    expect(f.agents.find((a) => a.id === "ag0")?.status).toBe(working);
    // The oldest finished one is what is left out, and the rows are still newest first.
    expect(f.agents.some((a) => a.id === "ag1")).toBe(false);
    expect(f.agents.map((a) => a.created)).toEqual(f.agents.map((a) => a.created).sort((x, y) => y - x));
    expect(f.live_cut).toBe(0);
    expect(omittedWords({ total: f.total, rows: f.agents as never[], live_cut: f.live_cut })).toBe("1 older finished agent is");
  }
});

test("when more agents work than the board holds, it says how many working ones it left out", () => {
  const f = boardFacts(tree([...Array(MAX_ROWS + 2).fill("running"), "completed"]), { root: "root" });
  expect(f.agents.every((a) => a.status === "running")).toBe(true);
  expect(f.live_cut).toBe(2);
  expect(f.agents.some((a) => a.id === "ag0" || a.id === "ag1")).toBe(false);
  expect(omittedWords({ total: f.total, rows: f.agents as never[], live_cut: f.live_cut })).toBe("3 agents are (2 working, the oldest, and 1 finished)");
});
