import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { localDay, localTime, zoneLabel } from "../core/clock.ts";
import type { Watch } from "../core/watch.ts";
import { didText, overview, overviewText, TEXT_TOKENS, tokensOf, topTwo, totalsText, unlistedText, type Overview, type OverviewRow } from "./overview.ts";

const AT = Date.UTC(2026, 0, 5, 12, 0, 0);
// The report's times are the machine's own, with its offset: "2026-01-05 14:00 UTC+02:00".
const hm = (ts: number) => localTime(ts).slice(0, 5);
const READ = `${localDay(AT)} ${hm(AT)} ${zoneLabel(AT)}`;
const sid = (n: number) => `01a1fd4b-73d5-7478-a92a-${String(n).padStart(12, "0")}`;
const row = (n: number, r: Partial<OverviewRow> & { title: string }): OverviewRow => ({ id: sid(n), watch: "done", agents: 0, approvals: 0, parked: 0, ...r });
const page = (o: Partial<Overview>): Overview => ({ as_of: AT, since: AT - 3_600_000, until: AT + 1, sessions: [], hidden: 0, totals: { turns: 0, failed: 0, agents: {}, cost: 0 }, ...o });

// The parts the e2e's twenty sessions do not reach: sessions past the listed
// ones, quiet rows beside told ones, an ended agent, requests with no price.
test("the text groups by state, folds the quiet rows and counts what is not listed", () => {
  const text = overviewText(page({
    hidden: 3,
    totals: { turns: 4, failed: 1, agents: { completed: 2, failed: 1 }, cost: 0.5, unpriced: true },
    agents: [
      row(1, { title: "Scout", watch: "fail", agent: { id: "4aa654d842fb", status: "failed" }, last: AT - 120_000, failed: { ts: AT - 120_000, why: "rate limit", turn: "t1" } }),
    ],
    sessions: [
      row(2, { title: "Card of an agent", watch: "need", line: "an approval waits in an agent", from: AT - 240_000, refs: { approval_id: "a1", child_session: "c1" } }),
      row(3, { title: "Timer", watch: "work", line: "waits on a timer", from: AT - 60_000, until: AT + 600_000, more: 2 }),
      row(4, { title: "Told", last: AT - 5_000, did: { turns: 3, failed: { "rate limit": 2, declined: 1 }, agents: { completed: 2, failed: 1 }, cost: 0.4, unpriced: true } }),
      row(5, { title: "Quiet one", last: AT - 86_400_000 }),
      row(6, { title: `${"A long title ".repeat(8)}` }),
    ],
  }));
  expect(text.split("\n")).toEqual([
    `Sessions, read ${READ}: 8 open. Since ${hm(AT - 3_600_000)} (1 h): 4 of the sessions' own turns ended, 1 failed; agents: 3 ended, 1 failed; $0.50 + unpriced spent in all.`,
    "Your agents (1):",
    '  "Scout": failed 2 min ago: rate limit  [agent=4aa654d842fb]',
    "Needs you (1):",
    '  "Card of an agent": an approval waits in an agent, for 4 min  [session=000000000002]',
    "Working (1):",
    '  "Timer": waits on a timer, for 1 min, due in 10 min  [session=000000000003]',
    "Done (3):",
    '  "Told": finished 5 s ago; 3 turns, 3 failed (2 rate limit, 1 declined); agents: 3 ended, 1 failed; $0.40 + unpriced  [session=000000000004]',
    '  nothing since then: "Quiet one", "A long title A long title A long tit…"',
    "3 more sessions not listed, the quietest.",
  ]);
  expect(overviewText(page({ agents: [], since: AT - 2 * 86_400_000 })).split("\n")).toEqual([
    `Sessions, read ${READ}: 0 open. Since ${localDay(AT - 2 * 86_400_000)} ${hm(AT - 2 * 86_400_000)} (2 d): 0 of the sessions' own turns ended; $0.00 spent in all.`,
    "Your agents: none at work, none ended since then.",
  ]);
  expect(didText({ turns: 1, failed: {}, agents: { completed: 2 }, cost: 0.004 })).toBe("1 turn; agents: 2 reported; $0.0040");
  // A list of classes says its two largest and counts the rest.
  expect(topTwo({ "rate limit": 6, overloaded: 2, declined: 1, budget: 1, "server error": 3 })).toBe("6 rate limit, 3 server error, 3 more");
  expect(didText({ turns: 2, failed: { "rate limit": 1 }, agents: {}, cost: 0 })).toBe("2 turns, 1 failed (rate limit)");
});

// Every agent past the rows is said by how it ended, the failed first, and the parts add up.
// (It read "36 not listed: 30 reported, 3 stopped, 2 more", and the failed one was in "2 more".)
test("the agents past the rows are all said, a failed one first, and a stopped one says who stopped it", () => {
  expect(unlistedText({ completed: 30, stopped: 3, declined: 2, failed: 1 })).toBe("1 failed, 2 declined, 3 stopped, 30 reported");
  const text = overviewText(page({
    agents: [row(1, { title: "Hook lane", watch: "stop", agent: { id: "4aa654d842fb", status: "stopped", stopped_by: "hook" }, last: AT - 12 * 60_000 })],
    agents_total: 37, agents_unlisted: { completed: 30, stopped: 3, declined: 2, failed: 1 },
    sessions: [row(2, { title: "Held", watch: "stop", stopped_by: "api", last: AT - 60_000 })],
  })).split("\n");
  expect(text[1]).toBe("Your agents (37; 36 not listed: 1 failed, 2 declined, 3 stopped, 30 reported):");
  expect(text[2]).toBe('  "Hook lane": stopped by a hook 12 min ago  [agent=4aa654d842fb]');
  expect(text).toContain('  "Held": stopped through the API 1 min ago  [session=000000000002]');
});

// The bound the row asks, 1.5k tokens for twenty sessions, in the heavy cases:
// long titles, every row with many turns, seven failure classes, agents that
// ended four ways and unpriced requests. The tokens are counted from the
// text's shape (tokensOf, which never counts under a local BPE's measure of
// these texts); a text over the bound is written again with less in each
// row, never with fewer rows.
test("twenty heavy rows fit the bound, in the report and in the tool's form", () => {
  const long = "Review the tracing lane and report what blocks landing, with the probes and the numbers";
  const did = { turns: 14, failed: { "rate limit": 6, overloaded: 2, "server error": 1, "dropped stream": 2, "quota or billing": 1, declined: 1, budget: 1 }, agents: { completed: 12, failed: 3, incomplete: 1, stopped: 2 }, cost: 12.34, unpriced: true as const };
  const failed = (i: number) => row(i, { title: `${long} ${i}`, watch: "fail", failed: { ts: AT - i * 60_000, why: "quota or billing", turn: sid(900 + i), error_id: sid(800 + i) }, did });
  const need = (i: number) => row(100 + i, { title: `${long} ${i}`, watch: "need", agents: 2, approvals: 2, parked: 1, line: "an approval waits in an agent", from: AT - 300_000, more: 3, did });
  const work = (i: number) => row(200 + i, { title: `${long} ${i}`, watch: "work", agents: 3, parked: 2, line: "step 112, running Bash, Read, Agent", from: AT - 5_400_000, more: 4, did });
  const totals = { turns: 280, failed: 60, agents: { completed: 240, failed: 60, incomplete: 20, stopped: 40 }, cost: 246.8, unpriced: true as const };
  const mixed = [...Array.from({ length: 4 }, (_, i) => need(i)), ...Array.from({ length: 8 }, (_, i) => work(i)), ...Array.from({ length: 8 }, (_, i) => failed(i))];
  const cases = [
    page({ totals, sessions: Array.from({ length: 20 }, (_, i) => failed(i)) }),
    page({ totals, sessions: mixed }),
    // The tool's form: the asking session's agents are rows of the same twenty.
    page({ totals, sessions: mixed.filter((_, i) => i % 2 === 0), agents: Array.from({ length: 10 }, (_, i) => ({ ...failed(i), agent: { id: "4aa654d842fb", status: "failed" }, last: AT - 60_000 })) }),
  ];
  for (const o of cases) {
    const text = overviewText(o);
    expect(tokensOf(text)).toBeLessThanOrEqual(TEXT_TOKENS);
    // Every row is still there, with its session and its failures.
    expect(text.split("\n").filter((l) => /\[(session|agent)=[0-9a-f]{12}\]$/.test(l))).toHaveLength(20);
    expect(text).toContain("14 turns, 14 failed (6 rate limit, 2 overloaded, 5 more)");
  }
  // A light text is not cut: the agents' ends stay in its rows.
  expect(overviewText(page({ sessions: [failed(1)] }))).toContain("agents: 18 ended, 3 failed");
  // More rows than twenty have twenty rows' bound each twenty.
  const sixty = overviewText(page({ totals, sessions: Array.from({ length: 60 }, (_, i) => failed(i)) }));
  expect(tokensOf(sixty)).toBeLessThanOrEqual(TEXT_TOKENS * 3);
  // Twenty turns that each run three tools with long names: what a row does now is clipped, the row stays.
  const tools = "step 112, running mcp__playwright__browser_navigate_and_wait, mcp__agent_workspace_linux__observe_window, mcp__computer_use_linux__get_app_state and 2 more";
  const busy = overviewText(page({ totals, sessions: Array.from({ length: 20 }, (_, i) => ({ ...work(i), line: tools })) }));
  expect(tokensOf(busy)).toBeLessThanOrEqual(TEXT_TOKENS);
  expect(busy.split("\n").filter((l) => l.includes(": step 112, running mcp__playwright__browser_navigate_and_wai…, for "))).toHaveLength(20);
  // Titles of hex and numbers, which split into more tokens a byte than prose: counted as that, and still twenty rows.
  const hex = overviewText(page({ totals, sessions: Array.from({ length: 20 }, (_, i) => ({ ...failed(i), title: `0x${(i * 7919 + 48879).toString(16)}f3a9c1e2 9f8e7d6c5b4a 2026-11-${10 + i} 4096 ${i * 1337} deadbeef${i}` })) }));
  expect(tokensOf(hex)).toBeLessThanOrEqual(TEXT_TOKENS);
  expect(hex.split("\n").filter((l) => /\[session=[0-9a-f]{12}\]$/.test(l))).toHaveLength(20);
  // The count from the shape, against what a local BPE (o200k) counted for the same lines: never under.
  expect(tokensOf('  "Release notes": an approval waits, for 639 ms; $0.0002  [session=2024d43914ab]')).toBeGreaterThanOrEqual(28);
  expect(tokensOf("0x1f2e3d4cf3a9c1e2 9f8e7d6c5b4a 2026-11-10 4096 1337 deadbeef1")).toBeGreaterThanOrEqual(31);
});

// What a coordinator's report says in numbers is read from every row, not from the rows it lists.
test("the report counts every agent with the failed ones first, and reads who spent most and who is quietest over every session", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "overview-"));
  const store = new Store(dir);
  try {
    store.migrate(`ALTER TABLE sessions ADD COLUMN parent_id TEXT;
      CREATE TABLE telemetry_turns (id INTEGER PRIMARY KEY, session_id TEXT, ts INTEGER, ms INTEGER, outcome TEXT, turn_event TEXT);
      CREATE TABLE telemetry_calls (id INTEGER PRIMARY KEY, session_id TEXT, ts INTEGER, cost REAL, unpriced INTEGER, turn_event TEXT, outcome TEXT, error_class TEXT);
      CREATE TABLE agents (id TEXT PRIMARY KEY, parent_id TEXT, session_id TEXT, status TEXT, created INTEGER, ended INTEGER);`);
    const now = Date.now();
    const watch = new Map<string, Watch>();
    const mk = (title: string, w: Watch, turns: number, cost: number, parent?: string) => {
      const s = store.createSession({ model: "fixture:m", workspace: dir, title });
      if (parent) store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(parent, s.id);
      watch.set(s.id, w);
      for (let i = 0; i < turns; i++) store.db.query("INSERT INTO telemetry_turns (session_id, ts, ms, outcome, turn_event) VALUES (?, ?, 5, 'ok', ?)").run(s.id, now - 60_000 - i, `${s.id}-t${i}`);
      if (cost) store.db.query("INSERT INTO telemetry_calls (session_id, ts, cost, unpriced, outcome) VALUES (?, ?, ?, 0, 'ok')").run(s.id, now - 60_000, cost);
      return s.id;
    };
    const lead = mk("Dozen lanes", "wait", 2, 0.004);
    // Twelve agents: eight that reported, then four that failed first of all.
    const statuses = [...Array(4).fill("failed"), ...Array(7).fill("completed"), "waiting"];
    statuses.forEach((st, i) => {
      const id = mk(`Lane ${i + 1}`, st === "failed" ? "fail" : st === "waiting" ? "wait" : "done", 1, 0.001, lead);
      store.db.query("INSERT INTO agents (id, parent_id, session_id, status, created, ended) VALUES (?, ?, ?, ?, ?, ?)").run(`agent${i}`, lead, id, st, now - 50_000 + i, st === "waiting" ? null : now - 40_000 + i);
    });
    mk("Needs approval", "need", 0, 0.0003);
    mk("Asks a question", "need", 0, 0.0002);
    // Done, and the one that did most: it ended before the small ones, so by its time alone it would be the first left out.
    mk("Many turns", "done", 1200, 2.9);
    for (const t of ["Docs pass", "Lint config", "Changelog"]) mk(t, "done", 1, 0.0002);
    const cutOnly = mk("Only cut", "need", 0, 0);
    for (let i = 0; i < 2; i++) store.db.query("INSERT INTO telemetry_turns (session_id, ts, ms, outcome, turn_event) VALUES (?, ?, 5, 'cut', ?)").run(cutOnly, now - 30_000 - i, `cut${i}`);
    const from = {
      store, counts: () => new Map<string, number>(), now: () => ({ state: "idle" as const, lines: [] }),
      state: (x: { id: string }) => ({ watch: watch.get(x.id)!, agents: 0 }),
    };
    const o = overview(from, { since: now - 3_600_000, of: lead, max: 14 });
    // All twelve are counted; the rows hold ten, and every failed one is among them. It read "Your agents (10)" with two failed left out.
    expect(o.agents_total).toBe(12);
    expect(o.agents!.length).toBe(10);
    expect(o.agents!.filter((r) => r.agent!.status === "failed").length).toBe(4);
    expect(o.agents_unlisted).toEqual({ completed: 2 });
    // Four rows are left for the sessions: the three that need the owner, and of the done ones the one that did most.
    // (Two of the listed ones did nothing in the window, so the three left out are not "the quietest": they are named by state.)
    expect(o.sessions.map((r) => r.title).sort()).toEqual(["Asks a question", "Many turns", "Needs approval", "Only cut"]);
    expect(o.hidden).toBe(3);
    expect(o.hidden_did).toEqual({ turns: 3, cost: expect.closeTo(0.0006, 6) });
    // The most spent is read over every session, the asking one with its agents' spend too.
    expect(o.top!.map((t) => [t.title, Number(t.cost.toFixed(4))])).toEqual([["Many turns", 2.9], ["Dozen lanes", 0.016], ["Needs approval", 0.0003]]);
    // A turn a restart cut is not one that ended.
    expect(o.sessions.find((r) => r.title === "Only cut")!.did).toMatchObject({ turns: 0, cut: 2 });
    expect(o.totals).toMatchObject({ turns: 1205, cut: 2 });
    const text = overviewText(o).split("\n");
    expect(text[1]).toBe("Your agents (12; 2 not listed: 2 reported):");
    expect(text.find((l) => l.includes('"Only cut"'))).toContain("; 2 turns cut");
    // (The three did as much as each other: the name is the first by title, whatever order they were made in.)
    expect(text.at(-2)).toBe('3 more sessions not listed: 3 done (3 turns, $0.0006), the busiest: "Changelog".');
    expect(text.at(-1)).toBe('Most spent since then: "Many turns" $2.90, "Dozen lanes" $0.02, "Needs approval" $0.0003.');
    // With two rows for the sessions the busiest done one is left out: the line says what the left-out ones did, and it still leads the spend.
    const two = overviewText(overview(from, { since: now - 3_600_000, of: lead, max: 12 })).split("\n");
    // The audit's statement 6 again: the session of 1,200 turns is among the hidden, so they are not called the quietest, and it is named.
    expect(two.at(-2)).toBe('5 more sessions not listed: 4 done, 1 needs you (1203 turns, $2.90), the busiest: "Many turns".');
    // Two sessions that did nothing in the window, and room for every other: what is left out is the quietest, and is called so.
    mk("Idle one", "idle", 0, 0);
    mk("Idle two", "idle", 0, 0);
    const most = overviewText(overview(from, { since: now - 3_600_000, max: 8 })).split("\n");
    expect(most.at(-2)).toBe("2 more sessions not listed, the quietest.");
    expect(two.at(-1)).toStartWith('Most spent since then: "Many turns" $2.90');
    expect(totalsText({ turns: 3, cut: 2, failed: 1, agents: {}, cost: 0 })).toBe("3 of the sessions' own turns ended, 1 failed, 2 cut by a restart; $0.00 spent in all");
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a row that says how long itself is given one duration, and a cut turn is said apart from the ended ones", () => {
  const text = overviewText(page({ sessions: [
    row(1, { title: "Silent", watch: "work", line: "step 1, the model is answering, no output for 26 s", from: AT - 120_000 }),
    row(2, { title: "Streams", watch: "work", line: "step 1, the model is answering", from: AT - 3_000 }),
  ] })).split("\n");
  expect(text[2]).toBe('  "Silent": step 1, the model is answering, no output for 26 s  [session=000000000001]');
  expect(text[3]).toBe('  "Streams": step 1, the model is answering, for 3 s  [session=000000000002]');
  expect(didText({ turns: 1, cut: 2, failed: { "rate limit": 1 }, agents: {}, cost: 0 })).toBe("1 turn, 1 failed (rate limit), 2 cut");
  // The class a row already gave as why it failed is not said again.
  expect(didText({ turns: 1, failed: { "rate limit": 1 }, agents: {}, cost: 0 }, 0, "rate limit")).toBe("1 turn, 1 failed");
  expect(didText({ turns: 0, cut: 2, failed: {}, agents: {}, cost: 0 })).toBe("2 turns cut");
});
