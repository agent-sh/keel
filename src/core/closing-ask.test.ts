import { expect, test } from "bun:test";
import { closingAsk, firstLine } from "./closing-ask.ts";

// Shapes of turn finals as a coordinator's store holds them (read-only from a live store, the words made generic):
// every unattended final the rule took there was a decision asked of the owner, and none was another's question.

test("a decision asked in the closing paragraph, with a short line after it, is owed to the owner", () => {
  const text = [
    "The lane built two fixes, now in review:",
    "- **Specialist agents:** one that needs a connector is refused with the reason.",
    "",
    "One decision is yours. The mail tools are reachable only through the other harness. Keel holds that sign-in too, but using it is authority you have not given. Do you want Keel to use your connectors directly? Until you say yes, they stay where they are.",
  ].join("\n");
  expect(closingAsk(text)).toBe("Do you want Keel to use your connectors directly?");
});

test("a list of open questions that ends the reply asks the last of them", () => {
  const text = "Both are blocked. Two questions for you are still open:\n\n- **Issue:** should I post the issue about the duplicated weights?\n- **Check:** should I run the quality and speed check?";
  expect(closingAsk(text)).toBe("Check: should I run the quality and speed check?");
  expect(closingAsk("Here is the summary of the thread.\n\nWant me to draft the reply?")).toBe("Want me to draft the reply?");
});

test("a reply that ends on a statement, a question told of, a quote, code or a bold label asks nothing", () => {
  // Most finals: a report.
  expect(closingAsk("Landing 12 is verified and live. Nine lanes are working, so nothing new this tick.")).toBeUndefined();
  // A question sent to an agent, told in the closing paragraph.
  expect(closingAsk("The new test fails on the old code. I asked the reviewer three questions:\n- **The mark:** it may need the urgent mark.\n- **The tools test:** it ends with one more turn. Is that caused by this change?")).toBeUndefined();
  // A label that asks, answered on its own line.
  expect(closingAsk("- **Did a scratch daemon use your config?** The lane searched the logs. No hook of yours ever ran.\n- **A smaller issue:** the walk should stop at the home folder.")).toBeUndefined();
  // A rhetorical question answered in the same paragraph.
  expect(closingAsk("Why did it fail? The cache was cold, and the request wrote it again.")).toBeUndefined();
  // A quoted question, in a quote block, in quotation marks and in code.
  expect(closingAsk("The reviewer wrote:\n\n> Should this land before the rebase?")).toBeUndefined();
  expect(closingAsk('The card now reads "Allow this command?" in both themes.')).toBeUndefined();
  expect(closingAsk("Its prompt is now `Continue?` and the default is no.")).toBeUndefined();
  expect(closingAsk("Done.\n\n```\nread -p 'Continue?' x\n```")).toBeUndefined();
  expect(closingAsk("")).toBeUndefined();
});

test("a question told to an agent, tracked, in a table, under a heading or after a status line asks the owner nothing", () => {
  // The coordinator's account of what it asked its agents.
  expect(closingAsk("The lane's tests are red. I told the lane: can you rebase onto main and run them again?")).toBeUndefined();
  expect(closingAsk("Sent the reviewer a message: does the fix hold on a 30k session?")).toBeUndefined();
  expect(closingAsk("Waiting on the agent's answer to: why did the build fail?")).toBeUndefined();
  expect(closingAsk("Next I will ask the reviewer whether the pin holds. Does it hold on a cold cache?")).toBeUndefined();
  expect(closingAsk("Open items I am tracking:\n- why does the flake come back on the dev desk?")).toBeUndefined();
  // A table cell and a heading are labels.
  expect(closingAsk("| Lane | Status |\n|---|---|\n| a | Do you want it landed? |")).toBeUndefined();
  expect(closingAsk("Done with the batch.\n\n## Next?")).toBeUndefined();
  // The reply thinking aloud after a status line, and a question it answers itself.
  expect(closingAsk("Nine lanes are working. Should I go on?")).toBeUndefined();
  expect(closingAsk("Should I go on? Yes: the next lane starts now.")).toBeUndefined();
  expect(closingAsk("Landed. See https://example.com/x?y=1")).toBeUndefined();
  // A decision with a waiting word in it is still the owner's.
  expect(closingAsk("**Decision for you:** after how many days should a session that waits on nothing be archived? Undo stays on its row.")).toBe("Decision for you: after how many days should a session that waits on nothing be archived?");
});

test("a question that says what it would send or tell, or follows a telling or a colon, still asks the owner", () => {
  expect(closingAsk("The draft is ready. Do you want me to send it?")).toBe("Do you want me to send it?");
  expect(closingAsk("Want me to message the lane with the fix?")).toBe("Want me to message the lane with the fix?");
  expect(closingAsk("I sent the PR. Do you want me to land it?")).toBe("Do you want me to land it?");
  expect(closingAsk("Lane 3: green. Lane 4: red. Do you want me to rerun lane 4?")).toBe("Do you want me to rerun lane 4?");
  expect(closingAsk("Model: fable. Do you want another model for the rerun?")).toBe("Do you want another model for the rerun?");
  expect(closingAsk("Two ways forward:\n- land now\n- wait for the rerun. Which do you prefer?")).toBe("Which do you prefer?");
  // A telling with its own subject inside the question is still told of.
  expect(closingAsk("Did the reviewer tell you why the build failed, or who sent the fix?")).toBeUndefined();
});

test("a long reply is judged by its end, in time linear in its length", () => {
  const t = performance.now();
  expect(closingAsk("Done.\n" + "    \n".repeat(64000) + "Ok?")).toBe("Ok?");
  expect(closingAsk("Done.\n" + "\n".repeat(64000) + "Do you want it?")).toBe("Do you want it?");
  expect(firstLine("\n".repeat(64000) + "Done.")).toBe("Done.");
  // A fence opened before the end's window is still code.
  expect(closingAsk("```\n" + "x\n".repeat(4000) + "Continue?")).toBeUndefined();
  expect(performance.now() - t).toBeLessThan(500);
});

test("a reply's first line is its first words without their marks", () => {
  expect(firstLine("## Landing 275\n\nThe resource fixes are installed.")).toBe("Landing 275");
  expect(firstLine("**Landed** `abc123`: the fix is live.\nMore.")).toBe("Landed abc123: the fix is live.");
  expect(firstLine("```\ncode\n```\n- the first item")).toBe("the first item");
  expect(firstLine("x ".repeat(200)).length).toBeLessThanOrEqual(160);
});
