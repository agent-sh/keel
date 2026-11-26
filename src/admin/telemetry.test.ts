// The ledger's attribution over the event tree, which a live e2e cannot set
// up: history from before telemetry (a fork copied with it), and branches.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { allHooks, cacheBreaks } from "../engine/hooks.ts";
import { changedBlocks } from "../engine/prompt-store.ts";
import { PromptStore } from "../engine/prompt-store.ts";
import { breakCause, prefixDiff, prefixOf, Telemetry } from "./telemetry.ts";
import { loadSettings } from "./settings.ts";

// These tests write a database of their own to disk (tens of thousands of
// rows); under a disk stall of a shared machine a write waits seconds, and the
// 5 s default was passed in whole-suite runs by tests that take under a second alone.
setDefaultTimeout(20_000);

// Turn hooks are process-wide: the files after this one run without the ones its tests register.
const hooksAtStart = allHooks().length;
// The settings are process-wide too: a test that loads a folder of its own and removes it leaves the files after
// this one a settings file no save can write. The scratch state folder is loaded again.
afterAll(() => { allHooks().length = hooksAtStart; loadSettings(process.env.KEEL_STATE_DIR!, () => {}); });

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
  const [ex] = await t.examples({});
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

// A turn resumed after a restart runs the calls it was cut in before its first
// request: they are that turn's, so its timeline can count the ones that failed.
test("a call that runs before its turn's first request is booked to that turn", () => withStore(async (store) => {
  const s = store.createSession({ model: "p:main", workspace: "/" });
  new PromptStore(store);
  new Telemetry(store, new Bus());
  const hooks = allHooks().at(-1)!;
  const sess = () => store.session(s.id)!;
  const run = (id: string, failed: boolean) => hooks.toolRan!(sess(), { id, tool: { name: "Read" }, input: {} } as any, { type: "tool_result", tool_use_id: id, content: failed ? "File does not exist: /x" : "ok", is_error: failed } as any, { ms: 1, outcome: failed ? "error" : "ok" });
  const turnsOf = () => store.db.query<{ call_id: string; turn_event: string | null }, [string]>("SELECT call_id, turn_event FROM telemetry_tools WHERE session_id = ? ORDER BY rowid").all(s.id).map((r) => [r.call_id, r.turn_event]);
  const request = () => {
    const req = { model: "m", system: "", messages: [], tools: [], signal: new AbortController().signal, purpose: "turn", route: "p:main" } as any;
    hooks.requestSent!(sess(), req);
    hooks.requestDone!(sess(), req, { blocks: [], stop: "end_turn", usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 } } as any);
  };
  store.append(s.id, "user", { text: "go" });
  hooks.turnStart?.(sess());
  const first = store.append(s.id, "turn_start", { model: "p:main" });
  request();
  run("c1", false);
  store.append(s.id, "turn_end", { reason: "restart" });
  // The turn that goes on: its calls run before any request of it.
  hooks.turnStart?.(sess());
  const second = store.append(s.id, "turn_start", { model: "p:main" });
  run("c2", true);
  run("c3", true);
  request();
  run("c4", false);
  expect(turnsOf()).toEqual([["c1", first.id], ["c2", second.id], ["c3", second.id], ["c4", second.id]]);
  expect(store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM telemetry_tools WHERE turn_event = ? AND is_error = 1").get(second.id)!.n).toBe(2);
}));

// A turn request that wrote its context again after warm requests read it within its lifetime: the warm
// requests missed (a failed warm), not an expiry or the provider's own miss.
test("a miss after warm requests is told as theirs", () => withStore(async (store) => {
  const s = store.createSession({ model: "p:m", workspace: "/" });
  store.append(s.id, "user", { text: "Start" });
  new PromptStore(store);
  const t = new Telemetry(store, new Bus());
  const hooks = allHooks().at(-1)!;
  const send = async (purpose: "turn" | "warm", read: number, write: number) => {
    await Bun.sleep(2); // (each request in a millisecond of its own: the ledger orders them by their start)
    const req = { model: "m", system: "", messages: [], tools: [], signal: new AbortController().signal, purpose, route: "p:m", cacheMs: 300_000 } as any;
    const sess = store.session(s.id)!;
    hooks.requestSent!(sess, req);
    const res = { blocks: [], stop: "end_turn", usage: { input: 0, output: 1, cache_read: read, cache_write: write } } as any;
    hooks.requestDone!(sess, req, res);
    return res;
  };
  const causes = async () => (await t.report({})).breaks.map((b) => [b.cause, b.count]);
  await send("turn", 0, 10_000);
  await send("turn", 1_000, 9_000);
  expect(await causes()).toEqual([["provider_miss", 1]]);
  await send("warm", 10_000, 0);
  const missed = await send("turn", 1_000, 9_100);
  expect(await causes()).toEqual([["warm_missed", 1], ["provider_miss", 1]]);
  // The cause is told with the answer, for the wait kept warm (src/engine/cache-plans.ts answered); a read is "none".
  expect([cacheBreaks.get(missed), cacheBreaks.get(await send("turn", 10_000, 100))]).toEqual(["warm_missed", "none"]);
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
  // Warm requests read it within its lifetime: their miss, past the lifetime or not; a changed prefix is still that.
  expect(breakCause({ ...gap, gapMs: 3_600_000, lifeMs: 300_000, diff: [], warmed: true })).toBe("warm_missed");
  expect(breakCause({ ...gap, gapMs: 1_000, diff: ["tools"], warmed: true })).toBe("prefix_changed");
  // With no difference recorded for the last request, nothing says the prefix held: not the warm requests' miss.
  expect(breakCause({ ...gap, gapMs: 1_000, diff: null, warmed: true })).toBe("prefix_changed");
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
  // Another connection that commits something else (the checkpoint thread's own row) does not make the ledger be summed again.
  const beside = new Database(join(store.stateDir, "keel.db"));
  let again = 0;
  (store.db as any).query = (sql: string) => { if (sql.includes("SUM(cost)")) again++; return query(sql); };
  for (let n = 0; n < 5; n++) {
    beside.run("UPDATE log_starts SET n = n + 1");
    same();
    send();
  }
  beside.close();
  // (same() reads the ledger's sums itself, twice a call, to compare: none of them is the total's own.)
  expect(again).toBe(5 * 2);
  (store.db as any).query = query;
  // A row written by another connection (another process) is seen at the next check.
  const other = new Database(join(store.stateDir, "keel.db"));
  other.run("INSERT INTO telemetry_calls (session_id, ts, model, cost, unpriced, outcome) VALUES (?, ?, 'p:main', 5, 0, 'ok')", [s.id, Date.now()]);
  other.close();
  const after = same();
  expect(after.day.usd).toBeGreaterThan(5);
  // Also one written while a request of this daemon's was under way: the daemon's own row comes after it,
  // and being the ledger's newest does not hide the other.
  const third = new Database(join(store.stateDir, "keel.db"));
  third.run("INSERT INTO telemetry_calls (session_id, ts, model, cost, unpriced, outcome) VALUES (?, ?, 'p:main', 7, 0, 'ok')", [s.id, Date.now()]);
  third.close();
  send();
  expect(same().day.usd).toBeGreaterThan(after.day.usd + 6.99);
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
  const { patchSettings } = await import("./settings.ts");
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

test("a failed call's reason is kept as the cause line, scrubbed like any error text the store keeps", () => withStore(async (store) => {
  const s = store.createSession({ model: "p:main", workspace: store.stateDir });
  new PromptStore(store);
  new Telemetry(store, new Bus());
  const hooks = allHooks().at(-1)!;
  // The store's scrub, as the secrets module sets it: a key-shaped token becomes a placeholder.
  store.redact = (_session, kind, v) => (kind === "error" ? String(v).replace(/sk-[A-Za-z0-9-]{16,}/g, "[secret:test]") : v);
  // A token of a key's shape, made here so that none stands in this file.
  const key = `sk-${"k".repeat(24)}`;
  hooks.toolRan!(store.session(s.id)!, { id: "c1", tool: { name: "Bash" }, input: {} } as any,
    { type: "tool_result", tool_use_id: "c1", is_error: true, content: `Exit code 1\nconnecting\n\x1b[31merror\x1b[0m: Authorization: Bearer ${key} was rejected\nsee the log` } as any, { ms: 1, outcome: "error" });
  // It read "Exit code 1", then "see the log" with the key as printed.
  expect(store.db.query<{ error: string }, []>("SELECT error FROM telemetry_tools").all().map((r) => r.error)).toEqual(["error: Authorization: Bearer [secret:test] was rejected (exit code 1)"]);
}));

test("a failed call is kept with its class and cause, old rows get theirs once, and the report ranks tool failures by cause", () => withStore(async (store) => {
  const s = store.createSession({ model: "p:main", workspace: store.stateDir });
  new PromptStore(store);
  const t = new Telemetry(store, new Bus());
  const hooks = allHooks().at(-1)!;
  const fail = (id: string, tool: string, content: string) => hooks.toolRan!(store.session(s.id)!, { id, tool: { name: tool }, input: {} } as any,
    { type: "tool_result", tool_use_id: id, is_error: true, content } as any, { ms: 1, outcome: "error" });
  fail("a", "Read", "File does not exist: /w/one.ts");
  fail("b", "Read", "File does not exist: /w/two.ts");
  fail("c", "Edit", "The old_string was not found in the file.");
  // A failure that names no cause has no class.
  fail("d", "Bash", "Exit code 1");
  hooks.toolRan!(store.session(s.id)!, { id: "e", tool: { name: "Read" }, input: {} } as any, { type: "tool_result", tool_use_id: "e", content: "ok" } as any, { ms: 1, outcome: "ok" });
  // Ranked by cause, the message's shape kept beside it.
  const ranked = () => t.report({}, true).then((r) => r.tool_failure_causes.map((c) => [c.tool, c.cause, c.count, c.shapes.map((x) => x.shape)] as const).sort((a, b) => b[2] - a[2] || a[0].localeCompare(b[0])));
  expect(await ranked()).toEqual([["Read", "missing_file", 2, ["File does not exist: <path>"]], ["Bash", "nonzero_exit", 1, []], ["Edit", "bad_input", 1, ["The old_string was not found in the file."]]]);
  // Rows from before the column: the class is set again from the kept line, once.
  store.db.exec("UPDATE telemetry_tools SET error_class = NULL, cause = NULL");
  store.db.exec("DELETE FROM admin_meta WHERE key IN ('telemetry_tool_class', 'telemetry_tool_cause')");
  const again = new Telemetry(store, new Bus());
  expect(await again.report({}, true).then((r) => r.tool_failure_causes.map((c) => [c.tool, c.cause, c.count, c.shapes.map((x) => x.shape)] as const).sort((a, b) => b[2] - a[2] || a[0].localeCompare(b[0])))).toEqual(await ranked());
  expect(store.db.query("SELECT COUNT(*) AS n FROM telemetry_tools WHERE error_class IS NOT NULL").get()).toEqual({ n: 3 });
  expect((await t.examples({ tool: "Edit" }))[0]).toMatchObject({ error_class: "The old_string was not found in the file.", cause: "bad_input" });
}));

// The report on a ledger that takes long to read is answered from what is kept, and the kept numbers are the full
// read's. The ledger here is small; the times that make a read "long" are set to nothing for the test.
test("a report is answered from the kept one while the ledger is read again, and its numbers are the full read's", () => withStore(async (store) => {
  const { reportOf } = await import("./telemetry-report.ts");
  const s = store.createSession({ model: "p:m", workspace: "/" });
  const t = new Telemetry(store, new Bus());
  const ins = store.db.query("INSERT INTO telemetry_calls (session_id, ts, model, latency_ms, ttft_ms, input, output, cache_read, cache_write, cost, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const tool = store.db.query("INSERT INTO telemetry_tools (session_id, ts, tool, ms, is_error) VALUES (?, ?, ?, ?, ?)");
  const now = Date.now();
  let n = 0;
  const fill = (rows: number) => store.db.transaction(() => {
    for (let i = 0; i < rows; i++, n++) {
      const ts = now - 6 * 86_400_000 + n * 20_000;
      ins.run(s.id, ts, n % 3 ? "p:m" : "q:other", 400 + (n * 37) % 9000, 80 + (n * 13) % 700, 100 + (n % 50), 20 + (n % 90), 30_000 + n, n % 400, n % 7 ? 0.01 + (n % 10) / 1000 : null, n % 41 ? "ok" : "error");
      tool.run(s.id, ts + 5, ["Bash", "Read", "Edit"][n % 3]!, 10 + (n % 300), n % 29 ? 0 : 1);
    }
  })();
  fill(6_000);
  const q = () => ({ since: Date.now() - 7 * 86_400_000 });
  // The full read: what the report is without anything kept.
  const full = () => JSON.parse(JSON.stringify(reportOf(store.db, q(), { daily_usd: null, monthly_usd: null })));
  const sums = (r: any) => ({ total: r.total, by_model: r.by_model, tools: r.tools, series: r.series.length });
  const settled = async () => { for (let i = 0; i < 200 && (t as any).reading.size; i++) await Bun.sleep(5); };
  const env = { fresh: process.env.KEEL_REPORT_FRESH_MS, slow: process.env.KEEL_REPORT_SLOW_MS };
  process.env.KEEL_REPORT_FRESH_MS = "0";
  process.env.KEEL_REPORT_SLOW_MS = "0";
  try {
    // The first ask reads the ledger and waits for it.
    const first = await t.report(q());
    expect(first.refreshing).toBeUndefined();
    expect(first.total.calls).toBe(6_000);
    expect(sums(first)).toEqual(sums(full()));
    const before = sums(first);
    // Rows are written. The next ask is answered at once with the kept numbers and says how old they are and that the ledger is read again.
    fill(500);
    const stale = await t.report(q());
    expect(stale.refreshing).toBe(true);
    expect(stale.as_of_ms).toBe(first.as_of_ms);
    expect(sums(stale)).toEqual(before);
    // Once that read is done the answer is the full read's again.
    await settled();
    const next = await t.report(q());
    expect(next.total.calls).toBe(6_500);
    expect(sums(next)).toEqual(sums(full()));
    expect(next.as_of_ms).toBeGreaterThan(first.as_of_ms);
    await settled();
    // `refresh` waits for a read of now.
    fill(100);
    const asked = await t.report(q(), true);
    expect(asked.refreshing).toBeUndefined();
    expect(sums(asked)).toEqual(sums(full()));
    // The next daemon on this store answers its first ask from the report kept with the store, and reads behind it.
    fill(50);
    const later = new Telemetry(store, new Bus());
    const kept = await later.report(q());
    expect(kept.refreshing).toBe(true);
    // (A report is written to the store at most once in five minutes: the one kept there is the first.)
    expect(kept.total.calls).toBe(6_000);
    for (let i = 0; i < 200 && (later as any).reading.size; i++) await Bun.sleep(5);
    expect(sums(await later.report(q()))).toEqual(sums(full()));
    for (let i = 0; i < 200 && (later as any).reading.size; i++) await Bun.sleep(5);
    // A session's report is another question: read for itself, not answered from the report of all.
    expect((await later.report({ ...q(), session: s.id })).refreshing).toBeUndefined();
  } finally {
    if (env.fresh === undefined) delete process.env.KEEL_REPORT_FRESH_MS; else process.env.KEEL_REPORT_FRESH_MS = env.fresh;
    if (env.slow === undefined) delete process.env.KEEL_REPORT_SLOW_MS; else process.env.KEEL_REPORT_SLOW_MS = env.slow;
  }
  // A ledger that is read in a moment is read at every ask: the numbers are never old.
  fill(10);
  const quick = await t.report(q());
  expect([quick.refreshing, quick.total.calls]).toEqual([undefined, 6_660]);
}));

test("a session's last runs of one tool are read by an index of the session and the tool, not by a walk of every run", () => withStore((store) => {
  new Telemetry(store, new Bus());
  // The statement each tool step of a turn runs on the loop (src/engine/turn.ts toolShape).
  const plan = store.db.query<{ detail: string }, [string, string]>("EXPLAIN QUERY PLAN SELECT ms FROM telemetry_tools WHERE session_id = ? AND tool = ? AND ms IS NOT NULL ORDER BY ts DESC LIMIT 20").all("s", "Bash").map((r) => r.detail).join("; ");
  expect(plan).toContain("USING INDEX telemetry_tools_session_tool (session_id=? AND tool=?)");
  expect(plan).not.toContain("TEMP B-TREE");
  // The build pin's question of whether the session ever called the tool reads the same index.
  const used = store.db.query<{ detail: string }, [string, string]>("EXPLAIN QUERY PLAN SELECT 1 FROM telemetry_tools WHERE session_id = ? AND tool = ? LIMIT 1").all("s", "Bash").map((r) => r.detail).join("; ");
  expect(used).toContain("(session_id=? AND tool=?)");
}));

// A call's step is looked up at every tool call on the loop: it reads the newest steps of the session,
// never its whole history. A call a program made is the program's call's.
test("a tool call finds its step among the newest ones, a program's call by the call that ran the program", () => withStore(async (store) => {
  const s = store.createSession({ model: "p:m", workspace: "/" });
  new PromptStore(store);
  new Telemetry(store, new Bus());
  const hooks = allHooks().at(-1)!;
  const step = (id: string) => store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id, name: "Read", input: {} }], model: "p:m", usage: {}, stop: "tool_use" });
  const old = step("old");
  for (let i = 0; i < 12; i++) step(`mid${i}`);
  const now = step("now");
  const run = (id: string, nestedIn?: string) => hooks.toolRan!(store.session(s.id)!, { id, tool: { name: "Read" }, input: {}, ctx: nestedIn ? { nestedIn } : {} } as any, { type: "tool_result", tool_use_id: id, content: "ok" } as any, { ms: 1, outcome: "ok" });
  run("now"); run("inner", "now"); run("old"); run("unknown");
  await store.side.flush?.();
  const rows = store.db.query<{ call_id: string; event_id: string | null; model: string | null }, [string]>("SELECT call_id, event_id, model FROM telemetry_tools WHERE session_id = ? ORDER BY rowid").all(s.id);
  expect(rows.map((r) => [r.call_id, r.event_id, r.model])).toEqual([["now", now.id, "p:m"], ["inner", now.id, "p:m"], ["old", null, null], ["unknown", null, null]]);
  // A listed example of an old row is found by the read thread through the whole history.
  store.db.query("UPDATE telemetry_tools SET is_error = 1, error = 'x' WHERE call_id = 'old'").run();
  expect((await new Telemetry(store, new Bus()).examples({})).map((e: any) => [e.call_id, e.event_id])).toEqual([["old", old.id]]);
}));
