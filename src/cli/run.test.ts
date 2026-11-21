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

async function watched(history: any[]) {
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
    const w = await watch({ c: new Client(`http://127.0.0.1:${server.port}`), sessionId: SID, afterSeq: 0, eventId: "e1", prompt: "go", stay: "all", onAsk: "deny", t0: Date.now() });
    return [w.answer, w.turns, w.errors];
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
