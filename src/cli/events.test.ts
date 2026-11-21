// The follower between its two sources, in orders a real daemon gives only by
// chance: a stand-in daemon whose stored events and socket frames the test sets.
import { afterEach, expect, test } from "bun:test";
import { Client } from "./client.ts";
import { Follower } from "./events.ts";

const SID = "s1";
const ev = (seq: number, kind: string, text?: string) => ({ id: `e${seq}`, session_id: SID, seq, kind, ts: 0, data: text ? { blocks: [{ type: "text", text }] } : {} });
let stop: (() => void) | undefined;
afterEach(() => stop?.());

async function follow(onEvent: (e: any) => void, onDelta?: (d: any) => void) {
  const stored: any[] = [];
  let sock: Bun.ServerWebSocket<unknown> | undefined;
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req, srv) {
      const u = new URL(req.url);
      if (u.pathname === "/ws") return srv.upgrade(req) ? undefined : new Response("", { status: 400 });
      return Response.json({ events: stored.filter((e) => e.seq > Number(u.searchParams.get("after"))) });
    },
    websocket: { message(ws) { sock = ws; } }, // its resume
  });
  const f = new Follower(new Client(`http://127.0.0.1:${server.port}`), SID, 0, onEvent, onDelta);
  stop = () => { f.close(); server.stop(true); };
  await f.connect();
  for (let i = 0; i < 200 && !sock; i++) await Bun.sleep(5);
  // Sends frames one by one, each once the follower has had the one before:
  // an event wakes it, and so does the queue frame sent after any other.
  const frames = async (...fs: any[]) => {
    for (const x of fs) {
      const woke = f.pause(1000);
      sock!.send(JSON.stringify(x));
      if (x.t !== "event") sock!.send(JSON.stringify({ t: "queue" }));
      await woke;
    }
  };
  return { f, stored, frames };
}

test("a reply whose beginning was not passed on is passed on whole by its event", async () => {
  const out: string[] = [];
  const { f, stored, frames } = await follow((e) => out.push(`event ${e.seq}`), (d) => out.push(d.text));
  // Event 1 was stored with no frame, so the socket is ahead when the reply starts to stream.
  stored.push(ev(1, "note"), ev(2, "turn_start"));
  await frames({ t: "event", event: stored[1] }, { t: "delta", session_id: SID, kind: "text", text: "Hel" });
  await f.read();
  stored.push(ev(3, "assistant", "Hello."));
  await frames({ t: "delta", session_id: SID, kind: "text", text: "lo." }, { t: "event", event: stored[2] });
  // The next reply streams from its first delta again.
  stored.push(ev(4, "assistant", "Bye."));
  await frames({ t: "delta", session_id: SID, kind: "text", text: "By" }, { t: "delta", session_id: SID, kind: "text", text: "e." }, { t: "event", event: stored[3] });
  expect(out).toEqual(["event 1", "event 2", "Hello.", "event 3", "By", "e.", "event 4"]);
});

test("what a callback throws on a socket frame comes out of the next read", async () => {
  const { f, stored, frames } = await follow(() => { throw new Error("the output is closed"); });
  stored.push(ev(1, "turn_end"));
  await frames({ t: "event", event: stored[0] });
  await expect(f.read()).rejects.toThrow("the output is closed");
});
