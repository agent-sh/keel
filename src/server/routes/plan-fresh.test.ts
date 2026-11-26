// A plan approved to go on in a fresh session (plan.ts decidePlan with `fresh`): what the new session takes of the
// planning one (its machine, sandbox and network, the outside sightings), the start as one write, and the planning
// turn's end kept across a restart. Pure parts of the route an e2e cannot reach (a session on another machine, a
// start that fails, a restart between the approval and the plan's step).
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../core/store.ts";
import { Bus } from "../../core/bus.ts";
import { allHooks } from "../../engine/hooks.ts";
import { toolsFor } from "../../tools/registry.ts";
import { decidePlan, planRoutes } from "./plan.ts";

const hooksAtStart = allHooks().length;
afterAll(() => { allHooks().length = hooksAtStart; });

const store = new Store(mkdtempSync(join(tmpdir(), "plan-fresh-")));
const bus = new Bus();
const sent: { id: string; text: string; meta: any }[] = [];
let failSend = false;
const engine = {
  isDraining: () => false,
  isRunning: () => false,
  interrupt: async () => {},
  send: (id: string, text: string, o: any) => {
    if (failSend) throw new Error("the model does not list");
    // As the engine does: the prompt is a stored event of the new session, in the same write.
    store.append(id, "user", { text, ...o.meta });
    sent.push({ id, text, meta: o.meta });
    return {};
  },
};
const errors = { capture: () => ({ message: "" }) };
planRoutes({ store, bus, engine, errors } as any);
const present = toolsFor("other").find((t) => t.name === "present_plan")!;
if (!store.columnExists("sessions", "machine")) store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT");

const presents = (sid: string, callId: string, plan: string) => {
  store.append(sid, "assistant", { blocks: [{ type: "tool_use", id: callId, name: "present_plan", input: { plan } }] });
  let got: any;
  void present.run({ plan }, { callId, sessionId: sid, signal: new AbortController().signal } as any).then((r: any) => (got = r));
  return () => got;
};
const sightings = { keys: [["host:docs.evil.example", "outside", "a WebFetch result"]], listed: {} } as any;
const planRow = (id: string) => JSON.parse(store.db.query<{ data: string }, [string]>("SELECT data FROM plans WHERE session_id = ?").get(id)?.data ?? "null");

test("the fresh session runs where the planning session's tools run, and carries what it read of outside content", async () => {
  const src = store.createSession({ model: "fx:m", workspace: "/srv/app", title: "Plan the mirror" });
  store.db.query("UPDATE sessions SET machine = 'build box' WHERE id = ?").run(src.id);
  const result = presents(src.id, "call-1", "1. Mirror it.");
  await Bun.sleep(0);
  const r = decidePlan(src.id, "call-1", { approve: true, mode: "auto-edits", fresh: true }, undefined, sightings);
  expect(r.status).toBe(200);
  const to = r.body.session.id;
  expect(store.session(to)!.machine).toBe("build box");
  expect(sent.at(-1)!.meta.sightings).toEqual(sightings);
  await Bun.sleep(0);
  expect(result().content).toContain("fresh session");
  // A second press finds no plan.
  expect(decidePlan(src.id, "call-1", { approve: true, mode: "auto-edits", fresh: true }, undefined, sightings).status).toBe(404);
});

test("a start that fails leaves nothing of the attempt, and the plan waits", async () => {
  const src = store.createSession({ model: "fx:m", workspace: "/srv/app", title: "Plan two" });
  presents(src.id, "call-2", "1. Do it.");
  await Bun.sleep(0);
  const before = store.sessions().length;
  failSend = true;
  try {
    const r = decidePlan(src.id, "call-2", { approve: true, mode: "auto-edits", fresh: true }, undefined, sightings);
    expect(r.status).toBe(500);
  } finally { failSend = false; }
  expect(store.sessions().length).toBe(before);
  expect(planRow(src.id)).toBeNull();
  // Still waiting: it can be approved now.
  expect(decidePlan(src.id, "call-2", { approve: true, mode: "auto-edits", fresh: true }, undefined, sightings).status).toBe(200);
});

test("with no sightings gathered, nothing starts", async () => {
  const src = store.createSession({ model: "fx:m", workspace: "/srv/app", title: "Plan three" });
  presents(src.id, "call-3", "1. Do it.");
  await Bun.sleep(0);
  expect(decidePlan(src.id, "call-3", { approve: true, mode: "auto-edits", fresh: true }).status).toBe(503);
});

test("a restart before the plan's step ends the planning turn instead of presenting the plan again", async () => {
  const src = store.createSession({ model: "fx:m", workspace: "/srv/app", title: "Plan four" });
  presents(src.id, "call-4", "1. Do it.");
  await Bun.sleep(0);
  const r = decidePlan(src.id, "call-4", { approve: true, mode: "auto-edits", fresh: true }, undefined, sightings);
  expect(planRow(src.id).end_owed).toBe(true);
  // The daemon went down before the step was stored: the next one's cut-turn recovery asks the hooks.
  const verdict = allHooks().map((h) => h.cutTurn?.(store.session(src.id)!, { stalled: 0 })).find(Boolean) as any;
  expect(verdict?.hold).toContain(r.body.session.title);
  expect(planRow(src.id).end_owed).toBeUndefined();
  // Once only: a later planning turn cut by a restart goes on.
  expect(allHooks().map((h) => h.cutTurn?.(store.session(src.id)!, { stalled: 0 })).find(Boolean)).toBeUndefined();
});
