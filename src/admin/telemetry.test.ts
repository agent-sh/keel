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

// A budget is checked before every request. The spend it is held against is a
// running total: equal to the ledger's sums after any run of requests, read
// from the ledger once and not at each check.
test("the running spend total equals the summed ledger after random requests", () => withStore(async (store) => {
  const { Database } = await import("bun:sqlite");
  const { spendOf } = await import("./telemetry-report.ts");
  const s = store.createSession({ model: "p:main", workspace: "/" });
  store.append(s.id, "user", { text: "Start" });
  new PromptStore(store);
  const t = new Telemetry(store, new Bus());
  const hooks = allHooks().at(-1)!;
  let rnd = 42;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const send = () => {
    const req = { model: "m", system: "", messages: [], tools: [], signal: new AbortController().signal, purpose: rand() < 0.8 ? "turn" : "side", route: "p:main" } as any;
    const sess = store.session(s.id)!;
    hooks.requestSent!(sess, req);
    const r = rand();
    const usage = { input: Math.floor(rand() * 5000), output: Math.floor(rand() * 900), cache_read: 0, cache_write: 0, ...(r < 0.7 ? { cost: rand() * 0.3 } : r < 0.85 ? { unpriced: 1 } : {}) };
    hooks.requestDone!(sess, req, { blocks: [], stop: "end_turn", usage } as any);
  };
  const limits = { daily_usd: null, monthly_usd: null };
  const same = () => {
    const have = t.spend(), want = spendOf(store.db, limits);
    for (const k of ["day", "month"] as const) {
      expect(have[k].since_ms).toBe(want[k].since_ms);
      expect(have[k].usd).toBeCloseTo(want[k].usd, 9);
      expect(have[k].unpriced_calls).toBe(want[k].unpriced_calls);
    }
    return have;
  };
  // Rows of earlier this month and of last month, written before the first check.
  const day = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime();
  const old = store.db.query("INSERT INTO telemetry_calls (session_id, ts, model, cost, unpriced, outcome) VALUES (?, ?, 'p:main', ?, 0, 'ok')");
  for (let n = 0; n < 40; n++) old.run(s.id, day - Math.floor(rand() * 50 * 86_400_000), rand());
  t.spendChanged();
  expect(same().month.usd).toBeGreaterThan(0);
  // The sums are read from the ledger for the first check only.
  let sums = 0;
  const query = store.db.query.bind(store.db);
  (store.db as any).query = (sql: string) => { if (sql.includes("SUM(cost)")) sums++; return query(sql); };
  for (let n = 0; n < 300; n++) {
    send();
    if (n % 7 === 0) t.spend();
  }
  expect(sums).toBe(0);
  (store.db as any).query = query;
  expect(same().day.usd).toBeGreaterThan(0);
  expect(store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM telemetry_calls").get()!.n).toBe(340);
  // A row written by another connection (another process) is seen at the next check.
  const other = new Database(join(store.stateDir, "keel.db"));
  other.run("INSERT INTO telemetry_calls (session_id, ts, model, cost, unpriced, outcome) VALUES (?, ?, 'p:main', 5, 0, 'ok')", [s.id, Date.now()]);
  other.close();
  const after = same();
  expect(after.day.usd).toBeGreaterThan(5);
  // The day turns: the day's sum starts again, the month's goes on.
  const tomorrow = new Date(day + 30 * 3_600_000);
  const next = t.spend(tomorrow), want = spendOf(store.db, limits, tomorrow);
  expect(next.day.usd).toBe(want.day.usd);
  expect(next.month.usd).toBeCloseTo(want.month.usd, 9);
}));

// The running total is a plain sum and the ledger's is a compensated one: at
// a limit that equal costs add up to exactly, the two differ in the last
// digit. The request refused is the one the ledger's own sum refuses.
test("a budget is refused at the request the ledger's sum says, also when costs add up to it exactly", () => withStore(async (store) => {
  const { loadSettings, patchSettings } = await import("./settings.ts");
  const { spendOf } = await import("./telemetry-report.ts");
  loadSettings(store.stateDir, () => {});
  const s = store.createSession({ model: "p:main", workspace: "/" });
  store.append(s.id, "user", { text: "Start" });
  new PromptStore(store);
  const t = new Telemetry(store, new Bus());
  const hooks = allHooks().at(-1)!;
  const send = (cost: number) => {
    const req = { model: "m", system: "", messages: [], tools: [], signal: new AbortController().signal, purpose: "turn", route: "p:main" } as any;
    const sess = store.session(s.id)!;
    hooks.requestSent!(sess, req);
    hooks.requestDone!(sess, req, { blocks: [], stop: "end_turn", usage: { input: 10, output: 5, cache_read: 0, cache_write: 0, cost } } as any);
  };
  try {
    for (const [cost, limit, key] of [[0.1, 1, "daily_usd"], [0.01, 0.1, "daily_usd"], [0.0125, 0.1, "monthly_usd"], [1.1, 11, "daily_usd"], [0.3, 0.9, "monthly_usd"], [0.07, 0.7, "daily_usd"]] as const) {
      store.db.run("DELETE FROM telemetry_calls");
      t.spendChanged();
      expect(patchSettings({ budget: { daily_usd: null, monthly_usd: null, [key]: limit } }).ok).toBe(true);
      let refused = 0, ledger = 0;
      for (let n = 1; n <= 40 && !refused; n++) {
        // What every check did before the running total: the ledger's sum against the limit.
        const sums = spendOf(store.db, { daily_usd: null, monthly_usd: null });
        if (!ledger && (key === "daily_usd" ? sums.day.usd : sums.month.usd) >= limit) ledger = n;
        if ((t as any).overBudget()) refused = n;
        else send(cost);
      }
      expect([cost, limit, refused]).toEqual([cost, limit, ledger]);
      expect(refused).toBeGreaterThan(1);
    }
  } finally {
    patchSettings({ budget: { daily_usd: null, monthly_usd: null } });
  }
}));
