import { expect, test } from "bun:test";
import { didText, overviewText, TEXT_TOKENS, tokensOf, topTwo, type Overview, type OverviewRow } from "./overview.ts";

const AT = Date.UTC(2026, 0, 5, 12, 0, 0);
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
    "Sessions, read 2026-01-05 12:00 UTC: 8 open. Since 11:00 (1 h): 4 of the sessions' own turns ended, 1 failed; agents: 3 ended, 1 failed; $0.50 + unpriced spent in all.",
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
    "Sessions, read 2026-01-05 12:00 UTC: 0 open. Since 2026-01-03 12:00 (2 d): 0 of the sessions' own turns ended; $0.00 spent in all.",
    "Your agents: none at work, none ended since then.",
  ]);
  expect(didText({ turns: 1, failed: {}, agents: { completed: 2 }, cost: 0.004 })).toBe("1 turn; agents: 2 reported; $0.0040");
  // A list of classes says its two largest and counts the rest.
  expect(topTwo({ "rate limit": 6, overloaded: 2, declined: 1, budget: 1, "server error": 3 })).toBe("6 rate limit, 3 server error, 3 more");
  expect(didText({ turns: 2, failed: { "rate limit": 1 }, agents: {}, cost: 0 })).toBe("2 turns, 1 failed (rate limit)");
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
