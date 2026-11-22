import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the daily paths by keyboard. Each test names the path it holds.
const MODEL = "scripted:stand-in";
// Every pane on screen: no focus mode (the config's default for the other specs).
test.use({ storageState: { cookies: [], origins: [] } });

async function scripted(request: APIRequestContext) {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === MODEL), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
}
const folder = (name: string) => {
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `${name}-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  return ws;
};
const create = async (request: APIRequestContext, title: string, workspace?: string) =>
  (await (await request.post("/api/sessions", { data: { model: MODEL, title, ...(workspace && { workspace }) } })).json()).session.id as string;
const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;

test("the palette shows only rows of the query that is typed", async ({ page, request }) => {
  await scripted(request);
  const ws = folder("palette");
  const word = `stale${Date.now()}`;
  const id = await create(request, "Check the types", ws);
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  // A command and its output: two hits in one event, on one call.
  await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([{ name: "Bash", input: { command: `echo ${word}` } }]) } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${id}`)).json()).events.some((e: any) => e.kind === "turn_end"), { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await (await request.get(`/api/search?q=${word}&limit=12`)).json()).hits.filter((h: any) => h.kind.startsWith("tool_")).length).toBe(2);

  await page.goto(`/s/${id}`);
  await page.keyboard.press("Control+k");
  const input = page.getByTestId("palette-input");
  const rows = page.getByTestId("palette").getByRole("option");
  await input.fill(word);
  await expect(rows.filter({ hasText: "Command" }).first()).toContainText(word);
  await expect(rows.filter({ hasText: "Tool output" }).first()).toContainText(word);
  await shoot(page, "keyboard-paths-04-palette-query");

  // Another query: no row of the first one is left, and one row is the highlighted one.
  for (const next of ["settings", "theme", "zzqq-nothing"]) {
    await input.fill(next);
    await expect(page.getByTestId("palette-searching")).toHaveCount(0);
    await expect(rows.filter({ hasText: word })).toHaveCount(0);
    expect(await page.getByTestId("palette").locator('[role="option"][aria-selected="true"]').count()).toBeLessThanOrEqual(1);
  }
  await expect(page.getByTestId("palette")).toContainText('Nothing matches "zzqq-nothing".');
  await input.fill("theme");
  await expect(rows.first()).toContainText("Theme");
  await shoot(page, "keyboard-paths-05-palette-next-query");
  await page.keyboard.press("Escape");
  await request.delete(`/api/sessions/${id}`);
});

test("End, Page Up and Page Down scroll the conversation from an empty message box", async ({ page, request }) => {
  await scripted(request);
  const id = await create(request, "A long conversation", folder("scroll"));
  await request.post(`/api/sessions/${id}/messages`, { data: { text: "script:fill" } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${id}`)).json()).events.some((e: any) => e.kind === "turn_end"), { timeout: 30_000 }).toBe(true);
  await page.goto(`/s/${id}`);
  const box = page.getByTestId("composer");
  await expect(box).toBeFocused();
  const at = () => page.evaluate(() => { const t = document.querySelector<HTMLElement>(".k-reading")!; return { top: Math.round(t.scrollTop), max: Math.round(t.scrollHeight - t.clientHeight), page: t.clientHeight }; });
  await expect.poll(async () => (await at()).max).toBeGreaterThan(2000);
  await expect.poll(async () => { const s = await at(); return s.max - s.top; }).toBeLessThan(4);

  // Up a page, twice; the caret stays in the box.
  await page.keyboard.press("PageUp");
  await expect.poll(async () => { const s = await at(); return s.max - s.top; }).toBeGreaterThan(400);
  const one = await at();
  await page.keyboard.press("PageUp");
  await expect.poll(async () => (await at()).top).toBeLessThan(one.top - 400);
  const two = await at();
  await expect(box).toBeFocused();
  await shoot(page, "keyboard-paths-06-paged-up");
  // Down a page, then End: at the bottom, following again.
  await page.keyboard.press("PageDown");
  await expect.poll(async () => (await at()).top).toBeGreaterThan(two.top + 400);
  await page.keyboard.press("PageUp");
  await page.keyboard.press("PageUp");
  await page.keyboard.press("End");
  await expect.poll(async () => { const s = await at(); return s.max - s.top; }).toBeLessThan(4);
  await expect(box).toBeFocused();

  // With a draft in the box the keys are the box's own: the conversation stays where it is.
  await page.keyboard.press("PageUp");
  await expect.poll(async () => { const s = await at(); return s.max - s.top; }).toBeGreaterThan(400);
  await box.fill("a draft\nof two lines");
  await page.waitForTimeout(500); // the glide ends, and the box has its two lines
  const held = await at();
  await page.keyboard.press("End");
  await page.keyboard.press("PageDown");
  await page.waitForTimeout(500);
  expect(Math.abs((await at()).top - held.top)).toBeLessThan(4);
  await box.fill("");
  // The sheet names the paging keys beside End.
  await page.keyboard.press("Control+/");
  await expect(page.getByTestId("shortcuts").locator("div").filter({ hasText: /^Conversation up a page, from an empty boxPgUp$/ })).toBeVisible();
  await expect(page.getByTestId("shortcuts").locator("div").filter({ hasText: /^Conversation down a page, from an empty boxPgDn$/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await request.delete(`/api/sessions/${id}`);
});

test("a new session starts in the folder of the session being worked in", async ({ page, request }) => {
  await scripted(request);
  const one = folder("ws-one"), two = folder("ws-two");
  const a = await create(request, "Works in the first folder", one);
  const b = await create(request, "Works in the second folder", two); // the folder used last
  const name = (ws: string) => ws.split("/").pop()!;
  const picker = page.getByTestId("workspace-picker");

  // From a session in the first folder, the key: the start box is on that folder, not on the one used last.
  await page.goto(`/s/${a}`);
  await expect(page.getByTestId("composer")).toBeFocused();
  await page.keyboard.press("Control+Shift+O");
  await expect(page).toHaveURL(/\/$/);
  await expect(picker).toContainText(name(one));
  await expect(page.getByTestId("composer")).toBeFocused();
  await shoot(page, "keyboard-paths-07-new-in-folder");
  // The session made there is in it.
  await page.getByTestId("composer").fill("script:quiet");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/s\//);
  const made = page.url().split("/s/")[1]!;
  expect((await (await request.get(`/api/sessions/${made}`)).json()).session.workspace).toBe(one);

  // The list's button does the same from a session in the second folder.
  await page.goto(`/s/${b}`);
  await page.getByTestId("new-session").click();
  await expect(picker).toContainText(name(two));
  // From the start page itself the folder stays the one chosen.
  await page.keyboard.press("Control+Shift+O");
  await expect(picker).toContainText(name(two));

  for (const id of [a, b, made]) { await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }); await request.delete(`/api/sessions/${id}`); }
});

test("Esc is in the shortcut sheet and a session row is one Tab stop", async ({ page, request }) => {
  await scripted(request);
  const ws = folder("rows");
  const ids: string[] = [];
  for (const n of ["one", "two", "three"]) ids.push(await create(request, `Row ${n}`, ws));
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.addInitScript(() => localStorage.setItem("keel.focus", "true")); // one pane: the list is open beside it
  await page.goto(`/s/${ids[1]}`);
  await expect(page.getByTestId("composer")).toBeFocused();

  // The sheet is a reference: Esc stops a turn, listed also while none runs.
  await page.keyboard.press("Control+/");
  const sheet = page.getByTestId("shortcuts");
  await expect(sheet.locator("div").filter({ hasText: /^Stop the turnEsc$/ })).toBeVisible();
  await expect(sheet.locator("div").filter({ hasText: /^Focus the session listAltL$/ })).toBeVisible();
  await shoot(page, "keyboard-paths-08-sheet-esc");
  await page.keyboard.press("Escape");

  // One key from the box to the list: the row of the session on screen.
  const rows = page.getByTestId("session-list").locator('[data-testid="session-row"]');
  const row = (id: string) => page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`);
  await page.keyboard.press("Alt+l");
  await expect(row(ids[1]!)).toBeFocused();
  // Tab leaves the row for the next one: its own buttons are not stops.
  const order = await rows.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.session));
  const at = order.indexOf(ids[1]);
  await page.keyboard.press("Tab");
  await expect(row(order[at + 1]!)).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(row(ids[1]!)).toBeFocused();
  // Right reaches a row's actions, Left comes back; Up and Down move by rows from either.
  const next = row(order[at + 1]!); // not on screen: it can open beside
  await page.keyboard.press("ArrowDown");
  await expect(next).toBeFocused();
  for (const act of ["row-pin", "row-beside", "row-archive"]) {
    await page.keyboard.press("ArrowRight");
    await expect(next.getByTestId(act)).toBeFocused();
  }
  await shoot(page, "keyboard-paths-09-row-actions");
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
  await expect(next).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowUp");
  await expect(row(ids[1]!)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  // Enter opens it, and Shift Esc is back in the message box.
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/s/${order[at + 1]}$`));
  await page.keyboard.press("Shift+Escape");
  await expect(page.getByTestId("composer")).toBeFocused();

  // With a second pane a row has one more action (place it in a pane): still one Tab stop, and Right reaches all four.
  await page.getByTestId("panes-2").click();
  const off = page.getByTestId("session-list").locator('[data-testid="session-row"]:not([data-shown])').first();
  await off.focus();
  for (const act of ["row-pin", "row-beside", "row-place", "row-archive"]) {
    await page.keyboard.press("ArrowRight");
    await expect(off.getByTestId(act)).toBeFocused();
  }
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowLeft");
  await expect(off).toBeFocused();
  await page.keyboard.press("Tab");
  expect(await off.evaluate((el) => el.contains(document.activeElement))).toBe(false);

  for (const id of ids) await request.delete(`/api/sessions/${id}`);
});

const pane = (page: Page, id: string) => page.locator(`section.k-station[data-station="${id}"]`);
// Where the keyboard is: the test id of the focused element and the pane it is in.
const keysAt = (page: Page) => page.evaluate(() => {
  const a = document.activeElement as HTMLElement | null;
  return { testid: a?.dataset.testid ?? a?.tagName ?? "", pane: a?.closest<HTMLElement>("[data-station]")?.dataset.station ?? "" };
});

test("the caret moves with the pane the keys move to", async ({ page, request }) => {
  await scripted(request);
  const ws = folder("panes");
  const ids: string[] = [];
  for (const n of ["A", "B", "C", "D"]) ids.push(await create(request, `Caret pane ${n}`, ws));
  await page.addInitScript((slots) => localStorage.setItem("keel.panes", JSON.stringify({ count: 4, slots, sizes: {}, active: 0 })), ids);
  await page.goto(`/s/${ids[0]}`);
  for (const id of ids) await expect(pane(page, id)).toBeVisible();
  await expect(pane(page, ids[0]!).getByTestId("composer")).toBeFocused();

  // Next pane: the highlight and the caret go together, so what is typed lands where the eye is.
  await page.keyboard.press("Alt+]");
  await expect(pane(page, ids[1]!)).toHaveAttribute("data-helm", "true");
  await expect(pane(page, ids[1]!).getByTestId("composer")).toBeFocused();
  await page.keyboard.type("for pane B");
  await expect(pane(page, ids[1]!).getByTestId("composer")).toHaveValue("for pane B");
  await expect(pane(page, ids[0]!).getByTestId("composer")).toHaveValue("");
  await shoot(page, "keyboard-paths-01-next-pane");

  // Twice on, and once back: the caret is in the pane that is the helm each time.
  await page.keyboard.press("Alt+]");
  await page.keyboard.press("Alt+]");
  await expect(pane(page, ids[3]!).getByTestId("composer")).toBeFocused();
  await page.keyboard.press("Alt+[");
  await expect(pane(page, ids[2]!)).toHaveAttribute("data-helm", "true");
  await page.keyboard.type("for pane C");
  await expect(pane(page, ids[2]!).getByTestId("composer")).toHaveValue("for pane C");
  expect(await keysAt(page)).toEqual({ testid: "composer", pane: ids[2] });

  for (const id of ids) await request.delete(`/api/sessions/${id}`);
});

// Stops every turn an earlier test left open: what waits on the owner is read across the daemon's sessions.
async function settle(request: APIRequestContext) {
  const { sessions } = (await (await request.get("/api/sessions")).json()) as { sessions: { id: string; phase: string }[] };
  for (const s of sessions) if (s.phase === "working") await request.post(`/api/sessions/${s.id}/interrupt`, { data: { by: "owner" } });
}
const question = { name: "AskUserQuestion", input: { questions: [{ header: "Color", question: "Which color should I use?", options: [{ label: "Teal" }, { label: "Amber" }], multiSelect: false }] } };

test("a key and the palette reach what waits on the owner, the inbox and the errors", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("waits");
  const quiet = await create(request, "Nothing waits here", ws);
  // Two sessions wait: one on an approval, then one on a question (the longer wait comes first).
  const asks = await create(request, "Waits on an approval", ws);
  await request.put(`/api/sessions/${asks}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await request.post(`/api/sessions/${asks}/messages`, { data: { text: calls([{ name: "Bash", input: { command: "echo waits > waits.txt" } }]) } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${asks}/approvals`)).json()).approvals.length).toBe(1);
  const picks = await create(request, "Waits on a question", ws);
  await request.post(`/api/sessions/${picks}/messages`, { data: { text: calls([question]) } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${picks}/questions`)).json()).pending.length).toBe(1);

  await page.goto(`/s/${quiet}`);
  await expect(page.getByTestId("composer")).toBeFocused();
  const row = (id: string) => page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`);
  await expect(row(asks)).toHaveAttribute("data-watch", "need");
  await expect(row(picks)).toHaveAttribute("data-watch", "need");

  // The key, from a session where nothing waits: the one that has waited longest, its approval under the keys.
  await page.keyboard.press("Alt+a");
  await expect(page).toHaveURL(new RegExp(`/s/${asks}$`));
  // (The keyboard comes to the card, and to its Allow once it has been there for the settle time.)
  await expect(page.getByTestId("allow-once")).toBeFocused();
  await shoot(page, "keyboard-paths-02-next-waiting");
  // Again, from the card: the next one, and around.
  await page.keyboard.press("Alt+a");
  await expect(page).toHaveURL(new RegExp(`/s/${picks}$`));
  await expect(page.getByTestId("composer-asks").getByTestId("question")).toBeFocused();
  await page.keyboard.press("Alt+a");
  await expect(page).toHaveURL(new RegExp(`/s/${asks}$`));

  // The palette has the three by name.
  const palette = page.getByTestId("palette");
  const pick = async (words: string, label: string) => {
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill(words);
    await expect(palette.getByRole("option").first()).toContainText(label);
    await page.keyboard.press("Enter");
    await expect(palette).toHaveCount(0);
  };
  await page.goto(`/s/${quiet}`);
  await pick("needs you", "Go to the next session that needs you");
  await expect(page).toHaveURL(new RegExp(`/s/${asks}$`));
  await pick("inbox", "Open the inbox");
  await expect(page.getByTestId("inbox-list")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("inbox-list")).toHaveCount(0);
  await pick("errors", "Show recorded errors");
  await expect(page.getByTestId("errors-panel")).toBeVisible();
  await page.keyboard.press("Escape");

  // Their keys open them too, and the shortcut sheet lists all three.
  await page.keyboard.press("Alt+b");
  await expect(page.getByTestId("inbox-list")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Alt+r");
  await expect(page.getByTestId("errors-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+/");
  const sheet = page.getByTestId("shortcuts");
  for (const [label, key] of [["Go to the next session that needs you", "A"], ["Open the inbox", "B"], ["Show recorded errors", "R"]] as const) {
    const line = sheet.locator("div").filter({ hasText: new RegExp(`^${label}Alt${key}$`) });
    await expect(line).toBeVisible();
  }
  await shoot(page, "keyboard-paths-03-sheet");
  await page.keyboard.press("Escape");

  // With nothing left waiting the key says so and stays.
  await request.post(`/api/sessions/${asks}/interrupt`, { data: { by: "owner" } });
  await request.post(`/api/sessions/${picks}/interrupt`, { data: { by: "owner" } });
  await expect(row(asks)).not.toHaveAttribute("data-watch", "need");
  await expect(row(picks)).not.toHaveAttribute("data-watch", "need");
  await page.goto(`/s/${quiet}`);
  await page.keyboard.press("Alt+a");
  await expect(page.locator(".k-tip")).toHaveText("Nothing waits for you.");
  await expect(page).toHaveURL(new RegExp(`/s/${quiet}$`));

  for (const id of [quiet, asks, picks]) await request.delete(`/api/sessions/${id}`);
});
