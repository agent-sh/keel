import { expect, test } from "bun:test";
import type { RestartTurn } from "../admin/life-rows.ts";
import { cutAgentsLine } from "./restart-told.ts";

const turn = (n: number, o: Partial<RestartTurn>): RestartTurn => ({
  turn_event: `t${n}`, end_event: `e${n}`, started_ms: 1, ran_ms: 4000, down_ms: 2, crashed: true, unstarted: false, step: 1, tools: [], waiting: 0,
  session_id: `s${n}`, title: `Session ${n}`, parent_id: "p", state: "continued", ...o,
});

test("a parent is told which of its agents a restart cut and what became of each, in one line", () => {
  const names: Record<string, string> = { s1: "Builder", s2: "Writer", s3: "Tester", s4: "Scout" };
  const named = (sid: string) => (names[sid] ? { id: `a${sid.slice(1)}`, title: names[sid]! } : undefined);
  const line = cutAgentsLine([
    turn(1, { tools: ["Bash"] }),
    turn(2, { waiting: 1 }),
    turn(3, { state: "held", why: "This turn was resumed after a daemon restart 3 times in a row,   and each time the daemon went down again." }),
    turn(4, { state: "moved", why: "went on in a turn started by its parent" }),
    turn(5, {}), // a silent agent: not one the parent follows
  ], named);
  expect(line).toBe(
    '[harness] A daemon restart cut 4 of your agents mid-turn: "Builder" (a1) resumed; "Writer" (a2) resumed, waits on the owner\'s answer; '
    + '"Tester" (a3) not continued: This turn was resumed after a daemon restart 3 times in a row, and each time the daemon went down again.; '
    + '"Scout" (a4) went on in a turn started by its parent. A resumed agent reports as before: nothing to send it.');
  // One agent, not continued: nothing is said of resumed ones.
  expect(cutAgentsLine([turn(1, { state: "left" })], named)).toBe('[harness] A daemon restart cut 1 of your agents mid-turn: "Builder" (a1) not continued.');
  expect(cutAgentsLine([turn(5, {})], named)).toBeUndefined();
});
