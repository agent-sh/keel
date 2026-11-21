// Which of a session's events a staying command counts as its own prompt's
// work, over histories a real daemon gives only with a failing provider and a
// subagent timed against it: a stand-in daemon serves them.
import { expect, test } from "bun:test";
import { Client } from "./client.ts";
import { watch } from "./run.ts";

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
