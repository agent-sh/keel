import { expect, test, type Locator, type Page } from "./isolate.ts";
import {
  answersOf, answersSent, approvals, arrives, ask, asksToRun, calls, cardIn, colors, create, drop, folder, idle, KINDS, mark, messagesSent, open, pane,
  pending, presses, rearm, reset, row, said, scripted, secondEnter, secretsAsked, SETTLE, settle, since, waits, watchKeys, type Kind,
} from "./answering.ts";
import { shoot } from "./shots.ts";

// Feature: answering what waits on the owner by keyboard. The rule every card is held to
// (ui/src/lib/asks.ts): an answer is given only for what the owner could read, by a key the owner
// meant. One test per card kind walks the ways the keyboard gets to a card at the two delays that
// decide; the others are the cases that each caught a fault. (The whole matrix of ways, kinds and
// delays is run for reviews from the same parts, test/e2e/answering.ts, outside the suite.)
// Every pane on screen: no focus mode (the config's default for the other specs).
test.use({ storageState: { cookies: [], origins: [] } });

// The numbers drawn on key caps (from data-n, the style sheet's: no part of the text they label).
const numbers = (caps: Locator) => caps.evaluateAll((els) => els.map((el) => el.getAttribute("data-n")));
const keysOn = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? document.activeElement?.tagName ?? "");
const LONG = `${Array.from({ length: 40 }, (_, i) => `echo step ${i + 1}`).join("\n")}\necho last > last.txt`;

test("Esc twice on an approval gives the keyboard back to Allow once", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const id = await asksToRun(request, "Esc and back", folder("esc"), "escback");
  await page.goto(`/s/${id}`);
  const card = page.getByTestId("approval");
  const allow = card.getByTestId("allow-once");
  await expect(allow).toBeFocused();
  // (The page brought the keyboard there: its keys act after the settle time from then.)
  await expect(allow).toHaveAttribute("data-ready", "true", { timeout: 5000 });
  // Esc opens the reason, Esc again leaves it: the keyboard is on Allow once, not on the page.
  await page.keyboard.press("Escape");
  await expect(card.getByTestId("deny-reason")).toBeFocused();
  let left = Date.now();
  await page.keyboard.press("Escape");
  await expect(allow).toBeFocused();
  expect(await keysOn(page)).toBe("allow-once");
  // Right away it answers nothing, and says so in words that show: Enter in the reason field would
  // have sent the denial, so an Enter pressed as the field was left may have been meant for that.
  // (A machine too slow to press well inside the settle time does not press, and says so.)
  const tip = page.locator(".k-tip");
  const early = async (how: string, press: () => Promise<void>) => {
    if (Date.now() - left > 500) return console.log(`slow: ${how} would come ${Date.now() - left} ms after the reason was left`);
    await press();
    await expect(tip).toHaveText(/^Not yet/);
    expect((await approvals(request, id))[0]).toMatchObject({ state: "pending" });
  };
  await early("Enter", () => page.keyboard.press("Enter"));
  // An Escape right behind that refused Enter still opens the reason: it answers nothing, so a key
  // refused a moment before does not hold it (lib/asks.ts, keysArrived).
  await page.keyboard.press("Escape");
  await expect(card.getByTestId("deny-reason")).toBeFocused();
  // The Back button leads back as Escape does, and so does a press with the pointer: on a narrow
  // screen "Send denial" stands where Allow once comes back, and a second tap meant for it must not allow.
  left = Date.now();
  await card.getByRole("button", { name: "Back" }).click();
  await expect(allow).toBeFocused();
  const at = (await allow.boundingBox())!;
  await early("a press", () => page.mouse.click(at.x + at.width / 2, at.y + at.height / 2));
  await shoot(page, "answer-keys-01-esc-back");
  // And Enter still allows, once the button has stood for its second.
  await expect(card).toHaveAttribute("data-live", "true");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await approvals(request, id))[0]).toMatchObject({ state: "allowed", choice: "once" });
  await expect(page.getByTestId("composer")).toBeFocused();
  await request.delete(`/api/sessions/${id}`);

  // A card whose command is not all on it takes no answer: leaving the reason puts the keyboard
  // on the list of requests, where the card's own rule keeps it, and Enter there answers nothing.
  const long = await create(request, "Esc and back, cut", folder("esc-cut"));
  await request.put(`/api/sessions/${long}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await request.post(`/api/sessions/${long}/messages`, { data: { text: calls([{ name: "Bash", input: { command: LONG } }]) } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${long}/approvals`)).json()).approvals.length).toBe(1);
  await page.goto(`/s/${long}`);
  await expect(card).toHaveAttribute("data-must-open", "true");
  const list = page.getByTestId("approvals");
  await expect(list).toBeFocused();
  await card.getByTestId("deny").click();
  await expect(card.getByTestId("deny-reason")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(list).toBeFocused();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  expect((await approvals(request, long))[0]).toMatchObject({ state: "pending" });
  await request.post(`/api/sessions/${long}/interrupt`, { data: { by: "owner" } });
  await request.delete(`/api/sessions/${long}`);
});

// Every way the keyboard gets to a card, in one pane and in four, each read 300 ms after the
// arrival (refused, or typed on into the message box) and 1,200 ms after it (the deliberate way
// answers); then what is typed while the card arrives, and a key held through its arrival.
for (const kind of KINDS as Exclude<Kind, "secret">[]) {
  const a = kind === "approval" ? "an approval" : `a ${kind}`;
  test(`${a}: no key answers as the keyboard arrives, by any way to it, in one pane and in four`, async ({ page, request }) => {
    await scripted(request);
    await settle(request);
    await watchKeys(page);
    const ws = folder(`ways-${kind}`);
    const made: string[] = [];
    const fresh = async (title: string) => { const id = await create(request, `${title} (${kind})`, ws); made.push(id); return id; };
    const box = (id: string) => pane(page, id).getByTestId("composer");

    // One pane. The card appears in the session worked in: it takes the keyboard from the empty box by itself.
    const appears = await fresh("Appears");
    await open(page, [appears]);
    await reset(page);
    await ask(request, appears, kind);
    await arrives(page, request, { way: "the card appears", kind, target: appears, from: "keys", own: false });
    // The key that goes to what waits, from another session.
    const waited = await fresh("Waits");
    await ask(request, waited, kind);
    await expect(row(page, waited)).toHaveAttribute("data-watch", "need");
    await rearm(page);
    await page.keyboard.press("Alt+a");
    await expect(page).toHaveURL(new RegExp(`/s/${waited}$`));
    await arrives(page, request, { way: "the key that goes to what waits", kind, target: waited, from: "keys", own: true });
    // The page loads on a session that asks (a link, a restart, a row of the list).
    const loaded = await fresh("Loads");
    await ask(request, loaded, kind);
    await page.goto(`/s/${loaded}`);
    await arrives(page, request, { way: "the page loads on it", kind, target: loaded, from: "keys", own: false });

    // What the owner types as a card arrives is theirs: it lands in the message box, whole and in order.
    const typed = await fresh("Typed through");
    await open(page, [typed]);
    await reset(page);
    const long = "keep typing 2 while it arrives, no wait";
    const typing = page.keyboard.type(long, { delay: 35 });
    await ask(request, typed, kind);
    await typing;
    await expect(box(typed)).toHaveValue(long);
    expect(await waits(request, typed, kind)).toBe(true);
    // Right after the key that goes to what waits, keys are meant for the card: what it does not
    // take types nothing anywhere (no "2" lands in the box), and the Enter after them sends nothing.
    await box(typed).fill("");
    await page.waitForTimeout(1200);
    await rearm(page);
    await page.keyboard.press("Alt+a");
    expect(await since(page, "keys", 100)).toBe(true);
    await page.keyboard.type("2 more things", { delay: 20 });
    await expect(box(typed)).toHaveValue("");
    if (kind === "question") await expect(cardIn(page, typed, kind).locator('[aria-checked="true"]')).toHaveCount(0);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    await expect(box(typed)).toHaveValue("");
    await expect(pane(page, typed).getByTestId("queue-item")).toHaveCount(0);
    expect(await said(request, typed)).toEqual([]);
    expect(await waits(request, typed, kind)).toBe(true);
    expect(await answersSent(page)).toEqual([]);

    // Enter goes down in the empty box before the card is there and stays down past the settle time
    // (and, for an approval, past its Allow taking the keyboard): a held key answers nothing.
    // (Not for a question: Enter on its card sends only what was chosen, and nothing is.)
    if (kind !== "question") {
      const held = await fresh("Held");
      await open(page, [held]);
      await reset(page);
      await page.keyboard.down("Enter");
      await ask(request, held, kind);
      while (!(await page.evaluate(() => { const k = (window as any).__k; return k.dom != null && performance.now() - k.dom > 1600; }))) { await page.keyboard.down("Enter"); await page.waitForTimeout(30); }
      await page.keyboard.up("Enter");
      const log = await presses(page);
      expect(log.some((p) => p.repeat && (p.dom ?? 0) > SETTLE + 500)).toBe(true);
      expect(await answersSent(page)).toEqual([]);
      expect(await waits(request, held, kind)).toBe(true);
    }
    await drop(request, ...made.splice(0));

    // Four panes. The card appears in the pane beside the one worked in: it never takes the keyboard,
    // and what is typed, with its Enter, stays with the session worked in.
    const helm = await fresh("Worked in"), target = await fresh("Asks"), first = await fresh("Asks first"), last = await fresh("Beside");
    await open(page, [helm, target, first, last]);
    await reset(page);
    await ask(request, target, kind);
    await expect(cardIn(page, target, kind)).toBeVisible();
    for (const ms of [300, 1200]) {
      expect(await since(page, "dom", ms)).toBe(true);
      await expect(box(helm)).toBeFocused();
      await page.keyboard.type(`2 at ${ms}`, { delay: 20 });
      await page.keyboard.press("Enter");
    }
    await expect.poll(() => said(request, helm)).toEqual(["2 at 300", "2 at 1200"]);
    expect(await said(request, target)).toEqual([]);
    expect(await waits(request, target, kind)).toBe(true);
    if (kind === "question") await expect(cardIn(page, target, kind).locator('[aria-checked="true"]')).toHaveCount(0);
    expect(await answersSent(page)).toEqual([]);
    // Next pane, onto the pane that asks: the keyboard goes to that pane's message box, not to the card.
    await rearm(page);
    await page.keyboard.press("Alt+]");
    await mark(page);
    await expect(pane(page, target)).toHaveAttribute("data-helm", "true");
    for (const ms of [300, 1200]) {
      expect(await since(page, "mark", ms)).toBe(true);
      await expect(box(target)).toBeFocused();
      await page.keyboard.press("Enter");
      if (kind !== "question") await page.keyboard.press("Space");
    }
    await expect(box(target)).toHaveValue(kind === "question" ? "" : "  ");
    await box(target).fill("");
    expect(await waits(request, target, kind)).toBe(true);
    expect(await answersSent(page)).toEqual([]);
    // The key that goes to what waits, to that pane from another.
    await box(helm).click();
    await expect(pane(page, helm)).toHaveAttribute("data-helm", "true");
    await rearm(page);
    await page.keyboard.press("Alt+a");
    await expect(pane(page, target)).toHaveAttribute("data-helm", "true");
    await arrives(page, request, { way: "the key that goes to what waits, to a pane on screen", kind, target, from: "keys", own: true });
    // A step of the answering sequence, both panes on screen: the answer to the first brings the keyboard to the next.
    await idle(request, target);
    await box(helm).click();
    await expect(pane(page, helm)).toHaveAttribute("data-helm", "true");
    await ask(request, first, "approval", "first");
    await ask(request, target, kind, "again");
    await expect(cardIn(page, target, kind)).toBeVisible();
    await page.keyboard.press("Alt+a");
    await expect(pane(page, first)).toHaveAttribute("data-helm", "true");
    await expect(cardIn(page, first, "approval").getByTestId("allow-once")).toBeFocused();
    // (Brought there by the page: Enter acts after the settle time from then, as the card says.)
    await expect(cardIn(page, first, "approval").getByTestId("allow-once")).toHaveAttribute("data-ready", "true", { timeout: 5000 });
    await expect(cardIn(page, first, "approval").getByTestId("approval")).toHaveAttribute("data-live", "true");
    await rearm(page);
    await page.keyboard.press("Enter");
    await expect(pane(page, target)).toHaveAttribute("data-helm", "true");
    await arrives(page, request, { way: "a step of the answering sequence, both panes on screen", kind, target, from: "keys", own: true });
    await drop(request, ...made);
  });
}

test("a second Enter after an answer in the sequence sends nothing: the next session's draft stays in its box", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  await watchKeys(page);
  // Twice at each delay here; reviews run it eight times at each (the fault it caught came in five runs of eight).
  await secondEnter(page, request, 2);
});

test("nothing answers and no command key acts under a dialog", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  await watchKeys(page);
  const ws = folder("overlay");
  const quiet = await create(request, "Nothing waits here", ws);
  const asks = await asksToRun(request, "Waits under a dialog", ws, "under");
  await open(page, [quiet]);
  await expect(row(page, asks)).toHaveAttribute("data-watch", "need");
  const sheet = page.getByTestId("shortcuts");
  const dialogs = () => page.locator('[role="dialog"]').count();

  // The shortcut sheet is open: the keys that go somewhere go nowhere, and no second dialog opens over it.
  await page.keyboard.press("Control+/");
  await expect(sheet).toBeVisible();
  for (const key of ["Alt+a", "Alt+b", "Alt+r", "Alt+l"]) await page.keyboard.press(key);
  await page.waitForTimeout(400);
  await expect(page).toHaveURL(new RegExp(`/s/${quiet}$`));
  expect(await dialogs()).toBe(1);
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="session-row"], [data-ask-card]'))).toBe(false);
  await shoot(page, "answer-keys-10-keys-under-sheet");
  // The sheet's own key still closes it.
  await page.keyboard.press("Control+/");
  await expect(sheet).toHaveCount(0);
  // The palette the same.
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.keyboard.press("Alt+a");
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(new RegExp(`/s/${quiet}$`));
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette")).toHaveCount(0);

  // On the card, its Allow ready: a dialog opens over it. The Allow no longer stands live, and a press
  // that reaches it anyway (focus put there by code, then a key's click) answers nothing.
  await page.keyboard.press("Alt+a");
  await expect(page).toHaveURL(new RegExp(`/s/${asks}$`));
  const card = cardIn(page, asks, "approval");
  await expect(card.getByTestId("allow-once")).toBeFocused();
  // (Brought there by the page: Enter acts after the settle time from then, as the card says.)
  await expect(card.getByTestId("allow-once")).toHaveAttribute("data-ready", "true", { timeout: 5000 });
  await expect(card.getByTestId("approval")).toHaveAttribute("data-live", "true");
  await page.keyboard.press("Control+/");
  await expect(sheet).toBeVisible();
  await expect(card.getByTestId("approval")).not.toHaveAttribute("data-live", "true");
  await page.waitForTimeout(SETTLE + 300);
  await card.getByTestId("allow-once").evaluate((el: HTMLElement) => { el.focus(); el.click(); });
  await page.waitForTimeout(400);
  expect(await answersSent(page)).toEqual([]);
  expect(await waits(request, asks, "approval")).toBe(true);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await drop(request, quiet, asks);
});

test("a question docks above the message box and is answered from the keyboard", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("question");
  const id = await create(request, "Pick a color", ws);
  // A long conversation first: the question must not scroll away with it.
  await request.post(`/api/sessions/${id}/messages`, { data: { text: "script:fill" } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${id}`)).json()).events.some((e: any) => e.kind === "turn_end"), { timeout: 30_000 }).toBe(true);
  await ask(request, id, "question");

  await page.goto(`/s/${id}`);
  const card = page.getByTestId("composer-asks").getByTestId("question");
  await expect(card).toHaveAttribute("data-state", "open");
  // Docked: in the region above the message box, where approvals wait, and one line in the conversation.
  await expect(page.getByTestId("transcript").getByTestId("question")).toHaveCount(0);
  // The card holds the question: the line says only that it waits.
  await expect(card).toContainText("Which color should I use?");
  await expect(page.getByTestId("transcript").getByTestId("question-asked")).toHaveText("Asks");
  await expect(page.getByTestId("transcript").getByTestId("question-asked").getByRole("img", { name: "needs you: an answer" })).toBeVisible();
  // It takes the keyboard as it opens: on the card, not on an answer. It says what the keys do now,
  // and draws no number while a number does not answer (one typed here goes on to the message box).
  await expect(card).toBeFocused();
  await expect(card).toHaveAttribute("data-keys", "ready");
  await expect(card.getByTestId("question-hint")).toHaveText("Up and Down choose, Enter sends");
  await expect(card.getByTestId("question-digit")).toHaveCount(0);
  await shoot(page, "answer-keys-02-question-docked");
  // At any scroll position of the conversation the card stays whole in view.
  const whole = () => card.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.height > 0; });
  for (const top of [0, 3000, 1e9]) {
    await page.evaluate((y) => { document.querySelector<HTMLElement>(".k-reading")!.scrollTop = y; }, top);
    await page.waitForTimeout(150);
    expect(await whole()).toBe(true);
  }
  await page.evaluate(() => { document.querySelector<HTMLElement>(".k-reading")!.scrollTop = 0; });

  // Enter with nothing chosen says why it does nothing. Down goes to the first option, and Enter there answers with it.
  await page.keyboard.press("Enter");
  await expect(card.getByTestId("question-nudge")).toHaveText("Choose an answer or type one first");
  const at = await card.getByRole("radio", { name: "Teal" }).boundingBox();
  await page.keyboard.press("ArrowDown");
  await expect(card.getByRole("radio", { name: "Teal" })).toBeFocused();
  // The keyboard is the owner's on the card now: the numbers are drawn (nothing moved for them), and the hint names them.
  await expect(card).toHaveAttribute("data-own", "true");
  await expect.poll(() => numbers(card.getByTestId("question-digit"))).toEqual(["1", "2", "3"]);
  expect(await card.getByRole("radio", { name: "Teal" }).boundingBox()).toEqual(at);
  await expect(card.getByTestId("question-hint")).toHaveText("Press 1 to 3 to answer, or Up and Down then Enter");
  await shoot(page, "answer-keys-03-question-numbers");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("transcript").getByTestId("question")).toHaveAttribute("data-state", "answered");
  expect(await answersOf(request, id)).toEqual({ "0": { picked: ["Teal"] } });
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("composer")).toBeFocused();
  await expect(page.getByTestId("composer")).toHaveValue("");

  // A question with several parts, then one more: numbers choose in the part the keyboard is in, Enter sends what is shown.
  const twoParts = { name: "AskUserQuestion", input: { questions: [
    { header: "Checks", question: "Which checks should run?", options: [{ label: "Lint" }, { label: "Types" }, { label: "Tests" }], multiSelect: true },
    { header: "Branch", question: "Which branch is the base?", options: [{ label: "main" }, { label: "release" }], multiSelect: false },
  ] } };
  const parts = await create(request, "Checks and base", ws);
  await request.post(`/api/sessions/${parts}/messages`, { data: { text: calls([twoParts, colors]) } });
  await expect.poll(() => pending(request, parts)).toHaveLength(1);
  await page.goto(`/s/${parts}`);
  await expect(card).toBeFocused();
  await expect(card).toHaveAttribute("data-keys", "ready");
  await page.keyboard.press("Enter");
  await expect(card.getByTestId("question-nudge")).toHaveText("Choose an answer for each question first");
  // Down puts the keyboard on the first part: two numbers there are two of its checks.
  await page.keyboard.press("ArrowDown");
  await expect(card.getByRole("checkbox", { name: "Lint" })).toBeFocused();
  await page.keyboard.press("1");
  await page.keyboard.press("2");
  await expect(card.getByRole("checkbox", { name: "Lint" })).toHaveAttribute("aria-checked", "true");
  await expect(card.getByRole("checkbox", { name: "Types" })).toHaveAttribute("aria-checked", "true");
  await expect(card.getByRole("radio", { name: "release" })).toHaveAttribute("aria-checked", "false");
  // Down walks on through the options and the own-answer field into the next part.
  for (const stop of ["Types", "Tests"]) { await page.keyboard.press("ArrowDown"); await expect(card.getByRole("checkbox", { name: stop })).toBeFocused(); }
  await page.keyboard.press("ArrowDown");
  await expect(card.getByTestId("question-other").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(card.getByRole("radio", { name: "main" })).toBeFocused();
  // The keyboard is on "main", the number picks "release": Enter sends what the card shows chosen.
  await page.keyboard.press("2");
  await expect(card.getByRole("radio", { name: "release" })).toHaveAttribute("aria-checked", "true");
  await shoot(page, "answer-keys-04-question-parts");
  await page.keyboard.press("Enter");
  await expect.poll(async () => await answersOf(request, parts)).toEqual({ "0": { picked: ["Lint", "Types"] }, "1": { picked: ["release"] } });
  // The next question takes the keyboard by itself: the owner's own answer goes into the card's field, and Enter there sends it.
  await expect.poll(() => pending(request, parts)).toHaveLength(1);
  await expect(card).toBeFocused();
  await card.getByTestId("question-other").click();
  await page.keyboard.type("a dark teal");
  await page.keyboard.press("Enter");
  await expect.poll(() => pending(request, parts)).toHaveLength(0);
  expect(await answersOf(request, parts)).toEqual({ "0": { picked: [], other: "a dark teal" } });
  await expect(page.getByTestId("composer")).toBeFocused();

  // A number answers only with an option that is in view, and a long question keeps its Answer in reach.
  const many = { name: "AskUserQuestion", input: { questions: [{ header: "Order", question: "Which order should the steps run in?", options: Array.from({ length: 11 }, (_, i) => ({ label: `Order ${i + 1}`, description: "One of many ways to order the steps of this long migration" })), multiSelect: false }] } };
  const long = await create(request, "A long question", ws);
  await request.post(`/api/sessions/${long}/messages`, { data: { text: calls([many]) } });
  await expect.poll(() => pending(request, long)).toHaveLength(1);
  await page.setViewportSize({ width: 1280, height: 620 });
  await page.goto(`/s/${long}`);
  await expect(card).toBeFocused();
  // The card is taller than the room above the message box: its Answer row stays at the lower edge, in view.
  const tray = page.getByTestId("composer-tray");
  expect(await card.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(await tray.evaluate((el) => el.clientHeight));
  const seen = (testid: string, nth = 0) => card.getByTestId(testid).nth(nth).evaluate((el) => {
    const r = el.getBoundingClientRect(), t = el.closest('[data-testid="composer-tray"]')!.getBoundingClientRect();
    return r.top >= t.top - 0.5 && r.bottom <= Math.min(innerHeight, t.bottom) + 0.5;
  });
  expect(await seen("question-submit")).toBe(true);
  expect(await seen("question-option", 8)).toBe(false);
  await shoot(page, "answer-keys-11-long-question");
  // The owner's own press on the card makes the numbers its own. 9 is out of view: chosen and shown, not sent.
  await card.getByText("Which order should the steps run in?").click();
  await expect(card).toHaveAttribute("data-own", "true");
  await page.keyboard.press("9");
  await expect(card.getByRole("radio", { name: /^Order 9/ })).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => seen("question-option", 8)).toBe(true);
  await page.waitForTimeout(400);
  expect(await pending(request, long)).toHaveLength(1);
  // Now that it can be read, the number answers with it.
  await page.keyboard.press("9");
  await expect.poll(() => pending(request, long)).toHaveLength(0);
  expect(await answersOf(request, long)).toEqual({ "0": { picked: ["Order 9"] } });
  await page.setViewportSize({ width: 1920, height: 1040 });
  await drop(request, id, parts, long);
});

test("a plan is approved by a key on Approve only once it was read to its end", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const open1 = async (id: string) => (await (await request.get(`/api/sessions/${id}/plan`)).json()).open.length as number;
  // A plan that stands whole in view: once the settle time of the arrival has passed, Approve has
  // the keyboard by itself (the hint said so meanwhile) and one Enter approves it.
  const short = await create(request, "Plan the index", folder("plan"));
  await ask(request, short, "plan");
  await page.goto(`/s/${short}`);
  const one = cardIn(page, short, "plan");
  await expect(one.getByTestId("plan-text")).toBeFocused();
  await expect(one.getByTestId("plan-approve")).toBeFocused();
  // (Brought there by the page: Enter acts after the settle time from then, as the card says.)
  await expect(one.getByTestId("plan-approve")).toHaveAttribute("data-ready", "true", { timeout: 5000 });
  await expect(one).toHaveAttribute("data-keys", "ready");
  await expect(one.getByTestId("plan-hint")).toHaveText("Enter approves the plan");
  await shoot(page, "answer-keys-19-plan-whole");
  await page.keyboard.press("Enter");
  await expect.poll(() => open1(short)).toBe(0);
  await drop(request, short);
  // An Enter pressed as the plan arrives (meant for what was there before) approves nothing, nor does
  // it once Approve took the keyboard by itself; after a key's settle time from the paint, one does.
  const late = await create(request, "Plan the index, Enter as it arrives", folder("plan"));
  await ask(request, late, "plan");
  await page.goto(`/s/${late}`);
  const two = cardIn(page, late, "plan");
  await page.waitForFunction(() => !!document.activeElement?.closest('[data-testid="plan-card"]'), null, { polling: "raf", timeout: 8000 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  expect(await open1(late), "Enter the moment the plan arrived").toBe(1);
  await expect(two.getByTestId("plan-approve")).toHaveAttribute("data-ready", "true", { timeout: 4000 });
  await page.keyboard.press("Enter");
  await expect.poll(() => open1(late)).toBe(0);
  await drop(request, late);
  // (A plan that fits its box is walked with the other kinds above: the key that answers waits out the arrival.)
  // A plan longer than its box: a key on Approve does nothing until the text was scrolled to its end.
  const long = await create(request, "Plan the migration", folder("plan"));
  await request.put(`/api/sessions/${long}/permissions`, { data: { mode: "plan" } });
  const steps = Array.from({ length: 60 }, (_, i) => `${i + 1}. Step ${i + 1} of the migration, in its own line.`).join("\n");
  await request.post(`/api/sessions/${long}/messages`, { data: { text: calls([{ name: "present_plan", input: { plan: `## Migration\n\n${steps}` } }]) } });
  await expect.poll(() => open1(long), { timeout: 30_000 }).toBe(1);
  await page.goto(`/s/${long}`);
  const card = page.getByTestId("plan-card");
  await expect(card.getByTestId("plan-text")).toBeFocused();
  await expect(card).toHaveAttribute("data-keys", "ready");
  await expect(card).not.toHaveAttribute("data-read", "true");
  await expect(card.getByTestId("plan-hint")).toHaveText("Read to the end, then Tab goes to Approve");
  await shoot(page, "answer-keys-05-plan-keys");
  await page.keyboard.press("Tab");
  await expect(card.getByTestId("plan-approve")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card.getByTestId("plan-hint")).toHaveText("Read the plan to its end first");
  await shoot(page, "answer-keys-12-plan-unread");
  await page.waitForTimeout(300);
  expect(await open1(long)).toBe(1);
  // Up is back on the text; End reads it to its end (the plan's own scroll, not the conversation's).
  await page.keyboard.press("ArrowUp");
  await expect(card.getByTestId("plan-text")).toBeFocused();
  await page.keyboard.press("End");
  await expect(card).toHaveAttribute("data-read", "true");
  await page.keyboard.press("Tab");
  await expect(card.getByTestId("plan-hint")).toHaveText("Enter approves the plan");
  await page.keyboard.press("Enter");
  await expect.poll(() => open1(long)).toBe(0);
  await expect.poll(async () => (await (await request.get(`/api/sessions/${long}/permissions`)).json()).perm.mode).toBe("auto-edits");
  await expect(page.getByTestId("composer")).toBeFocused();
  await drop(request, long);
});

test("a secret typed at the card goes nowhere: not into the message box, and not to the model", async ({ page, request, context }) => {
  await scripted(request);
  await settle(request);
  await watchKeys(page);
  const ws = folder("secret");
  const card = page.getByTestId("secret-request");
  const field = card.getByTestId("secret-value");
  const box = (id: string) => pane(page, id).getByTestId("composer");
  const hint = card.getByTestId("secret-hint");
  // The box holds half a message as the card appears: the card takes nothing, and the rest of the message is the box's.
  const draft = await create(request, "Secret while typing", ws);
  await open(page, [draft]);
  await page.keyboard.type("half a ");
  await ask(request, draft, "secret");
  await expect(card).toBeVisible();
  await page.waitForTimeout(300);
  await expect(box(draft)).toBeFocused();
  await expect(hint).toHaveCount(0);
  await page.keyboard.type("message 2");
  await expect(box(draft)).toHaveValue("half a message 2");
  await expect(field).toHaveValue("");

  // The box is empty as the card appears, or the page loads on it: the card takes the keyboard on
  // itself and says how to get to its field. A secret typed there, with its Enter, right away or
  // after the settle time, is dropped: nothing is in the message box, nothing is sent, nothing is given.
  for (const [way, ms] of [["appears", 100], ["loads", 1200]] as const) {
    const id = await create(request, `Secret ${way}`, ws);
    if (way === "appears") { await open(page, [id]); await reset(page); await ask(request, id, "secret"); }
    else { await ask(request, id, "secret"); await page.goto(`/s/${id}`); }
    await expect(card).toBeFocused();
    await expect(hint).toHaveText("Tab or Enter to type the secret");
    expect(await since(page, "keys", ms)).toBe(true);
    await page.keyboard.type("k9");
    await expect(hint).toHaveText("Tab or Enter to type the secret: what is typed here goes nowhere");
    if (way === "appears") {
      // Enter as the keyboard arrived was on its way somewhere else: it does not move to the field.
      await page.keyboard.press("Enter");
      await expect(card).toBeFocused();
    }
    await expect(box(id)).toHaveValue("");
    await expect(field).toHaveValue("");
    expect(await messagesSent(page)).toEqual([]);
    expect(await answersSent(page)).toEqual([]);
    expect(await secretsAsked(request, id)).toBe(1);
    if (way === "appears") { await shoot(page, "answer-keys-13-secret-card"); await drop(request, id); continue; }
    // After the settle time Enter on the card goes to the field (the keys typed there are a run of
    // their own: the card says when it is ready again). The value typed there is masked, and Enter
    // gives it once the field has had the keyboard for the settle time.
    await expect(card).toHaveAttribute("data-keys", "ready");
    await page.keyboard.press("Enter");
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute("type", "password");
    await page.keyboard.type("s3cret-value");
    await page.keyboard.press("Enter");
    await expect(card.getByTestId("secret-error")).toHaveText("Not yet: the keyboard has only just arrived");
    expect(await secretsAsked(request, id)).toBe(1);
    await page.waitForTimeout(SETTLE);
    await page.keyboard.press("Enter");
    await expect.poll(() => secretsAsked(request, id)).toBe(0);
    expect(await messagesSent(page)).toEqual([]);
    await drop(request, id);
  }

  // A paste on the card goes into the field, masked, and gives nothing by itself.
  const pasted = await create(request, "Secret pasted", ws);
  await ask(request, pasted, "secret");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/s/${pasted}`);
  await expect(card).toBeFocused();
  await page.evaluate(() => navigator.clipboard.writeText("pasted-s3cret"));
  await page.keyboard.press("Control+v");
  await expect(field).toHaveValue("pasted-s3cret");
  await expect(field).toBeFocused();
  await expect(box(pasted)).toHaveValue("");
  await page.keyboard.press("Enter");
  await expect(card.getByTestId("secret-error")).toHaveText("Not yet: the keyboard has only just arrived");
  expect(await secretsAsked(request, pasted)).toBe(1);

  // The key that goes to what waits: the owner came for it, so the field has the keyboard, and
  // Enter there gives nothing as the keyboard arrives.
  const quiet = await create(request, "Nothing waits here", ws);
  await drop(request, draft, pasted);
  const third = await create(request, "Secret from elsewhere", ws);
  await ask(request, third, "secret");
  await open(page, [quiet]);
  await expect(row(page, third)).toHaveAttribute("data-watch", "need");
  await page.keyboard.press("Alt+a");
  await expect(page).toHaveURL(new RegExp(`/s/${third}$`));
  await expect(field).toBeFocused();
  await page.keyboard.type("too-s00n-7q"); // (A value no ordinary text holds: a word is asked about first.)
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  expect(await secretsAsked(request, third)).toBe(1);
  await expect(card).toHaveAttribute("data-keys", "ready");
  await page.waitForTimeout(100);
  await page.keyboard.press("Enter");
  await expect.poll(() => secretsAsked(request, third)).toBe(0);
  await drop(request, quiet, third);
});

test("what waits across sessions is answered in sequence, one key each", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("sequence");
  const quiet = await create(request, "Nothing waits here", ws);
  // Three approvals and a question, each in a session of its own, in the order they began to wait.
  const a = await asksToRun(request, "Build the docs", ws, "docs");
  const b = await asksToRun(request, "Clean the cache", ws, "cache");
  const c = await asksToRun(request, "Tag the release", ws, "tag");
  const q = await create(request, "Pick a color", ws);
  await ask(request, q, "question");

  await page.goto(`/s/${quiet}`);
  await expect(page.getByTestId("composer")).toBeFocused();
  for (const id of [a, b, c, q]) await expect(row(page, id)).toHaveAttribute("data-watch", "need");
  // Only the keyboard is used from here: every press is counted, and the pointer never moves.
  let count = 0;
  const press = async (key: string) => { count++; await page.keyboard.press(key); };
  const at = (id: string) => expect(page).toHaveURL(new RegExp(`/s/${id}$`));
  // The keyboard comes to the card; once it has been there for the settle time, its Allow has it and acts.
  const ready = async (id: string) => {
    await at(id);
    const card = cardIn(page, id, "approval");
    await expect(card.getByTestId("allow-once")).toBeFocused();
    // (Brought there by the page: Enter acts after the settle time from then, as the card says.)
    await expect(card.getByTestId("allow-once")).toHaveAttribute("data-ready", "true", { timeout: 5000 });
    await expect(card.getByTestId("approval")).toHaveAttribute("data-live", "true");
  };

  // One key starts the sequence on the one that has waited longest.
  await press("Alt+a");
  await ready(a);
  // Each Enter answers, and the next one opens by itself with the keyboard on it.
  await press("Enter");
  await ready(b);
  // The card says that it is a sequence and how many more wait.
  await expect(page.getByTestId("waiting-elsewhere")).toHaveAttribute("data-on", "true");
  await expect(page.getByTestId("waiting-elsewhere")).toContainText("2 other sessions wait · next opens after this");
  await shoot(page, "answer-keys-06-sequence");
  await press("Enter");
  await ready(c);
  await expect(page.getByTestId("waiting-elsewhere")).toContainText("1 other session waits · next opens after this");
  await press("Enter");
  await at(q);
  const question = cardIn(page, q, "question");
  await expect(question).toBeFocused();
  await expect(question).toHaveAttribute("data-keys", "ready");
  await expect(question.getByTestId("question-hint")).toHaveText("Press 1 to 3 to answer, or Up and Down then Enter");
  await expect(question.getByTestId("question-digit")).toHaveCount(3);
  await expect(page.getByTestId("waiting-elsewhere")).toHaveCount(0);
  await shoot(page, "answer-keys-07-sequence-question");
  await press("2");

  // Everything is answered, in five presses, and the page says that nothing else waits.
  await expect(page.locator(".k-tip")).toHaveText("Nothing else waits for you.");
  expect(count).toBe(5);
  for (const id of [a, b, c]) await expect.poll(async () => (await approvals(request, id))[0]).toMatchObject({ state: "allowed", choice: "once" });
  expect(await answersOf(request, q)).toEqual({ "0": { picked: ["Amber"] } });
  for (const id of [a, b, c, q]) await expect(row(page, id)).not.toHaveAttribute("data-watch", "need");
  // The owner is back in the session the sequence began in, the keyboard in its message box.
  await at(quiet);
  await expect(page.getByTestId("composer")).toBeFocused();
  await drop(request, quiet, a, b, c, q);
});

// The same over two panes, with every kind the sequence meets: none of these sessions has a pane, so
// each is a look over the pane the sequence began in, in the place of the one before it. A long
// command is opened, read on to its end and allowed (Enter, End, Enter), the question takes its
// digit. The digit answers by itself, so the plan after it keeps the keyboard on its text (an Enter
// meant for the digit approves nothing): Tab goes to Approve, and Enter approves. After the last the
// pane shows what it held, the keyboard where it was: nine keys, no pointer.
test("over two panes, three approvals (one long), a question and a plan are answered in nine keys, and the panes are as they were", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("sequence-kinds");
  const reader = await create(request, "Reading the notes", ws);
  const beside = await create(request, "Beside it", ws);
  const a = await asksToRun(request, "Build the docs", ws, "docs");
  const long = await create(request, "Prune the old branches", ws);
  await request.put(`/api/sessions/${long}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await request.post(`/api/sessions/${long}/messages`, { data: { text: calls([{ name: "Bash", input: { command: LONG } }]) } });
  await expect.poll(async () => (await approvals(request, long)).length, { timeout: 30_000 }).toBe(1);
  const b = await asksToRun(request, "Tag the release", ws, "tag");
  const q = await create(request, "Pick a color", ws);
  await ask(request, q, "question");
  const p = await create(request, "Plan the index", ws);
  await ask(request, p, "plan");

  await open(page, [reader, beside]);
  const box = pane(page, reader).getByTestId("composer");
  await box.click();
  await expect(box).toBeFocused();
  for (const id of [a, long, b, q, p]) await expect(row(page, id)).toHaveAttribute("data-watch", "need");
  const slot0 = page.getByTestId("bridge").locator(':scope > [data-slot="0"]');
  let count = 0;
  const press = async (key: string) => { count++; await page.keyboard.press(key); };
  const at = async (id: string) => { await expect(page).toHaveURL(new RegExp(`/s/${id}$`)); await expect(slot0).toHaveAttribute("data-station", id); await expect(slot0).toHaveAttribute("data-holds", reader); };
  const ready = async (id: string) => {
    await at(id);
    const card = cardIn(page, id, "approval");
    await expect(card.getByTestId("allow-once")).toBeFocused({ timeout: 8000 });
    // (Brought there by the page: Enter acts after the settle time from then, as the card says.)
    await expect(card.getByTestId("allow-once")).toHaveAttribute("data-ready", "true", { timeout: 5000 });
    await expect(card.getByTestId("approval")).toHaveAttribute("data-live", "true");
  };

  await press("Alt+a");
  await ready(a);
  await press("Enter");
  // The long command: its list has the keyboard, Enter opens it, End reads it on to its end, Enter allows.
  await at(long);
  const list = cardIn(page, long, "approval"), card = list.getByTestId("approval");
  await expect(list).toBeFocused();
  await expect(list).toHaveAttribute("data-keys", "ready");
  await press("Enter");
  await expect(card.getByTestId("approval-read-key")).toBeVisible();
  await press("End");
  await expect.poll(async () => Number(await card.getAttribute("data-unseen")), { timeout: 5000 }).toBe(0);
  await ready(long);
  await press("Enter");
  await ready(b);
  await press("Enter");
  await at(q);
  const question = cardIn(page, q, "question");
  await expect(question.getByTestId("question-digit")).toHaveCount(3);
  await press("2");
  await at(p);
  const plan = cardIn(page, p, "plan");
  // (After an answer one key gave by itself: the keyboard rests on the plan's text, not on Approve.)
  await expect(plan.getByTestId("plan-text")).toBeFocused({ timeout: 8000 });
  await expect(plan.getByTestId("plan-hint")).toHaveText("Tab goes to Approve");
  await press("Tab");
  await expect(plan.getByTestId("plan-approve")).toBeFocused();
  await expect(plan.getByTestId("plan-approve")).toHaveAttribute("data-ready", "true", { timeout: 5000 });
  await shoot(page, "answer-keys-20-sequence-plan");
  await press("Enter");

  // Nothing is left: the pane shows the reader again, the keyboard in its box, the other pane as it was.
  await expect(page).toHaveURL(new RegExp(`/s/${reader}$`));
  await expect(slot0).toHaveAttribute("data-station", reader);
  await expect(slot0.getByTestId("look-bar")).toHaveCount(0);
  await expect(page.getByTestId("bridge").locator(':scope > [data-slot="1"]')).toHaveAttribute("data-station", beside);
  await expect(box).toBeFocused();
  expect(count).toBe(9);
  for (const id of [a, long, b]) await expect.poll(async () => (await approvals(request, id))[0]).toMatchObject({ state: "allowed", choice: "once" });
  expect(await answersOf(request, q)).toEqual({ "0": { picked: ["Amber"] } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${p}/plan`)).json()).open.length).toBe(0);
  await drop(request, reader, beside, a, long, b, q, p);
});

// One number answers a question by itself, with no Enter after it. The Enter the owner may still
// press for it lands on the next session's card in the same pane: it allows nothing there, however
// late it comes. The keyboard rests on the card, which says the way to its answer: Down, then Enter.
test("an Enter after a question answered by one number allows nothing in the next session", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  await watchKeys(page);
  const ws = folder("sequence-one-key");
  const quiet = await create(request, "Nothing waits here", ws);
  const q = await create(request, "Pick a color", ws);
  await ask(request, q, "question");
  const next = await asksToRun(request, "Write the step", ws, "step2");

  await page.goto(`/s/${quiet}`);
  await expect(page.getByTestId("composer")).toBeFocused();
  for (const id of [q, next]) await expect(row(page, id)).toHaveAttribute("data-watch", "need");
  await page.keyboard.press("Alt+a");
  await expect(page).toHaveURL(new RegExp(`/s/${q}$`));
  const question = cardIn(page, q, "question");
  await expect(question).toBeFocused();
  await expect(question).toHaveAttribute("data-keys", "ready");
  await expect(question.getByTestId("question-digit")).toHaveCount(3);
  await page.keyboard.press("2");
  await mark(page);
  await expect(page).toHaveURL(new RegExp(`/s/${next}$`));
  const list = cardIn(page, next, "approval");
  const card = list.getByTestId("approval");
  await expect(card).toHaveAttribute("data-live", "true");
  // Well past the settle time of the arrival: the Enter still answers nothing, and the keyboard is on the list.
  expect(await since(page, "mark", SETTLE + 300)).toBe(true);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  expect((await approvals(request, next))[0]).toMatchObject({ state: "pending" });
  await expect(page).toHaveURL(new RegExp(`/s/${next}$`));
  await expect(list).toBeFocused();
  await expect(card.getByTestId("approval-arming")).toHaveText("Down, then Enter allows once");
  await shoot(page, "answer-keys-08-after-one-key");
  // The owner goes to the answer themselves: Down, then Enter allows once.
  await page.keyboard.press("ArrowDown");
  await expect(card.getByTestId("allow-once")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await approvals(request, next))[0]).toMatchObject({ state: "allowed", choice: "once" });
  expect(await answersOf(request, q)).toEqual({ "0": { picked: ["Amber"] } });
  await drop(request, quiet, q, next);
});

// Two questions in a row: the second's number, pressed as the first's was, is not dropped in
// silence. The card says what answers it: Down first, then the number.
test("a number on the question after one a number answered says Down first, and answers after Down", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  await watchKeys(page);
  const ws = folder("sequence-two-questions");
  const quiet = await create(request, "Nothing waits here", ws);
  const q1 = await create(request, "First question", ws);
  await ask(request, q1, "question");
  const q2 = await create(request, "Second question", ws);
  await ask(request, q2, "question");
  await page.goto(`/s/${quiet}`);
  await expect(page.getByTestId("composer")).toBeFocused();
  for (const id of [q1, q2]) await expect(row(page, id)).toHaveAttribute("data-watch", "need");
  await page.keyboard.press("Alt+a");
  await expect(page).toHaveURL(new RegExp(`/s/${q1}$`));
  const first = cardIn(page, q1, "question");
  await expect(first).toHaveAttribute("data-keys", "ready");
  await page.keyboard.press("1");
  await expect(page).toHaveURL(new RegExp(`/s/${q2}$`));
  const second = cardIn(page, q2, "question");
  await expect(second).toHaveAttribute("data-keys", "ready");
  await expect(second).not.toHaveAttribute("data-own", "true");
  await page.keyboard.press("2");
  await expect(second.getByTestId("question-nudge")).toHaveText("Down first, then a number answers");
  await expect(page.locator(`[data-station="${q2}"]`).getByTestId("composer")).toHaveValue("");
  await shoot(page, "answer-keys-09-down-first");
  await page.keyboard.press("ArrowDown");
  await expect(second).toHaveAttribute("data-own", "true");
  await expect(second).toHaveAttribute("data-keys", "ready");
  await page.keyboard.press("2");
  await expect.poll(() => answersOf(request, q2), { timeout: 10_000 }).toEqual({ "0": { picked: ["Amber"] } });
  expect(await answersOf(request, q1)).toEqual({ "0": { picked: ["Teal"] } });
  await drop(request, quiet, q1, q2);
});

test("the sequence stays with the owner: it goes on through a grant, ends when they do something else, and after a quiet minute", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  // A long folder: the second request's path is cut by its box, as it is on a machine whose scratch
  // folder is deep. Its card must hold still for the first one's Allow to take the keyboard.
  const ws = folder(`sequence-ends-${"deep-".repeat(12)}`);
  const quiet = await create(request, "Nothing waits here", ws);
  // One session with two requests of different tools (each is answered on its own), and two more sessions.
  const two = await create(request, "Two requests", ws);
  await request.put(`/api/sessions/${two}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await request.post(`/api/sessions/${two}/messages`, { data: { text: `script:batch ${JSON.stringify([{ name: "Bash", input: { command: "echo one > one.txt" } }, { name: "Write", input: { file_path: `${ws}/two.txt`, content: "two" } }])}` } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${two}/approvals`)).json()).approvals.length).toBe(2);
  const other = await asksToRun(request, "One more", ws, "more");
  const third = await asksToRun(request, "And another", ws, "another");

  // (The page's clock is the test's from here: a quiet minute passes at the end without waiting for it.)
  await page.clock.install();
  await page.goto(`/s/${quiet}`);
  await expect(page.getByTestId("composer")).toBeFocused();
  await page.keyboard.press("Alt+a");
  await expect(page).toHaveURL(new RegExp(`/s/${two}$`));
  const cards = page.getByTestId("approval");
  await expect(cards).toHaveCount(2);
  await expect(cards.first().getByTestId("allow-once")).toBeFocused();
  // (Brought there by the page: Enter acts after the settle time from then, as the card says.)
  await expect(cards.first().getByTestId("allow-once")).toHaveAttribute("data-ready", "true", { timeout: 5000 });
  await expect(cards.first()).toHaveAttribute("data-live", "true");
  // The first is answered: the keyboard goes to the one left in this session, not to another session.
  await page.keyboard.press("Enter");
  await expect(cards).toHaveCount(1);
  await expect(page).toHaveURL(new RegExp(`/s/${two}$`));
  await expect(cards.getByTestId("allow-once")).toBeFocused();
  // With the keyboard on its Allow the card says what Enter does; a card whose Allow has
  // no keyboard says nothing.
  await expect(cards.getByTestId("approval-hint")).toBeVisible();
  // The owner types into the message box instead: the sequence is over, and an answer moves nothing.
  await page.getByTestId("composer").focus();
  await page.keyboard.type("x");
  await expect(page.getByTestId("waiting-elsewhere")).not.toHaveAttribute("data-on", "true");
  // The count is a chip in the card's header that goes to the next, not a line of small text above the card; the
  // key's hint stays on the card only while its Allow has the keyboard.
  const chip = cards.getByTestId("waiting-elsewhere");
  await expect(chip).toHaveText("2 other sessions wait");
  await expect(chip.locator(".k-mark"), "the state dot, not a yellow diamond").toHaveAttribute("data-watch", "need");
  await expect(chip).toHaveAttribute("aria-label", "2 other sessions wait for you. Go to the next");
  expect(await chip.evaluate((b) => b.tagName)).toBe("BUTTON");
  await expect(chip).toHaveAttribute("title", "2 other sessions wait for you. Alt A goes to the next.");
  expect(await chip.evaluate((b) => { const card = b.closest('[data-testid="approval"]'); return !!card && b.getBoundingClientRect().bottom <= card.querySelector('[data-testid="allow-once"]')!.getBoundingClientRect().top; }), "the chip is in the card's header, above the answers").toBe(true);
  await shoot(page, "answer-keys-09-waits-elsewhere");
  await page.getByTestId("composer").fill("");
  await expect(cards).toHaveAttribute("data-live", "true");
  await cards.getByTestId("allow-once").click();
  await expect(cards).toHaveCount(0);
  await page.waitForTimeout(800);
  await expect(page).toHaveURL(new RegExp(`/s/${two}$`));

  // The key again takes up what is left. A grant made with the pointer, in the card's own popup, is
  // an answer like any other: the sequence goes on, and the keyboard is on the next request.
  await page.keyboard.press("Alt+a");
  await expect(page).toHaveURL(new RegExp(`/s/${other}$`));
  await expect(cards.getByTestId("allow-once")).toBeFocused();
  await expect(cards).toHaveAttribute("data-live", "true");
  await expect(cards.getByTestId("allow-always")).not.toHaveAttribute("aria-disabled", "true");
  await cards.getByTestId("allow-always").click();
  await page.getByTestId("grant-session").click();
  await expect(page).toHaveURL(new RegExp(`/s/${third}$`));
  await expect(cards.getByTestId("allow-once")).toBeFocused();
  await expect(page.getByTestId("waiting-elsewhere")).toHaveCount(0);
  expect((await approvals(request, third))[0]).toMatchObject({ state: "pending" });

  // Nothing is answered for a minute: the sequence ends by itself and says so. The request still
  // waits with the keyboard on it; the answer given then moves the page nowhere.
  const fourth = await asksToRun(request, "Later", ws, "later");
  await expect(page.getByTestId("waiting-elsewhere")).toHaveAttribute("data-on", "true");
  await page.clock.fastForward(61_000);
  await expect(page.locator(".k-tip")).toHaveText("The answering sequence ended after a quiet minute.");
  await expect(page.getByTestId("waiting-elsewhere")).not.toHaveAttribute("data-on", "true");
  await expect(cards.getByTestId("allow-once")).toBeFocused();
  // (Brought there by the page: Enter acts after the settle time from then, as the card says.)
  await expect(cards.getByTestId("allow-once")).toHaveAttribute("data-ready", "true", { timeout: 5000 });
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await approvals(request, third))[0]).toMatchObject({ state: "allowed", choice: "once" });
  await page.waitForTimeout(600);
  await expect(page).toHaveURL(new RegExp(`/s/${third}$`));
  expect((await approvals(request, fourth))[0]).toMatchObject({ state: "pending" });
  await drop(request, quiet, two, other, third, fourth);
});

test("an approval taller than the room above the message box gets the keyboard on Allow once, and folding it keeps the keyboard", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  await watchKeys(page);
  const ws = folder("tall");
  // A command of eight lines in a short window: the card is whole, and taller than the region it is in.
  const command = `${Array.from({ length: 7 }, (_, i) => `echo line ${i + 1}`).join("\n")}\necho line 8 > out.txt`;
  const id = await create(request, "A tall card", ws);
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([{ name: "Bash", input: { command } }]) } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${id}/approvals`)).json()).approvals.length).toBe(1);
  // (A window short enough that the card is taller than its region, the running line under it gone.)
  await page.setViewportSize({ width: 1280, height: 490 });
  await page.goto(`/s/${id}`);
  const card = page.getByTestId("approval");
  const allow = card.getByTestId("allow-once");
  await expect(card).toBeVisible();
  await expect(card).not.toHaveAttribute("data-must-open", "true");
  const tray = page.getByTestId("composer-tray");
  expect(await card.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(await tray.evaluate((el) => el.clientHeight));
  // After the settle time its Allow once has the keyboard and is brought into view; Enter then allows.
  await expect(allow).toBeFocused();
  await expect.poll(() => allow.evaluate((el) => { const r = el.getBoundingClientRect(), t = el.closest('[data-testid="composer-tray"]')!.getBoundingClientRect(); return r.top >= t.top - 0.5 && r.bottom <= Math.min(innerHeight, t.bottom) + 0.5; })).toBe(true);
  await shoot(page, "answer-keys-14-tall-card");
  await expect(card).toHaveAttribute("data-live", "true");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await approvals(request, id))[0]).toMatchObject({ state: "allowed", choice: "once" });
  await page.setViewportSize({ width: 1920, height: 1040 });

  // A command cut by its box: Enter on the control that opens it, and Enter again to fold it. The
  // keyboard stays on that control (folded, the text is measured again, and the control does not leave).
  const cut = await create(request, "A cut card", ws);
  await request.put(`/api/sessions/${cut}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await request.post(`/api/sessions/${cut}/messages`, { data: { text: calls([{ name: "Bash", input: { command: LONG } }]) } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${cut}/approvals`)).json()).approvals.length).toBe(1);
  await page.goto(`/s/${cut}`);
  await expect(card).toHaveAttribute("data-must-open", "true");
  const expand = card.getByTestId("approval-expand");
  await expand.focus();
  await page.keyboard.press("Enter");
  await expect(expand).toHaveText("Fold");
  await expect(expand).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(expand).toHaveText("Show the whole command");
  await page.waitForTimeout(300);
  await expect(expand).toBeFocused();
  await expect(card).toHaveAttribute("data-must-open", "true");
  // A press on an answer that is refused says why where it was pressed, in words that show.
  await allow.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".k-tip")).toHaveText("Open the whole command first");
  expect((await approvals(request, cut))[0]).toMatchObject({ state: "pending" });
  await drop(request, id, cut);
});

// The sequence and a card that is not read: a step onto a long command rests on the list of
// requests, where Enter opens the text and answers nothing; once every line of it has been in
// view the card's Allow takes the keyboard, and the next Enter allows. Each key is one the
// owner meant, and nothing is answered for a text that was not on screen.
test("a step of the sequence onto a long command rests on the list: Enter opens it, read, Enter allows", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("sequence-long");
  const quiet = await create(request, "Nothing waits here", ws);
  const short = await asksToRun(request, "A short command", ws, "short");
  // Twelve lines: more than the card's box shows, and all in view once it is opened.
  const twelve = `${Array.from({ length: 11 }, (_, i) => `echo step ${i + 1}`).join("\n")}\necho last > twelve.txt`;
  const long = await create(request, "Twelve lines", ws);
  await request.put(`/api/sessions/${long}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await request.post(`/api/sessions/${long}/messages`, { data: { text: calls([{ name: "Bash", input: { command: twelve } }]) } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${long}/approvals`)).json()).approvals.length, { timeout: 30_000 }).toBe(1);

  await page.goto(`/s/${quiet}`);
  await expect(page.getByTestId("composer")).toBeFocused();
  for (const id of [short, long]) await expect(row(page, id)).toHaveAttribute("data-watch", "need");
  let count = 0;
  const press = async (key: string) => { count++; await page.keyboard.press(key); };
  await press("Alt+a");
  await expect(page).toHaveURL(new RegExp(`/s/${short}$`));
  const first = cardIn(page, short, "approval");
  await expect(first.getByTestId("allow-once")).toBeFocused();
  // (Brought there by the page: Enter acts after the settle time from then, as the card says.)
  await expect(first.getByTestId("allow-once")).toHaveAttribute("data-ready", "true", { timeout: 5000 });
  await expect(first.getByTestId("approval")).toHaveAttribute("data-live", "true");
  await press("Enter");
  // The next one is the long command: the keyboard is on its list, not on an answer.
  await expect(page).toHaveURL(new RegExp(`/s/${long}$`));
  const list = cardIn(page, long, "approval");
  const card = list.getByTestId("approval");
  await expect(list).toBeFocused();
  await expect(card).toHaveAttribute("data-must-open", "true");
  await expect(card.getByTestId("approval-open-first")).toHaveText("Enter opens the whole command.");
  await expect(list).toHaveAttribute("data-keys", "ready");
  await shoot(page, "answer-keys-15-sequence-long");
  await press("Enter");
  await expect(card.getByTestId("approval-summary")).toContainText("echo last > twelve.txt");
  expect((await approvals(request, long))[0]).toMatchObject({ state: "pending" });
  // Read, its Allow has the keyboard; the fourth key allows.
  await expect(card.getByTestId("allow-once")).toBeFocused({ timeout: 8000 });
  // (Brought there by the page: Enter acts after the settle time from then, as the card says.)
  await expect(card.getByTestId("allow-once")).toHaveAttribute("data-ready", "true", { timeout: 5000 });
  await expect(card).toHaveAttribute("data-live", "true");
  await press("Enter");
  await expect.poll(async () => (await approvals(request, long))[0]).toMatchObject({ state: "allowed", choice: "once" });
  expect(count).toBe(4);
  await drop(request, quiet, short, long);
});

// After a page load, and after coming back from an agent's page, the keyboard is where the
// owner works. A request in a pane they are not working in gets none of it, and no answer of a
// high-risk request has it by the page's own doing in any pane: Enter then allows nothing.
test("a load or a return never leaves the keyboard on a high-risk answer, or in a pane that is not worked in", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("high-risk");
  const reader = await create(request, "Reading the logs", ws);
  // A coordinator whose agent asks to rewrite a remote's history: its request shows on the coordinator's page.
  const push = { name: "Bash", input: { command: "git push --force-with-lease origin main" } };
  const coordinator = await create(request, "Coordinator", ws);
  await request.put(`/api/sessions/${coordinator}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await request.post(`/api/sessions/${coordinator}/messages`, { data: { text: calls([{ name: "spawn_agent", input: { message: `Publish the branch\nscript:calls ${JSON.stringify([push])}`, isolation: "none" } }, { name: "wait_agent", input: {} }]) } });
  const kid = async () => ((await (await request.get(`/api/sessions/${coordinator}/agents`)).json()).agents?.[0]?.session_id ?? "") as string;
  await expect.poll(async () => { const k = await kid(); return k ? (await approvals(request, k)).map((a) => a.state).join() : ""; }, { timeout: 60_000 }).toBe("pending");
  const agent = await kid();
  const keys = () => page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return `${a?.dataset.testid ?? a?.tagName ?? ""} in ${a?.closest<HTMLElement>("[data-station]")?.dataset.station ?? "no pane"}`; });
  const still = async () => expect((await approvals(request, agent))[0]).toMatchObject({ state: "pending" });

  // Two panes, the reader's the one worked in: the keyboard stays in its message box.
  await page.setViewportSize({ width: 1920, height: 1040 });
  await open(page, [reader, coordinator]);
  const risky = pane(page, coordinator).getByTestId("approval");
  await expect(risky).toHaveAttribute("data-risk", "high");
  await page.waitForTimeout(1600);
  expect(await keys()).toBe(`composer in ${reader}`);
  await expect(pane(page, reader)).toHaveAttribute("data-helm", "true");
  await expect(pane(page, coordinator)).not.toHaveAttribute("data-helm", "true");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await still();
  await shoot(page, "answer-keys-16-two-panes-high-risk");

  // The coordinator alone, the pane worked in: its card may have the keyboard, its answer may not.
  await page.goto("/api/daemon");
  await page.evaluate((id) => localStorage.setItem("keel.panes", JSON.stringify({ count: 1, slots: [id], sizes: {}, active: 0 })), coordinator);
  await page.goto(`/s/${coordinator}`);
  await expect(risky).toBeVisible();
  await page.waitForTimeout(1600);
  expect(await keys()).not.toMatch(/^allow/);
  await expect(risky.getByTestId("approval-hint")).toBeHidden();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await still();

  // To the agent's own page and back with Escape: the same.
  await page.goto(`/s/${agent}`);
  await expect(page).toHaveURL(new RegExp(`/s/${agent}$`));
  await page.waitForTimeout(1600);
  expect(await keys()).not.toMatch(/^allow/);
  await pane(page, agent).getByTestId("composer").focus();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(new RegExp(`/s/${coordinator}$`));
  await expect(risky).toBeVisible();
  await page.waitForTimeout(1600);
  expect(await keys()).not.toMatch(/^allow/);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await still();
  // The answer is one deliberate key away, and the card says which.
  await takeToCard(page, coordinator);
  await expect(risky.getByTestId("approval-arming")).toHaveText("High risk: Down, then Enter allows once");
  await page.keyboard.press("ArrowDown");
  await expect(risky.getByTestId("allow-once")).toBeFocused();
  // (Brought there by the page: Enter acts after the settle time from then, as the card says.)
  await expect(risky.getByTestId("allow-once")).toHaveAttribute("data-ready", "true", { timeout: 5000 });
  await expect(risky.getByTestId("approval-hint")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await approvals(request, agent))[0]).toMatchObject({ state: "allowed", choice: "once" });
  await drop(request, reader, coordinator);
});
// The key that goes to what waits brings the keyboard to the card of that pane (the owner's own doing).
async function takeToCard(page: Page, id: string) {
  const at = await page.evaluate(() => !!document.activeElement?.closest("[data-ask-card]"));
  if (!at) { await pane(page, id).getByTestId("composer").focus(); await page.keyboard.press("Alt+a"); }
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("[data-ask-card]"))).toBe(true);
  await page.waitForTimeout(1100);
}

// What the card says Enter does is true at every moment: while the keyboard is on its way to
// Allow once and the settle time runs, "in a moment", dimmer; "Enter allows once" from the
// moment a press would answer, and not before. Nothing moves as one line gives way to the other.
test("the hint says Enter allows once exactly when it would, and says so quietly before", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const id = await asksToRun(request, "The hint is true", folder("hint"), "hint");
  await page.goto(`/s/${id}`);
  const card = page.getByTestId("approval");
  const allow = card.getByTestId("allow-once");
  const arming = card.getByTestId("approval-arming"), hint = card.getByTestId("approval-hint");
  // Seen within the settle time: it says what is coming, and an Enter now allows nothing.
  await expect(arming).toHaveText("Enter allows once in a moment");
  await expect(hint).toBeHidden();
  // And the Allow itself shows it arming: a line fills under its label for what is left of the settle time.
  await expect(allow).toHaveAttribute("data-arming", "");
  const line = await allow.getByTestId("allow-arming").evaluate((el) => { const a = getComputedStyle(el); return { name: a.animationName, ms: parseFloat(a.animationDuration) * 1000, h: a.height }; });
  expect(line.name).toBe("k-arm");
  expect(line.ms).toBeGreaterThan(100);
  expect(line.ms).toBeLessThanOrEqual(400);
  const where = async () => (await card.getByTestId("approval-actions").locator("button").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)))).join();
  const before = await where(), height = Math.round((await card.boundingBox())!.height);
  await page.keyboard.press("Enter");
  expect((await approvals(request, id))[0]).toMatchObject({ state: "pending" });
  await shoot(page, "answer-keys-17-hint-arming");
  // The line turns exactly when Enter would act: from then one press allows.
  await expect(hint).toBeVisible();
  await expect(arming).toHaveCount(0);
  await expect(allow).not.toHaveAttribute("data-arming");
  await expect(allow).toBeFocused();
  await expect(card).toHaveAttribute("data-live", "true");
  expect(await where()).toBe(before);
  expect(Math.round((await card.boundingBox())!.height)).toBe(height);
  // The box under it says what Enter does while the card has the keys, and what it does once the keys are the box's:
  // Enter is never two things on one screen.
  const box = page.getByTestId("composer");
  await page.waitForTimeout(200);
  await shoot(page, "answer-keys-17b-box-hint-card");
  await expect(box).toHaveAttribute("placeholder", "Enter allows once; Tab to the box to steer");
  await box.focus();
  await expect(box).toHaveAttribute("placeholder", /^Enter steers, /);
  await shoot(page, "answer-keys-17c-box-hint-box");
  await allow.focus();
  await expect(box).toHaveAttribute("placeholder", "Enter allows once; Tab to the box to steer");
  // (The keyboard came back by code: its keys act after the settle time.)
  await expect(allow).toHaveAttribute("data-ready", "true");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await approvals(request, id))[0]).toMatchObject({ state: "allowed", choice: "once" });
  await drop(request, id);
  // A high-risk request is the owner's to go to (Down, then Enter): its Allow never shows the arming line.
  const risky = await create(request, "The hint is true, high risk", folder("hint"));
  await request.put(`/api/sessions/${risky}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await request.post(`/api/sessions/${risky}/messages`, { data: { text: calls([{ name: "Bash", input: { command: "rm -rf ./release && git push --force origin main" } }]) } });
  await expect.poll(async () => (await approvals(request, risky)).length, { timeout: 30_000 }).toBe(1);
  await page.goto(`/s/${risky}`);
  const rc = page.getByTestId("approval");
  await expect(rc).toHaveAttribute("data-risk", "high");
  await page.evaluate(() => { const w = window as unknown as { __armed: number }; w.__armed = 0; const t0 = performance.now(); const look = () => { if (document.querySelector('[data-testid="allow-once"][data-arming]')) w.__armed++; if (performance.now() - t0 < 2500) requestAnimationFrame(look); }; requestAnimationFrame(look); });
  await page.waitForTimeout(2700);
  expect(await page.evaluate(() => (window as unknown as { __armed: number }).__armed)).toBe(0);
  await expect(rc.getByTestId("approval-arming")).toHaveText("High risk: Down, then Enter allows once");
  await drop(request, risky);
});

// Enter held down through an answer in the sequence answers once: its repeats allow nothing of the
// next card, which arrives while the key is still down.
test("Enter held through an answer in the sequence allows one card, never the next", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("held-enter");
  const quiet = await create(request, "Nothing waits here", ws);
  const a = await asksToRun(request, "Held: first", ws, "first");
  const b = await asksToRun(request, "Held: second", ws, "second");
  await page.goto(`/s/${quiet}`);
  await expect(page.getByTestId("composer")).toBeFocused();
  await page.keyboard.press("Alt+a");
  await expect(page).toHaveURL(new RegExp(`/s/${a}$`));
  await expect(cardIn(page, a, "approval").getByTestId("allow-once")).toBeFocused({ timeout: 8000 });
  // (Brought there by the page: Enter acts after the settle time from then, as the card says.)
  await expect(cardIn(page, a, "approval").getByTestId("allow-once")).toHaveAttribute("data-ready", "true", { timeout: 5000 });
  await expect(cardIn(page, a, "approval").getByTestId("approval")).toHaveAttribute("data-live", "true");
  // Down, and held for three seconds (the browser repeats it): past the next card's arrival and its settle time.
  await page.keyboard.down("Enter");
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) { await page.keyboard.down("Enter"); await page.waitForTimeout(30); }
  await page.keyboard.up("Enter");
  await expect.poll(async () => (await approvals(request, a))[0]).toMatchObject({ state: "allowed", choice: "once" });
  await expect(page).toHaveURL(new RegExp(`/s/${b}$`));
  await page.waitForTimeout(800);
  expect((await approvals(request, b))[0]).toMatchObject({ state: "pending" });
  // A fresh press answers it.
  await expect(cardIn(page, b, "approval").getByTestId("allow-once")).toBeFocused({ timeout: 8000 });
  // (Brought there by the page: Enter acts after the settle time from then, as the card says.)
  await expect(cardIn(page, b, "approval").getByTestId("allow-once")).toHaveAttribute("data-ready", "true", { timeout: 5000 });
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await approvals(request, b))[0]).toMatchObject({ state: "allowed", choice: "once" });
  await drop(request, quiet, a, b);
});

// A key that went down sooner than a key's settle time after a card was painted (lib/approvals.ts,
// KEY_MS) was on its way before the owner saw it. Four panes, a question and the next session's
// approval in the sequence: the number answers the question, the sequence moves on, and an Enter
// pressed the moment the approval arrives (meant for the question, the owner never saw the approval)
// allows nothing. After an answer one key gave by itself the keyboard rests on the list: the owner's
// Down goes to Allow once, and Enter there allows once the card says it is ready.
test("a key pressed as an approval arrives is not taken; one pressed once it is ready is", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("page-focus");
  const helm = await create(request, "Worked in", ws), q = await create(request, "Asks a question", ws);
  const b = await create(request, "Beside", ws), c = await create(request, "Beside too", ws);
  await ask(request, q, "question");
  const w = await asksToRun(request, "Writes a file", ws, "write");
  await open(page, [helm, q, b, c]);
  await page.keyboard.press("Alt+a");
  await expect(pane(page, q)).toHaveAttribute("data-helm", "true");
  const question = cardIn(page, q, "question");
  await expect(question.getByTestId("question-digit")).toHaveCount(3);
  await page.keyboard.press("1");
  await expect.poll(() => waits(request, q, "question")).toBe(false);
  // The approval arrives: Enter at once.
  const allow = cardIn(page, w, "approval").getByTestId("allow-once");
  await page.waitForFunction((id) => !!document.activeElement?.closest(`section.k-station[data-station="${id}"] [data-ask-card]`), w, { polling: "raf", timeout: 10_000 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  expect((await approvals(request, w))[0], "Enter the moment the approval arrived").toMatchObject({ state: "pending" });
  // (The digit answered by itself: the list keeps the keyboard, and says the way to the answer.)
  await expect(cardIn(page, w, "approval").getByTestId("approval-arming")).toHaveText("Down, then Enter allows once");
  await page.keyboard.press("ArrowDown");
  await expect(allow).toBeFocused();
  // The card says when it is ready; from then Enter allows.
  await expect(allow).toHaveAttribute("data-ready", "true", { timeout: 3000 });
  await expect(cardIn(page, w, "approval").getByTestId("approval-hint")).toHaveText("Enter allows once, Esc to deny with a reason");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await approvals(request, w))[0]).toMatchObject({ state: "allowed", choice: "once" });
  await drop(request, helm, q, b, c, w);
});

// A key pressed on a card that took the keyboard by itself, and that the card does not take, types
// nothing: a number meant for a card never lands in the message box, and Enter then sends no "1".
test("a number with no answer pressed on a card that took the keyboard by itself goes nowhere, never into a message", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const id = await create(request, "Asks, and a number is pressed", folder("no-type"));
  await open(page, [id]);
  await page.waitForTimeout(1500);
  await ask(request, id, "approval", "num");
  const list = cardIn(page, id, "approval");
  await expect(list).toBeFocused();
  await expect(list).toHaveAttribute("data-keys", "ready");
  // (1 to 3 are the card's answers: a number it has no answer for.)
  await page.keyboard.press("7");
  await expect(page.locator(".k-tip")).toHaveText("Nothing typed: this request has the keyboard");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  await expect(pane(page, id).getByTestId("composer")).toHaveValue("");
  expect(await said(request, id)).toEqual([]);
  await expect(pane(page, id).getByTestId("queue-item")).toHaveCount(0);
  // The key took back the page's move onto the answer: Allow once does not take the keyboard by
  // itself any more, and the card says how to get there.
  const allow = list.getByTestId("allow-once");
  await page.waitForTimeout(1500);
  await expect(list).toBeFocused();
  await expect(list.getByTestId("approval-arming")).toHaveText("Down, then Enter allows once");
  await page.keyboard.press("ArrowDown");
  await expect(allow).toBeFocused();
  await expect(allow).toHaveAttribute("data-ready", "true", { timeout: 4000 });
  // On its Allow once, ready: a number with no answer types nothing, gives the keyboard back to the
  // list and starts the settle time again, so the Enter right behind it allows nothing either.
  await page.keyboard.press("7");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  expect((await approvals(request, id))[0]).toMatchObject({ state: "pending" });
  await expect(list).toBeFocused();
  await expect(pane(page, id).getByTestId("composer")).toHaveValue("");
  expect(await said(request, id)).toEqual([]);
  // The owner's own move to the answer, then Enter: allowed.
  await page.keyboard.press("ArrowDown");
  await expect(allow).toHaveAttribute("data-ready", "true", { timeout: 4000 });
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await approvals(request, id))[0]).toMatchObject({ state: "allowed", choice: "once" });
  await drop(request, id);
});

// Three approvals and a question answered by keys at a steady pace (a key every 450 ms, the hand
// never waiting for the page): each card takes a press that went down a key's settle time after it
// was painted (lib/approvals.ts, KEY_MS), so a steady hand loses at most one press on a card. The
// card says when it is ready. Nothing typed lands in a message box.
test("three approvals and a question by keys at a steady pace: each card takes a press soon after it shows", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("steady");
  const quiet = await create(request, "Nothing waits here", ws);
  const a = await asksToRun(request, "Steady: tests", ws, "tests");
  const b = await asksToRun(request, "Steady: notes", ws, "notes");
  const c = await asksToRun(request, "Steady: push", ws, "push");
  const q = await create(request, "Steady: scope", ws);
  await ask(request, q, "question");
  await page.goto(`/s/${quiet}`);
  await expect(page.getByTestId("composer")).toBeFocused();
  for (const id of [a, b, c, q]) await expect(row(page, id)).toHaveAttribute("data-watch", "need");
  let presses = 0;
  const left = async () => (await Promise.all([a, b, c].map(async (id) => (await approvals(request, id))[0]?.state === "pending"))).filter(Boolean).length + ((await waits(request, q, "question")) ? 1 : 0);
  await page.keyboard.press("Alt+a"); presses++;
  for (let i = 0; i < 20 && (await left()) > 0; i++) {
    await page.waitForTimeout(450);
    const onQuestion = await page.evaluate(() => !!document.activeElement?.closest('[data-testid="question"]'));
    await page.keyboard.press(onQuestion ? "1" : "Enter"); presses++;
  }
  await expect.poll(left).toBe(0);
  for (const id of [a, b, c]) expect((await approvals(request, id))[0]).toMatchObject({ state: "allowed", choice: "once" });
  // At most two presses a card, the key that starts the sequence besides.
  expect(presses, "presses for three approvals and a question").toBeLessThanOrEqual(9);
  expect(await said(request, quiet)).toEqual([]);
  await expect(page.getByTestId("composer").first()).toHaveValue("");
  await drop(request, quiet, a, b, c, q);
});

// The answers of an approval card have numbers of their own once the owner put the keyboard on the card
// (Alt A here, or a press on it): 1 Allow once, 2 Always allow, 3 Deny, each drawn on its answer exactly
// while it answers, each under a key's rule (too soon after the card showed, a number does nothing and the
// card says why). A number the card has no answer for types nothing.
test("an approval card's answers have numbers: 1 allows once, 2 opens Always allow, 3 opens the denial", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("approval-digits");
  const id = await asksToRun(request, "Digits: one", ws, "one");
  await page.goto(`/s/${id}`);
  const list = cardIn(page, id, "approval"), card = list.getByTestId("approval");
  const box = page.getByTestId("composer");
  // The card took the keyboard by itself: no numbers. The owner's Alt A puts it there.
  await expect(list).toBeFocused();
  await expect(card.getByTestId("allow-once")).toHaveAttribute("data-ready", "true", { timeout: 5000 });
  await expect(card.getByTestId("approval-digit")).toHaveCount(0);
  await page.keyboard.press("Alt+a");
  // Drawn on the three answers, once they answer.
  await expect.poll(() => numbers(card.getByTestId("approval-digit")), { timeout: 5000 }).toEqual(["1", "2", "3"]);
  // (The numbers are no part of the answers' text or name.)
  await expect(card.getByTestId("allow-once")).toHaveText("Allow once");
  await expect(card.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(1);
  await shoot(page, "answer-keys-21-approval-digits");
  // 3 opens the denial, with the keyboard in its reason field; Escape leaves it.
  await page.keyboard.press("3");
  await expect(card.getByTestId("deny-reason")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(card.getByTestId("allow-once")).toBeFocused();
  // 2 opens Always allow's choices; Escape closes them.
  await expect.poll(() => numbers(card.getByTestId("approval-digit")), { timeout: 5000 }).toEqual(["1", "2", "3"]);
  await page.keyboard.press("2");
  await expect(card.getByTestId("allow-always")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(card.getByTestId("allow-always")).toHaveAttribute("aria-expanded", "false");
  // A number with no answer types nothing, and gives the keyboard back to the list.
  await card.getByTestId("allow-once").focus();
  await page.keyboard.press("7");
  await expect(box).toHaveValue("");
  await expect(list).toBeFocused();
  // From the list, 1 allows its first card once (after a key's settle time from the 7).
  await expect.poll(() => numbers(card.getByTestId("approval-digit")), { timeout: 5000 }).toEqual(["1", "2", "3"]);
  await page.keyboard.press("1");
  await expect.poll(async () => (await approvals(request, id))[0]).toMatchObject({ state: "allowed", choice: "once" });
  await expect(box).toHaveValue("");
  expect(await said(request, id)).toEqual([]);
  // Pressed as the keyboard arrives, a number does nothing (and is typed nowhere).
  const two = await asksToRun(request, "Digits: two", ws, "two");
  await page.goto(`/s/${two}`);
  await expect(cardIn(page, two, "approval")).toBeFocused();
  await page.waitForTimeout(1500);
  await page.keyboard.press("Alt+a");
  await page.waitForFunction(() => document.querySelector('[data-testid="approvals"]')?.getAttribute("data-keys") === "wait", null, { polling: "raf", timeout: 8000 });
  await page.keyboard.press("1");
  await page.waitForTimeout(500);
  expect((await approvals(request, two))[0]).toMatchObject({ state: "pending" });
  await expect(page.getByTestId("composer")).toHaveValue("");
  expect(await said(request, two)).toEqual([]);
  await drop(request, id, two);
});

// A card that took the keyboard by itself from an empty message box has no numbers: 1, 2 and 3 were meant
// for the box (a reply), not for the card. None answers, opens Always allow or opens the denial; each is a
// key typed at a card that holds the keyboard by itself (lib/asks.ts, typeToBox): it types nothing.
test("a number meant for the message box answers nothing on a card that took the keyboard by itself", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("self-taken");
  for (const key of ["1", "2", "3"]) {
    const id = await create(request, `Self-taken: ${key}`, ws);
    await page.goto(`/s/${id}`);
    const box = page.getByTestId("composer");
    await expect(box).toBeFocused();
    await page.waitForTimeout(1000);
    await ask(request, id, "approval", `self${key}`);
    const list = cardIn(page, id, "approval"), card = list.getByTestId("approval");
    await expect(list).toBeFocused();
    await expect(card.getByTestId("allow-once")).toBeFocused({ timeout: 5000 });
    await expect(card.getByTestId("allow-once")).toHaveAttribute("data-ready", "true", { timeout: 5000 });
    // (No numbers are drawn: the owner did not put the keyboard there.)
    await expect(card.getByTestId("approval-digit")).toHaveCount(0);
    await page.keyboard.press(key);
    await page.waitForTimeout(600);
    expect((await approvals(request, id))[0], `${key} meant for the box`).toMatchObject({ state: "pending" });
    await expect(card.getByTestId("allow-always")).toHaveAttribute("aria-expanded", "false");
    await expect(card.getByTestId("deny-reason")).toHaveCount(0);
    await expect(page.locator(".k-tip")).toHaveText("Nothing typed: this request has the keyboard");
    expect(await said(request, id)).toEqual([]);
    await drop(request, id);
  }
});

// A pointer's press on an Allow once that holds the keyboard counts after a key's settle time only where
// the owner's own Tab or arrow put the keyboard. A request that comes under a pointer, whose Allow takes
// the keyboard by itself, waits the second: a click meant for the request before allows nothing.
test("a request that comes under the pointer takes no click within its second, though its Allow has the keyboard", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const two = calls([{ name: "Bash", input: { command: "echo c0 > c0.txt" } }, { name: "Bash", input: { command: "echo c1 > c1.txt" } }]);
  const waiting = async (id: string) => ((await (await request.get(`/api/sessions/${id}/approvals`)).json()).approvals as { summary: string }[]).map((a) => a.summary);
  // The page draws the next request where the last step's result leaves room, not in the place of the one before:
  // a first session of the same two calls says where, and the pointer waits there in the second.
  const first = await create(request, "Where the next lands", folder("click-where"));
  await request.put(`/api/sessions/${first}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await page.goto(`/s/${first}`);
  await request.post(`/api/sessions/${first}/messages`, { data: { text: two } });
  await expect(page.getByTestId("allow-once")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await page.keyboard.press("Enter");
  await expect.poll(() => waiting(first), { timeout: 10_000 }).toEqual([expect.stringContaining("c1")]);
  await expect(page.getByTestId("allow-once")).toHaveAttribute("data-ready", "true", { timeout: 8000 });
  // Where it lands is where it stands once the page has drawn the step: the box is the same for a second.
  const box = async () => (await page.getByTestId("allow-once").boundingBox())!;
  let there = await box();
  await expect.poll(async () => {
    const was = there;
    await page.waitForTimeout(800);
    there = await box();
    return was.x === there.x && was.y === there.y;
  }, { timeout: 20_000 }).toBe(true);
  await drop(request, first);
  const id = await create(request, "Clicks onto the next", folder("click-next"));
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await page.goto(`/s/${id}`);
  await expect(page.getByTestId("composer")).toBeFocused();
  await page.evaluate(() => {
    const w = window as unknown as { seen: { id: string; at: number }[] };
    w.seen = [];
    new MutationObserver(() => {
      for (const c of document.querySelectorAll<HTMLElement>('[data-testid="approval"]')) if (!w.seen.some((x) => x.id === c.dataset.approvalId)) w.seen.push({ id: c.dataset.approvalId!, at: performance.now() });
    }).observe(document.body, { subtree: true, childList: true });
  });
  await request.post(`/api/sessions/${id}/messages`, { data: { text: two } });
  const allow = page.getByTestId("allow-once");
  await expect(allow).toHaveCount(1, { timeout: 30_000 });
  await expect(allow).toHaveAttribute("data-ready", "true", { timeout: 8000 });
  await page.waitForTimeout(1200);
  // The pointer rests where the next request's Allow will be; the first is answered by its key.
  const x = there.x + there.width / 2, y = there.y + there.height / 2;
  await page.mouse.move(x, y);
  await page.keyboard.press("Enter");
  await expect.poll(() => waiting(id), { timeout: 10_000 }).toEqual([expect.stringContaining("c1")]);
  // The next request is drawn under the pointer, and its Allow takes the keyboard by itself.
  const since = await page.waitForFunction(([x, y]: [number, number]) => {
    const b = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-testid="allow-once"]');
    const card = b?.closest<HTMLElement>('[data-testid="approval"]');
    const w = window as unknown as { seen: { id: string; at: number }[] };
    const seen = w.seen.find((s) => s.id === card?.dataset.approvalId);
    return !!b && b === document.activeElement && b.dataset.ready === "true" && w.seen.length === 2 && !!seen && seen === w.seen[1] ? performance.now() - seen.at : 0;
  }, [x, y] as [number, number], { polling: "raf", timeout: 8000 });
  expect(await since.jsonValue(), "the click comes within the next request's second").toBeLessThan(900);
  await page.mouse.click(x, y);
  await page.waitForTimeout(400);
  expect(await waiting(id), "a click within the second of a request that came under the pointer").toEqual([expect.stringContaining("c1")]);
  await expect(allow).toHaveAttribute("data-nudge", "true");
  // Once it stood its second, a click allows it.
  await page.waitForTimeout(1200);
  await page.mouse.click(x, y);
  await expect.poll(() => waiting(id)).toEqual([]);
  expect((await approvals(request, id)).map((a) => a.state)).toEqual(["allowed", "allowed"]);
  await drop(request, id);
});

// A pointer's press on an Allow once the owner's own arrow put the keyboard on is judged by the keyboard's
// times as the press went down: a key's settle time from the card's arrival, and again from a key it
// refused. The press itself makes the hold the owner's, and that fresh hold says nothing of either. Here
// Enter is pressed 260 ms after the card arrived (refused: it runs the settle time again), then Down; a
// click 420 ms after the arrival comes before the keys are ready, and allows nothing. The Allow is not
// drawn live until then.
test("a click on an Allow the owner's arrow reached waits for the keys to be ready, after a key refused", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const id = await create(request, "Keyed gap", folder("keyed-gap"));
  await page.goto(`/s/${id}`);
  await expect(page.getByTestId("composer")).toBeFocused();
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const w = window as unknown as { seen: number };
    w.seen = 0;
    new MutationObserver(() => { if (!w.seen && document.querySelector('[data-testid="allow-once"]')) w.seen = performance.now(); }).observe(document.body, { subtree: true, childList: true });
  });
  const since = (ms: number) => page.waitForFunction((ms) => { const w = window as unknown as { seen: number }; return !!w.seen && performance.now() - w.seen >= ms; }, ms, { polling: "raf", timeout: 10_000 });
  await ask(request, id, "approval", "gap");
  const list = cardIn(page, id, "approval"), allow = list.getByTestId("allow-once");
  await page.waitForFunction(() => !!document.activeElement?.closest('[data-testid="approvals"]'), null, { polling: "raf", timeout: 10_000 });
  const at = (await allow.boundingBox())!;
  await since(260);
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await expect(allow).toBeFocused();
  await since(420);
  const look = await allow.evaluate((b) => ({ disabled: b.getAttribute("aria-disabled"), keys: b.closest('[data-testid="approvals"]')?.getAttribute("data-keys"), t: performance.now() - (window as unknown as { seen: number }).seen }));
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
  await page.waitForTimeout(300);
  // (Only a click that came while the keys still waited proves anything.)
  expect(look.keys, `the keys at ${Math.round(look.t)} ms`).toBe("wait");
  expect((await approvals(request, id))[0], "a click before the keys were ready").toMatchObject({ state: "pending" });
  expect(look.disabled, "drawn live while the keys still wait").toBe("true");
  await expect(allow).toHaveAttribute("data-nudge", "true");
  // Ready, drawn live, a click allows.
  await expect(allow).toHaveAttribute("data-ready", "true", { timeout: 5000 });
  await expect(allow).not.toHaveAttribute("aria-disabled", "true");
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
  await expect.poll(async () => (await approvals(request, id))[0]).toMatchObject({ state: "allowed", choice: "once" });
  await drop(request, id);
});

// The page brings the keyboard onto Allow once by itself: from when the card says Enter allows it (its keys
// are ready) to when a pointer's press counts (it stood its second), it is drawn whole, as the key it
// answers, not dimmed as if nothing worked. A press meanwhile is refused and says why; a press after counts.
test("an Allow once ready for Enter is drawn whole while a press does not count yet, and says so when pressed", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const id = await create(request, "Ready look", folder("ready-look"));
  await page.goto(`/s/${id}`);
  await expect(page.getByTestId("composer")).toBeFocused();
  await page.waitForTimeout(800);
  await ask(request, id, "approval", "look");
  const list = cardIn(page, id, "approval"), allow = list.getByTestId("allow-once");
  await expect(allow).toBeFocused({ timeout: 8000 });
  await expect(allow).toHaveAttribute("data-ready", "true", { timeout: 5000 });
  const look = await allow.evaluate((b) => ({ disabled: b.getAttribute("aria-disabled"), opacity: getComputedStyle(b).opacity, cursor: getComputedStyle(b).cursor }));
  const at = (await allow.boundingBox())!;
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
  // (Only a look taken while a press did not count yet proves anything.)
  expect(look.disabled, "a press counted already").toBe("true");
  expect(look, "ready for Enter, a press not yet").toEqual({ disabled: "true", opacity: "1", cursor: "default" });
  await expect(allow).toHaveAttribute("data-nudge", "true");
  expect((await approvals(request, id))[0], "a press before it stood its second").toMatchObject({ state: "pending" });
  await expect(allow).not.toHaveAttribute("aria-disabled", "true", { timeout: 5000 });
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
  await expect.poll(async () => (await approvals(request, id))[0]).toMatchObject({ state: "allowed", choice: "once" });
  await drop(request, id);
});

// A plan brought the keyboard as a thing to answer, but not whole in view when its keys are ready (a short
// window): Approve takes the keyboard once the plan stands whole, not never. The arrival is not used up
// while the plan does not fit.
test("a plan that does not fit as its keys are ready gets Approve the keyboard once it fits", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const id = await create(request, "Plan fit", folder("plan-fit"));
  await page.goto(`/s/${id}`);
  await ask(request, id, "plan", "p");
  const plan = cardIn(page, id, "plan"), approve = plan.getByTestId("plan-approve");
  await expect(approve).toBeFocused({ timeout: 8000 });
  await page.keyboard.press("ArrowUp");
  await expect(plan.getByTestId("plan-text")).toBeFocused();
  // A short window: the plan no longer stands whole. The owner's key to what waits is a new arrival.
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: size.width, height: 360 });
  await page.waitForTimeout(300);
  await page.keyboard.press("Alt+a");
  await expect(plan).toHaveAttribute("data-keys", "ready");
  await page.waitForTimeout(600);
  await expect(plan.getByTestId("plan-text")).toBeFocused();
  await page.setViewportSize(size);
  await expect(approve).toBeFocused({ timeout: 4000 });
  await expect(approve).toHaveAttribute("data-ready", "true", { timeout: 4000 });
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await (await request.get(`/api/sessions/${id}/plan`)).json()).open.length).toBe(0);
  await drop(request, id);
});

// End pressed at once after Enter opened a long command reads it to its end. The opened view may not have
// been read after a paint yet when End comes: a step then would carry its lines out of view unread, and
// End would stop short ("7 lines not seen yet"). The step waits for that view to count. Six times each
// with End in the frame of the Enter and a frame after it (the race showed about once in five).
test("End at once after Enter opened a long command reads it to its end, every time", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  test.setTimeout(120_000);
  const ws = folder("end-at-once");
  const left: string[] = [];
  for (const gap of [0, 16]) for (let i = 0; i < 6; i++) {
    const id = await create(request, `End ${gap} ms after Enter, ${i + 1}`, ws);
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
    await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([{ name: "Bash", input: { command: LONG } }]) } });
    await expect.poll(async () => (await approvals(request, id)).length, { timeout: 30_000 }).toBe(1);
    await page.goto(`/s/${id}`);
    const list = cardIn(page, id, "approval"), card = list.getByTestId("approval");
    await expect(list).toBeFocused();
    await expect(list).toHaveAttribute("data-keys", "ready");
    await page.keyboard.press("Enter");
    if (gap) await page.waitForTimeout(gap);
    await page.keyboard.press("End");
    let n = -1;
    await expect.poll(async () => (n = Number(await card.getAttribute("data-unseen"))), { timeout: 5000 }).toBe(0).catch(() => {});
    if (n !== 0) left.push(`${gap} ms, run ${i + 1}: ${n} lines not seen`);
    await drop(request, id);
  }
  expect(left, "End stopped short of the end").toEqual([]);
});

// A key is judged by when it went down, not by when the page handled it. A key that went down while the
// keyboard was arriving, and that a busy page handles only once the card says it is ready, was pressed
// before the card stood there: it answers nothing. (The key is sent stamped with the time it went down,
// as the system stamps one; the page takes it later.)
test("a key that went down as the keyboard arrived answers nothing, however late the page handles it", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const id = await asksToRun(request, "Busy page", folder("busy-page"), "busy");
  const cdp = await page.context().newCDPSession(page);
  await page.goto(`/s/${id}`);
  const list = cardIn(page, id, "approval");
  await expect(list).toBeFocused();
  await page.waitForTimeout(1500);
  // When the list's keys last began to wait (the page's own clock, the one a key is stamped by).
  await page.evaluate(() => {
    const w = window as unknown as { waitFrom: number };
    new MutationObserver(() => { if (document.querySelector('[data-testid="approvals"]')?.getAttribute("data-keys") === "wait") w.waitFrom = Date.now(); })
      .observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-keys"] });
  });
  const keys = { "1": { key: "1", code: "Digit1", text: "1", windowsVirtualKeyCode: 49 }, Enter: { key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 } };
  for (const key of ["1", "Enter"] as const) {
    await page.keyboard.press("Alt+a");
    await expect(list).toHaveAttribute("data-keys", "wait");
    if (key === "Enter") { await page.keyboard.press("ArrowDown"); await expect(list.getByTestId("allow-once")).toBeFocused(); }
    await expect(list).toHaveAttribute("data-keys", "ready");
    // Down 100 ms into the wait, taken now.
    const at = (await page.evaluate(() => (window as unknown as { waitFrom: number }).waitFrom)) + 100;
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...keys[key], timestamp: at / 1000 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: keys[key].key, code: keys[key].code, windowsVirtualKeyCode: keys[key].windowsVirtualKeyCode, timestamp: at / 1000 + 0.05 });
    await page.waitForTimeout(400);
    expect((await approvals(request, id))[0], `${key} that went down as the keyboard arrived`).toMatchObject({ state: "pending" });
    await page.waitForTimeout(1200);
  }
  // Pressed once the card says it is ready, it allows.
  await page.keyboard.press("Alt+a");
  await expect.poll(() => numbers(list.getByTestId("approval-digit")), { timeout: 5000 }).toEqual(["1", "2", "3"]);
  await page.keyboard.press("1");
  await expect.poll(async () => (await approvals(request, id))[0]).toMatchObject({ state: "allowed", choice: "once" });
  expect(await said(request, id)).toEqual([]);
  await drop(request, id);
});

// After the sequence moves from an approval to a question, numbers pressed at a steady pace are the
// question's: the first ones, too soon after it showed, do nothing (they never go to the message box),
// and the next one answers it. No "1" is ever typed or sent.
test("numbers pressed as the sequence moves from an approval to a question answer it, and none is typed", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("to-question");
  const quiet = await create(request, "Nothing waits here", ws);
  const a = await asksToRun(request, "First: an approval", ws, "first");
  const q = await create(request, "Then: a question", ws);
  await ask(request, q, "question");
  await page.goto(`/s/${quiet}`);
  await expect(page.getByTestId("composer")).toBeFocused();
  await page.keyboard.press("Alt+a");
  await expect(cardIn(page, a, "approval").getByTestId("allow-once")).toHaveAttribute("data-ready", "true", { timeout: 8000 });
  await page.keyboard.press("Enter");
  // Numbers every 400 ms from the answer on, ten of them at most. (Faster, each is refused: a press
  // sooner than a key's settle time after one refused is part of the same run, lib/asks.ts.)
  for (let i = 0; i < 10 && (await waits(request, q, "question")); i++) { await page.keyboard.press("1"); await page.waitForTimeout(400); }
  await expect.poll(() => waits(request, q, "question")).toBe(false);
  expect(await answersOf(request, q)).toEqual({ "0": { picked: ["Teal"] } });
  for (const box of await page.getByTestId("composer").all()) await expect(box).toHaveValue("");
  for (const id of [quiet, a, q]) expect(await said(request, id)).toEqual([]);
  for (const id of [quiet, a, q]) expect((await (await request.get(`/api/sessions/${id}/queue`)).json()).queue, `queued in ${id}`).toEqual([]);
  await drop(request, quiet, a, q);
});
