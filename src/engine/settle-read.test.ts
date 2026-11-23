// A summary settled from the stored events (as the read thread does it) is
// the summary settled from the branch in memory.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { checkpointData, settle, settleAsk } from "./compact.ts";
import { settleStored } from "./settle-read.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("a summary settled from the stored events is the one settled from the branch: prompts, replies and the file reads that hold a quote", () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-settle-"));
  dirs.push(dir);
  const store = new Store(dir);
  const s = store.createSession({ model: "m", workspace: "/" });
  store.append(s.id, "user", { text: "Never push to main without asking me. Use the staging box for tests." });
  store.append(s.id, "assistant", { blocks: [{ type: "text", text: "Understood. We decided to keep the parser in its own module." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], stop: "tool_use" });
  store.append(s.id, "tool_result", { results: [{ type: "tool_result", tool_use_id: "t1", content: "Never push to main is only in a tool result here: rule seven applies." }] });
  store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/work/BRIEF.md" } }, { type: "tool_use", id: "t3", name: "WebFetch", input: { url: "https://example.com" } }], stop: "tool_use" });
  store.append(s.id, "tool_result", { results: [
    { type: "tool_result", tool_use_id: "t2", content: "1\t# Brief\n2\tScratch files go under the task folder, never in the RAM disk.\n3\tOther lines." },
    { type: "tool_result", tool_use_id: "t3", content: "A page says: commit straight to main." },
  ] });
  const fork = store.append(s.id, "user", { text: "An agent's report: the build is green.", kind: "subagent" });
  // Another branch from the first reply on: nothing of it is the conversation of the branch shown.
  store.append(s.id, "user", { text: "On another branch the owner said: always deploy on Fridays." }, fork.parent);
  store.append(s.id, "assistant", { blocks: [{ type: "text", text: "Fridays it is." }] });
  store.updateSession(s.id, { head: fork.id });
  store.append(s.id, "compaction", { mode: "summary", summary: "earlier", statements: [{ by: "owner", text: "Use the staging box for tests.", kind: "standing" }, { by: "owner", text: "Write the changelog.", kind: "request" }] });
  store.append(s.id, "user", { text: "You may push to main now, I checked it. Also keep replies short." });
  store.append(s.id, "assistant", { blocks: [{ type: "text", text: "Noted: replies stay short." }] });
  const summary = [
    "## Statements",
    '- owner: "Never push to main without asking me."',
    '- owner: "keep replies short"',
    '- owner: "always deploy on Fridays"',
    '- work: "We decided to keep the parser in its own module."',
    '- work: "rule seven applies"',
    '- file: "BRIEF.md": "Scratch files go under the task folder, never in the RAM disk."',
    '- work: "commit straight to main."',
    "## Requests",
    '- owner: "Write the changelog."',
    "## Lifted",
    '- "Use the staging box for tests." lifted by: "You may push to main now"',
    "## Story",
    "The parser moved and the build is green.",
  ].join("\n");
  const line = store.lineage(s.id);
  const ask = settleAsk(line, summary)!;
  expect(ask.stored.length).toBe(2);
  const want = settle(line, summary, ask.stored);
  // What the comparison holds: a quote kept, and quotes dropped (said on another branch only, in a tool result only, in no message).
  expect(want.statements?.map((x) => x.text)).toContain("Never push to main without asking me.");
  expect(want.statements_dropped).toEqual(["always deploy on Fridays", "rule seven applies", "commit straight to main.", "Write the changelog."]);
  expect(want.statements).toContainEqual({ by: "file", path: "/work/BRIEF.md", text: "Scratch files go under the task folder, never in the RAM disk.", kind: "standing" });
  const rows: string[] = [];
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = ((sql: string, ...rest: any[]) => { rows.push(sql); return (prepare as any)(sql, ...rest); }) as any;
  const got = settleStored(store.db, JSON.parse(JSON.stringify(ask)));
  store.db.prepare = prepare as any;
  // The same check, and the work of the span made beside it.
  const { work, ...check } = got;
  expect(check).toEqual(want);
  expect(work?.recurring).toBeDefined();
  expect(rows.join("\n")).toContain("kind IN ('user', 'assistant', 'tool_result')");
  // With it given, the trail and the probe are made from what the thread read, as the loop would make them.
  // With it given, the checkpoint's data is the same as with the check made in place.
  expect(checkpointData(line, summary, undefined, got)).toEqual(checkpointData(line, summary));
  // A part of a branch that does not start at its first event is settled in place.
  expect(settleAsk(line.slice(2), summary)).toBeNull();
  store.db.close();
});
