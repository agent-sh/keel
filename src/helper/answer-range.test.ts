import { expect, test } from "bun:test";
import { tempTree } from "../../test/env.ts";
import { Bus } from "../core/bus.ts";
import { ErrorTracker } from "../core/errors.ts";
import { Store } from "../core/store.ts";
import type { EventKind } from "../core/types.ts";
import { allHooks } from "../engine/hooks.ts";
import type { Deps } from "../server/app.ts";
import { Helper } from "./helper.ts";
import type { MailSource } from "./mail.ts";

test("a phone question reads its queue row or the delivered answer, not the helper's history", async () => {
  const store = new Store(tempTree("keel-helper-answer-"));
  const bus = new Bus();
  const hooks = allHooks().length;
  const deps = { store, bus, errors: new ErrorTracker(store, bus), engine: { isRunning: () => false } };
  const helper = new Helper(deps as unknown as Deps, {} as MailSource);
  const event = (kind: EventKind, data: unknown, parent?: string) => ({ id: crypto.randomUUID(), kind, data, ts: Date.now(), parent });
  const history = () => Array.from({ length: 256 }, () => event("tool_result", { results: [{ content: "unrelated history" }] }));
  const reply = (text: string) => event("assistant", { blocks: [{ type: "text", text }] });
  const before = history();
  const abandoned = event("user", { queue_id: "delivered", text: "Question on the abandoned branch" });
  const question = event("user", { ask: "phone", queue_id: "delivered", text: "Delivered question" }, before.at(-1)!.id);
  const s = store.createWithEvents({ model: "scripted:stand-in", workspace: "/" }, [
    ...before, abandoned, question, reply("before restart"), event("turn_end", { reason: "restart" }),
    reply("after restart"), event("turn_end", { reason: "end_turn" }), ...history(),
  ]);
  store.db.query("INSERT INTO helper_state (id, value) VALUES (1, ?)").run(JSON.stringify({ session_id: s.id }));
  const queued = store.enqueue(s.id, "Queued question", false);

  let warmed = 0;
  store.readOff = async (sql, params) => {
    const rows = store.db.query(sql).all(...params);
    if (sql.startsWith("SELECT data FROM events")) warmed += rows.length;
    return rows;
  };
  try {
    expect(await helper.answer(`q:${queued.id}`)).toMatchObject({ state: "waiting", question: "Queued question" });
    const waitingBodies = warmed;
    expect(await helper.answer("q:delivered")).toMatchObject({ state: "done", question: "Delivered question", text: "after restart" });
    expect(await helper.answer(question.id)).toMatchObject({ state: "done", text: "after restart" });
    expect(waitingBodies).toBe(0);
    // The answer fits in one run of bodies. Neither the older nor newer history is needed.
    expect(warmed).toBeLessThanOrEqual(64);
  } finally {
    helper.stop();
    allHooks().length = hooks;
    store.db.close();
  }
});
