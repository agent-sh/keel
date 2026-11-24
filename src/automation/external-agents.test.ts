import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import * as agents from "./agents.ts";
import { setDeps } from "./core.ts";
import { readState } from "../acp/children.ts";

// The agent rows of the children an external ACP agent announced (src/acp/external.ts makes and moves them).
function world() {
  const dir = mkdtempSync(join(tmpdir(), "keel-ext-"));
  const store = new Store(join(dir, "state"));
  setDeps({ store, bus: new Bus(), errors: { capture() {} }, engine: { isRunning: () => false, isHeld: () => false }, providers: { current: () => [] } } as any);
  store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT");
  agents.migrate();
  const parent = store.createSession({ model: "acp:x", workspace: dir, title: "Lead" });
  const make = (child: string, title: string, state?: { state: string; stopReason?: string }) => {
    const reading = readState(state);
    return agents.createExternal(store.session(parent.id)!, { title, model: "acp:x", agent: "Codex", child, conv: "root", callId: `call-${child}`, status: reading.status, cancel: true, state: reading.state });
  };
  return { store, parent, make, dir };
}

test("an announced child is an agent row under the session, with a session of its own and its card's call id", () => {
  const { store, parent, make } = world();
  const { agent, session } = make("c1", "Test investigator");
  expect(agent).toMatchObject({ parent_id: parent.id, title: "Test investigator", type: "acp", status: "waiting", call_id: "call-c1", external: { agent: "Codex", child: "c1", cancel: true, state: "unconfirmed" } });
  expect(store.session(session.id)!.parent_id).toBe(parent.id);
  expect(agents.byChild(session.id)!.id).toBe(agent.id);
  // It is found again by the agent's id for it (a resumed conversation announces the same child).
  expect(agents.externalOf(parent.id, "c1", "root")!.id).toBe(agent.id);
  expect(agents.externalOf(parent.id, "other", "root")).toBeUndefined();
  // (The same id in another conversation of the agent is another child.)
  expect(agents.externalOf(parent.id, "c1", "root2")).toBeUndefined();
  expect(agents.externalAgentOf(session.id)).toBe("Codex");
  expect(agents.externalAgentOf(parent.id)).toBeUndefined();
  // Its result goes to its own panel, never to its parent's conversation, and nothing of Keel's sends it a message.
  expect(agents.isSilent(agent.id)).toBe(true);
  expect(agents.send(agent.id, "hello")).rejects.toThrow("is run by Codex");
});

test("the agent's reports move the row: running, then ended by its stop reason, then running again for more work", () => {
  const { make } = world();
  const { agent } = make("c1", "Docs");
  const set = (s: Parameters<typeof readState>[0], more: Parameters<typeof agents.patchExternal>[1] = {}) => {
    const r = readState(s);
    return agents.patchExternal(agent.id, { status: r.status, end_reason: r.end_reason ?? null, external: { state: r.state }, ...more })!;
  };
  expect(set({ state: "running" })).toMatchObject({ status: "running", ended: null, external: { state: "running" } });
  expect(set({ state: "requires_action" })).toMatchObject({ status: "running", external: { state: "requires_action" } });
  const done = set({ state: "idle", stopReason: "end_turn" }, { result: "Two tests fail." });
  expect(done).toMatchObject({ status: "completed", result: "Two tests fail." });
  expect(done.ended).toBeGreaterThan(0);
  // The same child, given more work: live again, its end cleared.
  expect(set({ state: "running" })).toMatchObject({ status: "running", ended: null });
  const stopped = set({ state: "idle", stopReason: "cancelled" }, { stopped_by: "owner" });
  expect(stopped).toMatchObject({ status: "stopped", stopped_by: "owner" });
  // A label the agent changed is the row's too.
  expect(agents.patchExternal(agent.id, { title: "Doc checker" })!.title).toBe("Doc checker");
});

test("a stop goes to the agent that runs the child, which says when it has stopped", () => {
  const { make } = world();
  const { agent } = make("c1", "Docs", { state: "running" });
  const asked: string[] = [];
  agents.outside.stop = (a, by) => { asked.push(`${a.external!.child}:${by}`); };
  try {
    // Asked, not ended: the row is the agent's to end.
    expect(agents.stop(agent.id, "owner")!.status).toBe("running");
    expect(asked).toEqual(["c1:owner"]);
    // The agent's word ends it.
    agents.patchExternal(agent.id, { status: "stopped", stopped_by: "owner" });
    expect(agents.stop(agent.id, "owner")!.status).toBe("stopped");
    expect(asked).toHaveLength(1);
  } finally { agents.outside.stop = undefined; }
});

test("when the connection to the agent ends the child is shown as ended and disconnected, never as finished or failed", () => {
  const { make } = world();
  const { agent } = make("c1", "Docs", { state: "running" });
  agents.disconnectExternal(agent.id);
  const gone = agents.get(agent.id)!;
  expect(gone).toMatchObject({ status: "incomplete", end_reason: "disconnected", external: { gone: true, state: "unknown" } });
  expect(gone.ended).toBeGreaterThan(0);
  // A stop has nothing to reach now.
  expect(agents.stop(agent.id, "owner")!.status).toBe("incomplete");
  // A daemon that restarts finds a live row of an agent that went down with it: it is the same.
  const { agent: other } = make("c2", "More", { state: "running" });
  agents.recover();
  expect(agents.get(other.id)).toMatchObject({ status: "incomplete", end_reason: "disconnected" });
});
