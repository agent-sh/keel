// A daemon's engine in a process of its own that kills itself (SIGKILL: no
// handler runs, nothing is flushed) at a named point of a prompt's way into
// a turn. The test that started it then opens the same state folder as the
// next daemon would. Run: bun delivery.child.ts <state dir> <case> <kill point>.
//
// Cases: `dequeue` (the queue's next prompt after a turn), `steer` (a steer
// joining the running turn), `send-now` (the owner's Send now on a queued row),
// `send` (a prompt sent to an idle session), `recover` (the next daemon's
// start on a state folder an earlier case left).
// Kill points: `stopping` (Send now has asked the running turn to stop),
// `claimed` (the row was just removed from the queue), `stored` (its prompt
// was just written), `setup` (the prompt is stored and its turn is resolving
// its provider: the turn has not started), and at a start `boot` (the store
// is open, nothing recovered yet) and `waiting` (recovery waits for the
// session's model). All are calls the engine makes on the store, the
// providers or itself, so the same points exist whatever the code between
// them does.
import { writeSync } from "node:fs";
import { QUEUED, rig, SENT, untilStopped } from "./delivery.fixture.ts";

const [stateDir, scenario, killAt] = process.argv.slice(2) as [string, string, string];
const say = (line: Record<string, unknown>) => writeSync(1, JSON.stringify(line) + "\n");
let armed = false;
const at = (point: string) => {
  if (!armed || point !== killAt) return;
  say({ killed_at: point });
  process.kill(process.pid, "SIGKILL");
  Bun.sleepSync(5_000); // never reached: the signal is not one a process outlives
};

let opened!: () => void;
const open = new Promise<void>((r) => (opened = r));
let letGo!: () => void;
const released = new Promise<void>((r) => (letGo = r));
const { store, engine, session } = rig(stateDir, {
  // After the code that accepted the prompt has returned (and told the owner so).
  setup: async () => {
    await Promise.resolve();
    at("setup");
  },
  // The first turn is held open until the test has queued its prompt.
  request: async (req) => {
    if (JSON.stringify(req.messages).includes(QUEUED.text)) return;
    opened();
    await Promise.race([released, untilStopped(req)]);
  },
});

const dequeue = store.dequeue.bind(store);
store.dequeue = (id) => {
  const removed = dequeue(id);
  if (removed) at("claimed");
  return removed;
};
const append = store.append.bind(store);
store.append = (sessionId, kind, data, parent) => {
  const e = append(sessionId, kind, data, parent);
  if (kind === "user" && (data as any)?.queue_id) at("stored");
  return e;
};
const interrupt = engine.interrupt.bind(engine);
engine.interrupt = (id, by) => {
  const stopped = interrupt(id, by); // the stop is asked for; the turn has not ended yet
  at("stopping");
  return stopped;
};

const survived = (code = 3): never => {
  say({ survived: true });
  process.exit(code);
};

if (scenario === "recover") {
  armed = true;
  at("boot");
  await engine.recover(store.bootWorking, async () => {
    await Promise.resolve();
    at("waiting");
  });
  survived();
}

const s = session();
if (scenario === "send") {
  armed = true;
  const accepted = engine.send(s.id, SENT.text, { images: SENT.images });
  // From here the owner has been told the prompt was sent.
  say({ session: s.id, prompt: accepted.event!.id });
  await engine.idle(s.id);
  survived();
}

engine.send(s.id, "first");
await open;
const sent = engine.send(s.id, QUEUED.text, { mode: scenario === "steer" ? "steer" : "queue", images: QUEUED.images });
// From here the owner has been told the prompt is queued.
say({ session: s.id, queued: sent.queued!.id });
armed = true;
if (scenario === "send-now") await engine.sendNow(s.id, sent.queued!.id);
else letGo();
await engine.idle(s.id);
await engine.idle(s.id);
survived();
