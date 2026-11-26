// A drain stops a running turn at its next step boundary and does not wait for the rest of the turn:
// the request on its way is finished, the next one is not sent, and the park loses nothing. Called
// off, the stopped turn goes on.
import { afterAll, expect, test } from "bun:test";
import { allHooks, type TurnHooks } from "./hooks.ts";

const hooksAtStart = allHooks().length;
afterAll(() => { allHooks().length = hooksAtStart; });

test("a drain waits for the request on its way, then the turn stops at its step boundary until it is parked or the drain is called off", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Engine } = await import("./turn.ts");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "drain-boundary-"));
  const store = new Store(dir);
  const info = { id: "p:m", provider: "p", model: "m", name: "M", family: "other", context: 100_000, output: 1_000, efforts: [], billing: "per_token" };
  // Every turn request waits until the test lets it go, and honors its stop. Each reply is cut at the
  // output limit, so the turn always has a next step.
  const asked: { signal: AbortSignal; go: () => void }[] = [];
  let arrived = Promise.withResolvers<void>();
  const provider = {
    id: "p", wire: "anthropic_messages", available: () => true, list: async () => [],
    stream: async (req: any) => {
      if (req.purpose && req.purpose !== "turn") return { blocks: [{ type: "text", text: "t" }], usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 }, stop: "end_turn", model: "m" };
      const wait = Promise.withResolvers<void>();
      asked.push({ signal: req.signal, go: wait.resolve });
      req.signal.addEventListener("abort", () => wait.resolve(), { once: true });
      arrived.resolve();
      await wait.promise;
      if (req.signal.aborted) throw Object.assign(new Error("stopped"), { name: "AbortError" });
      return { blocks: [{ type: "text", text: "part" }], usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 }, stop: "max_tokens", model: "m" };
    },
  };
  const providers = { resolve: async () => ({ provider, info }), models: async () => [info], current: () => [info] };
  const engine = new Engine(store, new Bus(), providers as any, { capture: (_s: string, e: unknown) => ({ message: String(e) }) } as any, join(dir, "spill"));
  const s = store.createSession({ title: "Fixture", model: "p:m", workspace: dir });
  engine.send(s.id, "write a long thing");
  await arrived.promise;
  expect(asked).toHaveLength(1);

  // The drain starts while the first request is on its way; the request ends a moment later.
  const t0 = Date.now();
  const settled = engine.settle(10_000);
  await Bun.sleep(50);
  asked[0]!.go();
  await settled;
  expect(Date.now() - t0).toBeLessThan(3_000);
  // The reply was kept and the next request was not sent.
  expect(asked).toHaveLength(1);
  expect(store.events(s.id).filter((e) => e.kind === "assistant")).toHaveLength(1);
  expect(engine.isRunning(s.id)).toBe(true);

  // Called off: the turn goes on with its next request.
  arrived = Promise.withResolvers<void>();
  engine.undrain();
  await arrived.promise;
  expect(asked).toHaveLength(2);

  // Drained again: the request on its way ends, the turn stops at the boundary, and the park ends it
  // as cut for a restart with its two replies stored.
  const again = engine.settle(10_000);
  await Bun.sleep(50);
  asked[1]!.go();
  await again;
  expect(asked).toHaveLength(2);
  await engine.park();
  expect(engine.isRunning(s.id)).toBe(false);
  expect(store.events(s.id).filter((e) => e.kind === "assistant")).toHaveLength(2);
  expect(store.events(s.id).findLast((e) => e.kind === "turn_end")?.data.reason).toBe("restart");
});

// A bare engine on a stand-in provider: each turn request is a step of `script` (the session's own list).
async function fixture(script: (sid: string, n: number, req: any, onDelta: (d: any) => void) => Promise<any>) {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Engine } = await import("./turn.ts");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "drain-boundary-"));
  const store = new Store(dir);
  const info = { id: "p:m", provider: "p", model: "m", name: "M", family: "other", context: 100_000, output: 1_000, efforts: [], billing: "per_token" };
  const asked = new Map<string, number>();
  const provider = {
    id: "p", wire: "anthropic_messages", available: () => true, list: async () => [],
    stream: async (req: any, onDelta: (d: any) => void) => {
      if (req.purpose && req.purpose !== "turn") return { blocks: [{ type: "text", text: "t" }], usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 }, stop: "end_turn", model: "m" };
      const sid = JSON.stringify(req.messages).includes("wait for your agent") ? "parent" : "other";
      const n = (asked.get(sid) ?? 0) + 1;
      asked.set(sid, n);
      return script(sid, n, req, onDelta);
    },
  };
  const providers = { resolve: async () => ({ provider, info }), models: async () => [info], current: () => [info] };
  const engine = new Engine(store, new Bus(), providers as any, { capture: (_s: string, e: unknown) => ({ message: String(e) }) } as any, join(dir, "spill"));
  return { store, engine, asked, dir };
}
const usage = { input: 1, output: 1, cache_read: 0, cache_write: 0 };
const held = (req: any) => {
  const w = Promise.withResolvers<void>();
  req.signal.addEventListener("abort", () => w.resolve(), { once: true });
  return w;
};

for (const part of ["before the request goes out", "after the reply ends"] as const) {
  test(`a drain waits for an active step ${part}`, async () => {
    const release = Promise.withResolvers<void>();
    const arrived = Promise.withResolvers<void>();
    const { store, engine, asked, dir } = await fixture(async () => ({
      blocks: [{ type: "tool_use", id: "drain-call", name: "drain_probe", input: {} }], usage, stop: "tool_use", model: "m",
    }));
    const s = store.createSession({ title: "Fixture", model: "p:m", workspace: dir });
    const hold = async (session: { id: string }) => {
      if (session.id !== s.id) return;
      arrived.resolve();
      await release.promise;
    };
    const hook: TurnHooks = part === "before the request goes out"
      ? { beforeRequest: async (session, req) => { if (req.purpose === "turn") await hold(session); return req; } }
      : { afterResponse: hold };
    const { registerSessionTools } = await import("../tools/registry.ts");
    registerSessionTools("drain-parts-test", (sid) => sid !== s.id ? [] : [{
      name: "drain_probe", description: "Reports when the reply's call ran.",
      input_schema: { type: "object", properties: {} }, readOnly: true, run: async () => ({ content: "call saved" }),
    }]);
    allHooks().push(hook);
    try {
      engine.send(s.id, "ask for the probe");
      await arrived.promise;
      expect(asked.get("other") ?? 0).toBe(part === "before the request goes out" ? 0 : 1);
      let done = false;
      const settled = engine.settle(10_000).then(() => { done = true; });
      await Promise.resolve(); // a settle that found nothing to wait for has returned
      expect(done).toBe(false);
      release.resolve();
      await settled;
      expect(asked.get("other")).toBe(1);
      expect(store.events(s.id).find((e) => e.kind === "tool_result")?.data.results).toMatchObject([{ tool_use_id: "drain-call", content: "call saved" }]);
    } finally {
      release.resolve();
      await engine.park();
      allHooks().splice(allHooks().indexOf(hook), 1);
      registerSessionTools("drain-parts-test", () => []);
    }
  });
}

// The status says idle from a reply's first output, while the reply still streams: the drain decides from the
// request the turn has on its way, so a reply that began to stream is not cut and paid again.
test("a drain waits for a reply that has begun to stream", async () => {
  let go = () => {};
  const streaming = Promise.withResolvers<void>();
  const { store, engine } = await fixture(async (_sid, _n, req, onDelta) => {
    const w = held(req);
    go = w.resolve;
    onDelta({ index: 0, kind: "text", text: "the first words" });
    streaming.resolve();
    await w.promise;
    if (req.signal.aborted) throw Object.assign(new Error("stopped"), { name: "AbortError" });
    return { blocks: [{ type: "text", text: "the first words and the rest" }], usage, stop: "max_tokens", model: "m" };
  });
  const s = store.createSession({ title: "Fixture", model: "p:m", workspace: "/" });
  engine.send(s.id, "write a long thing");
  await streaming.promise;
  expect(engine.statusOf(s.id).kind).toBe("idle");
  let done = false;
  const settled = engine.settle(10_000).then(() => { done = true; });
  // Past a look of the drain's (SETTLE_CHECK_MS): it still waits.
  await Bun.sleep(600);
  expect(done).toBe(false);
  go();
  await settled;
  expect(store.events(s.id).filter((e) => e.kind === "assistant").map((e) => e.data.stop)).toEqual(["max_tokens"]);
  await engine.park();
});

// A parent whose call blocks on its agent is not waited for once the agent stopped at its own boundary, and is
// while the agent has a request on its way.
test("a drain waits for a parent blocked on its agent only while the agent is waited for", async () => {
  let childGo = () => {};
  const childAsked = Promise.withResolvers<void>();
  const parentCalled = Promise.withResolvers<void>();
  let parentId = "", childId = "";
  const { store, engine } = await fixture(async (sid, n, req) => {
    if (sid === "parent") {
      if (n > 1) { await held(req).promise; throw Object.assign(new Error("stopped"), { name: "AbortError" }); }
      parentCalled.resolve();
      return { blocks: [{ type: "tool_use", id: "wait1", name: "wait_for_agent", input: {} }], usage, stop: "tool_use", model: "m" };
    }
    const w = held(req);
    childGo = w.resolve;
    childAsked.resolve();
    await w.promise;
    if (req.signal.aborted) throw Object.assign(new Error("stopped"), { name: "AbortError" });
    return { blocks: [{ type: "text", text: "part" }], usage, stop: "max_tokens", model: "m" };
  });
  const parent = store.createSession({ title: "Parent", model: "p:m", workspace: "/" });
  const child = store.createSession({ title: "Child", model: "p:m", workspace: "/" });
  parentId = parent.id; childId = child.id;
  // The parent's call blocks until it is stopped, as wait_agent does while its agent works.
  const { registerSessionTools } = await import("../tools/registry.ts");
  const waitTool = {
    name: "wait_for_agent", description: "Waits for the agent.", input_schema: { type: "object", properties: {} }, readOnly: true,
    run: (_input: unknown, ctx: any) => new Promise<any>((r) => ctx.signal?.addEventListener("abort", () => r("stopped"), { once: true })),
  };
  registerSessionTools("drain-boundary-test", (sid) => sid === parentId ? [waitTool as any] : []);
  allHooks().push({ awaitsAgents: (sid: string, call: string) => sid === parentId && call === "wait1" ? [childId] : undefined } as any);
  engine.send(child.id, "work");
  await childAsked.promise;
  // A running turn for the parent that the drain sees blocked on its call.
  engine.send(parent.id, "wait for your agent");
  await parentCalled.promise;
  const t0 = Date.now();
  let done = false;
  const settled = engine.settle(10_000).then(() => { done = true; });
  await Bun.sleep(600);
  expect(done).toBe(false); // the agent's request is on its way
  expect((engine as any).inflight.get(parentId)?.has("wait1")).toBe(true);
  childGo();
  await settled;
  expect(Date.now() - t0).toBeLessThan(3_000);
  await engine.park();
  registerSessionTools("drain-boundary-test", () => []);
});

// A drain called off and asked for again in the same tick leaves a stopped turn waiting, not spinning the loop.
test("a drain called off and asked again at once leaves the stopped turn waiting without holding the loop", async () => {
  let go = () => {};
  const asked = Promise.withResolvers<void>();
  let requests = 0;
  const { store, engine } = await fixture(async (_sid, _n, req) => {
    requests++;
    const w = held(req);
    go = w.resolve;
    asked.resolve();
    await w.promise;
    if (req.signal.aborted) throw Object.assign(new Error("stopped"), { name: "AbortError" });
    return { blocks: [{ type: "text", text: "part" }], usage, stop: "max_tokens", model: "m" };
  });
  const s = store.createSession({ title: "Fixture", model: "p:m", workspace: "/" });
  engine.send(s.id, "write a long thing");
  await asked.promise;
  const settled = engine.settle(10_000);
  go();
  await settled; // stopped at its boundary
  engine.undrain();
  const again = engine.settle(10_000);
  // A timer runs: the loop is free.
  const beat = await Promise.race([Bun.sleep(50).then(() => "free"), new Promise((r) => setTimeout(() => r("held"), 2_000))]);
  expect(beat).toBe("free");
  await again;
  expect(requests).toBe(1);
  await engine.park();
});
