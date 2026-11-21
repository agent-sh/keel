// How a prompt gets from the queue into a turn: logic of the turn loop and the
// store that a page cannot time (which branch a steer joins, a daemon killed
// between two writes), so it is driven here on the real engine and database
// with the scripted stand-in as the model.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { promptsOf, QUEUED, rig, SENT, untilStopped } from "./delivery.fixture.ts";
import { STALLED_MAX } from "./turn.ts";

const scratch = (name: string) => mkdtempSync(join(process.env.TMPDIR ?? ".", `${name}-`));
const image = { type: "image" as const, media_type: "image/png", data: "iVBORw0KGgo=" };

// A steer is the same row as a queued prompt with a mark on it: it carries the
// branch it was written on, and the running turn takes it only on that branch.
test("a steer written on another branch waits for the owner instead of joining this branch's turn", async () => {
  let enqueued!: () => void;
  const waiting = new Promise<void>((r) => (enqueued = r));
  const { store, engine, requests, session } = rig(scratch("steer-branch"), {
    request: async (req) => {
      // The turn on branch B is held open while the owner queues a prompt on it.
      if (!JSON.stringify(req.messages).includes("second, on branch B")) return;
      engine.send(s.id, "meant for branch B", { mode: "queue", images: [image] });
      enqueued();
      await untilStopped(req);
    },
  });
  const s = session();
  engine.send(s.id, "first");
  await engine.idle(s.id);
  const branchA = store.session(s.id)!.head!;
  engine.send(s.id, "second, on branch B");
  await waiting;
  await engine.interrupt(s.id);
  const [q] = store.queue(s.id);
  expect(q?.text).toBe("meant for branch B");

  // The owner goes back to where branch A ends, marks the row a steer and sends a prompt there.
  store.updateSession(s.id, { head: branchA });
  store.updateQueueItem(q!.id, { steer: true });
  expect(engine.offBranch(store.queueItem(q!.id)!)).toBe(true);
  const before = requests.length;
  engine.send(s.id, "third, on branch A");
  await engine.idle(s.id);

  // The turn on A ran alone: one request, without the steer, and the row still waits.
  expect(requests.slice(before).map((r) => r.join("|"))).toEqual(["first|third, on branch A"]);
  expect(promptsOf(store, s.id, q!.id)).toEqual([]);
  expect(store.queue(s.id).map((x) => [x.id, x.steer, x.text])).toEqual([[q!.id, true, "meant for branch B"]]);
  expect(engine.isHeld(s.id)).toBe(true);
  expect(engine.lineage(s.id).at(-1)?.data.reason).toBe("end_turn");

  // Only the owner's choice sends it on this branch: once, whole, with its attachment.
  engine.resumeQueue(s.id, true);
  await engine.idle(s.id);
  const sent = promptsOf(store, s.id, q!.id);
  expect(sent.map((e) => [e.data.text, e.data.images])).toEqual([["meant for branch B", [image]]]);
  expect(engine.lineage(s.id).some((e) => e.id === sent[0]!.id)).toBe(true);
  expect(store.queue(s.id)).toEqual([]);
  expect(requests.at(-1)!.join("|")).toBe("first|third, on branch A|meant for branch B");
});

// The daemon is killed (SIGKILL, in a process of its own: delivery.child.ts)
// at each point of a queued prompt's way into a turn, and the next daemon
// opens the same state. What the owner was told is queued is then still
// queued or is one stored prompt, never neither and never both, with its
// words and its attachment; once it has run there is exactly one.
// A daemon on `dir` that kills itself at `point` of `scenario`; what it said first.
async function killedDaemon(dir: string, scenario: string, point: string): Promise<{ session: string; queued: string }> {
  const child = Bun.spawn(["bun", join(import.meta.dir, "delivery.child.ts"), dir, scenario, point], { stdout: "pipe", stderr: "inherit" });
  const said = (await new Response(child.stdout).text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  await child.exited;
  expect(child.signalCode).toBe("SIGKILL");
  expect(said.at(-1)).toEqual({ killed_at: point });
  return said[0];
}

const kills: [string, string][] = [
  ["dequeue", "claimed"], ["dequeue", "stored"],
  ["steer", "claimed"], ["steer", "stored"],
  ["send-now", "stopping"], ["send-now", "claimed"], ["send-now", "stored"],
];
for (const [scenario, point] of kills) {
  test(`a daemon killed during ${scenario} (${point}) neither loses nor doubles the queued prompt`, async () => {
    const dir = scratch(`kill-${scenario}-${point}`);
    const { session: sid, queued: qid } = await killedDaemon(dir, scenario, point);

    // The next daemon on the same state.
    const { store, engine, requests } = rig(dir);
    const pending = store.queue(sid).filter((q) => q.id === qid);
    const stored = promptsOf(store, sid, qid);
    expect([pending.length, stored.length].join(" queued, ") + " stored").toBeOneOf(["1 queued, 0 stored", "0 queued, 1 stored"]);
    for (const x of [...pending, ...stored.map((e) => e.data)]) expect([x.text, x.images]).toEqual([QUEUED.text, QUEUED.images]);

    // It goes on from there: the cut turn continues, and a prompt still queued
    // is sent by the queue itself or by the owner (Resume, or Send now again).
    await engine.recover(store.bootWorking, async () => {});
    await engine.idle(sid);
    if (store.queueItem(qid) && engine.isHeld(sid)) await engine.sendNow(sid, qid);
    else if (store.queueItem(qid)) engine.resumeQueue(sid);
    await engine.idle(sid);
    await engine.idle(sid);
    expect(store.queue(sid)).toEqual([]);
    expect(promptsOf(store, sid, qid).map((e) => [e.data.text, e.data.images])).toEqual([[QUEUED.text, QUEUED.images]]);
    expect(engine.lineage(sid).filter((e) => e.data.queue_id === qid).length).toBe(1);
    expect(requests.at(-1)!.filter((t) => t === QUEUED.text).length).toBe(1);
  }, 30_000);
}

// A prompt is accepted (the owner is told it was sent, or it left the queue)
// and the daemon is killed before the turn has started, while the turn
// resolves its provider. The next daemon runs it once: also when that daemon
// is killed during its own start (before it recovered anything, while it
// waits for the model, or with the continued turn in setup again).
const accepted: Record<string, { text: string; images: unknown }> = { send: SENT, dequeue: QUEUED, "send-now": QUEUED };
const noRecover = async () => {};
for (const scenario of Object.keys(accepted)) {
  for (const again of [undefined, "boot", "waiting", "setup"]) {
    test(`a prompt accepted by ${scenario} and killed in setup${again ? `, then again at the next start (${again}),` : ""} is run once`, async () => {
      const dir = scratch(`setup-${scenario}-${again ?? "once"}`);
      const { session: sid } = await killedDaemon(dir, scenario, "setup");
      if (again) await killedDaemon(dir, "recover", again);
      const want = accepted[scenario]!;

      const { store, engine, requests } = rig(dir);
      await engine.recover(store.bootWorking, noRecover);
      await engine.idle(sid);
      const line = engine.lineage(sid);
      const prompts = line.filter((e) => e.kind === "user" && e.data.text === want.text);
      expect(prompts.map((e) => e.data.images)).toEqual([want.images]);
      // One request carried it, and one reply follows it.
      expect(requests.map((r) => r.filter((t) => t === want.text).length)).toEqual([1]);
      expect(line.slice(line.indexOf(prompts[0]!)).filter((e) => e.kind === "assistant").length).toBe(1);
      expect(line.at(-1)).toMatchObject({ kind: "turn_end", data: { reason: "end_turn" } });
      expect(store.session(sid)!.phase).toBe("idle");

      // A start after that replays nothing: the turn is done.
      const next = rig(dir);
      const stored = next.store.events(sid).length;
      expect(next.store.bootWorking).toEqual([]);
      await next.engine.recover(next.store.bootWorking, noRecover);
      await next.engine.idle(sid);
      expect(next.requests).toEqual([]);
      expect(next.store.events(sid).length).toBe(stored);
    }, 30_000);
  }
}

// When it cannot be continued, it is held where the owner sees it: the turn
// reads as cut by the restart (what Continue is offered on), with the reason.
test("an accepted prompt that cannot be continued is held with Continue", async () => {
  const held = async (dir: string, sid: string, waitModel: () => Promise<void>, why: string) => {
    const { store, engine, requests } = rig(dir);
    await engine.recover(store.bootWorking, waitModel);
    const line = engine.lineage(sid);
    expect(requests).toEqual([]);
    expect(line.at(-1)).toMatchObject({ kind: "note", data: { kind: "restart" } });
    expect(line.at(-1)!.data.text).toContain(why);
    expect(line.findLast((e) => e.kind === "turn_end")!.data.reason).toBe("restart");
    expect(store.session(sid)!.phase).toBe("idle");
    // The owner's Continue runs it, once.
    engine.resume(sid);
    await engine.idle(sid);
    expect(requests.map((r) => r.filter((t) => t === SENT.text).length)).toEqual([1]);
    expect(engine.lineage(sid).at(-1)).toMatchObject({ kind: "turn_end", data: { reason: "end_turn" } });
  };

  // Its model does not come back.
  const gone = scratch("setup-held-model");
  const a = await killedDaemon(gone, "send", "setup");
  await held(gone, a.session, async () => { throw new Error("no provider lists this model"); }, "no provider lists this model");

  // Every continuation dies in setup again: it is not tried for ever.
  const dying = scratch("setup-held-stalled");
  const b = await killedDaemon(dying, "send", "setup");
  for (let i = 0; i < STALLED_MAX; i++) await killedDaemon(dying, "recover", "setup");
  await held(dying, b.session, noRecover, `${STALLED_MAX} times in a row`);
}, 60_000);
