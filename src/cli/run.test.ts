// Which of a session's events a staying command counts as its own prompt's
// work, over histories a real daemon gives only with a failing provider and a
// subagent timed against it: a stand-in daemon serves them.
import { expect, test } from "bun:test";
import { Client } from "./client.ts";
import { resultObject, treeUsage, watch } from "./run.ts";

const SID = "s1";
const say = (text: string) => ({ kind: "assistant", data: { blocks: [{ type: "text", text }] } });
const end = { kind: "turn_end", data: { reason: "end_turn" } };
const own = [{ kind: "user", data: { text: "go" } }, { kind: "turn_start" }, say("First."), end];
const other = { kind: "user", data: { text: "another prompt" } };
const report = { kind: "user", data: { text: "a report", kind: "subagent" } };

async function watched(history: any[], stay: "turn" | "all" = "all", full = false): Promise<any> {
  const events = history.map((e, i) => ({ data: {}, ...e, id: `e${i + 1}`, session_id: SID, seq: i + 1, ts: 0 }));
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname.endsWith("/events")) return Response.json({ events: events.filter((e) => e.seq > Number(u.searchParams.get("after"))) });
      if (u.pathname.startsWith("/api/cli/state/")) return Response.json({ last_seq: events.length, running: false, queue: 0, held: false, approvals: [], questions: [], background: { agents: 0, waits: 0, jobs: 0 } });
      return new Response("", { status: 404 }); // no socket: the events are read by seq
    },
  });
  try {
    const w = await watch({ c: new Client(`http://127.0.0.1:${server.port}`), sessionId: SID, afterSeq: 0, eventId: "e1", prompt: "go", stay, onAsk: "deny", t0: Date.now(), ...(full ? { timeoutS: 2 } : {}) });
    return full ? [w.subtype, w.outcome, w.errors, w.turns] : [w.answer, w.turns, w.errors];
  } finally {
    server.stop(true);
  }
}

test("another prompt's turn hides only itself from a command that stays for its work", async () => {
  expect({
    "a turn of theirs": await watched([...own, other, { kind: "turn_start" }, say("Theirs."), end]),
    "theirs failed before it started": await watched([...own, other, { kind: "error", data: { message: "no such model" } }, report, { kind: "turn_start" }, say("After the report."), end]),
    "a report joined their turn": await watched([...own, other, { kind: "turn_start" }, say("Theirs."), report, say("With the report."), end]),
  }).toEqual({
    "a turn of theirs": ["First.", 1, []],
    "theirs failed before it started": ["After the report.", 2, []],
    "a report joined their turn": ["With the report.", 2, []],
  });
});

// The command's own prompt fails while its turn is set up (no provider, no
// such model): an error and no turn. That is the end of its work, for --wait
// (the turn) and for -p (the turn and what it left running) alike, at once
// and as a failure, not a wait for a turn end that never comes.
test("the command's own prompt that fails before its turn starts ends the wait at once, as a failure", async () => {
  const failed = [{ kind: "user", data: { text: "go" } }, { kind: "error", data: { message: "no such model" } }];
  const t0 = Date.now();
  expect(await watched(failed, "turn", true)).toEqual(["error_during_execution", "failure", ["no such model"], 0]);
  expect(await watched(failed, "all", true)).toEqual(["error_during_execution", "failure", ["no such model"], 0]);
  expect(Date.now() - t0).toBeLessThan(1500);
  // A turn that started and failed is told by its end, as before, and counted once.
  const started = [{ kind: "user", data: { text: "go" } }, { kind: "turn_start" }, { kind: "turn_end", data: { reason: "error" } }, { kind: "error", data: { message: "overloaded" } }];
  expect(await watched(started, "all", true)).toEqual(["error_during_execution", "failure", ["overloaded"], 1]);
  // A retry of the owner's after the failure is theirs, not this command's.
  expect(await watched([...failed, other, { kind: "turn_start" }, say("Theirs."), end], "all", true)).toEqual(["error_during_execution", "failure", ["no such model"], 0]);
});

// The cost a run reports is the whole tree's: the usage the daemon sums for the session and its agents.
test("a run's usage is the tree's, and its agents come grouped by definition with their launches", async () => {
  const sum = (o: Record<string, number | string>) => ({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, calls: 1, priced_cost_usd: 0, unpriced_calls: 0, incomplete_calls: 0, ...o });
  let asked = "";
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      asked = req.url;
      return Response.json({
        total: sum({ calls: 3, input_tokens: 30, output_tokens: 9, priced_cost_usd: 0.75 }),
        buckets: [sum({ key: "", input_tokens: 10, output_tokens: 3, priced_cost_usd: 0.25 }), sum({ key: "Explore", launches: 2, calls: 2, input_tokens: 20, output_tokens: 6, priced_cost_usd: 0.5 })],
      });
    },
  });
  try {
    const w: any = { usage: { input: 10, output: 3, cache_read: 0, cache_write: 0, cost: 0.25, unpriced: 0 }, agents: [] };
    await treeUsage(new Client(`http://127.0.0.1:${server.port}`), w, "s 1", 1234.7);
    expect(new URL(asked).searchParams.get("tree_of")).toBe("s 1");
    expect(new URL(asked).searchParams.get("since_ms")).toBe("1234");
    expect(w.usage).toMatchObject({ input: 30, output: 9, cost: 0.75, unpriced: 0 });
    expect(w.agents).toEqual([{ name: "Explore", launches: 2, input: 20, output: 6, cache_read: 0, cache_write: 0, cost: 0.5 }]);
    expect(resultObject({ ...w, subtype: "success", outcome: "success", answer: "", errors: [], turns: 1, pending: 0, refused: 0, held: false }, { sessionId: "s1", url: "u", ms: 1, onAsk: "deny" })).toMatchObject({ total_cost_usd: 0.75, agents: [{ name: "Explore", launches: 2, cost: 0.5 }] });
  } finally {
    server.stop(true);
  }
  // A daemon that cannot answer leaves the session's own count.
  const w: any = { usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, cost: 0.1, unpriced: 0 }, agents: [] };
  await treeUsage(new Client("http://127.0.0.1:1"), w, "s1", 0);
  expect(w.usage.cost).toBe(0.1);
});
