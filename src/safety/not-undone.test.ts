// What a command does that a restore of files leaves alone, read from its words (src/safety/not-undone.ts).
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ledgerOf, shellReach } from "./not-undone.ts";

const W = "/w/repo", HOME = "/home/u";
const reach = (command: string) => shellReach(command, W, { workspace: W, own: [W, "/scratch"], home: HOME, scratch: ["/scratch"] });
const kinds = (command: string) => reach(command).out.map((r) => r.kind);

test("git that changes refs, the stash or a remote is named, and git that reads is not", () => {
  expect(kinds("git commit -m x")).toEqual(["git"]);
  expect(kinds("git -C sub -c user.name=a commit -qm x")).toEqual(["git"]);
  expect(kinds("git add -A && git commit -m x && git push origin main")).toEqual(["git", "remote"]);
  expect(kinds("git push --dry-run origin main")).toEqual([]);
  expect(reach("git push /srv/a/long/path/to/remote.git HEAD:main").out).toEqual([{ kind: "remote", line: "git push …/remote.git HEAD:main" }]);
  expect(kinds("git tag v1")).toEqual(["git"]);
  expect(kinds("git tag -l")).toEqual([]);
  expect(kinds("git branch -D old")).toEqual(["git"]);
  expect(kinds("git branch")).toEqual([]);
  expect(kinds("git stash list")).toEqual([]);
  expect(kinds("git status && git log -3 && git diff")).toEqual([]);
});

test("a request names its host only when it sends something", () => {
  expect(reach("curl -X POST -d a=1 https://api.example.com/v1/x").out).toEqual([{ kind: "remote", line: "sent a request to api.example.com" }]);
  expect(kinds("curl -s https://example.com/page")).toEqual([]);
  expect(kinds("curl -X POST -d a=1 http://localhost:3000/x")).toEqual([]);
  expect(kinds("wget --post-data=a=1 https://example.org/f")).toEqual(["remote"]);
});

test("paths outside the folder are named, paths inside are candidates, a scratch folder is its own", () => {
  const r = reach("echo x > /home/u/notes/x && rm -rf data && cp a.txt /scratch/a.txt && echo y | tee src/new.ts");
  expect(r.out).toEqual([{ kind: "outside", line: "wrote ~/notes/x" }]);
  expect(r.touched).toEqual([{ path: "data", how: "deleted" }, { path: "src/new.ts", how: "wrote" }]);
  expect(reach("cd /tmp/other && rm -f x").out).toEqual([{ kind: "outside", line: "deleted /tmp/other/x" }]);
  expect(reach("echo hi > /dev/null").out).toEqual([]);
  expect(reach("rm -rf $dir").touched).toEqual([]);
});

test("the ledger reads its calls' ids and inputs from the rows, not the tool results' bodies", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE events (session_id TEXT, seq INTEGER, kind TEXT, data TEXT)");
  db.run("CREATE INDEX events_bare ON events (session_id, seq, kind)");
  const add = (seq: number, kind: string, data: unknown) => db.run("INSERT INTO events VALUES ('s', ?, ?, ?)", [seq, kind, typeof data === "string" ? data : JSON.stringify(data)]);
  const big = "x".repeat(2_000_000);
  add(1, "turn_start", {});
  add(2, "assistant", { blocks: [{ type: "text", text: "two calls" }, { type: "tool_use", id: "c1", name: "mcp__srv__send", input: { to: "a" } }, { type: "tool_use", id: "c2", name: "mcp__srv__send", input: { to: "b" } }] });
  add(3, "tool_result", { results: [{ tool_use_id: "c1", content: big }, { tool_use_id: "c2", is_error: true, content: "refused" }], images: [{ data: big }] });
  add(4, "assistant", "not json");
  add(5, "turn_end", {});
  const real = JSON.parse;
  let longest = 0;
  JSON.parse = ((t: string, r?: any) => { if (typeof t === "string") longest = Math.max(longest, t.length); return real(t, r); }) as typeof JSON.parse;
  let got;
  try {
    got = ledgerOf(db, { session: "s", from: 1, workspace: "/w", scope: { workspace: "/w", scratch: [] }, machine: false, home: "/h", tools: [], runCode: "run_code", mcpCall: "mcp_call", mcp: [], spawned: [] } as any);
  } finally { JSON.parse = real; }
  // The call that failed is no item; the one that ran is, and the turn is read to its end.
  expect(got.items.map((i) => [i.call, i.kind, i.seq, i.n])).toEqual([["c1", "mcp", 2, 1]]);
  expect(got.through).toBe(5);
  expect(longest < 10_000).toBe(true);
});
