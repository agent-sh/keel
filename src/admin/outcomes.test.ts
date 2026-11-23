// A turn's rollup over rows the clock cannot tell apart: two turns in the same
// millisecond, a side request, and history from before the ids were recorded.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { allHooks } from "../engine/hooks.ts";
import { Outcomes } from "./outcomes.ts";
import { Telemetry } from "./telemetry.ts";

// A store of its own; the hooks its ledgers registered go with it.
function fixture() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "outcomes-test-"));
  const store = new Store(dir);
  const before = allHooks().length;
  new Telemetry(store, new Bus());
  return { store, close: () => { allHooks().splice(before); store.db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const id = (n: number) => `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const T = 1_700_000_000_000;
const usage = (input: number, cost: number) => ({ input, output: 1, cache_read: 0, cache_write: 0, cost });
const turnRows = (store: Store) => Object.fromEntries(store.db.query<any, []>("SELECT * FROM telemetry_turns").all().map((r) => [r.turn_event, r]));

test("two turns in one millisecond each count the requests and tools recorded with their own id", () => {
  const { store, close } = fixture();
  try {
    const [a, b] = [id(1), id(2)];
    const s = store.createWithEvents({ model: "p:m", workspace: "/" }, [
      { id: id(10), kind: "user", data: { text: "one" }, ts: T },
      { id: a, kind: "turn_start", data: { model: "p:m" }, ts: T },
      { id: id(11), kind: "turn_end", data: { reason: "end_turn", usage: {} }, ts: T },
      { id: id(12), kind: "user", data: { text: "two" }, ts: T },
      { id: b, kind: "turn_start", data: { model: "p:m" }, ts: T },
      { id: id(13), kind: "turn_end", data: { reason: "end_turn", usage: {} }, ts: T },
    ]);
    const call = store.db.query("INSERT INTO telemetry_calls (session_id, ts, model, input, output, cost, outcome, purpose, turn_event, attempt) VALUES (?, ?, 'p:m', ?, 1, ?, ?, ?, ?, 1)");
    const tool = store.db.query("INSERT INTO telemetry_tools (session_id, ts, tool, is_error, turn_event) VALUES (?, ?, ?, ?, ?)");
    call.run(s.id, T, 10, 0.25, "ok", "turn", a);
    call.run(s.id, T, 0, null, "error", "turn", a);
    call.run(s.id, T, 300, 2, "ok", "turn", b);
    call.run(s.id, T, 400, 3, "ok", "summary", b);
    // An advisor's answer while the turns ran: in neither.
    call.run(s.id, T, 9000, 50, "ok", "side", null);
    tool.run(s.id, T, "Bash", 1, a);
    tool.run(s.id, T, "Bash", 0, b);
    tool.run(s.id, T, "Read", 0, b);
    tool.run(s.id, T, "Read", 1, b);

    new Outcomes(store);
    const rows = turnRows(store);
    expect(rows[a]).toMatchObject({ requests: 2, failed_attempts: 1, input: 10, cost: 0.25, tool_calls: 1, tool_errors: 1 });
    expect(rows[b]).toMatchObject({ requests: 2, failed_attempts: 0, input: 700, cost: 5, tool_calls: 3, tool_errors: 1 });
  } finally { close(); }
});

test("rows from before the ids were recorded are counted once, in the last turn started at or before them", () => {
  const { store, close } = fixture();
  try {
    const [a, b, c] = [id(1), id(2), id(3)];
    const use = { type: "tool_use", id: "call_1", name: "Bash", input: {} };
    const s = store.createWithEvents({ model: "p:m", workspace: "/" }, [
      { id: id(10), kind: "user", data: { text: "one" }, ts: T },
      { id: a, kind: "turn_start", data: { model: "p:m" }, ts: T },
      { id: id(11), kind: "assistant", data: { blocks: [use], model: "p:m", usage: usage(10, 0.25), stop: "tool_use" }, ts: T },
      { id: id(12), kind: "tool_result", data: { results: [{ type: "tool_result", tool_use_id: "call_1", is_error: true, content: "no" }] }, ts: T },
      { id: id(13), kind: "turn_end", data: { reason: "end_turn", usage: {} }, ts: T + 5 },
      { id: id(14), kind: "user", data: { text: "two" }, ts: T + 5 },
      { id: b, kind: "turn_start", data: { model: "p:m" }, ts: T + 5 },
      { id: id(15), kind: "assistant", data: { blocks: [{ type: "text", text: "done" }], model: "p:m", usage: usage(300, 2), stop: "end_turn" }, ts: T + 5 },
      { id: id(16), kind: "turn_end", data: { reason: "end_turn", usage: {} }, ts: T + 5 },
      // A third turn in the same millisecond with no request of its own.
      { id: c, kind: "turn_start", data: { model: "p:m" }, ts: T + 5 },
      { id: id(17), kind: "turn_end", data: { reason: "interrupted", usage: {} }, ts: T + 9 },
    ]);
    // The ledger from before the ids: Telemetry's own backfill of the stored steps.
    store.db.exec("DELETE FROM admin_meta WHERE key = 'telemetry_backfill'");
    const before = allHooks().length;
    new Telemetry(store, new Bus());
    allHooks().splice(before);
    expect(store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM telemetry_calls WHERE session_id = ? AND turn_event IS NULL").get(s.id)!.n).toBe(2);
    // A request after the last turn ended is in no turn.
    store.db.query("INSERT INTO telemetry_calls (session_id, ts, model, input, output, cost, outcome) VALUES (?, ?, 'p:m', 77, 1, 9, 'ok')").run(s.id, T + 20);

    new Outcomes(store);
    const rows = turnRows(store);
    expect(rows[a]).toMatchObject({ requests: 1, input: 10, cost: 0.25, tool_calls: 1, tool_errors: 1 });
    expect(rows[b]).toMatchObject({ requests: 0, tool_calls: 0 });
    // The request at the shared millisecond goes to the last turn started by then, and only to it.
    expect(rows[c]).toMatchObject({ requests: 1, input: 300, cost: 2, tool_calls: 0 });
    const total = Object.values(rows).reduce((n: number, r: any) => n + r.requests, 0);
    expect(total).toBe(2);
  } finally { close(); }
});

// What a turn's end reads, by the statements it runs and their plans.
test("a turn's end reads rows without an id by its time range, and the next turn's start once", () => {
  const { store, close } = fixture();
  try {
    const [a, b] = [id(1), id(2)];
    const s = store.createWithEvents({ model: "p:m", workspace: "/" }, [
      { id: id(10), kind: "user", data: { text: "one" }, ts: T },
      { id: a, kind: "turn_start", data: { model: "p:m" }, ts: T },
      { id: id(11), kind: "turn_end", data: { reason: "end_turn", usage: {} }, ts: T + 50 },
      { id: id(12), kind: "user", data: { text: "two" }, ts: T + 60 },
      { id: b, kind: "turn_start", data: { model: "p:m" }, ts: T + 60 },
      { id: id(13), kind: "turn_end", data: { reason: "end_turn", usage: {} }, ts: T + 90 },
    ]);
    // Many rows without an id elsewhere in time: what the turn_event index holds under one key.
    const tool = store.db.query("INSERT INTO telemetry_tools (session_id, ts, tool, is_error, turn_event) VALUES (?, ?, 'Bash', 0, ?)");
    const call = store.db.query("INSERT INTO telemetry_calls (session_id, ts, model, input, output, outcome, purpose, turn_event) VALUES (?, ?, 'p:m', 1, 1, 'ok', ?, ?)");
    store.db.transaction(() => { for (let i = 0; i < 2000; i++) { tool.run("other", T - 10_000 - i, null); call.run("other", T - 10_000 - i, null, null); } })();
    // In the first turn's time: five rows without an id of each kind, and side answers.
    for (let i = 0; i < 5; i++) { tool.run(s.id, T + i, null); call.run(s.id, T + i, null, null); call.run(s.id, T + i, "side", null); }
    // The second turn has only rows with its id.
    tool.run(s.id, T + 70, b);
    call.run(s.id, T + 70, "turn", b);

    const seen: string[] = [];
    const query = store.db.query.bind(store.db);
    (store.db as any).query = (sql: string) => (seen.push(sql), query(sql));
    new Outcomes(store);
    (store.db as any).query = query;
    const rows = turnRows(store);
    expect(rows[a]).toMatchObject({ requests: 5, tool_calls: 5 });
    expect(rows[b]).toMatchObject({ requests: 1, tool_calls: 1 });

    const plan = (sql: string) => store.db.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join("\n");
    const noId = seen.filter((q) => /turn_event IS NULL/.test(q));
    const [tools, calls] = [noId.find((q) => q.includes("telemetry_tools"))!, noId.find((q) => q.includes("telemetry_calls"))!];
    // The time range and the session's own rows, never every row without an id; no look at the events per row.
    expect(plan(tools)).toContain("telemetry_tools_session");
    expect(plan(tools)).not.toContain("telemetry_tools_turn");
    expect(plan(calls)).toContain("telemetry_calls_session");
    expect(plan(calls)).not.toContain("telemetry_calls_turn");
    for (const q of [tools, calls]) expect(plan(q)).not.toContain("SUBQUERY");
    // The next turn's start: once for the first turn (it has rows to place), not at all for the second.
    expect(seen.filter((q) => /FROM events WHERE session_id = \? AND kind = 'turn_start'/.test(q))).toHaveLength(1);
  } finally { close(); }
});
