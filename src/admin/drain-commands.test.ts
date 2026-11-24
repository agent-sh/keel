import { expect, test } from "bun:test";
import { COMMAND_WAIT_MS, commandsBegin, commandsEnd, waitForCommands } from "./drain-commands.ts";
import { drainLine, exitLine } from "./daemon-log.ts";

// A clock the wait runs on: each wait moves it, and `ending` says which commands have ended by then.
const clock = (ending: Record<string, number>, ids: string[]) => {
  let t = 0;
  const waits: number[] = [];
  return {
    waits,
    o: {
      list: () => ids.filter((id) => ending[id] === undefined || t < ending[id]!).map((id) => ({ id, session: "s" })),
      now: () => t,
      wait: async (ms: number) => { waits.push(ms); t += ms; },
    },
  };
};

test("the drain waits for the commands in front of turns until they end, and counts none cut", async () => {
  const c = clock({ a: 3_000, b: 20_000 }, ["a", "b"]);
  expect(await waitForCommands({ ...c.o, boundMs: COMMAND_WAIT_MS })).toEqual({ waited: 2, cut: 0 });
  expect(c.waits.reduce((x, y) => x + y, 0)).toBe(20_000);
});

test("a command still running at the bound is counted cut, and the wait is no longer than the bound", async () => {
  const c = clock({ a: 3_000 }, ["a", "b", "c"]);
  expect(await waitForCommands({ ...c.o, boundMs: 10_000 })).toEqual({ waited: 3, cut: 2 });
  expect(c.waits.reduce((x, y) => x + y, 0)).toBe(10_000);
});

test("no command in front: no wait; a command that starts meanwhile is not waited for", async () => {
  const none = clock({}, []);
  expect(await waitForCommands({ ...none.o, boundMs: 60_000 })).toEqual({ waited: 0, cut: 0 });
  expect(none.waits).toEqual([]);
  let t = 0, ids = ["a"];
  const r = await waitForCommands({ list: () => ids.map((id) => ({ id, session: "s" })), now: () => t, boundMs: 60_000, wait: async (ms) => { t += ms; ids = ["b"]; } });
  expect(r).toEqual({ waited: 1, cut: 0 });
});

test("the notices say how many commands the restart waits for and how many it cut", () => {
  expect(commandsBegin(3, COMMAND_WAIT_MS)).toBe("3 commands run in front of a turn: the restart waits up to 60 s more for them before it parks the turns.");
  expect(commandsBegin(1, COMMAND_WAIT_MS)).toBe("1 command runs in front of a turn: the restart waits up to 60 s more for it before it parks the turns.");
  expect(commandsEnd(2, COMMAND_WAIT_MS)).toContain("2 commands still ran after 60 s and were stopped by the restart");
  expect(drainLine({ restart: true, running: 2, timeoutMs: 120_000, commands: 1, commandsMs: COMMAND_WAIT_MS })).toBe("[daemon] draining for a restart: 2 turns running get up to 2 min; 1 command runs in front of them, waited for up to 1 min more");
  expect(exitLine({ restart: true, parked: 2, upMs: 60_000, cut: 1 })).toBe("[daemon] restarting after 1 min up: 2 turns parked for the next start, 1 command in front of them cut");
});
