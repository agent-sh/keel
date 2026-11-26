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

test("a reply's first line is its first words without their marks", () => {
  expect(firstLine("## Landing 275\n\nThe resource fixes are installed.")).toBe("Landing 275");
  expect(firstLine("**Landed** `abc123`: the fix is live.\nMore.")).toBe("Landed abc123: the fix is live.");
  expect(firstLine("```\ncode\n```\n- the first item")).toBe("the first item");
  expect(firstLine("x ".repeat(200)).length).toBeLessThanOrEqual(160);
});
