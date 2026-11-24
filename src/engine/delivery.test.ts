// How a prompt gets from the queue into a turn: logic of the turn loop and the
// store that a page cannot time (which branch a steer joins, a daemon killed
// between two writes), so it is driven here on the real engine and database
// with the scripted stand-in as the model.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { promptsOf, QUEUED, rig, SENT, untilStopped } from "./delivery.fixture.ts";
import { allHooks, registerHooks } from "./hooks.ts";
import { STALLED_MAX } from "./turn.ts";
import { turnRoutes } from "../server/routes/turns.ts";

// Turn hooks are process-wide: the files after this one run without the ones its tests register.
const hooksAtStart = allHooks().length;
afterAll(() => { allHooks().length = hooksAtStart; });

const scratch = (name: string) => mkdtempSync(join(process.env.TMPDIR ?? ".", `${name}-`));
const image = { type: "image" as const, media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" };

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
  await engine.interrupt(s.id, "owner");
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

// A daemon stop that parks a turn still in setup, whose setup then fails (a
// provider that went down first): the prompt keeps a turn, closed as cut at
// its start, and the next daemon runs it. Before, the failure was dropped with
// the stop: a prompt with no turn, no error, an idle session and nothing to continue.
test("a turn parked in setup whose setup then fails is run by the next start", async () => {
  const dir = scratch("park-setup-fails");
  let fail!: (e: Error) => void;
  let inSetup!: () => void;
  const reached = new Promise<void>((r) => (inSetup = r));
  const first = rig(dir, { setup: () => new Promise<void>((_, reject) => { fail = reject; inSetup(); }) });
  const s = first.session();
  const ends: string[] = [];
  // The setup fails once the turn is being parked.
  registerHooks({ turnEnd: (x, reason) => { if (x.id === s.id) ends.push(reason); }, turnParking: (id) => { if (id === s.id) fail(new Error("the provider is gone")); } });
  first.engine.send(s.id, SENT.text);
  await reached;
  await first.engine.drain(0);
  const line = first.engine.lineage(s.id);
  expect(line.map((e) => e.kind)).toEqual(["user", "turn_start", "turn_end"]);
  expect(line.at(-1)!.data).toMatchObject({ reason: "restart", unstarted: true });
  expect(ends).toEqual(["restart"]);
  expect(first.requests).toEqual([]);
  first.store.db.close();

  const next = rig(dir);
  await next.engine.recover(next.store.bootWorking, async () => {});
  await next.engine.idle(s.id);
  expect(next.requests.map((r) => r.filter((t) => t === SENT.text).length)).toEqual([1]);
  expect(next.engine.lineage(s.id).filter((e) => e.kind === "turn_end").map((e) => e.data.reason)).toEqual(["restart", "end_turn"]);
});

// Send now on two queued rows while one stop is still under way: the first
// starts its turn and the second is the next prompt, after that turn. Before,
// both started a turn, and the two ran side by side in one session.
test("two Send now calls on different rows during one stop start one turn, then the other", async () => {
  let queued!: () => void;
  const waiting = new Promise<void>((r) => (queued = r));
  let live = 0, most = 0;
  const { store, engine, requests, session } = rig(scratch("send-now-twice"), {
    request: async (req) => {
      if (!requests.slice(0, -1).length) {
        engine.send(s.id, "row A", { mode: "queue" });
        engine.send(s.id, "row B", { mode: "queue" });
        engine.send(s.id, "row C", { mode: "queue" });
        queued();
        await untilStopped(req);
      }
      most = Math.max(most, ++live);
      await Bun.sleep(20);
      live--;
    },
  });
  const s = session();
  engine.send(s.id, "first");
  await waiting;
  const [a, b, c] = store.queue(s.id);
  // B first, then A, both before the stop has ended.
  await Promise.all([engine.sendNow(s.id, b!.id), engine.sendNow(s.id, a!.id)]);
  expect(store.queue(s.id).map((x) => x.text)).toEqual(["row A", "row C"]);
  expect(engine.isHeld(s.id)).toBe(false);
  for (let i = 0; i < 200 && (engine.isRunning(s.id) || store.queue(s.id).length); i++) await engine.idle(s.id).then(() => Bun.sleep(1));
  expect(most).toBe(1);
  const line = engine.lineage(s.id);
  // Each turn ends before the next prompt is stored.
  expect(line.filter((e) => e.kind !== "assistant").map((e) => (e.kind === "user" ? e.data.text : e.kind === "turn_end" ? e.data.reason : e.kind))).toEqual([
    "first", "turn_start", "interrupted", "row B", "turn_start", "end_turn", "row A", "turn_start", "end_turn", "row C", "turn_start", "end_turn",
  ]);
  for (const q of [a!, b!, c!]) expect(promptsOf(store, s.id, q.id)).toHaveLength(1);
});

// A sender names its input with a key of its own (a tool call, a send id).
// Asked twice, it is delivered once: whether the first was stored as the
// session's prompt, is still a row in its queue, or has left the queue since.
test("an input sent again under its sender's key is stored once", async () => {
  let reached!: () => void;
  const waiting = new Promise<void>((r) => (reached = r));
  let go!: () => void;
  const gate = new Promise<void>((r) => (go = r));
  let held = false;
  const { store, engine, session } = rig(scratch("input-key"), {
    request: async (req) => {
      if (held || !JSON.stringify(req.messages).includes("held open")) return;
      held = true;
      reached();
      await gate;
    },
  });
  const s = session();
  const texts = () => store.events(s.id).filter((e) => e.kind === "user").map((e) => e.data.text);
  const meta = { kind: "steer", agent_id: "ag_1" };

  // To an idle session: the prompt, once.
  expect(engine.send(s.id, "a wake, sent once", { meta: { kind: "wait" }, key: "wake-1" }).event).toBeTruthy();
  expect(engine.send(s.id, "a wake, sent once", { meta: { kind: "wait" }, key: "wake-1" })).toEqual({ duplicate: true });
  await engine.idle(s.id);

  // To a working one: one row in its queue, however often it is asked.
  engine.send(s.id, "held open");
  await waiting;
  const first = engine.message(s.id, "from the parent", meta, { key: "call-7" });
  expect(first.queued).toMatchObject({ steer: true, text: "from the parent", meta });
  expect(engine.message(s.id, "from the parent", meta, { key: "call-7" })).toEqual({ duplicate: true });
  expect(store.queue(s.id).map((q) => q.id)).toEqual([first.queued!.id]);

  // The running turn takes it at its next step; asked again after that, nothing is stored.
  go();
  await engine.idle(s.id);
  expect(engine.message(s.id, "from the parent", meta, { key: "call-7" })).toEqual({ duplicate: true });
  await engine.idle(s.id);
  expect(texts()).toEqual(["a wake, sent once", "held open", "from the parent"]);
  expect(promptsOf(store, s.id, first.queued!.id)).toHaveLength(1);
  expect(store.events(s.id).filter((e) => e.kind === "turn_start")).toHaveLength(2);
  expect(store.queue(s.id)).toEqual([]);

  // A key names an input of one session: another session's sender may use the same.
  const other = session();
  expect(engine.message(other.id, "from the parent", meta, { key: "call-7" }).event).toBeTruthy();
  await engine.idle(other.id);
});

// A stop leaves the messages the turn had not read in the queue, held. The
// sender's next message continues the session: the earlier ones go first, in
// the order they were sent, in one turn, and the hold is off.
test("messages a stop left unread are read first, in order, when the next one arrives", async () => {
  let reached!: () => void;
  const waiting = new Promise<void>((r) => (reached = r));
  let stopped = false;
  const { store, engine, requests, session } = rig(scratch("message-order"), {
    request: async (req) => {
      if (stopped) return;
      stopped = true;
      reached();
      await untilStopped(req);
    },
  });
  const s = session();
  const meta = { kind: "steer", agent_id: "ag_1" };
  engine.send(s.id, "the task");
  await waiting;
  engine.message(s.id, "one", meta);
  engine.message(s.id, "two", meta);
  await engine.interrupt(s.id, "parent");
  expect(store.queue(s.id).map((q) => [q.text, q.steer])).toEqual([["one", false], ["two", false]]);
  expect(engine.isHeld(s.id)).toBe(true);

  // The stop was the sender's own: its next message releases the hold it left.
  expect(engine.heldBy(s.id)).toBe("parent");
  expect(engine.message(s.id, "three", meta, { releases: ["parent"] }).queued).toBeTruthy();
  for (let i = 0; i < 200 && (engine.isRunning(s.id) || store.queue(s.id).length); i++) await engine.idle(s.id).then(() => Bun.sleep(1));
  expect(engine.isHeld(s.id)).toBe(false);
  const line = engine.lineage(s.id);
  expect(line.filter((e) => e.kind === "user").map((e) => e.data.text)).toEqual(["the task", "one", "two", "three"]);
  expect(line.filter((e) => e.kind === "turn_start")).toHaveLength(2);
  // The first request after the stop carried all of them.
  expect(requests[1]).toEqual(["the task", "one", "two", "three"]);
  expect(line.at(-1)).toMatchObject({ kind: "turn_end", data: { reason: "end_turn" } });
});

// A daemon on its way down starts no turn. A turn that ends by itself in that
// time leaves the prompt queued behind it with nothing to take it: the next
// start does, once. A queue the owner's stop holds stays as it is.
test("a prompt left queued when its turn ended while the daemon stopped starts at the next start", async () => {
  const dir = scratch("queued-at-stop");
  let reached!: () => void;
  const waiting = new Promise<void>((r) => (reached = r));
  let go!: () => void;
  const gate = new Promise<void>((r) => (go = r));
  const a = rig(dir, { request: async () => { reached(); await gate; } });
  const s = a.session();
  const stopped = a.session();
  a.store.enqueue(stopped.id, "held by the owner's stop", false);
  a.store.db.run("INSERT INTO queue_holds (session_id) VALUES (?)", [stopped.id]);
  a.engine.send(s.id, "first");
  await waiting;
  const q = a.engine.send(s.id, "queued while the first turn ran", { mode: "queue" }).queued!;
  const down = a.engine.drain(5_000);
  go();
  await down;
  expect(a.engine.lineage(s.id).at(-1)).toMatchObject({ kind: "turn_end", data: { reason: "end_turn" } });
  expect(a.store.queue(s.id).map((x) => x.id)).toEqual([q.id]);

  const b = rig(dir);
  await b.engine.recover(b.store.bootWorking, noRecover);
  for (let i = 0; i < 200 && (b.engine.isRunning(s.id) || b.store.queue(s.id).length); i++) await b.engine.idle(s.id).then(() => Bun.sleep(1));
  expect(promptsOf(b.store, s.id, q.id).map((e) => e.data.origin)).toEqual(["queued"]);
  expect(b.requests).toEqual([["first", "queued while the first turn ran"]]);
  expect(b.engine.lineage(s.id).at(-1)).toMatchObject({ kind: "turn_end", data: { reason: "end_turn" } });
  expect(b.store.queue(stopped.id).map((x) => x.text)).toEqual(["held by the owner's stop"]);
  expect(b.store.events(stopped.id)).toEqual([]);

  // A start after that has nothing left to deliver.
  const c = rig(dir);
  await c.engine.recover(c.store.bootWorking, noRecover);
  await Bun.sleep(20);
  expect(c.requests).toEqual([]);
  expect(promptsOf(c.store, s.id, q.id)).toHaveLength(1);
});

// The owner's Stop holds a session's queue until the owner resumes it. A
// message from the session it answers to never starts it and never takes the
// hold off, whenever it comes: before the stop (the stopped turn leaves it in
// the queue), after it, or while the daemon stops. The sender is told it is
// held. On Resume everything goes in the order it came, each once.
test("a message to a session the owner stopped waits for the owner's Resume, sent before the stop, after it or during a drain", async () => {
  const dir = scratch("message-owner-stop");
  let reached!: () => void;
  const waiting = new Promise<void>((r) => (reached = r));
  let stopped = false;
  const a = rig(dir, {
    request: async (req) => {
      if (stopped) return;
      stopped = true;
      reached();
      await untilStopped(req);
    },
  });
  const s = a.session();
  const meta = { kind: "steer", agent_id: "ag_1" };
  const mine = { releases: ["parent"] };
  a.engine.send(s.id, "the task");
  await waiting;
  expect(a.engine.message(s.id, "sent before the stop", meta, mine)).toMatchObject({ queued: { steer: true } });
  await a.engine.interrupt(s.id, "owner");
  expect(a.engine.heldBy(s.id)).toBe("owner");
  a.engine.send(s.id, "the owner's own queued prompt", { mode: "queue" });
  const requests = a.requests.length;

  const after = a.engine.message(s.id, "sent after the stop", meta, mine);
  expect(after).toMatchObject({ held: true, queued: { steer: false } });
  expect(after.event).toBeUndefined();
  await Bun.sleep(10);
  expect(a.engine.isRunning(s.id)).toBe(false);
  expect(a.engine.isHeld(s.id)).toBe(true);

  // While the daemon stops: held all the same, and not owed a start by the next one.
  await a.engine.drain(0);
  expect(a.engine.message(s.id, "sent during the drain", meta, mine)).toMatchObject({ held: true, queued: { steer: false } });
  const b = rig(dir);
  await b.engine.recover(b.store.bootWorking, noRecover);
  await Bun.sleep(20);
  expect(b.requests).toEqual([]);
  expect(a.requests.length).toBe(requests);
  expect(b.engine.heldBy(s.id)).toBe("owner");
  expect(b.store.queue(s.id).map((q) => q.text)).toEqual(["sent before the stop", "the owner's own queued prompt", "sent after the stop", "sent during the drain"]);

  // The owner resumes: each is read once, in the order it came.
  b.engine.resumeQueue(s.id);
  for (let i = 0; i < 400 && (b.engine.isRunning(s.id) || b.store.queue(s.id).length); i++) await b.engine.idle(s.id).then(() => Bun.sleep(1));
  expect(b.engine.lineage(s.id).filter((e) => e.kind === "user").map((e) => e.data.text)).toEqual(["the task", "sent before the stop", "the owner's own queued prompt", "sent after the stop", "sent during the drain"]);
  expect(b.engine.isHeld(s.id)).toBe(false);
});

// A hold is released only by the sender that made it. One the sender made and
// the owner then made theirs (a second stop) is the owner's; one nobody named
// is the owner's too, and a hold from before makers were kept is read from the
// stop of the last turn.
test("only the maker of a hold releases it with a message", async () => {
  const dir = scratch("hold-makers");
  const { store, engine, session } = rig(dir);
  const meta = { kind: "steer", agent_id: "ag_1" };
  const mine = { releases: ["parent"] };
  const settled = async (id: string) => { for (let i = 0; i < 200 && engine.isRunning(id); i++) await engine.idle(id).then(() => Bun.sleep(1)); };

  const own = session();
  engine.holdQueue(own.id, "parent");
  expect(engine.message(own.id, "after my own stop", meta, mine).event).toBeTruthy();
  await settled(own.id);
  expect(engine.isHeld(own.id)).toBe(false);

  const both = session();
  engine.holdQueue(both.id, "parent");
  engine.holdQueue(both.id, "owner");
  engine.holdQueue(both.id, "parent");
  expect(engine.heldBy(both.id)).toBe("owner");
  expect(engine.message(both.id, "after the owner's stop too", meta, mine)).toMatchObject({ held: true });

  const unnamed = session();
  engine.holdQueue(unnamed.id);
  expect(engine.message(unnamed.id, "after a stop nobody named", meta, mine)).toMatchObject({ held: true });
  expect(engine.isHeld(unnamed.id)).toBe(true);

  // A hold stored before its maker was: the last turn's stop says who made it.
  const old = session();
  store.append(old.id, "user", { text: "x" });
  store.append(old.id, "turn_start", { model: "m" });
  store.append(old.id, "turn_end", { reason: "interrupted", stopped_by: "parent" });
  store.db.run("INSERT INTO queue_holds (session_id) VALUES (?)", [old.id]);
  const again = rig(dir);
  expect(again.engine.heldBy(old.id)).toBe("parent");
  expect(again.engine.message(old.id, "after a stop from before", meta, mine).event).toBeTruthy();
  await again.engine.idle(old.id);
});

// The same key with other words is the sender's mistake: refused, not
// answered as already sent with the words dropped. Keys are kept 30 days.
test("a key used for another message is refused, and old keys go", () => {
  const { store, engine, session } = rig(scratch("key-words"));
  const s = session();
  engine.holdQueue(s.id); // nothing starts: the rows stay to be counted
  const meta = { kind: "steer", agent_id: "ag_1" };
  expect(engine.message(s.id, "the words", meta, { key: "send-1", fp: "a" }).queued).toBeTruthy();
  expect(engine.message(s.id, "the words", meta, { key: "send-1", fp: "a" })).toEqual({ duplicate: true });
  expect(() => engine.message(s.id, "other words", meta, { key: "send-1", fp: "b" })).toThrow("used for another message");
  expect(store.queue(s.id).map((q) => q.text)).toEqual(["the words"]);

  store.db.run("UPDATE input_keys SET ts = ? WHERE key = 'send-1'", [Date.now() - 31 * 86_400_000]);
  expect(engine.message(s.id, "a later one", meta, { key: "send-2", fp: "c" }).queued).toBeTruthy();
  expect(engine.hasInput(s.id, "send-1")).toBe(false);
  expect(engine.hasInput(s.id, "send-2")).toBe(true);
});

// A queue owed a start whose model is not listed when the daemon starts says
// so in the session, and starts when the model is back, not at the next restart.
test("an owed queue whose model is not listed yet says so and starts when it lists", async () => {
  const dir = scratch("queued-model");
  let reached!: () => void;
  const waiting = new Promise<void>((r) => (reached = r));
  let go!: () => void;
  const gate = new Promise<void>((r) => (go = r));
  const a = rig(dir, { request: async () => { reached(); await gate; } });
  const s = a.session();
  a.engine.send(s.id, "first");
  await waiting;
  const q = a.engine.send(s.id, "queued while the first turn ran", { mode: "queue" }).queued!;
  const down = a.engine.drain(5_000);
  go();
  await down;

  const before = process.env.KEEL_QUEUED_RETRY_MS;
  process.env.KEEL_QUEUED_RETRY_MS = "20";
  try {
    const b = rig(dir);
    let tries = 0;
    await b.engine.recover(b.store.bootWorking, async () => { if (++tries < 3) throw new Error("no provider lists this model"); });
    for (let i = 0; i < 400 && (tries < 3 || b.engine.isRunning(s.id) || b.store.queue(s.id).length); i++) await b.engine.idle(s.id).then(() => Bun.sleep(5));
    const line = b.engine.lineage(s.id);
    const notes = line.filter((e) => e.kind === "note" && e.data.kind === "restart");
    // Said once, however often it was tried.
    expect(notes.map((e) => String(e.data.text))).toEqual([expect.stringContaining("no provider lists this model")]);
    expect(promptsOf(b.store, s.id, q.id)).toHaveLength(1);
    expect(line.indexOf(promptsOf(b.store, s.id, q.id)[0]!)).toBeGreaterThan(line.indexOf(notes[0]!));
    expect(line.at(-1)).toMatchObject({ kind: "turn_end", data: { reason: "end_turn" } });
  } finally {
    if (before === undefined) delete process.env.KEEL_QUEUED_RETRY_MS;
    else process.env.KEEL_QUEUED_RETRY_MS = before;
  }
});

// An archived session starts nothing. The start its queue is owed is given
// when it is restored, not by itself at some later restart.
test("an owed queue of an archived session starts when the session is restored", async () => {
  const dir = scratch("queued-archived");
  let reached!: () => void;
  const waiting = new Promise<void>((r) => (reached = r));
  let go!: () => void;
  const gate = new Promise<void>((r) => (go = r));
  const a = rig(dir, { request: async () => { reached(); await gate; } });
  const s = a.session();
  a.engine.send(s.id, "first");
  await waiting;
  const q = a.engine.send(s.id, "queued while the first turn ran", { mode: "queue" }).queued!;
  const down = a.engine.drain(5_000);
  go();
  await down;
  a.store.updateSession(s.id, { archived: true });

  const b = rig(dir);
  await b.engine.recover(b.store.bootWorking, noRecover);
  await Bun.sleep(20);
  expect(b.requests).toEqual([]);
  b.store.updateSession(s.id, { archived: false });
  b.engine.startOwed(s.id);
  for (let i = 0; i < 200 && (b.engine.isRunning(s.id) || b.store.queue(s.id).length); i++) await b.engine.idle(s.id).then(() => Bun.sleep(1));
  expect(promptsOf(b.store, s.id, q.id)).toHaveLength(1);

  // Nothing is left for a later start, and a restore with nothing owed starts nothing.
  const c = rig(dir);
  await c.engine.recover(c.store.bootWorking, noRecover);
  c.engine.startOwed(s.id);
  await Bun.sleep(20);
  expect(c.requests).toEqual([]);
});

// A hook can keep another session's message from starting a turn (a reached dollar cap): it waits in
// the stored queue, in the order it came, and goes when the hook lets go and the queue is released.
test("another session's message waits in the queue while a hook holds it, and goes in order when released", async () => {
  const { store, engine, requests, session } = rig(scratch("peer-hold"));
  const s = session();
  let capped = true;
  registerHooks({ holdsInput: (x) => x.id === s.id && capped });
  const peer = (n: number) => engine.send(s.id, `peer ${n}`, { mode: "queue", meta: { kind: "peer", message_id: `m${n}` } });
  expect(peer(1)).toMatchObject({ queued: { text: "peer 1" } });
  expect(peer(2)).toMatchObject({ queued: { text: "peer 2" } });
  // The owner's own words still run, and the queue behind them is still held.
  engine.send(s.id, "owner words");
  await engine.idle(s.id);
  expect(requests.map((r) => r.join("|"))).toEqual(["owner words"]);
  expect(store.queue(s.id).map((q) => q.text)).toEqual(["peer 1", "peer 2"]);
  engine.queueReleased(s.id);
  expect(store.queue(s.id)).toHaveLength(2);
  capped = false;
  engine.queueReleased(s.id);
  await engine.idle(s.id);
  await engine.idle(s.id);
  expect(store.queue(s.id)).toEqual([]);
  expect(requests.at(-1)!.filter((t) => t.startsWith("peer"))).toEqual(["peer 1", "peer 2"]);
});

// The turn a restart cut and the turn that continues it are one turn, and so is whose it was.
test("a continued turn counts as the owner's when the owner started the cut one", () => {
  const { store, engine, session } = rig(scratch("by-owner"));
  const cut = (first: Record<string, unknown>) => {
    const s = session();
    store.append(s.id, "user", first);
    store.append(s.id, "turn_start", {});
    store.append(s.id, "turn_end", { reason: "restart" });
    store.append(s.id, "user", { text: "[harness] The daemon restarted during your previous turn.", origin: "restart" });
    return s.id;
  };
  const owners = cut({ text: "go" });
  expect(engine.byOwner(owners)).toBe(true);
  // Cut again and continued again: still the owner's.
  store.append(owners, "turn_start", {});
  store.append(owners, "turn_end", { reason: "restart" });
  store.append(owners, "user", { text: "[harness] The daemon restarted again.", origin: "restart" });
  expect(engine.byOwner(owners)).toBe(true);
  // A loop's turn that was cut is not made the owner's by the restart.
  expect(engine.byOwner(cut({ text: "run", kind: "loop" }))).toBe(false);
  // A turn that ended is over: the owner's words before it are not this turn's.
  store.append(owners, "turn_start", {});
  store.append(owners, "turn_end", { reason: "end_turn" });
  expect(engine.byOwner(owners)).toBe(false);
});

// A question from the helper's row on a phone is the owner's words with a mark (`ask`): it releases the
// owner's hold as a typed prompt does, and a queue clear removes it as the owner's own row, telling no
// sender. A mark of the harness's beside it (a peer's message, a kind) keeps an input not the owner's:
// it waits behind the hold, and a clear, a remove or a delete tells its sender it went unread.
test("an ask is the owner's words; an ask with another mark, or a peer's message, is not", async () => {
  const dir = scratch("ask-owner");
  const { store, engine, session } = rig(dir);
  const told: string[] = [];
  registerHooks({ inputDropped: (rows, why) => { for (const r of rows) told.push(`${r.text}:${why}`); } });
  const routes = turnRoutes({ store, engine } as any) as any;
  const clear = (id: string) => routes["/api/sessions/:id/queue"].DELETE({ params: { id } });
  const remove = (id: string, qid: string) => routes["/api/sessions/:id/queue/:qid"].DELETE({ params: { id, qid } });
  const ask = { ask: "phone" };
  const peer = { kind: "peer" };
  const mixed = { ask: "phone", kind: "peer" };

  // engine.send and the hold: the ask releases it and runs; the others wait behind it.
  const held = session();
  engine.holdQueue(held.id, "owner");
  expect(engine.send(held.id, "from a peer", { meta: peer, mode: "queue" }).queued).toBeTruthy();
  expect(engine.send(held.id, "an ask with a kind", { meta: mixed, mode: "queue" }).queued).toBeTruthy();
  expect(engine.isHeld(held.id)).toBe(true);
  expect(engine.send(held.id, "what waits for me?", { meta: ask }).event).toBeTruthy();
  expect(engine.isHeld(held.id)).toBe(false);
  await engine.idle(held.id);
  expect(store.events(held.id).find((e) => e.kind === "user" && e.data.text === "what waits for me?")?.data.ask).toBe("phone");

  // The queue clear: the ask row is the owner's and goes untold; the others' senders are told.
  const q = session();
  engine.holdQueue(q.id, "owner");
  for (const [text, meta] of [["asked", ask], ["peer", peer], ["mixed", mixed]] as const) engine.send(q.id, text, { meta, mode: "queue" });
  expect(store.queue(q.id)).toHaveLength(3);
  told.length = 0;
  await clear(q.id);
  expect(store.queue(q.id)).toEqual([]);
  expect(told.sort()).toEqual(["mixed:removed", "peer:removed"]);

  // One row removed: an ask by itself, a peer's told; engine.drop never takes the owner's.
  const r = session();
  engine.holdQueue(r.id, "owner");
  const a = engine.send(r.id, "asked", { meta: ask, mode: "queue" }).queued!;
  const p = engine.send(r.id, "peer", { meta: peer, mode: "queue" }).queued!;
  engine.drop([a], "removed");
  expect(store.queue(r.id).map((x) => x.text)).toEqual(["asked", "peer"]);
  told.length = 0;
  await remove(r.id, a.id);
  await remove(r.id, p.id);
  expect(store.queue(r.id)).toEqual([]);
  expect(told).toEqual(["peer:removed"]);

  // A deleted session tells the senders of what it had not read, never the owner of an ask.
  const d = session();
  engine.holdQueue(d.id, "owner");
  for (const [text, meta] of [["asked", ask], ["peer", peer], ["mixed", mixed]] as const) engine.send(d.id, text, { meta, mode: "queue" });
  told.length = 0;
  store.deleteSession(d.id);
  expect(told.sort()).toEqual(["mixed:deleted", "peer:deleted"]);
});

// A prompt that came while the daemon stopped is owed a start (queue_owed). The turn a restart cut is continued
// by the next daemon, and its first request takes the row; the debt is paid there, not left for a later start.
test("a queued prompt taken by the continued turn's first request leaves no start owed", async () => {
  const dir = scratch("owed-continued");
  let reached!: () => void;
  const waiting = new Promise<void>((r) => (reached = r));
  let first = true;
  const a = rig(dir, { request: async (req) => { if (!first) return; first = false; reached(); await untilStopped(req); } });
  const s = a.session();
  a.engine.send(s.id, "the task");
  await waiting;
  await a.engine.drain(0);
  const q = a.engine.message(s.id, "sent during the drain", { kind: "steer", agent_id: "ag_1" }).queued!;
  const owed = (r: typeof a) => r.store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM queue_owed").get()!.n;
  expect(owed(a)).toBe(1);

  const b = rig(dir);
  await b.engine.recover(b.store.bootWorking, noRecover);
  for (let i = 0; i < 400 && (b.engine.isRunning(s.id) || b.store.queue(s.id).length); i++) await b.engine.idle(s.id).then(() => Bun.sleep(1));
  expect(promptsOf(b.store, s.id, q.id)).toHaveLength(1);
  expect(b.store.queue(s.id)).toEqual([]);
  expect(owed(b)).toBe(0);
});

// An agent acts for the owner's words when the turn that started it, or sent it a message, held them.
test("an agent's task counts as the owner's only when the parent's turn held the owner's words", () => {
  const { store, engine, session } = rig(scratch("by-owner-agent"));
  const agent = (...events: Record<string, unknown>[]) => { const s = session(); for (const e of events) store.append(s.id, "user", e); store.append(s.id, "turn_start", {}); return s.id; };
  expect(engine.byOwner(agent({ text: "do it", kind: "task", owned: true }))).toBe(true);
  expect(engine.byOwner(agent({ text: "do it", kind: "task" }))).toBe(false);
  // Owner words copied in front of the task (a forked history) are not the task's.
  expect(engine.byOwner(agent({ text: "earlier", origin: undefined }, { text: "do it", kind: "task" }))).toBe(false);
  // A message of the parent's or the owner's after an unowned task.
  expect(engine.byOwner(agent({ text: "do it", kind: "task" }, { text: "go on", kind: "steer", owned: true }))).toBe(true);
  expect(engine.byOwner(agent({ text: "do it", kind: "task" }, { text: "go on", kind: "steer" }))).toBe(false);
  expect(engine.byOwner(agent({ text: "do it", kind: "task" }, { text: "mine" }))).toBe(true);
});
