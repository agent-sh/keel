import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "./isolate.ts";
import { shoot } from "./shots.ts";

const MODEL = "scripted:stand-in";

// Feature: several sessions in the list are marked and acted on at once. Ctrl click marks a row, Shift click
// marks the rows from the last marked one, Space marks the focused row, a long press does on a phone; the list
// foot shows how many are marked and offers Archive N (with Undo), Pin, Mark read, Stop and Send to all. Three
// sessions, one of them at work: two are marked, the working one is named, Archive takes both and Undo brings both
// back, Escape lets go, and a message to all is queued in each of the two and in not the third.
test("rows are marked together and archived, stopped or sent one message at once", async ({ page, request, browser, baseURL }) => {
  test.setTimeout(120_000);
  test.skip(!(await (await request.get("/api/models")).json()).models.some((m: any) => m.id === MODEL), "requires the scripted provider");
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `select-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const gate = join(ws, "go");
  const make = async (title: string) => {
    const { session } = await (await request.post("/api/sessions", { data: { model: MODEL, title, workspace: ws } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
    return session.id as string;
  };
  const working = await make("Select working"), calm1 = await make("Select calm one"), calm2 = await make("Select calm two");
  await request.post(`/api/sessions/${working}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: `until [ -f ${gate} ]; do sleep 0.2; done`, timeout: 120_000 } }])}` } });
  for (const id of [calm1, calm2]) { await request.post(`/api/sessions/${id}/messages`, { data: { text: "One line." } }); }
  const idle = (id: string) => expect.poll(async () => { const d = await (await request.get(`/api/sessions/${id}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; }, { timeout: 60_000 }).toBe(true);
  for (const id of [calm1, calm2]) await idle(id);
  await expect.poll(async () => (await (await request.get(`/api/sessions/${working}`)).json()).running).toBe(true);

  const list = (p: Page) => p.getByTestId("session-list");
  const row = (p: Page, id: string) => list(p).locator(`[data-testid="session-row"][data-session="${id}"]`);
  const archived = async (id: string) => (await (await request.get(`/api/sessions/${id}`)).json()).session.archived;
  await page.goto("/");
  for (const id of [working, calm1, calm2]) await expect(row(page, id)).toBeVisible();
  await shoot(page, "select-00-list");

  // The rows in the order the list draws them; the one left out is a calm one, the middle one when it is calm.
  const order = (await list(page).locator('[data-testid="session-row"]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.session!))).filter((id) => [working, calm1, calm2].includes(id));
  const other = order[1] !== working ? order[1]! : order.find((id) => id !== working)!;
  const marked = [working, calm1, calm2].filter((id) => id !== other);
  await row(page, order[0]!).click({ modifiers: ["Control"] });
  await expect(page.getByTestId("sel-count")).toHaveText("1 selected");
  await row(page, order[2]!).click({ modifiers: ["Shift"] });
  await expect(page.getByTestId("sel-count")).toHaveText(/^[23] selected$/);
  if (await row(page, other).getAttribute("data-selected") !== null) await row(page, other).click({ modifiers: ["Control"] });
  // Two are marked, the list did not move and no session opened; the working one is named; the third is not marked.
  await expect(page.getByTestId("sel-count")).toHaveText("2 selected");
  await expect(page.getByTestId("sel-archive")).toHaveText("Archive 2");
  await expect(page.getByTestId("sel-working")).toContainText("Select working");
  for (const id of marked) await expect(row(page, id)).toHaveAttribute("data-selected", "true");
  await expect(row(page, other)).not.toHaveAttribute("data-selected", "true");
  await expect(page).toHaveURL(/\/$/);
  expect(await list(page).locator('[data-testid="session-row"]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.session!)).then((l) => l.filter((id) => [working, calm1, calm2].includes(id)))).toEqual(order);
  await shoot(page, "select-01-two-marked");

  // Archive 2 takes both, not the third; Undo brings both back.
  await page.getByTestId("sel-archive").click();
  // The working one still runs a command: one question names it, and archiving stops it only once the owner says so.
  const ask = page.getByRole("alertdialog", { name: "Stop their background commands?" });
  await expect(ask).toContainText("Select working");
  await ask.getByRole("button", { name: "Stop and archive" }).click();
  for (const id of marked) await expect.poll(() => archived(id)).toBe(true);
  expect(await archived(other)).toBeFalsy();
  await expect(page.getByTestId("sel-bar")).toBeHidden();
  await expect(page.getByTestId("undo-words")).toHaveText("Archived 2 sessions");
  await shoot(page, "select-02-archived");
  await page.getByTestId("undo").click();
  for (const id of marked) await expect.poll(() => archived(id)).toBeFalsy();
  for (const id of marked) await expect(row(page, id)).toBeVisible();

  // Space marks a focused row, and Escape lets go of all of them.
  const space = async (id: string) => { await row(page, id).focus(); await page.keyboard.press("Space"); };
  for (const id of marked) await space(id);
  await expect(page.getByTestId("sel-count")).toHaveText("2 selected");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sel-bar")).toBeHidden();
  await expect(row(page, marked[0]!)).not.toHaveAttribute("data-selected", "true");
  // With a session open too: its message box keeps the closed + popup in the page, and Escape still lets go.
  await page.goto(`/s/${calm1}`);
  await page.getByTestId("composer").first().waitFor();
  await space(marked[0]!);
  await expect(page.getByTestId("sel-count")).toHaveText("1 selected");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sel-bar")).toBeHidden();
  await page.goto("/");
  for (const id of marked) await expect(row(page, id)).toBeVisible();

  // Send to all: one message queued in each marked session, shown with its count and words before it goes.
  for (const id of marked) await space(id);
  await page.getByTestId("sel-send").click();
  const words = `Please report back ${Date.now().toString(36)}`;
  await page.getByTestId("sel-field").fill(words);
  await expect(page.getByTestId("sel-send-go")).toHaveText("Send to 2");
  await expect(page.getByTestId("sel-preview")).toHaveText(`Queued in each of 2: “${words}”`);
  await shoot(page, "select-03-send");
  // (A shot at another size lays the list out again, which closes the field: open it and write again.)
  if (!(await page.getByTestId("sel-field").isVisible())) { await page.getByTestId("sel-send").click(); await page.getByTestId("sel-field").fill(words); }
  await page.keyboard.press("Enter");
  const got = async (id: string) => { const d = await (await request.get(`/api/sessions/${id}`)).json(); return d.queue.some((q: any) => JSON.stringify(q).includes(words)) || d.events.some((e: any) => e.kind === "user" && JSON.stringify(e.data).includes(words)); };
  for (const id of marked) await expect.poll(() => got(id)).toBe(true);
  expect(await got(other)).toBe(false);
  await expect(page.getByTestId("sel-bar")).toBeHidden();

  // Stop takes the working one only (it works again for this).
  const gate2 = join(ws, "go-again");
  await request.post(`/api/sessions/${working}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: `until [ -f ${gate2} ]; do sleep 0.2; done`, timeout: 120_000 } }])}` } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${working}`)).json()).running).toBe(true);
  await space(working);
  await page.getByTestId("sel-stop").click();
  await expect.poll(async () => (await (await request.get(`/api/sessions/${working}`)).json()).running, { timeout: 30_000 }).toBe(false);
  await expect(page.getByTestId("sel-bar")).toBeHidden();
  writeFileSync(gate, "");
  writeFileSync(gate2, "");

  // A phone: a long press marks the row (the touch screen has no Ctrl), and the bar stands at the list's foot.
  const ctx = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await ctx.newPage();
  await phone.goto("/");
  await phone.getByTestId("show-sidebar").tap();
  await expect(phone.getByTestId("sidebar")).toBeInViewport();
  const target = row(phone, other);
  await expect(target).toBeVisible();
  const box = (await target.boundingBox())!;
  const at = { x: box.x + 60, y: box.y + box.height / 2 };
  const cdp = await ctx.newCDPSession(phone);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
  await phone.waitForTimeout(800);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(phone.getByTestId("sel-count")).toHaveText("1 selected");
  await expect(target).toHaveAttribute("data-selected", "true");
  await expect(phone).toHaveURL(/\/$/);
  await expect(phone.getByTestId("sel-archive")).toBeInViewport();
  await shoot(phone, "select-04-phone");
  await ctx.close();
});
