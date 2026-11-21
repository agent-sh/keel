// How a prompt gets from the queue into a turn: logic of the turn loop and the
// store that a page cannot time (which branch a steer joins, a daemon killed
// between two writes), so it is driven here on the real engine and database
// with the scripted stand-in as the model.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
  ["dequeue", "claimed"], ["dequeue", "stored"], ["dequeue", "delivered"],
  ["steer", "claimed"], ["steer", "stored"], ["steer", "delivered"],
  ["send-now", "stopping"], ["send-now", "claimed"], ["send-now", "stored"], ["send-now", "delivered"],
];
// Which side of the move each kill lands on: inside the one write the row is
// still queued, after it the prompt is stored.
const lands: Record<string, string> = { stopping: "1 queued, 0 stored", claimed: "1 queued, 0 stored", stored: "1 queued, 0 stored", delivered: "0 queued, 1 stored" };
for (const [scenario, point] of kills) {
  test(`a daemon killed during ${scenario} (${point}) neither loses nor doubles the queued prompt`, async () => {
    const dir = scratch(`kill-${scenario}-${point}`);
    const { session: sid, queued: qid } = await killedDaemon(dir, scenario, point);

    // The next daemon on the same state.
    const { store, engine, requests } = rig(dir);
    const pending = store.queue(sid).filter((q) => q.id === qid);
    const stored = promptsOf(store, sid, qid);
    expect([pending.length, stored.length].join(" queued, ") + " stored").toBe(lands[point]!);
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

// Send now that cannot store its prompt (the write fails) leaves everything as
// it was and says so: the row is queued again in the open pages, and the
// queue is still paused in memory as it is in the table.
test("a Send now whose write fails puts the row back in the queue the pages show", async () => {
  let queued!: () => void;
  const waiting = new Promise<void>((r) => (queued = r));
  const { store, bus, engine, session } = rig(scratch("send-now-fails"), {
    request: async (req) => {
      engine.send(s.id, QUEUED.text, { mode: "queue" });
      queued();
      await untilStopped(req);
    },
  });
  const s = session();
  const shown: string[][] = [];
  bus.on((f) => { if (f.t === "queue" && f.session_id === s.id) shown.push(f.queue.map((q) => q.text)); });
  engine.send(s.id, "first");
  await waiting;
  const [q] = store.queue(s.id);
  const append = store.append.bind(store);
  store.append = (sid, kind, data, parent) => {
    if (kind === "user" && (data as any)?.queue_id) throw new Error("the disk is full");
    return append(sid, kind, data, parent);
  };
  await expect(engine.sendNow(s.id, q!.id)).rejects.toThrow("the disk is full");
  expect(store.queue(s.id).map((x) => x.text)).toEqual([QUEUED.text]);
  expect(promptsOf(store, s.id, q!.id)).toEqual([]);
  const inTable = !!store.db.query("SELECT 1 FROM queue_holds WHERE session_id = ?").get(s.id);
  expect({ shown: shown.at(-1), held: engine.isHeld(s.id), inTable }).toEqual({ shown: [QUEUED.text], held: true, inTable: true });
});

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

// Only the working mark makes a session a candidate, and the mark is cleared
// by whichever build starts next. A prompt that was stored and never run on
// old data (an import, a stop before the turn, a build without this
// recovery) is not run by a later start: that would be a model call nobody
// asked for.
test("a stored prompt in a session that is not marked as working is never run at a start", async () => {
  const dir = scratch("idle-prompt");
  const a = rig(dir);
  const s = a.session();
  a.store.append(s.id, "user", { text: "stored long ago, never run" });
  const { store, engine, requests } = rig(dir);
  expect(store.bootWorking).toEqual([]);
  await engine.recover(store.bootWorking, noRecover);
  await engine.idle(s.id);
  expect(requests).toEqual([]);
  expect(store.events(s.id).map((e) => e.kind)).toEqual(["user"]);
});

// A rollback: this build opens the store and dies before it recovers
// anything, the build before it starts (its start sets every working session
// idle and knows nothing of unstarted prompts), then this build starts again.
// Nothing is left over from the first start for the last one to act on.
for (const [scenario, point, shape] of [["send", "setup", "a prompt whose turn never started"], ["steer", "claimed", "a turn left open"]] as const) {
  test(`after a rollback to a build that only resets the marks, a later start runs nothing for ${shape}`, async () => {
    const dir = scratch(`rollback-${scenario}`);
    const { session: sid } = await killedDaemon(dir, scenario, point);
    await killedDaemon(dir, "recover", "boot");
    const old = new Database(join(dir, "keel.db"));
    old.run("UPDATE sessions SET phase = 'idle' WHERE phase = 'working'");
    old.close();

    const { store, engine, requests } = rig(dir);
    const stored = store.events(sid).length;
    expect(store.bootWorking).toEqual([]);
    await engine.recover(store.bootWorking, noRecover);
    await engine.idle(sid);
    expect(requests).toEqual([]);
    expect(store.events(sid).length).toBe(stored);
    expect(store.session(sid)!.phase).toBe("idle");
  }, 30_000);
}

// An earlier prompt whose setup failed (it said so, and is not owed a turn)
// does not hide the prompt sent after it.
test("a prompt accepted after a failed setup is still run when the daemon dies in its setup", async () => {
  const dir = scratch("after-error");
  const a = rig(dir);
  const s = a.session();
  a.store.append(s.id, "user", { text: "first try" });
  a.store.append(s.id, "error", { message: "the provider is down" });
  a.store.append(s.id, "user", { text: "second try" });
  a.store.updateSession(s.id, { phase: "working" });

  const { store, engine, requests } = rig(dir);
  await engine.recover(store.bootWorking, noRecover);
  await engine.idle(s.id);
  expect(requests.map((r) => r.filter((t) => t === "second try").length)).toEqual([1]);
  expect(engine.lineage(s.id).at(-1)).toMatchObject({ kind: "turn_end", data: { reason: "end_turn" } });
});

// A session that runs a turn of this start (a monitor's wake delivered while
// the daemon starts) is not a leftover of the last daemon, also when it was
// listed at the start.
test("recovery leaves a session alone whose turn of this start is still in setup", async () => {
  let ready!: () => void;
  const gate = new Promise<void>((r) => (ready = r));
  const { store, engine, requests, session } = rig(scratch("running-at-recover"), { setup: () => gate });
  const s = session();
  engine.send(s.id, "delivered while the daemon starts");
  await engine.recover([s.id], noRecover);
  expect(store.events(s.id).map((e) => e.kind)).toEqual(["user"]);
  ready();
  await engine.idle(s.id);
  expect(store.events(s.id).map((e) => e.kind)).toEqual(["user", "turn_start", "assistant", "turn_end"]);
  expect(requests.length).toBe(1);
});

// Stop while the turn is still being set up closes the turn at once, as
// stopped: the stop is stored before the setup settles, so a daemon killed in
// between does not run the prompt at its next start. Continue runs it.
test("a stop during setup closes the turn at once", async () => {
  // Closed when Stop is pressed, and nothing is asked of the model.
  let ready!: () => void;
  const gate = new Promise<void>((r) => (ready = r));
  const one = rig(scratch("stop-in-setup"), { setup: () => gate });
  const s = one.session();
  one.engine.send(s.id, SENT.text);
  const stopped = one.engine.interrupt(s.id, "owner");
  expect(one.store.events(s.id).map((e) => [e.kind, e.data.reason, e.data.stopped_by])).toEqual([["user", undefined, undefined], ["turn_start", undefined, undefined], ["turn_end", "interrupted", "owner"]]);
  ready();
  await stopped;
  expect(one.store.events(s.id).length).toBe(3);
  expect([one.requests.length, one.store.session(s.id)!.phase, one.engine.isHeld(s.id)]).toEqual([0, "idle", true]);
});

test("a daemon killed right after a stop during setup does not run the prompt at its next start", async () => {
  const dir = scratch("stop-in-setup-kill");
  const { session: sid } = await killedDaemon(dir, "stop", "stopping");
  const { store, engine, requests } = rig(dir);
  await engine.recover(store.bootWorking, noRecover);
  await engine.idle(sid);
  expect(requests).toEqual([]);
  expect(engine.lineage(sid).map((e) => [e.kind, e.data.reason])).toEqual([["user", undefined], ["turn_start", undefined], ["turn_end", "interrupted"]]);
  expect([store.session(sid)!.phase, engine.isHeld(sid)]).toEqual(["idle", true]);
  engine.resume(sid);
  await engine.idle(sid);
  expect(requests.map((r) => r.filter((t) => t === SENT.text).length)).toEqual([1]);
}, 30_000);

// One session whose history cannot be read (a stored reply without blocks)
// must not stop the start for the others, nor leave their marks behind.
test("a session recovery cannot read is set aside and the others are still recovered", async () => {
  const dir = scratch("bad-session");
  const a = rig(dir);
  const bad = a.session();
  a.store.append(bad.id, "user", { text: "unreadable" });
  a.store.append(bad.id, "turn_start", { model: bad.model });
  a.store.append(bad.id, "assistant", {} as any);
  a.store.updateSession(bad.id, { phase: "working" });
  const good = a.session();
  a.store.append(good.id, "user", { text: "owed a turn" });
  a.store.updateSession(good.id, { phase: "working" });

  const { store, engine, requests } = rig(dir);
  await engine.recover(store.bootWorking, noRecover);
  await engine.idle(good.id);
  expect(requests.map((r) => r.filter((t) => t === "owed a turn").length)).toEqual([1]);
  expect([store.session(bad.id)!.phase, store.session(good.id)!.phase]).toEqual(["idle", "idle"]);
  expect(store.events(bad.id).map((e) => e.kind)).toEqual(["user", "turn_start", "assistant"]);
});
