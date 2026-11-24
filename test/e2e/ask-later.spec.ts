import { expect, test } from "./isolate.ts";
import { ask, asksToRun, create, drop, folder, idle, pending, scripted, settle } from "./answering.ts";
import { shoot } from "./shots.ts";

// Feature: an approval or a question that waits above the message box can be put away with Later, to a
// count in the session's head ("1 waiting"), and the count brings it back (a press, or Enter on it, the
// keyboard goes to the card). The turn waits for it all along: nothing is answered or dropped. On the
// scripted stand-in. (That a request that comes later brings the pile back is the rule in
// ui/src/lib/later.test.ts: the stand-in asks the next only after an answer.)
const state = async (request: import("@playwright/test").APIRequestContext, id: string) => (await (await request.get(`/api/sessions/${id}/approvals?all`)).json()).approvals as { id: string; state: string }[];
const phase = async (request: import("@playwright/test").APIRequestContext, id: string) => (await (await request.get(`/api/sessions/${id}?events=0`)).json()).session.phase as string;

test("an approval put away with Later waits in the head, and the count brings it back", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const id = await asksToRun(request, "Later approval", folder("later"), "later");
  try {
    await page.goto(`/s/${id}`);
    const card = page.getByTestId("approval");
    const pill = page.getByTestId("later-pill");
    await expect(card).toBeVisible();
    await expect(pill).toHaveCount(0);
    await shoot(page, "ask-later-01-card");

    await card.getByTestId("ask-later").click();
    await expect(card).toHaveCount(0);
    await expect(pill).toHaveText("1 waiting");
    await shoot(page, "ask-later-02-away");
    // Put away, not answered: the daemon still holds it, and the turn waits.
    expect((await state(request, id)).map((a) => a.state)).toEqual(["pending"]);
    expect(await phase(request, id)).toBe("working");
    // The keyboard is in the message box, where the card's buttons were.
    await expect(page.getByTestId("composer")).toBeFocused();

    // By keyboard: the count is a button of the head's own tab order, and Enter brings the card back.
    await pill.focus();
    await expect(pill).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(card).toBeVisible();
    await expect(pill).toHaveCount(0);
    expect(await page.evaluate(() => !!document.activeElement?.closest("[data-ask-card]"))).toBe(true);
    await shoot(page, "ask-later-03-back");

    // A phone's width: the card keeps its layout, and the count fits in the head.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(card).toBeVisible();
    await shoot(page, "ask-later-06-phone-card");
    await card.getByTestId("ask-later").click();
    await expect(pill).toBeVisible();
    await shoot(page, "ask-later-07-phone-away");
    expect(await pill.evaluate((el) => el.getBoundingClientRect().right <= innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1920, height: 1040 });
    await expect(card).toHaveCount(0);
    await pill.click();
    await expect(card).toBeVisible();

    // Put away again, then answered elsewhere (here: by the daemon's own answer): the count goes with it.
    await card.getByTestId("ask-later").click();
    await expect(pill).toHaveText("1 waiting");
    const [open] = await state(request, id);
    await request.post(`/api/sessions/${id}/approvals/${open!.id}`, { data: { choice: "once", seen: "whole", via: "page" } });
    await expect(pill).toHaveCount(0);
    await idle(request, id);
  } finally {
    await drop(request, id);
  }
});

test("a question put away with Later waits in the head, and the count brings it back", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const id = await create(request, "Later question", folder("later-q"));
  try {
    await ask(request, id, "question");
    await page.goto(`/s/${id}`);
    const card = page.getByTestId("question");
    const pill = page.getByTestId("later-pill");
    await expect(card).toBeVisible();
    await card.getByTestId("ask-later").click();
    await expect(card).toHaveCount(0);
    await expect(pill).toHaveText("1 waiting");
    await shoot(page, "ask-later-04-question-away");
    expect(await pending(request, id)).toHaveLength(1);
    expect(await phase(request, id)).toBe("working");
    await pill.click();
    await expect(card).toBeVisible();
    await expect(pill).toHaveCount(0);
    await shoot(page, "ask-later-05-question-back");
  } finally {
    await drop(request, id);
  }
});
