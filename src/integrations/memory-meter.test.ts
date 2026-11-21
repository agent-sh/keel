// The pure rules of what memory adds to a turn and how its use is counted.
import { expect, test } from "bun:test";
import { asksMemory, factOf, usedBy } from "./memory-meter.ts";
import { fitMemory, memoryBlock, shownLines } from "./tacit.ts";

test("a block adds the lines the context lacks, whole, within the room, first ones kept", () => {
  const block = "# store: facts matching this request\n- alpha-rule: Keep the first thing\n- beta-rule: Keep the second thing\n- gamma-rule: Keep the third thing\nOpen one with its name.";
  const all = fitMemory(block, new Set(), 10_000);
  expect(all).toMatchObject({ text: block, repeats: 0, cut: 0 });
  expect(all.lines).toEqual(["- alpha-rule: Keep the first thing", "- beta-rule: Keep the second thing", "- gamma-rule: Keep the third thing"]);
  // A line the context holds is left out; the title and the closing line stay with the rest.
  const some = fitMemory(block, new Set(["- beta-rule: Keep the second thing"]), 10_000);
  expect(some).toMatchObject({ repeats: 1, cut: 0, lines: ["- alpha-rule: Keep the first thing", "- gamma-rule: Keep the third thing"] });
  expect(some.text).not.toContain("beta-rule");
  expect(some.text).toContain("Open one with its name.");
  // Everything held already: no block at all.
  expect(fitMemory(block, new Set(all.lines), 10_000)).toEqual({ text: null, lines: [], repeats: 3, cut: 0 });
  // Room for the title, one fact and the line that says the rest was left out
  // (two facts fit without that line, and it counts): the first fact whole.
  const tight = fitMemory(block, new Set(), 130);
  expect(tight).toMatchObject({ lines: ["- alpha-rule: Keep the first thing"], cut: 2 });
  expect(tight.text).toBe("# store: facts matching this request\n- alpha-rule: Keep the first thing\n[2 more left out: over this turn's memory budget]");
  expect(tight.text!.length).toBeLessThanOrEqual(130);
  // No room for a fact with that line: nothing, never half a line.
  for (const room of [40, 80]) expect(fitMemory(block, new Set(), room)).toMatchObject({ text: null, cut: 3 });
  // A block that is one long text keeps its start.
  expect(fitMemory("x".repeat(500), new Set(), 100).text).toBe("x".repeat(100));
});

test("the lines a context holds are read from its memory blocks only", () => {
  const note = `${memoryBlock("session-start", "# rules\n- RULE one: First")}\n\n${memoryBlock("prompt", "# facts\n- two: Second\nOpen one with its name.")}`;
  expect(shownLines(note)).toEqual(["- RULE one: First", "- two: Second"]);
  expect(shownLines(`output of a command\n- not memory: a list item\n\n${memoryBlock("pre-tool", "- three: Third")}`)).toEqual(["- three: Third"]);
  expect(shownLines("- a list in a file: nothing from memory")).toEqual([]);
});

test("the store is asked about requests, not about what the harness delivers", () => {
  for (const d of [{}, { origin: "steer" }, { origin: "queued" }, { origin: "voice" }, { kind: "task" }, { kind: "peer" }, { origin: "momentum" }, { kind: "review" }]) expect(asksMemory(d)).toBe(true);
  for (const d of [{ kind: "subagent" }, { kind: "wait" }, { kind: "wake" }, { kind: "loop" }, { kind: "goal" }, { kind: "failures" }, { kind: "helper_digest" }, { kind: "harness" }, { origin: "harness" }, { origin: "restart" }]) expect(asksMemory(d)).toBe(false);
});

test("a fact counts as used when the output names it or repeats three of its words in a row", () => {
  expect(factOf("- RULE deploy-freeze: No deploys on Fridays after noon")).toEqual({ names: ["deploy-freeze"], text: "No deploys on Fridays after noon" });
  expect(factOf("- person.dana-levi (person): Dana is the accountant")).toEqual({ names: ["person.dana-levi"], text: "Dana is the accountant" });
  expect(factOf("- staging (this machine): The gateway is halcyon")).toMatchObject({ names: ["staging"] });
  const f = factOf("- deploy-freeze: No deploys on Fridays after noon");
  expect(usedBy(f, "Per deploy-freeze, I will wait.")).toBe(true);
  expect(usedBy(f, "It is Friday afternoon, and there are no deploys on Fridays, so I will wait.")).toBe(true);
  expect(usedBy(f, '{"command":"echo deploy_freeze"}')).toBe(true); // names are compared as words
  expect(usedBy(f, "Deploying now. No problems on the way.")).toBe(false);
  expect(usedBy({ names: ["person.dana-levi", "dana"], text: "Dana is the accountant" }, "I sent it to Dana.")).toBe(true);
  expect(usedBy({ names: ["ab"], text: "Short one" }, "ab is here")).toBe(false); // a name too short to tell
});
