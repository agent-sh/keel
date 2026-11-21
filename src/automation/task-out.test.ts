// "Do it in its own session", with a daemon that stops between its steps. A
// stop is a throw inside the step: what was not committed is gone, as it is
// for a killed process.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { setDeps } from "./core.ts";
import * as activity from "./activity.ts";
import * as goals from "./goals.ts";
import * as taskOut from "./task-out.ts";
import * as renames from "./task-renames.ts";

const store = new Store(mkdtempSync(join(tmpdir(), "keel-task-out-")));
store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT"); // the fleet adds it in the daemon
const faults: { beforeAppend?: boolean } = {};
const engine = {
  isRunning: () => false,
  send: (id: string, text: string, o: any) => {
    if (faults.beforeAppend) throw new Error("the daemon stopped here");
    return { event: store.append(id, "user", { text, ...o?.meta }) };
  },
};
setDeps({ store, bus: new Bus(), errors: { capture() {} }, engine } as any);
activity.migrate();
goals.migrate();

const source = () => {
  const s = store.createSession({ model: "m", workspace: "/", title: "Source" });
  return { s, task: goals.addTask(s.id, "Say hello") };
};
// What a launch of the task left: its destinations, the row's link, the stored prompts.
const left = (sourceId: string, taskId: string) => {
  const dests = store.sessions().filter((x) => x.title === "Say hello");
  const prompts = dests.flatMap((d) => store.events(d.id)).filter((e) => e.kind === "user" && e.data.kind === "task_start" && e.data.task_id === taskId);
  return { dests: dests.map((d) => d.id), link: goals.tasks(sourceId).find((t) => t.id === taskId)!.dest_session ?? null, prompts: prompts.length };
};
const reset = () => { for (const d of store.sessions().filter((x) => x.title === "Say hello")) store.deleteSession(d.id); };

test("a stop after the destination is created leaves nothing, and the retry launches once", () => {
  reset();
  const { s, task } = source();
  const create = store.createSession.bind(store);
  store.createSession = (o) => { create(o); throw new Error("the daemon stopped here"); };
  try {
    expect(() => taskOut.start(s.id, task.id)).toThrow("the daemon stopped here");
  } finally {
    store.createSession = create;
  }
  expect(left(s.id, task.id)).toEqual({ dests: [], link: null, prompts: 0 });
  const r = taskOut.start(s.id, task.id);
  expect(r.status).toBe(201);
  expect(left(s.id, task.id)).toEqual({ dests: [r.body.session_id as string], link: r.body.session_id as string, prompts: 1 });
});

test("a stop after the link is stored and before the prompt leaves nothing, and the retry launches once", () => {
  reset();
  const { s, task } = source();
  faults.beforeAppend = true;
  try {
    expect(() => taskOut.start(s.id, task.id)).toThrow("the daemon stopped here");
  } finally {
    faults.beforeAppend = false;
  }
  expect(left(s.id, task.id)).toEqual({ dests: [], link: null, prompts: 0 });
  expect(goals.tasks(s.id)[0]!.status).toBe("pending");
  const r = taskOut.start(s.id, task.id);
  expect(r.status).toBe(201);
  const again = taskOut.start(s.id, task.id);
  expect(again).toEqual({ status: 200, body: { session_id: r.body.session_id, existing: true } });
  expect(left(s.id, task.id)).toEqual({ dests: [r.body.session_id as string], link: r.body.session_id as string, prompts: 1 });
});

// A store written by a daemon that stopped between the link and the prompt,
// before launches were one write: the destination is linked and empty.
test("a linked destination that never got its prompt gets it on the retry, once", () => {
  reset();
  const { s, task } = source();
  const dest = store.createSession({ model: "m", workspace: "/", title: "Say hello" });
  goals.editTask(s.id, task.id, { status: "in_progress", dest_session: dest.id });
  for (let i = 0; i < 2; i++) expect(taskOut.start(s.id, task.id)).toEqual({ status: 200, body: { session_id: dest.id, existing: true } });
  expect(left(s.id, task.id)).toEqual({ dests: [dest.id], link: dest.id, prompts: 1 });
});

// Only a launch links a row to a session. A destination named in an edit of
// the row (the panel's PATCH passes its body on) is not taken: the task's
// words are never sent into a session the daemon did not make for it.
test("an edit of the row cannot name its destination", () => {
  reset();
  const { s, task } = source();
  const other = store.createSession({ model: "m", workspace: "/", title: "Someone else's session" });
  renames.edit(s.id, task.id, { status: "in_progress", dest_session: other.id } as any);
  expect(goals.tasks(s.id)[0]).toMatchObject({ status: "in_progress", dest_session: null });
  const r = taskOut.start(s.id, task.id);
  expect(r.status).toBe(201);
  expect(r.body.session_id).not.toBe(other.id);
  expect(store.events(other.id)).toEqual([]);
});
