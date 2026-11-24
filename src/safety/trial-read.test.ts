// The read thread's trial over a store: it stops at its budget with what it replayed, the newest sessions first,
// and it never loads code a request names.
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tasks } from "../server/read-tasks.ts";
import { looking } from "./looked.ts";
import { trialRead, type TrialAsk } from "./trial-read.ts";

const root = join(process.env.HOME!, ".cache/keel-work/bun/unit", `trial-read-${process.pid}`);
mkdirSync(root, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const NOW = 1_800_000_000_000;
// A store of `n` sessions on another machine (nothing of this disk is asked), each with one call that ran.
function store(n: number): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE sessions (id TEXT, workspace TEXT, updated INTEGER, parent_id TEXT, machine TEXT)");
  db.run("CREATE TABLE events (id TEXT, session_id TEXT, kind TEXT, ts INTEGER, data TEXT)");
  for (let i = 0; i < n; i++) {
    const ts = NOW - (i + 1) * 60_000;
    db.run("INSERT INTO sessions VALUES (?, '/w', ?, NULL, 'box')", [`s${i}`, ts]);
    db.run("INSERT INTO events VALUES (?, ?, 'assistant', ?, ?)", [`a${i}`, `s${i}`, ts, JSON.stringify({ blocks: [{ type: "tool_use", id: `c${i}`, name: "Bash", input: { command: "echo hi" } }] })]);
    db.run("INSERT INTO events VALUES (?, ?, 'tool_result', ?, ?)", [`r${i}`, `s${i}`, ts + 1, JSON.stringify({ results: [{ tool_use_id: `c${i}`, is_error: false, content: "hi" }] })]);
  }
  return db;
}
const ask = (more: Partial<TrialAsk> = {}): TrialAsk => ({
  days: 1, now: NOW, home: "/h", state: join(root, "state"), config: [join(root, "cfg")], path: "", tools: [{ name: "Bash", readOnly: false, kind: "shell", props: ["command"] } as any],
  mcp: [], runCode: "run_code", mcpCall: "mcp_call", namespaces: [], defaultMode: "full-auto", sandbox: false, rev: "test", ...more,
});

test("a trial past its budget stops between calls and says how far it came, the newest sessions first", async () => {
  const db = store(4);
  let t = 0;
  // Each look at the clock is a second later: the budget of 2.5 s ends after two calls.
  const r = await trialRead(db, ask(), { budget: 2_500, clock: () => (t += 1_000) });
  expect(r.partial).toEqual({ budgetMs: 2_500, sessions: 1, of: 4 });
  expect(r.calls).toBe(1);
  expect(r.agreement.compared).toBe(1);
  const whole = await trialRead(db, ask());
  expect(whole.partial).toBeUndefined();
  expect(whole.calls).toBe(4);
});

test("the read thread's trial loads no code the request names", async () => {
  const marker = join(root, "ran");
  const code = join(root, "evil.ts");
  writeFileSync(code, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");\nexport const replayCall = () => { throw new Error("no"); };\nexport const lastingOf = () => [];\n`);
  const db = store(1);
  const r = await tasks["safety.trial"](db, { ...ask(), base: code, cand: code } as TrialAsk);
  expect(existsSync(marker)).toBe(false);
  expect(r.calls).toBe(1);
});

test("a decision's record keeps a file's hash and length, never its text", () => {
  const text = "rm -rf ./build\n".repeat(10);
  const l = looking("/w", [["read\0/w/run.sh", text], ["exists\0/w/x", "none"]]);
  const kept = Object.fromEntries(l.known());
  expect(kept["read\0/w/run.sh"]).toEqual({ sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"), len: text.length });
  expect(JSON.stringify(kept)).not.toContain("rm -rf");
  expect(kept["exists\0/w/x"]).toBe("none");
});
