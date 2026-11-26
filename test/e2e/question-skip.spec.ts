import { expect, test } from "./isolate.ts";
import { answersOf, calls, create, drop, folder, idle, pending, scripted, settle } from "./answering.ts";
import { shoot } from "./shots.ts";

// Feature: a card of several questions is sent with the answers picked so far. "Skip the rest" sends them and
// tells the agent which questions were skipped; the keyboard path is the same (Enter sends only a whole card).
test("skip the rest sends what is picked and names what was skipped", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const three = { name: "AskUserQuestion", input: { questions: [
    { header: "Checks", question: "Which checks should run?", options: [{ label: "Lint" }, { label: "Types" }], multiSelect: true },
    { header: "Branch", question: "Which branch is the base?", options: [{ label: "main" }, { label: "release" }], multiSelect: false },
    { header: "Deploy", question: "Where should it deploy?", options: [{ label: "Staging" }, { label: "Production" }], multiSelect: false },
  ] } };
  const id = await create(request, "Skip the rest", folder("skip"));
  await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([three]) } });
  await expect.poll(() => pending(request, id)).toHaveLength(1);
  await page.goto(`/s/${id}`);
  const card = page.getByTestId("question");
  const skip = card.getByTestId("question-skip");
  // Nothing is picked yet: there is nothing to send.
  await expect(card).toBeVisible();
  // The head names who asks and no more: no pulsing mark in the accent beside it (the card's edge says it waits).
  await expect(card.locator(".animate-pulse-dot")).toHaveCount(0);
  await expect(skip).toHaveCount(0);
  await card.getByRole("checkbox", { name: "Lint" }).click();
  await card.getByRole("radio", { name: "release" }).click();
  await expect(card.getByTestId("question-submit")).toBeDisabled();
  // With nothing to send yet the filled button is an outline in the quiet ink at the regular weight, not a slab of grey.
  expect(await card.getByTestId("question-submit").evaluate((el) => { const s = getComputedStyle(el); return [s.backgroundColor, s.fontWeight, s.opacity]; })).toEqual(["rgba(0, 0, 0, 0)", "400", "1"]);
  await expect(skip).toBeVisible();
  await shoot(page, "question-skip-01-two-of-three");
  await skip.click();
  await expect(page.getByTestId("transcript").getByTestId("question")).toHaveAttribute("data-state", "answered");
  expect(await answersOf(request, id)).toEqual({ "0": { picked: ["Lint"] }, "1": { picked: ["release"] }, "2": { picked: [], skipped: true } });
  // The turn goes on, and the tool result names the answers and the skip.
  await idle(request, id);
  const { events } = await (await request.get(`/api/sessions/${id}`)).json();
  const result = JSON.stringify(events.findLast((e: any) => e.kind === "tool_result").data);
  expect(result).toContain('\\"Which checks should run?\\"=\\"Lint\\"');
  expect(result).toContain('\\"Which branch is the base?\\"=\\"release\\"');
  expect(result).toContain('\\"Where should it deploy?\\"=\\"skipped by the owner\\"');
  await page.getByTestId("transcript").getByTestId("question").locator(".k-line").click();
  await expect(page.getByTestId("question-answer")).toHaveText(["YouLint", "Yourelease", "Youskipped"]);
  await shoot(page, "question-skip-02-answered");
  await drop(request, id);
});
