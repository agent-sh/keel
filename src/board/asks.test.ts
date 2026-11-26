import { expect, test } from "bun:test";
import { askState, linkAsks, type AskFacts } from "./asks.ts";
import type { BoardRow } from "./rules.ts";
import { notHis } from "./asks-read.ts";

const input = (id: string, seq: number, ts: number, text: string) => ({ id, seq, ts, how: "prompt" as const, text });
const agent = (id: string, created: number, task = "", parent_id = "root") => ({ id, parent_id, session_id: `s-${id}`, created, task });

test("an agent is tied to the owner's message whose turn started it, and to one its task quotes", () => {
  const f: AskFacts = {
    root: "root",
    inputs: [
      input("m1", 1, 100, "Make the message box shorter and the status line two lines"),
      input("m2", 5, 300, "ok"),
      input("m3", 9, 500, "Show the sessions of every machine in the list, under a separator of their own"),
    ],
    ends: [200, 400, 600],
    agents: [
      agent("a1", 150),                                        // in m1's turn
      agent("a2", 250),                                        // after m1's turn ended: started by a report, no owner turn
      agent("a3", 700, "Lane: the owner asked to show the sessions of every machine in the list today"), // quotes m3
      agent("a4", 710, "", "s-a1"),                            // under a1
    ],
  };
  const asks = linkAsks(f);
  // Newest first; "ok" has no work tied to it and too few words: not an ask.
  expect(asks.map((a) => a.id)).toEqual(["m3", "m1"]);
  expect(asks.find((a) => a.id === "m1")!.links).toEqual([{ agent: "a1", by: "turn" }, { agent: "a4", by: "under" }]);
  expect(asks.find((a) => a.id === "m3")!.links).toEqual([{ agent: "a3", by: "task" }]);
  expect(asks.every((a) => a.ended)).toBe(true);
});

const row = (id: string, o: Partial<BoardRow>): BoardRow => ({
  id, session_id: `s-${id}`, parent_id: "root", depth: 1, title: id, type: "general-purpose", model: "m", state: "completed", created: 1, ended: 2,
  machine: null, branch: null, repo: null, base: null, head: null, ahead: null, behind: null, worktree: null, checks: null, review: null, reviews: [],
  landed: null, queue: null, live: null, work: null, together: null, ...o,
});

test("an ask is as far as the least advanced branch of its work", () => {
  const ask = (...agents: string[]) => ({ ended: true, links: agents.map((agent) => ({ agent, by: "turn" as const })) });
  const rows = [
    row("live", { branch: "b1", landed: { state: "yes", how: "ancestor" }, live: { state: "yes", at: "x", how: "this daemon" } }),
    row("main", { branch: "b2", landed: { state: "yes", how: "patch" }, live: { state: "no", at: "x", how: "this daemon" } }),
    row("refused", { branch: "b3", landed: { state: "no", missing: 1 }, review: { by: "r", title: "r", how: "named", state: "completed", verdict: "refused", source: "verdict", line: "no", tip: null, of: null, current: true, at: 1 } }),
    row("work", { state: "running", branch: "b4" }),
    row("research", {}),
    row("reviewer", { reviews: ["b3"] }),
  ];
  expect(askState(ask("live"), rows).state).toBe("running");
  expect(askState(ask("live", "main"), rows).state).toBe("on main");
  expect(askState(ask("live", "refused"), rows).state).toBe("in review");
  expect(askState(ask("live", "work"), rows).state).toBe("working");
  // A finished agent with no branch says nothing of a branch's state; alone it reported.
  expect(askState(ask("live", "research"), rows).state).toBe("running");
  expect(askState(ask("research"), rows).state).toBe("reported");
  // A reviewer is its branch's review, not work of its own.
  expect(askState(ask("live", "reviewer"), rows).agents.map((x) => x.id)).toEqual(["live"]);
  expect(askState(ask("reviewer"), rows).state).toBe("reported");
  expect(askState({ ended: true, links: [] }, rows).state).toBe("replied");
  expect(askState({ ended: false, links: [] }, rows).state).toBe("asked");
});

test("a steer and a typed card answer of a turn are tied to the agents that turn starts after them", () => {
  const asks = linkAsks({
    root: "root",
    inputs: [
      input("p", 1, 100, "Build the export feature for the reports page please"),
      { id: "s", seq: 2, ts: 110, how: "steer", text: "also keep the export small and plain" },
      { id: "c", seq: 3, ts: 115, how: "answer", text: "use the csv format for every export file" },
    ],
    ends: [200],
    agents: [agent("a", 120, "Implement export."), agent("late", 250)],
  });
  for (const id of ["p", "s", "c"]) expect(asks.find((a) => a.id === id)!.links).toEqual([{ agent: "a", by: "turn" }]);
});

test("a task ties only an agent no turn ties, and not by a phrase the tasks of several turns copy", () => {
  const standing = "heavy checks on the dev desk with eight runs at most";
  const asks = linkAsks({
    root: "root",
    inputs: [
      input("old", 1, 100, `Fix the login bug. ${standing}.`),
      input("new", 3, 300, "Now add dark mode to the settings page with its own toggle"),
      input("third", 5, 500, "Show the sessions of every machine in the list, under a separator"),
    ],
    ends: [200, 400, 600],
    agents: [
      agent("a1", 150, `Fix login. ${standing}.`),                      // old's turn
      agent("a2", 350, `Add dark mode. ${standing}.`),                  // new's turn, copies old's standing phrase
      agent("a3", 650, `Later. ${standing}.`),                          // no turn: the phrase is in several turns' tasks
      agent("a4", 660, "show the sessions of every machine in the list please"), // no turn: quotes third alone
      agent("a5", 550, "", "s-a1"),                                     // under a1
    ],
  });
  const of = (id: string) => asks.find((a) => a.id === id)!.links;
  expect(of("old")).toEqual([{ agent: "a1", by: "turn" }, { agent: "a5", by: "under" }]);
  expect(of("new")).toEqual([{ agent: "a2", by: "turn" }]);
  expect(of("third")).toEqual([{ agent: "a4", by: "task" }]);
  expect(asks.some((a) => a.links.some((l) => l.agent === "a3"))).toBe(false);
});

test("an agent the board has no row of is unknown, never no agent", () => {
  const ask = (...agents: string[]) => ({ ended: true, links: agents.map((agent) => ({ agent, by: "turn" as const })) });
  const rows = [row("main", { branch: "b", landed: { state: "yes", how: "ancestor" }, live: { state: "yes", at: "x", how: "this daemon" } }), row("work", { state: "running" })];
  expect(askState(ask("gone"), rows)).toEqual({ state: "unknown", agents: [], unknown: 1 });
  // A known running branch says nothing of an unknown agent's; a working one is as far as any can be behind.
  expect(askState(ask("main", "gone"), rows).state).toBe("unknown");
  expect(askState(ask("work", "gone"), rows)).toMatchObject({ state: "working", unknown: 1 });
});

test("the harness's notes and a peer session's message are not the owner's asks", () => {
  expect(notHis("[harness] The daemon restarted.")).toBe(true);
  expect(notHis('<external_input source="peer_session" from="x">do it</external_input>')).toBe(true);
  expect(notHis("Build the export page")).toBe(false);
});

test("linking a long session's asks costs one pass a task", () => {
  // (4,000 inputs and 400 agents of 800 words: 1.4 to 2.4 s when each ask's runs were rebuilt a task; about 0.2 s now.)
  let n = 1;
  const word = () => `w${(n = (n * 48271) % 2147483647) % 3000}`;
  const said = (k: number) => Array.from({ length: k }, word).join(" ");
  const inputs = Array.from({ length: 4000 }, (_, i) => ({ id: crypto.randomUUID(), seq: i, ts: i * 10, how: "prompt" as const, text: said(60) }));
  const agents = Array.from({ length: 400 }, (_, i) => ({ id: crypto.randomUUID(), parent_id: "root", session_id: `s${i}`, created: i * 100 + 1, task: said(800) }));
  const t0 = performance.now();
  linkAsks({ root: "root", inputs, ends: inputs.map((i) => i.ts + 5), agents });
  expect(performance.now() - t0).toBeLessThan(1_000);
});
