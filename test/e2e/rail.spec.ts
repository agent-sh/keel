import { expect, test } from "./isolate.ts";
import { shoot, setPanes, WORKBENCH } from "./shots.ts";

// Feature: the rail always says which session is which. With room it is the
// list (title, state, time, by folder), with one pane, two or three open at
// this width. With less room beside the panes it is still a list of titles,
// one line a session. It folds to marks only by choice (the toggle or Ctrl B,
// remembered) or when the panes leave no room for a title (three in a narrow window); a
// mark is the state's shape and a short code of the title, no two alike, and
// the card beside the entry under the pointer or the focus gives the title,
// the state, the folder and the last activity. Without room the toggle lays
// the list over the panes until a session is picked. A failed session is
// marked failed on a fresh page, before any of its events are loaded (the
// daemon keeps the mark). The pane head shows the whole title in the text
// face.
const MODEL = "scripted:stand-in";
test.use({ storageState: WORKBENCH, viewport: { width: 1700, height: 980 } });

test("the list with room, marks without, the card and the toggle", async ({ page, request }) => {
  const tag = Date.now().toString(36);
  const mk = async (title: string, text: string) => {
    const s = (await (await request.post("/api/sessions", { data: { model: MODEL, title } })).json()).session;
    await request.post(`/api/sessions/${s.id}/messages`, { data: { text } });
    await expect.poll(async () => (await (await request.get(`/api/sessions/${s.id}`)).json()).events.some((e: any) => e.kind === "turn_end" || e.kind === "error"), { timeout: 30_000 }).toBe(true);
    return s.id as string;
  };
  const failed = await mk(`Charge the card on file ${tag}`, "Charge it. script:billing");
  const twin = await mk(`Check the cache headers on the asset host ${tag}`, "Check them.");
  const done = await mk(`Why the nightly export job times out on large tenants and what to change in the batch size ${tag}`, "Look into it.");
  await expect.poll(async () => (await (await request.get(`/api/sessions/${failed}`)).json()).session.settings.failed_ms).toBeGreaterThan(0);
  const folder = (await (await request.get(`/api/sessions/${done}`)).json()).session.workspace.split("/").pop() as string;

  const side = page.getByTestId("sidebar");
  const rail = page.getByTestId("session-list");
  const entry = (id: string) => rail.locator(`[data-testid="session-row"][data-session="${id}"]`);
  const card = page.getByTestId("rail-card");
  const stations = page.locator("section.k-station[data-station]");
  const stored = (k: string) => page.evaluate((k) => localStorage.getItem(k), k);
  // Writes a stored choice and reloads in one step, so the page cannot write its own value back in between.
  const reloadWith = async (k: string, v: string) => {
    await Promise.all([page.waitForEvent("load"), page.evaluate(([k, v]) => { localStorage.setItem(k!, v!); location.reload(); }, [k, v]).catch(() => {})]);
  };

  // One station (the helm at full width): the list, nothing chosen yet.
  await page.addInitScript(() => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem("keel.focus", "true"); sessionStorage.setItem("seeded", "1"); } });
  await page.goto(`/s/${done}`);
  await expect(stations).toHaveCount(1);
  await expect(side).toHaveAttribute("data-open", "true");
  await expect(entry(done).locator(".k-row-title")).toBeVisible();
  await expect(entry(done)).toContainText(`batch size ${tag}`);
  await expect(entry(done)).toHaveAttribute("data-watch", "done");
  await expect(entry(failed)).toHaveAttribute("data-watch", "fail");
  await expect(entry(failed).getByTestId("row-state")).toHaveText("Failed");
  await expect(page.getByTestId("rail-toggle")).toHaveAttribute("aria-expanded", "true");
  await shoot(page, "rail-01-one-station-list");

  // A row is one line: its mark, its title, its time. The card beside it says the rest: the state
  // in a word, the title whole, the failure in full, the folder, the model, the last activity.
  await entry(failed).hover();
  await expect(card).toHaveAttribute("data-watch", "fail");
  await expect(card).not.toHaveAttribute("data-kind", "row");
  await expect(card).toContainText("credit balance");
  await expect(card).toContainText(`Charge the card on file ${tag}`);
  await expect(card).toContainText("Failed");
  await expect(card.locator("dl")).toContainText(folder);
  await expect(card.locator("dl")).toContainText("Model");
  await expect(card.locator("dl")).toContainText("Active");
  await shoot(page, "rail-02-list-card");

  // Two stations (asked for: one pane is the default): still the list. The keyboard walks it, and the focus brings the card.
  await Promise.all([page.waitForEvent("load"), page.evaluate((ids) => {
    localStorage.setItem("keel.focus", "false"); localStorage.setItem("keel.workbench", "true");
    localStorage.setItem("keel.panes", JSON.stringify({ count: 2, slots: ids, sizes: {}, active: 0 }));
    location.reload();
  }, [done, failed]).catch(() => {})]);
  await expect(stations).toHaveCount(2);
  await expect(side).toHaveAttribute("data-open", "true");
  await entry(done).focus();
  await expect(card).toContainText(`batch size ${tag}`);
  await expect(card.locator("dl")).toContainText("Active");
  await page.keyboard.press("ArrowDown");
  await expect(entry(done)).not.toBeFocused();
  await expect(rail.locator('[data-testid="session-row"]:focus')).toHaveCount(1);
  await page.keyboard.press("ArrowUp");
  await expect(entry(done)).toBeFocused();
  await shoot(page, "rail-03-two-stations-list");

  // Folded by choice (Ctrl B): marks, banded by state, each with its own code; the choice holds over a reload.
  await page.keyboard.press("Control+b");
  await expect(side).not.toHaveAttribute("data-open", "true");
  expect(await stored("keel.list")).toBe("false");
  await page.reload();
  await expect(side).not.toHaveAttribute("data-open", "true");
  await expect(entry(failed)).toHaveAttribute("data-watch", "fail");
  const failBand = rail.getByTestId("rail-band").filter({ has: page.locator(`[data-session="${failed}"]`) });
  await expect(failBand).toHaveAttribute("data-watch", "fail");
  // A band is headed by its state's mark and how many; its name and tooltip say in words what it holds.
  await expect(failBand.locator(".k-marks-head")).toHaveText(/^\d+$/);
  await expect(failBand.locator(".k-marks-head .k-mark")).toHaveAttribute("data-watch", "fail");
  await expect(failBand).toHaveAttribute("title", /^Failed: \d+$/);
  await expect(failBand).toHaveAccessibleName(/^Failed: \d+$/);
  const codes = await rail.getByTestId("rail-code").allTextContents();
  expect(codes.length).toBeGreaterThanOrEqual(3);
  expect(codes.every((c) => c.length >= 2)).toBe(true);
  expect(new Set(codes).size).toBe(codes.length);
  // Same initials (Charge the card, Check the cache), told apart.
  const [c1, c2] = [await entry(failed).getByTestId("rail-code").textContent(), await entry(twin).getByTestId("rail-code").textContent()];
  expect(c1![0]).toBe("C");
  expect(c2![0]).toBe("C");
  expect(c1).not.toBe(c2);
  await entry(done).hover();
  await expect(card).toContainText(`batch size ${tag}`);
  await expect(card).toContainText("Done");
  await expect(card).toContainText(folder);
  await shoot(page, "rail-04-two-stations-folded-card");
  await entry(failed).focus();
  await expect(card).toHaveAttribute("data-watch", "fail");
  await expect(card).toContainText("credit balance");

  // The toggle brings the list back, and that is remembered too.
  await page.getByTestId("rail-toggle").click();
  await expect(side).toHaveAttribute("data-open", "true");
  expect(await stored("keel.list")).toBe("true");

  // Three panes (the owner's number) still leave room at this width: the list stays.
  await setPanes(page, 3);
  await entry(twin).click(); // it takes the free pane
  await expect(stations).toHaveCount(3);
  await expect(side).toHaveAttribute("data-open", "true");
  await expect(entry(twin).locator(".k-row-title")).toBeVisible();
  await shoot(page, "rail-05-three-stations-list");
  // Folded by choice with three panes: the marks and the card.
  await page.getByTestId("rail-toggle").click();
  await expect(side).not.toHaveAttribute("data-open", "true");
  await entry(twin).hover();
  await expect(card).toContainText(`asset host ${tag}`);
  await shoot(page, "rail-06-three-stations-folded-card");
  await page.getByTestId("rail-toggle").click();
  await expect(side).toHaveAttribute("data-open", "true");

  // A narrower window has no room for the list at its width beside three panes: it is the narrow
  // list, a title a line, and the panes keep their width.
  await page.setViewportSize({ width: 1500, height: 980 });
  await expect(side).toHaveAttribute("data-narrow", "true");
  await expect(entry(twin).locator(".k-row-title")).toBeVisible();
  await expect(entry(twin).getByTestId("rail-code")).toHaveCount(0);
  await expect(stations).toHaveCount(3);
  // Narrower still there is no room for a title: marks, though the list is the choice.
  await page.setViewportSize({ width: 1400, height: 980 });
  await expect(side).not.toHaveAttribute("data-open", "true");
  await expect(stations).toHaveCount(3);
  await expect(entry(twin).getByTestId("rail-code")).toBeVisible();
  // The toggle lays the list over the panes; Escape puts it away; picking a session does too.
  await page.getByTestId("rail-toggle").click();
  await expect(side).toHaveAttribute("data-over", "true");
  await expect(entry(twin).locator(".k-row-title")).toBeVisible();
  await expect(stations).toHaveCount(3);
  await shoot(page, "rail-07-no-room-list-over");
  await page.keyboard.press("Escape");
  await expect(side).not.toHaveAttribute("data-open", "true");
  await page.keyboard.press("Control+b");
  await expect(side).toHaveAttribute("data-over", "true");
  await entry(failed).click();
  await expect(page).toHaveURL(new RegExp(`/s/${failed}`));
  await expect(side).not.toHaveAttribute("data-open", "true");
  expect(await stored("keel.list")).toBe("true");
  // With the room back the list is back by itself.
  await page.setViewportSize({ width: 1700, height: 980 });
  await expect(side).toHaveAttribute("data-open", "true");

  // The station of a long title shows it whole, over two lines at most.
  await entry(done).click();
  const head = page.locator(`section.k-station[data-station="${done}"]`).getByTestId("station-head");
  const title = head.getByRole("heading");
  await expect(title).toContainText(`batch size ${tag}`);
  expect(await title.evaluate((el) => getComputedStyle(el).fontFamily)).toContain("Plex Sans");
  await shoot(page, "rail-08-station-title");

  // A new turn that works clears the failed mark.
  await request.post(`/api/sessions/${failed}/messages`, { data: { text: "Try again." } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${failed}`)).json()).session.settings.failed_ms ?? null, { timeout: 30_000 }).toBe(null);
  await expect(entry(failed)).toHaveAttribute("data-watch", "done");

  for (const id of [failed, twin, done]) await request.delete(`/api/sessions/${id}`);
  for (const e of (await (await request.get("/api/errors?resolved=0")).json()).errors) if (e.message.includes("credit balance")) await request.patch(`/api/errors/${e.id}`, { data: { resolved: true } });
});

// The rail's foot names its places in words (Inbox, Errors, Loops; the gear is a glyph every desk
// knows, named by its tip), and the three open the same way: a sheet from the rail's side, at one place, one size.
test("the foot names its places, and they open from one side in one style", async ({ page, request }) => {
  await page.setViewportSize({ width: 1920, height: 1040 });
  // With counts of two figures the words still fit the list's default width (they once gave way to glyphs there).
  const tag = Date.now().toString(36);
  // (Each its own cause: errors that differ only in a number are one.)
  for (const word of ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"]) await request.post("/api/errors", { data: { message: `rail foot ${tag}: the ${word} request timed out`, context: {} } });
  // And an approval that waits, so the Inbox has its count too.
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === "scripted:stand-in"), "needs the scripted stand-in: start the daemon with KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: `Rail foot asks ${tag}` } })).json();
  try {
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask" } });
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "echo rail-foot > rail-foot.txt" } }])}` } });
    await page.goto("/");
    const foot = page.locator(".k-rail-foot");
    await expect(foot.getByTestId("errors-button").locator(".k-act-n")).toHaveText(/^\d{2,}/);
    await expect(foot.getByTestId("inbox-count")).toBeVisible({ timeout: 15_000 });
    for (const [id, word] of [["inbox-button", "Inbox"], ["errors-button", "Errors"], ["loops-button", "Loops"]] as const) {
      const label = foot.getByTestId(id).locator(".k-foot-word");
      await expect(label, `the ${word} button shows no name`).toBeVisible();
      await expect(label).toHaveText(word);
    }
    expect(await foot.getByTestId("settings-button").getAttribute("title")).toBeTruthy();
    // The theme is chosen in Settings and the palette, not at the foot.
    await expect(foot.getByTestId("theme-toggle")).toHaveCount(0);
    // The foot is one row inside the rail.
    const f = (await foot.boundingBox())!, rail = (await page.getByTestId("sidebar").boundingBox())!;
    for (const b of await foot.locator(":scope > *").all()) { const r = await b.boundingBox(); if (r) { expect(r.x + r.width, "a foot button spills from the rail").toBeLessThanOrEqual(rail.x + rail.width); expect(Math.abs(r.y + r.height / 2 - (f.y + f.height / 2))).toBeLessThan(4); } }
    await shoot(page, "rail-08-foot");
    const boxes: Record<string, { x: number; y: number; height: number }> = {};
    for (const [id, sheet] of [["inbox-button", "inbox-panel"], ["errors-button", "errors-panel"], ["loops-button", "loops-panel"]] as const) {
      await foot.getByTestId(id).click();
      const s = page.getByTestId(sheet);
      await expect(s).toBeVisible();
      await expect.poll(async () => (await s.boundingBox())?.x).toBeLessThan(40);
      await page.waitForTimeout(400);
      const b = (await s.boundingBox())!;
      boxes[sheet] = { x: Math.round(b.x), y: Math.round(b.y), height: Math.round(b.height) };
      await shoot(page, `rail-09-${sheet}`);
      await page.keyboard.press("Escape");
      await expect(s).toBeHidden();
    }
    const [first, ...rest] = Object.values(boxes);
    for (const b of rest) expect(b, `the sheets open at different places: ${JSON.stringify(boxes)}`).toEqual(first);
  } finally {
    await request.delete(`/api/sessions/${session.id}`);
  }
});

// The session list (its top block, its rows, its foot) and the top bar beside it are one block of the
// text face: names and actions, state words, clocks and counts. The sizes and weights step alike: the
// product's name is a label of the rail (its size, the regular weight) beside a mark the height of the
// rail's icons, and New session, Search and every row's title share one weight, whatever the row's state.
test("the list's top block, its rows and the top bar are set in one face, at the same steps", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === "scripted:stand-in"), "needs the scripted stand-in: start the daemon with KEEL_SCRIPTED_PROVIDER=1");
  const tag = Date.now().toString(36);
  const made: string[] = [];
  const make = async (title: string, mode: string, text: string) => {
    const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: `${title} ${tag}` } })).json();
    made.push(session.id);
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode } });
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text } });
    return session.id as string;
  };
  try {
    const asks = await make("One face: asks", "ask", `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "echo one-face > one-face.txt" } }])}`);
    const failed = await make("One face: failed", "full-auto", "script:billing");
    const seen = await make("One face: read", "full-auto", "script:say Done.");
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`/s/${asks}`);
    const pane = page.locator(`section.k-station[data-station="${asks}"]`);
    await expect(pane).toHaveAttribute("data-watch", "need", { timeout: 15_000 });
    await expect(page.locator(`[data-testid="session-row"][data-session="${failed}"]`)).toHaveAttribute("data-watch", "fail", { timeout: 15_000 });
    await expect(pane.getByTestId("station-clock")).toBeVisible();
    const seenRow = page.locator(`[data-testid="session-row"][data-session="${seen}"]`);
    await expect(seenRow).toHaveAttribute("data-watch", "done", { timeout: 15_000 });
    await request.post(`/api/sessions/${seen}/marks`, { data: { unread: false } });
    await expect(seenRow).not.toHaveAttribute("data-unread", /.*/);
    await page.mouse.move(1000, 700);
    // Every word shown there, but a key's cap and a code: which face it is set in.
    const faces = await page.evaluate((id) => {
      const roots = [...document.querySelectorAll<HTMLElement>(".k-rail-brand, .k-rail-acts, .k-rail-top, .k-rail-body, .k-rail-foot"), document.querySelector<HTMLElement>(`section.k-station[data-station="${id}"] [data-testid="station-head"]`)!];
      const out: Record<string, string[]> = {};
      for (const root of roots) {
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const el = n.parentElement!;
          if (!n.textContent!.trim() || el.closest("kbd, code, .sr-only") || !el.getClientRects().length) continue;
          const face = getComputedStyle(el).fontFamily.split(",")[0]!.replace(/"/g, "").trim();
          (out[face] ??= []).push(`${el.className || el.tagName} "${n.textContent!.trim().slice(0, 20)}"`);
        }
      }
      return out;
    }, asks);
    expect(Object.keys(faces), `faces in the list and the top bar: ${JSON.stringify(faces)}`).toEqual(["IBM Plex Sans Variable"]);
    const font = (sel: string) => page.locator(sel).first().evaluate((el) => { const c = getComputedStyle(el); return `${c.fontSize} ${c.fontWeight}`; });
    // The brand is a line of the rail, not a banner over it.
    expect(await font(".k-brand-name"), "the product's name is a label of the rail").toBe(await font('[data-testid="open-palette"] .k-act-label'));
    expect((await font(".k-brand-name")).split(" ")[1], "the product's name is in the regular weight").toBe("400");
    const high = (sel: string) => page.locator(sel).first().evaluate((el) => el.getBoundingClientRect().height);
    expect(await high(".k-logo svg"), "the mark is the height of the rail's icons").toBe(await high('[data-testid="open-palette"] svg'));
    expect(await high(".k-logo svg"), "the mark is no taller than the name's line").toBeLessThanOrEqual(await high(".k-brand-name"));
    // The session's title is quiet: the body's size in regular weight.
    expect(await font(`section.k-station[data-station="${asks}"] [data-testid="station-title"]`), "the session's title is the body's size in regular weight").toBe(await page.evaluate(() => `${0.875 * parseFloat(getComputedStyle(document.documentElement).fontSize)}px 400`));
    expect(await font('[data-testid="new-session"] .k-act-label')).toBe(await font(`[data-testid="session-row"][data-session="${asks}"] .k-row-title`));
    expect(await font('[data-testid="open-palette"] .k-act-label')).toBe(await font(`[data-testid="session-row"][data-session="${seen}"] .k-row-title`));
    expect(await font(`[data-testid="session-row"][data-session="${failed}"] .k-row-title`), "a failed row's title is a read row's weight").toBe(await font(`[data-testid="session-row"][data-session="${seen}"] .k-row-title`));
    await shoot(page, "rail-10-one-face");
  } finally {
    for (const id of made) await request.delete(`/api/sessions/${id}`);
  }
});
