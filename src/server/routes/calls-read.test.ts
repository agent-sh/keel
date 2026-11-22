// The newest accepted call of a tool on a branch, answered from the search
// index and a few rows instead of a walk over the branch's bodies: the same
// answer as that walk, on generated sessions.
import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../core/store.ts";
import { firstAt } from "../../core/tree.ts";
import type { StoredEvent } from "../../core/types.ts";
import { callAnswered, callsNamed, lastCall } from "./calls-read.ts";
import { initSearchIndex } from "./search.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// The route as it was: one walk back over the branch, every body read on the way.
function walk(line: readonly StoredEvent[], names: Set<string>, before: number | null) {
  const ok = new Set<string>();
  for (let i = (before !== null ? firstAt(line, before) : line.length) - 1; i >= 0; i--) {
    const e = line[i]!;
    if (e.kind === "tool_result") { for (const r of e.data.results) if (!r.is_error) ok.add(r.tool_use_id); continue; }
    if (e.kind !== "assistant") continue;
    for (let k = e.data.blocks.length - 1; k >= 0; k--) {
      const b = e.data.blocks[k];
      if (b.type === "tool_use" && names.has(b.name) && ok.has(b.id)) return { name: b.name, input: b.input, seq: e.seq };
    }
  }
  return null;
}

test("the last accepted call is the one a walk over the branch finds, with no body of the session read on the loop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-calls-"));
  dirs.push(dir);
  const store = new Store(dir);
  initSearchIndex(store.db);
  let rnd = 11;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)]!;
  const TOOLS = ["TodoWrite", "update_plan", "write_todos", "Bash", "Read", "mcp__plans__update_plan", "TodoWriter", "++"];
  const asks: string[][] = [["TodoWrite", "update_plan", "write_todos"], ["TodoWrite"], ["Bash"], ["update_plan", "++"], ["mcp__plans__update_plan"], ["NoSuchTool"], []];
  let compared = 0, found = 0, plans = 0;
  for (let n = 0; n < 12; n++) {
    const s = store.createSession({ model: "m", workspace: "/" });
    const ids: string[] = [];
    let call = 0;
    // Sparse sessions too: the plan tools are called seldom, or never.
    const planShare = n % 3 === 0 ? 0 : n % 3 === 1 ? 0.03 : 0.3;
    for (let turn = 0; turn < 30; turn++) {
      // An edited prompt: the turn starts from an earlier event, and what followed that one is another branch.
      const parent = ids.length > 6 && rand() < 0.2 ? pick(ids) : undefined;
      ids.push(store.append(s.id, "user", { text: `prompt ${turn} about TodoWrite and update_plan` }, parent).id);
      for (let step = 0; step < 1 + Math.floor(rand() * 4); step++) {
        const calls = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => {
          const name = rand() < planShare ? pick(TOOLS.slice(0, 3)) : pick(TOOLS.slice(3));
          if (TOOLS.indexOf(name) < 3) plans++;
          // (Ids repeat now and then, as some providers' do.)
          return { type: "tool_use", id: rand() < 0.1 ? `call_${Math.floor(rand() * 5)}` : `t${n}_${++call}`, name, input: { todos: [{ content: `item ${call} "quoted" TodoWrite`, status: "pending" }], n: call } };
        });
        // A declined reply ends its turn: its calls are never run (and the index leaves it out).
        const declined = rand() < 0.05;
        ids.push(store.append(s.id, "assistant", { blocks: [{ type: "text", text: "I will call update_plan" }, ...calls], stop: declined ? "refusal" : "tool_use" }).id);
        if (declined) break;
        // Each result by itself; some are errors, some calls get none, one now and then is answered twice.
        for (const c of calls) {
          if (rand() < 0.1) continue;
          ids.push(store.append(s.id, "tool_result", { results: [{ type: "tool_result", tool_use_id: c.id, content: "TodoWrite done", ...(rand() < 0.3 ? { is_error: true } : {}) }] }).id);
          if (rand() < 0.05) ids.push(store.append(s.id, "tool_result", { results: [{ type: "tool_result", tool_use_id: c.id, content: "again" }] }).id);
        }
      }
      ids.push(store.append(s.id, "turn_end", { reason: "end_turn" }).id);
    }
    const line = store.lineage(s.id);
    const last = store.lastSeq(s.id);
    // What is asked on the loop reads no body of the session: the read thread's reads do (here they run in place).
    const body = spyOn(store as any, "bodyOf");
    const answers: unknown[] = [];
    const wanted: { names: string[]; before: number | null }[] = [];
    for (const names of asks) for (const before of [null, last + 1, last, Math.floor(last / 2), line[Math.floor(line.length / 3)]!.seq, 3, 0]) wanted.push({ names, before });
    for (const w of wanted) {
      // (Small parts, so an answer is put together from several reads: the loop's own first, then the thread's.)
      answers.push(await lastCall({ db: store.db, named: async (a) => callsNamed(store.db, { ...a, max: 7 }), answered: async (a) => callAnswered(store.db, a), line: () => store.lineage(s.id) }, s.id, w.names, w.before, { rows: 5, span: 3 }));
    }
    expect(body).toHaveBeenCalledTimes(0);
    body.mockRestore();
    wanted.forEach((w, i) => {
      const want = walk(line, new Set(w.names), w.before);
      expect({ ...w, call: answers[i] }).toEqual({ ...w, call: want });
      compared++;
      if (want) found++;
    });
  }
  // The generated sessions hold what is compared: plan calls, and asks with and without an answer.
  expect(plans).toBeGreaterThan(40);
  expect(found).toBeGreaterThan(compared / 5);
  expect(compared - found).toBeGreaterThan(compared / 5);
  store.db.close();
});
