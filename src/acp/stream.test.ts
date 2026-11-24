import { expect, test } from "bun:test";
import { retryNotice, streamStep } from "./stream.ts";

test("a reply sent again after a failure: what the editor shows is not sent again", () => {
  // The retried attempt says the same: only what goes past the shown part.
  let shown = "The same start ";
  const steps = ["The same ", "The same start and the rest."].map((streamed) => { const s = streamStep(shown, streamed); shown = s.shown; return s; });
  expect(steps.map((s) => s.send)).toEqual(["", "and the rest."]);
  // It says something else: the whole of it, marked.
  expect(streamStep("This half reply ", "The whole")).toEqual({ send: "The whole", shown: "The whole", restarted: true });
  // No retry: each delta as it comes.
  expect(streamStep("Hello", "Hello world").send).toBe(" world");
  expect(retryNotice({ attempt: 1, max: 4, at: 0, message: "Scripted: the stream broke" })).toEqual({ sessionUpdate: "notice", severity: "warning", title: "The model request failed: sending it again (retry 1 of 4)", description: "Scripted: the stream broke" });
  expect(retryNotice({ attempt: 0, max: 0, at: 0, message: "dns", unreachable: 1 }).title).toContain("cannot be reached");
});
