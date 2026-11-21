// The pure rules of what memory adds to a turn and how its use is counted.
import { expect, test } from "bun:test";
import { asksMemory, factOf, handlesOf, usedBy } from "./memory-meter.ts";
import { fitMemory, memoryBlock, shownLines } from "./tacit.ts";

test("a block adds the lines the context lacks, whole, within its cap; what does not fit is owed, never dropped", () => {
  const block = "# store: facts matching this request\n- alpha-rule: Keep the first thing\n- beta-rule: Keep the second thing\n- gamma-rule: Keep the third thing\nOpen one with its name.";
  const all = fitMemory(block, new Set(), 10_000);
  expect(all).toMatchObject({ text: block, repeats: 0, owed: [] });
  expect(all.lines).toEqual(["- alpha-rule: Keep the first thing", "- beta-rule: Keep the second thing", "- gamma-rule: Keep the third thing"]);
  // A line the context holds is left out; the title and the closing line stay with the rest.
  const some = fitMemory(block, new Set(["- beta-rule: Keep the second thing"]), 10_000);
  expect(some).toMatchObject({ repeats: 1, owed: [], lines: ["- alpha-rule: Keep the first thing", "- gamma-rule: Keep the third thing"] });
  expect(some.text).not.toContain("beta-rule");
  expect(some.text).toContain("Open one with its name.");
  // Everything held already: no block, and nothing owed (it is in the context).
  expect(fitMemory(block, new Set(all.lines), 10_000)).toEqual({ text: null, lines: [], repeats: 3, owed: [] });
  // Room for the title, one fact and the line that says more follow: the
  // first fact whole, and the rest owed in the store's order.
  const tight = fitMemory(block, new Set(), 150);
  expect(tight.lines).toEqual(["- alpha-rule: Keep the first thing"]);
  expect(tight.owed).toEqual(["- beta-rule: Keep the second thing", "- gamma-rule: Keep the third thing", "Open one with its name."]);
  expect(tight.text).toBe("# store: facts matching this request\n- alpha-rule: Keep the first thing\n[3 more lines follow with the next step: this block is full]");
  expect(tight.text!.length).toBeLessThanOrEqual(150);
  // Every line is in the block or owed, whatever the room: nothing is lost.
  for (const room of [110, 150, 200, 10_000]) {
    const f = fitMemory(block, new Set(), room);
    expect([...f.lines, ...f.owed.filter((l) => l.startsWith("- "))]).toEqual(all.lines);
    expect(f.lines.length).toBeGreaterThan(0); // what is owed always shrinks
  }
  // What is owed, offered again, goes on where the block stopped.
  const next = fitMemory(tight.owed.join("\n"), new Set(tight.lines), 10_000);
  expect(next).toMatchObject({ lines: ["- beta-rule: Keep the second thing", "- gamma-rule: Keep the third thing"], owed: [] });
  // One line longer than a block goes in parts: its start here with a line
  // saying it goes on, and the rest owed first, so nothing of it is dropped.
  const huge = `- huge: ${"x".repeat(300)}${"y".repeat(300)}`;
  const long = fitMemory(`${huge}\n- small: fits`, new Set(), 250);
  expect(long.text).toContain("[the line above goes on with the next step: it is longer than a block]");
  expect(long.text!.length).toBeLessThanOrEqual(250);
  expect(long.owed.length).toBe(2);
  expect(long.owed[1]).toBe("- small: fits");
  expect(long.text!.split("\n")[0]! + long.owed[0]!.replace("(continued) ", "")).toBe(huge);
  // The rest, offered again, goes on in parts until it is through.
  let rest = long.owed, got = long.text!.split("\n")[0]!, rounds = 0;
  while (rest.length && rounds++ < 10) {
    const f = fitMemory(rest.join("\n"), new Set(), 250);
    for (const l of f.text!.split("\n")) if (l.startsWith("(continued) ")) got += l.replace("(continued) ", "");
    rest = f.owed;
  }
  expect(got).toBe(huge);
  expect(rest).toEqual([]);
  expect(fitMemory("x".repeat(500), new Set(), 200).text!.startsWith("xxxxxxxx")).toBe(true);
});

test("the lines a context holds are read from its memory blocks only", () => {
  const note = `${memoryBlock("session-start", "# rules\n- RULE one: First")}\n\n${memoryBlock("prompt", "# facts\n- two: Second\nOpen one with its name.")}`;
  expect(shownLines(note)).toEqual(["- RULE one: First", "- two: Second"]);
  expect(shownLines(`output of a command\n- not memory: a list item\n\n${memoryBlock("pre-tool", "- three: Third")}`)).toEqual(["- three: Third"]);
  expect(shownLines("- a list in a file: nothing from memory")).toEqual([]);
});

test("the store is asked about what asks for work, not about what the harness delivers", () => {
  const asks = [
    {}, { origin: "steer" }, { origin: "queued" }, { origin: "voice" }, { origin: "cli" }, { origin: "momentum" }, { origin: "hook" },
    { kind: "task" }, { kind: "task_start" }, { kind: "steer" }, { kind: "peer" }, { kind: "review" }, { kind: "review_fix" }, { kind: "verify_goal" },
    // A loop's run is the owner's standing prompt; a goal's start and resume carry the objective.
    { kind: "loop", loop_name: "x" }, { kind: "goal", goal: "start" }, { kind: "goal", goal: "resume" },
    // Several deliveries in one input: any part that asks.
    { kind: "wake", parts: [{ kind: "subagent" }, { kind: "steer" }] }, { kind: "wake", parts: [{ kind: "wait" }, { kind: "loop" }] },
  ];
  const delivered = [
    { kind: "subagent" }, { kind: "wait" }, { kind: "goal", goal: "continue" }, { kind: "failures" }, { kind: "helper_digest" }, { kind: "harness" },
    { origin: "harness" }, { origin: "restart" }, { kind: "wake", parts: [{ kind: "subagent" }, { kind: "wait" }] }, { kind: "wake" },
  ];
  for (const d of asks) expect([d, asksMemory(d)]).toEqual([d, true]);
  for (const d of delivered) expect([d, asksMemory(d)]).toEqual([d, false]);
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

test("three common words in a row say nothing; a tool call that touches what a fact names does", () => {
  const f = factOf("- gateway-place: The gateway is in the west region and it is at the end of the list");
  // "is in the", "at the end": any two texts share them.
  expect(usedBy(f, "It is in the kitchen, at the end of the day, and it is fine.")).toBe(false);
  expect(usedBy(f, "I checked: the gateway is in the west region.")).toBe(true);
  const g = factOf("- own-file: Edit the config only through src/core/ownfile.ts, with `bun test ./test/cli` after, never --no-verify");
  expect(handlesOf(g.text).sort()).toEqual(["--no-verify", "./test/cli", "bun test ./test/cli", "ownfile.ts", "src/core/ownfile.ts"]);
  expect(usedBy(g, "Done.")).toBe(false);
  // Only what a tool call held counts as acted on: the reply's own words do not.
  expect(usedBy(g, "Done.", "sed -n 1,20p src/core/ownfile.ts")).toBe(true);
  expect(usedBy(g, "Done.", "git commit --no-verify -m x")).toBe(true);
  expect(usedBy(g, "Done.", "ls src/core")).toBe(false);
  // Two common words with a slash between them are no path.
  expect(handlesOf("Version 1.2 is out, e.g. today. Use it and/or wait, his/her call.")).toEqual([]);
  expect(handlesOf("It lives under src/core and in docs/api.")).toEqual(["src/core", "docs/api"]);
});
