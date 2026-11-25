import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { allHooks } from "../engine/hooks.ts";
import * as agents from "./agents.ts";
import * as waits from "./waits.ts";
import { setDeps } from "./core.ts";
import { sessionState, TALLY } from "./state.ts";
import { startJob, stopJob } from "../tools/jobs.ts";
import { stuckSaid } from "../core/stuck.ts";

const hooksAtStart = allHooks().length;
afterAll(() => { allHooks().length = hooksAtStart; });

test("a session's state counts its own agents by a seek on the parent, never by a pass over every agent stored", () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-state-"));
  const store = new Store(join(dir, "state"));
  setDeps({ store, bus: new Bus(), errors: { capture() {} }, engine: { isRunning: () => false, isHeld: () => false }, providers: { current: () => [] } } as any);
  store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT");
  agents.migrate();
  const lead = store.createSession({ model: "m:x", workspace: dir, title: "Lead" });
  const other = store.createSession({ model: "m:x", workspace: dir, title: "Other" });
  const alone = store.createSession({ model: "m:x", workspace: dir, title: "Alone" });
  // Twelve agents of one session (four failed, one waiting), and twenty thousand of another.
  const now = Date.now();
  const add = store.db.query("INSERT INTO agents (id, parent_id, session_id, title, type, model, background, status, created, ended) VALUES (?, ?, ?, 'a', 'general-purpose', 'm:x', 1, ?, ?, ?)");
  store.db.transaction(() => {
    ["failed", "failed", "failed", "failed", "waiting", ...Array(7).fill("completed")].forEach((st, i) => add.run(`lead-${i}`, lead.id, `sl-${i}`, st, now - 60_000, st === "waiting" ? null : now - 1000));
    for (let i = 0; i < 20_000; i++) add.run(`other-${i}`, other.id, `so-${i}`, i % 5 ? "completed" : "failed", now - 60_000, now - 1000);
  })();
  expect(sessionState(store.session(lead.id)!)).toMatchObject({ agents: 1, agents_total: 12, agents_failed: 4, agents_waiting: 1 });
  expect(sessionState(store.session(other.id)!)).toMatchObject({ agents_total: 20_000, agents_failed: 4_000 });
  // A session with no agent has no counts.
  const none = sessionState(store.session(alone.id)!);
  expect(none.agents_total).toBeUndefined();
  expect(none.agents_failed).toBeUndefined();
  // The read is a search of one parent's rows on the parent's index: its cost does not grow with the table.
  // (It grouped the whole table for every state: 41 ms at a hundred thousand agents.)
  const plan = store.db.query<{ detail: string }, [string, number, number]>(`EXPLAIN QUERY PLAN ${TALLY}`).all(lead.id, 0, 0).map((r) => r.detail).join("; ");
  expect(plan).toContain("SEARCH agents USING INDEX agents_parent (parent_id=?)");
  expect(plan).not.toMatch(/SCAN (agents|a)\b/);
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) store.db.query(TALLY).get(lead.id, now - 86_400_000, 0);
  expect((performance.now() - t0) / 200).toBeLessThan(1);
  store.db.close();
});

// The row counts what the agents line under it counts (src/core/agent-count.ts): the whole tree,
// live or of the last day, and as failed only what failed after the owner last looked.
test("a session's agent counts are its tree's of the last day, and its failures since the owner looked", () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-state-"));
  const store = new Store(join(dir, "state"));
  setDeps({ store, bus: new Bus(), errors: { capture() {} }, engine: { isRunning: () => false, isHeld: () => false }, providers: { current: () => [] } } as any);
  store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT");
  agents.migrate();
  const lead = store.createSession({ model: "m:x", workspace: dir, title: "Coordinator" });
  const long = store.createSession({ model: "m:x", workspace: dir, title: "Long", parent_id: lead.id } as any);
  const now = Date.now(), day = 86_400_000;
  const add = store.db.query("INSERT INTO agents (id, parent_id, session_id, title, type, model, background, status, created, ended) VALUES (?, ?, ?, 'a', 'general-purpose', 'm:x', 1, ?, ?, ?)");
  store.db.transaction(() => {
    // Three days of work: forty agents that ended days ago, eleven of them failed.
    for (let i = 0; i < 40; i++) add.run(`old-${i}`, lead.id, `so-${i}`, i < 11 ? "failed" : "completed", now - 3 * day, now - 2 * day);
    // Live for two days, still at work, with an agent of its own that ended an hour ago.
    add.run("long", lead.id, long.id, "running", now - 2 * day, null);
    add.run("deep", long.id, "s-deep", "completed", now - 2 * 3_600_000, now - 3_600_000);
    // Today: one failure the owner looked at, then one more.
    add.run("seen", lead.id, "s-seen", "failed", now - 5 * 3_600_000, now - 4 * 3_600_000);
    add.run("new", lead.id, "s-new", "failed", now - 2 * 3_600_000, now - 600_000);
  })();
  store.mergeSettings(lead.id, { agents_failed_ms: now - 4 * 3_600_000 + 5, agents_fail_seen_ms: now - 4 * 3_600_000 + 5 });
  // The tree's four of the day (the live one, its own agent, the two failures), one failed since the look.
  expect(sessionState(store.session(lead.id)!)).toMatchObject({ agents_total: 4, agents_failed: 1 });
  // A live agent under one that ended days ago is reached all the same.
  const old = store.createSession({ model: "m:x", workspace: dir, title: "Old", parent_id: lead.id } as any);
  add.run("old", lead.id, old.id, "completed", now - 3 * day, now - 2 * day);
  add.run("under-old", old.id, "s-under-old", "running", now - 2 * day, null);
  expect(sessionState(store.session(lead.id)!)).toMatchObject({ agents_total: 5, agents_failed: 1 });
  store.db.query("DELETE FROM agents WHERE id IN ('old', 'under-old')").run();
  // Never looked at: both of the day's failures are news.
  store.mergeSettings(lead.id, { agents_fail_seen_ms: null });
  expect(sessionState(store.session(lead.id)!)).toMatchObject({ agents_total: 4, agents_failed: 2 });
  store.db.close();
});

// A command its session left running works; one that writes nothing past the tool's stuck limit is marked
// stuck, "command running long" in the session's words, while one that keeps writing is not.
test("a session's command that writes nothing past the tool's limit marks it stuck, still working", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-state-"));
  const store = new Store(join(dir, "state"));
  setDeps({ store, bus: new Bus(), errors: { capture() {} }, engine: { isRunning: () => false, isHeld: () => false }, providers: { current: () => [] } } as any);
  store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT");
  agents.migrate();
  const hung = store.createSession({ model: "m:x", workspace: dir, title: "Hung" });
  const busy = store.createSession({ model: "m:x", workspace: dir, title: "Busy" });
  const logDir = join(dir, "jobs");
  const a = startJob({ sessionId: hung.id, command: "sleep 30", description: "the hung run", cwd: dir, logDir, background: true });
  const b = startJob({ sessionId: busy.id, command: "for i in $(seq 1500); do echo x; sleep 0.02; done", cwd: dir, logDir, background: true });
  try {
    const after = { model: 120_000, tool: 300 };
    await Bun.sleep(600);
    const st = sessionState(store.session(hung.id)!, { after });
    expect(st).toMatchObject({ watch: "work", why: "command", stuck: { what: "tool", text: "Command running long" }, text: "Command running long: the hung run", label: "Working", word: "working (command running long)" });
    expect(stuckSaid({ ...st.stuck!, elapsed_ms: 660_000 })).toBe("Command running long, no output for 11m");
    const ok = sessionState(store.session(busy.id)!, { after });
    expect([ok.watch, ok.why, ok.stuck, ok.word]).toEqual(["work", "command", undefined, "working (command in background)"]);
  } finally {
    await stopJob(a);
    await stopJob(b);
    store.db.close();
  }
});

// A silent command is what a wait the session set watches: the wait owns the time, so the session is not
// listed as stuck. The same command with no wait set is (the test above).
test("a session that set a wait of its own is not stuck by the silent command the wait watches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-state-"));
  const store = new Store(join(dir, "state"));
  setDeps({ store, bus: new Bus(), errors: { capture() {} }, engine: { isRunning: () => false, isHeld: () => false }, providers: { current: () => [] } } as any);
  store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT");
  agents.migrate();
  waits.migrate();
  const parked = store.createSession({ model: "m:x", workspace: dir, title: "Parked" });
  const bare = store.createSession({ model: "m:x", workspace: dir, title: "Bare" });
  const logDir = join(dir, "jobs");
  const a = startJob({ sessionId: parked.id, command: "sleep 30", description: "the remote check", cwd: dir, logDir, background: true });
  const b = startJob({ sessionId: bare.id, command: "sleep 30", description: "the hung run", cwd: dir, logDir, background: true });
  try {
    store.db.query("INSERT INTO waits (id, session_id, kind, spec, note, status, created, deadline, by) VALUES ('w1', ?, 'log', '{}', 'a stage line', 'active', ?, ?, NULL)").run(parked.id, Date.now(), Date.now() + 3_600_000);
    await Bun.sleep(600);
    const after = { model: 120_000, tool: 300 };
    expect(sessionState(store.session(bare.id)!, { after }).stuck?.what).toBe("tool");
    const st = sessionState(store.session(parked.id)!, { after });
    expect([st.watch, st.why, st.stuck]).toEqual(["work", "command", undefined]);
  } finally {
    await stopJob(a);
    await stopJob(b);
    store.db.close();
  }
});
