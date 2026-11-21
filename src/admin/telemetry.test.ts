// The ledger's attribution over the event tree, which a live e2e cannot set
// up: history from before telemetry (a fork copied with it), and branches.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { allHooks } from "../engine/hooks.ts";
import { changedBlocks } from "../engine/prompt-store.ts";
import { PromptStore } from "../engine/prompt-store.ts";
import { breakCause, prefixDiff, prefixOf, Telemetry } from "./telemetry.ts";

const withStore = async (f: (store: Store) => void | Promise<void>) => {
  const root = mkdtempSync(join(tmpdir(), "keel-telemetry-"));
  try { await f(new Store(root)); } finally { rmSync(root, { recursive: true, force: true }); }
};
const use = { type: "tool_use", id: "call_12", name: "inspect", input: {} };

test("history from before telemetry counts each request once, a fork's copy included", () => withStore(async (store) => {
  const a = store.createSession({ model: "p:m", workspace: "/" });
  store.append(a.id, "user", { text: "go" });
  const step = store.append(a.id, "assistant", { blocks: [use], model: "p:m", usage: { input: 10, output: 2, cache_read: 0, cache_write: 0, cost: 0.25 }, stop: "tool_use" });
  store.append(a.id, "tool_result", { results: [{ type: "tool_result", tool_use_id: "call_12", is_error: true, content: "Fixture report unavailable\nmore" }] });
  store.append(a.id, "assistant", { blocks: [{ type: "text", text: "Earlier call_12 failed" }], model: "p:m", usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, cost: 0 }, stop: "end_turn" });
  const b = store.createSession({ model: "p:m", workspace: "/" });
  store.copyEvents(b.id, store.events(a.id));

  const t = new Telemetry(store, new Bus());
  const r = await t.report({});
  expect(r.total.calls).toBe(2);
  expect(r.total.priced_cost_usd).toBe(0.25);
  expect([r.total.tool_calls, r.total.tool_errors]).toEqual([1, 1]);
  const [ex] = t.examples({});
  expect(ex).toMatchObject({ session_id: a.id, call_id: "call_12", error: "Fixture report unavailable", event_id: step.id });
}));

test("a request is booked to its own branch, route and turn", () => withStore(async (store) => {
  const s = store.createSession({ model: "p:main", workspace: "/" });
  const root = store.append(s.id, "user", { text: "Start" });
  store.append(s.id, "assistant", { blocks: [{ type: "text", text: "ok" }], model: "p:main", usage: {}, stop: "end_turn" });
  new PromptStore(store);
  const t = new Telemetry(store, new Bus());
  const hooks = allHooks().at(-1)!;
  const send = (purpose: "turn" | "side" | "summary", prompt: number, route = "p:main") => {
    const req = { model: "m", system: "", messages: [], tools: [], signal: new AbortController().signal, purpose, route } as any;
    const sess = store.session(s.id)!;
    hooks.requestSent!(sess, req);
    hooks.requestDone!(sess, req, { blocks: [], stop: "end_turn", usage: { input: prompt, output: 1, cache_read: 0, cache_write: 0 } } as any);
  };
  const head = store.session(s.id)!.head!;
  // Branch A asks; sibling B asks; a summary is installed on A, then B's turn
  // runs, then A's.
  const askA = store.append(s.id, "user", { text: "Verify A" }, head);
  const askB = store.append(s.id, "user", { text: "Verify B" }, head);
  store.append(s.id, "compaction", { mode: "summary", summary: "s", covered: root.id, tokens_before: 500 }, askA.id);
  const turnA = store.append(s.id, "turn_start", { model: "p:main" });
  store.append(s.id, "turn_start", { model: "p:main" }, askB.id);
  send("turn", 900);
  store.updateSession(s.id, { head: turnA.id });
  send("turn", 70);
  send("side", 5, "q:advisor");
  store.append(s.id, "turn_end", { reason: "end_turn", usage: {} });
  send("side", 3);

  const [c] = (await t.compactions({ session: s.id })).compactions;
  expect(c!.tokens_after).toBe(70);
  expect(c!.kept!.verbatim_events).toBe(2); // the start's reply and "Verify A", never B's
  const turn = ((await t.tokens({ session: s.id })).turns as any[]).find((x) => x.turn_event === turnA.id);
  expect(turn.prompt).toBe("Verify A");
  expect(turn.requests).toBe(1); // the side answers are in no turn
  expect((await t.report({})).by_model.map((m) => [m.model, m.calls]).sort()).toEqual([["p:main", 4], ["q:advisor", 1]]);

  // Why the cache broke, from what each request recorded. The request on A
  // after the one on B: another branch, though A has a compaction B has not
  // (it was made before either request). Then a compaction on A itself.
  const causes = async () => (await t.report({})).breaks.map((b) => [b.cause, b.count]);
  expect(await causes()).toEqual([["branch_switch", 1]]);
  store.append(s.id, "turn_start", { model: "p:main" });
  store.append(s.id, "compaction", { mode: "summary", summary: "s2", covered: turnA.id, tokens_before: 70 });
  send("turn", 40);
  expect(await causes()).toEqual([["compaction", 1], ["branch_switch", 1]]);
  // Back on B, where neither compaction is: another branch again.
  store.updateSession(s.id, { head: askB.id });
  store.append(s.id, "turn_start", { model: "p:main" });
  send("turn", 900);
  expect(await causes()).toEqual([["compaction", 1], ["branch_switch", 2]]);
}));

test("a cache break is a changed prefix only where a stored fingerprint differs", () => {
  const tool = (name: string, defer = false) => ({ name, description: "d", input_schema: {}, defer }) as any;
  const was = prefixOf({ tools: [tool("Bash")], system: "one" }, ["a", "b"]);
  const prev = { h_tools: was.tools, h_system: was.system, n_msgs: was.n, h_msgs: was.msgs, h_kept: was.kept };
  // The same request grown by a message, a deferred tool more, the last message rewritten: nothing differs.
  expect(prefixDiff(prev, prefixOf({ tools: [tool("Bash"), tool("mcp__x__y", true)], system: "one" }, ["a", "b", "c"]))).toEqual([]);
  expect(prefixDiff(prev, prefixOf({ tools: [tool("Bash")], system: "one" }, ["a", "b2", "c"]))).toEqual([]);
  expect(prefixDiff(prev, prefixOf({ tools: [tool("Read")], system: "two" }, ["x", "b", "c"]), ["instruction files"])).toEqual(["tools", "system (instruction files)", "history"]);
  expect(prefixDiff({ ...prev, h_tools: null }, was)).toBeNull();
  const gap = { modelChanged: false, compacted: false };
  expect(breakCause({ ...gap, gapMs: 1_000, diff: [] })).toBe("provider_miss");
  // Expired only past the lifetime the request before asked for, and never where its route states none.
  expect(breakCause({ ...gap, gapMs: 3_600_000, lifeMs: 300_000, diff: [] })).toBe("expired");
  expect(breakCause({ ...gap, gapMs: 780_000, lifeMs: 3_600_000, diff: [] })).toBe("provider_miss");
  expect(breakCause({ ...gap, gapMs: 3_600_000, lifeMs: null, diff: [] })).toBe("provider_miss");
  expect(breakCause({ ...gap, gapMs: 3_600_000, diff: ["system"] })).toBe("prefix_changed");
  // The build's tools and prompt taken because the cache had expired: an expiry, though the prefix differs.
  expect(breakCause({ ...gap, gapMs: 3_600_000, diff: ["tools", "system (core)"], tookExpired: true })).toBe("expired");
  expect(breakCause({ ...gap, gapMs: 1_000, diff: null })).toBe("prefix_changed");
  // Another branch is its own cause: before a changed prefix, after a compaction or a model switch.
  expect(breakCause({ ...gap, gapMs: 1_000, switched: true, diff: ["history"] })).toBe("branch_switch");
  expect(breakCause({ ...gap, compacted: true, gapMs: 1_000, switched: true, diff: ["history"] })).toBe("compaction");
  expect(breakCause({ ...gap, modelChanged: true, gapMs: 1_000, switched: true, diff: [] })).toBe("model_switch");
  const b = (name: string, hash: string) => ({ name, hash, bytes: 1 });
  expect(changedBlocks([b("core", "1"), b("skills", "2"), b("place", "3")], [b("core", "1"), b("place", "3"), b("mcp", "4")])).toEqual(["mcp", "skills"]);
  expect(changedBlocks([b("core", "1")], [b("core", "1")])).toEqual([]);
});
