import { expect, test, type Page } from "./isolate.ts";
import { shoot, setPanes } from "./shots.ts";

// Feature: the top edge of the window. The rail's brand row and the pane's top bar are one height,
// so their content starts on one line. Where a pane is as wide as a desk window leaves it (a
// 40rem pane and up), its head and the session's tools are one bar, and panes side by side end on
// one line. The head in the bar is one line or two: the title whole with the reason beside it,
// else the title over the state and its reason, which then have the head's width. Nothing is drawn at the pane's edge where it meets the rail: a
// pinned session's head once wore an ink tab there, a short white line in the dark theme; then the outline of a pane
// that needs the owner, the red edge of a failed or declined head and the ink rule over the pane worked in stood there.

// What lies at a point, top first: the classes of each element whose own background is the ink.
const inkAt = (page: Page, x: number, y: number) => page.evaluate(([px, py]) => {
  const probe = document.createElement("div");
  probe.style.background = "var(--fg)";
  document.body.append(probe);
  const ink = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return document.elementsFromPoint(px!, py!).filter((el) => getComputedStyle(el).backgroundColor === ink).map((el) => el.className || el.tagName);
}, [x, y]);

// The colours drawn in a box of the page, as the screen shows them: how many differ from its middle pixel's,
// and where the first such pixel is. A box that is one plain paper has none.
const strayIn = async (page: Page, clip: { x: number; y: number; width: number; height: number }) => {
  const png = await page.screenshot({ clip });
  return page.evaluate(async (b64) => {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(img.width, img.height), g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height).data;
    const at = (x: number, y: number) => { const i = (y * img.width + x) * 4; return `${d[i]},${d[i + 1]},${d[i + 2]}`; };
    const paper = at(img.width >> 1, img.height >> 1);
    let n = 0, first = "";
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (at(x, y) !== paper) { n++; first ||= `${at(x, y)} at ${x},${y} on ${paper}`; }
    return { n, first };
  }, png.toString("base64"));
};

// Where a pane meets the rail, from under the pane's band to its bar's hairline, the pane's first
// sixteen pixels are its head's paper: no outline, edge, rule or gap, in either theme.
const edgeClean = async (page: Page, pane: ReturnType<Page["getByTestId"]>, what: string) => {
  const p = (await pane.boundingBox())!, band = (await pane.locator(":scope > .k-band").boundingBox())!, head = (await pane.getByTestId("station-head").boundingBox())!;
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => { document.documentElement.classList.add("theme-switch"); document.documentElement.classList.toggle("dark", t === "dark"); }, theme);
    await page.waitForTimeout(60);
    const top = Math.ceil(band.y + band.height), bottom = Math.floor(head.y + head.height) - 2;
    const got = await strayIn(page, { x: Math.round(p.x), y: top, width: 16, height: bottom - top });
    expect(got.n, `${what}, ${theme}: a line at the pane's edge where it meets the rail (${got.first})`).toBe(0);
  }
  await page.evaluate(() => document.documentElement.classList.remove("theme-switch", "dark"));
};

test("nothing is drawn where a pane meets the rail, in a state that calls the owner and in the pane worked in", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string; provider: string }[];
  const model = models.find((m) => m.id === "scripted:stand-in")?.id;
  test.skip(!model, "needs the scripted stand-in: start the daemon with KEEL_SCRIPTED_PROVIDER=1");
  const made: string[] = [];
  const make = async (title: string, text: string, mode = "full-auto") => {
    const { session } = await (await request.post("/api/sessions", { data: { model, title } })).json();
    made.push(session.id);
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode } });
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text } });
    return session.id as string;
  };
  try {
    const need = await make("Waits on an approval at the edge", `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "echo edge > top-edge-need.txt" } }])}`, "ask");
    const fail = await make("Fails at the edge", "script:billing");
    const declined = await make("Declined at the edge", "script:refuse");
    await page.setViewportSize({ width: 1920, height: 1040 });
    for (const [id, w] of [[need, "need"], [fail, "fail"], [declined, "declined"]] as const) {
      await page.goto(`/s/${id}`);
      const pane = page.getByTestId("station").and(page.locator(`[data-station="${id}"]`));
      await expect(pane).toHaveAttribute("data-watch", w, { timeout: 30_000 });
      await page.mouse.move(1000, 700);
      await edgeClean(page, pane, `a pane that is ${w}`);
    }
    // Two panes: the one worked in is the first, against the rail.
    await page.goto(`/s/${fail}`);
    await setPanes(page, 2);
    const helm = page.getByTestId("bridge").locator(':scope > [data-slot="0"]');
    await expect(page.getByTestId("bridge").locator(':scope > [data-slot="1"]')).toBeVisible();
    // (The new pane takes the keys; a press in the first gives them back.)
    await helm.getByTestId("transcript").click({ position: { x: 40, y: 200 } });
    await expect(helm).toHaveAttribute("data-helm", /.*/);
    await page.mouse.move(1000, 700);
    await edgeClean(page, helm, "the pane worked in, beside another");
    await shoot(page, "top-edge-05-edge-two-panes");
    await setPanes(page, 1);
  } finally {
    for (const id of made) await request.delete(`/api/sessions/${id}`).catch(() => {});
  }
});

test("the rail and a pinned pane meet in one clean top edge, the head and its tools one bar", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string; provider: string }[];
  const model = models.find((m) => m.provider === "scripted")?.id;
  test.skip(!model, "needs the scripted provider: start the daemon with KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model, title: "Pinned at the top edge" } })).json();
  await request.patch(`/api/sessions/${session.id}`, { data: { settings: { pinned_ms: Date.now() } } });
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto(`/s/${session.id}`);
  const pane = page.getByTestId("station").and(page.locator(`[data-station="${session.id}"]`));
  const head = pane.getByTestId("station-head");
  const tools = pane.getByTestId("session-header");
  await expect(head).toBeVisible();
  await expect(page.getByTestId("pinned-group").locator(`[data-session="${session.id}"]`)).toBeVisible();
  await page.mouse.move(1000, 700);

  const h = (await head.boundingBox())!, t = (await tools.boundingBox())!;
  const brand = (await page.locator(".k-rail-brand").boundingBox())!;
  const band = (await pane.locator(":scope > .k-band").boundingBox())!;
  // Nothing in ink at the pane's edge under the band.
  for (const y of [band.y + band.height + 2, band.y + band.height + 12]) expect(await inkAt(page, h.x + 1, y)).toEqual([]);
  // One bar: the tools stand beside the head, on its line, as high as it is.
  expect(Math.abs(t.y - h.y), "the tools are a row under the head").toBeLessThan(1);
  expect(Math.abs(t.y + t.height - (h.y + h.height))).toBeLessThan(1);
  expect(t.x).toBeGreaterThan(h.x + h.width / 2);
  // One top edge: the bar (band included) is the brand row's height.
  expect(Math.abs(h.y + h.height - (brand.y + brand.height)), "the bar and the brand row end apart").toBeLessThanOrEqual(1);
  // A pane alone has no tools of its own but the pressed pin, the pane's cue that it is pinned; the menu's row and the list say it too.
  await expect(head.locator(".k-station-tools .k-tool")).toHaveCount(1);
  await expect(head.getByTestId("station-pin")).toHaveAttribute("aria-pressed", "true");
  await tools.getByTestId("session-menu").click();
  await expect(page.getByTestId("menu-pin")).toHaveText("Unpin from the top of the list");
  await page.keyboard.press("Escape");
  // The tools are as wide as what they show: the head has the rest of the bar.
  const top = (await pane.locator(".k-top").boundingBox())!;
  expect(t.width, "the tools keep a share of the bar they do not use").toBeLessThan(top.width / 2 - 8);
  await shoot(page, "top-edge-01-pinned-1920");

  // Panes side by side: the other pane's head ends where the bar does.
  const { session: other } = await (await request.post("/api/sessions", { data: { model, title: "Beside the pinned one" } })).json();
  try {
    // Two panes, the other session dropped on the second from the list.
    await setPanes(page, 2);
    const second = page.getByTestId("bridge").locator(':scope > [data-slot="1"]');
    await expect(second).toBeVisible();
    await page.locator(`[data-testid="session-row"][data-session="${other.id}"]`).dragTo(second);
    await expect(second).toHaveAttribute("data-station", other.id);
    await page.mouse.move(1000, 700);
    await expect(page.getByTestId("station-head")).toHaveCount(2);
    const ends = await page.getByTestId("station-head").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().bottom)));
    for (const end of ends) expect(Math.abs(end - (brand.y + brand.height)), `panes end at ${ends.join(", ")}, the brand row at ${brand.y + brand.height}`).toBeLessThanOrEqual(1);
    await shoot(page, "top-edge-04-two-panes");
    await setPanes(page, 1);
  } finally {
    await request.delete(`/api/sessions/${other.id}`);
  }

  // On a phone the pinned head is clean too.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(head).toBeVisible();
  const p = (await head.boundingBox())!, pb = (await pane.locator(":scope > .k-band").boundingBox())!;
  expect(await inkAt(page, p.x + 1, pb.y + pb.height + 4)).toEqual([]);
  await shoot(page, "top-edge-02-pinned-390");
});

test("a head with a long title and a long reason is still one bar, the brand row's height", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string; provider: string }[];
  const model = models.find((m) => m.id === "scripted:stand-in")?.id;
  test.skip(!model, "needs the scripted stand-in: start the daemon with KEEL_SCRIPTED_PROVIDER=1");
  const title = "A session with a rather long title that keeps going on and on across the bar";
  const command = "echo a long command line that keeps going on and on so the reason does not fit beside the title > top-edge-long-reason.txt";
  const made: string[] = [];
  const make = async (mode: string, input: Record<string, unknown>) => {
    const { session } = await (await request.post("/api/sessions", { data: { model, title } })).json();
    made.push(session.id);
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode } });
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input }])}` } });
    return session as { id: string; workspace: string };
  };
  try {
    // An approval it waits on (never given): the card under the head says what is asked, so the bar does not say
    // it again. The bar is the title, the state with its glyph and clock, the folder in the room left, and the tools:
    // the whole reason is the state's tooltip, and the session's menu wears no dot.
    const asks = await make("ask", { command });
    const pane = page.getByTestId("station").and(page.locator(`[data-station="${asks.id}"]`));
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`/s/${asks.id}`);
    await expect(pane).toHaveAttribute("data-watch", "need", { timeout: 15_000 });
    await expect(pane.locator(".k-approval")).toBeVisible();
    const head = pane.getByTestId("station-head");
    await expect(head.getByTestId("station-word")).toContainText("Needs you");
    await expect(head.getByTestId("station-clock")).toBeVisible();
    await expect(head.getByTestId("station-why"), "the bar says again what the approval card says").toHaveCount(0);
    expect(await head.getByTestId("station-word").getAttribute("title")).toContain("top-edge-long-reason.txt");
    const folder = asks.workspace.split("/").filter(Boolean).pop()!;
    await expect(head.locator(".k-station-where"), "the pane names its folder nowhere").toBeVisible();
    await expect(head.locator(".k-station-where")).toHaveText(folder);
    expect(await head.getByTestId("station-title").getAttribute("title")).toBe(`${title}\n${asks.workspace}\nClick to rename`);
    await expect(pane.getByTestId("session-header").getByTestId("head-folder")).toBeHidden();
    await expect(pane.getByTestId("session-menu").locator("span")).toHaveCount(0);
    // The clock is part of the state: the word's size, not a figure of its own.
    const sizes = await head.evaluate((h) => [h.querySelector(".k-station-word")!, h.querySelector(".k-station-clock")!].map((e) => getComputedStyle(e).fontSize));
    expect(sizes[1], "the clock is larger than the state's word").toBe(sizes[0]);
    await page.mouse.move(1000, 700);
    await shoot(page, "top-edge-03-approval-1920");

    // At work on a long command: the bar is the title, the dot and the word alone; what it runs is the word's
    // tooltip (the transcript shows the command), the step's clock is the line over the box's, and the folder is the title's.
    const busy = await make("full-auto", { command: `sleep 30; ${command}` });
    const work = page.getByTestId("station").and(page.locator(`[data-station="${busy.id}"]`));
    // Below 1400 the bar is one too (it once was two rows there, 125px against the brand row's 60).
    for (const width of [1920, 1440, 1366, 1200, 1050]) {
      await page.setViewportSize({ width, height: 1040 });
      await page.goto(`/s/${busy.id}`);
      await expect(work).toHaveAttribute("data-watch", "work", { timeout: 15_000 });
      await page.mouse.move(1000, 700);
      const head = work.getByTestId("station-head");
      await expect(head.getByTestId("station-word")).toContainText("Working");
      await expect(head.getByTestId("station-word"), `at ${width} the head's word is the word alone`).not.toContainText("·");
      await expect(head.getByTestId("station-clock"), `at ${width} the head says the step's clock again`).toHaveCount(0);
      await expect(work.getByTestId("dock-action-clock")).toBeVisible();
      await expect(head.getByTestId("station-why"), `at ${width} the command is not in the bar`).toHaveCount(0);
      await expect(head.locator(".k-station-meta"), `at ${width} the folder is not in the bar`).toHaveCount(0);
      expect(await head.getByTestId("station-word").getAttribute("title"), `at ${width} the command is the word's tooltip`).toContain("top-edge-long-reason.txt");
      const h = (await head.boundingBox())!, brand = (await page.locator(".k-rail-brand").boundingBox())!;
      const t = (await work.getByTestId("session-header").boundingBox())!;
      expect(Math.abs(t.y - h.y), `at ${width} the tools are a row under the head`).toBeLessThan(1);
      expect(Math.abs(h.y + h.height - (brand.y + brand.height)), `at ${width} the bar and the brand row end apart`).toBeLessThanOrEqual(1);
      if (width === 1440 || width === 1050) await shoot(page, `top-edge-03-long-${width}`);
    }
  } finally {
    for (const id of made) {
      await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }).catch(() => {});
      await request.delete(`/api/sessions/${id}`).catch(() => {});
    }
  }
});

// Feature: the bar's mode control is neutral ink in every session. Full auto draws warm, with the struck
// shield, only where it is unusual for the session (new sessions start in another mode, so the owner
// chose it for this one) or while a call of the session waits on the owner. The mode is said once, in the message
// box's row; the bar does not repeat it.
test("Full auto is neutral ink where it is the owner's usual mode and warm where it is not", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  const model = models.find((m) => m.id === "scripted:stand-in")?.id;
  test.skip(!model, "needs the scripted stand-in: start the daemon with KEEL_SCRIPTED_PROVIDER=1");
  const usual = (await (await request.get("/api/permissions/settings")).json()).default_mode as string;
  const { session } = await (await request.post("/api/sessions", { data: { model, title: "Mode tone" } })).json();
  const trigger = page.getByTestId("permission-menu");
  const look = () => trigger.evaluate((el) => ({ colour: getComputedStyle(el).color, struck: !!el.querySelector(".lucide-shield-off") }));
  try {
    await page.setViewportSize({ width: 1920, height: 1040 });
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask" } });
    await page.goto(`/s/${session.id}`);
    await expect(page.getByTestId("permission-mode")).toHaveText("Ask");
    const calm = await look();
    // The owner's usual mode is Full auto: the session in it looks like any other.
    await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
    await page.reload();
    await expect(page.getByTestId("permission-mode")).toHaveText("Full auto");
    await expect.poll(look, "Full auto, the owner's usual mode, is neutral ink without the struck shield").toEqual(calm);
    await shoot(page, "mode-tone-01-usual");
    // New sessions start in Ask: this session chose Full auto, which is unusual here.
    await request.put("/api/permissions/settings", { data: { default_mode: "ask" } });
    await page.reload();
    await expect(page.getByTestId("permission-mode")).toHaveText("Full auto");
    await expect.poll(async () => (await look()).colour, "Full auto the owner chose for this session is warm").not.toBe(calm.colour);
    expect((await look()).struck).toBe(true);
    // It is said once, in the message box's row: the bar says nothing of the mode, usual or not.
    await expect(page.getByTestId("head-mode")).toHaveCount(0);
    await expect(page.getByTestId("session-header")).not.toContainText("Full auto");
    await expect(page.getByTestId("permission-menu")).toHaveCount(1);
    await shoot(page, "mode-tone-02-unusual");
  } finally {
    await request.put("/api/permissions/settings", { data: { default_mode: usual } });
    await request.delete(`/api/sessions/${session.id}`).catch(() => {});
  }
});

// Feature: the bar says a session's state once, in the glyph and the word (no coloured strip across the
// top of the pane, no tint on its head, no working rule under it), and what it waits on the owner for is said once, in its card: while the card is in view the bar
// and the dock's line say the state only, not "approve: ..." or "asks: ..." again (UX-S143).
test("the bar has no state strip, and a session that needs the owner says why once, in its card", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  const model = models.find((m) => m.id === "scripted:stand-in")?.id;
  test.skip(!model, "needs the scripted stand-in: start the daemon with KEEL_SCRIPTED_PROVIDER=1");
  const made: string[] = [];
  const make = async (title: string, text: string, mode: string) => {
    const { session } = await (await request.post("/api/sessions", { data: { model, title } })).json();
    made.push(session.id);
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode } });
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text } });
    return session.id as string;
  };
  const calls = (c: unknown) => `script:calls ${JSON.stringify([c])}`;
  try {
    const approve = await make("Waits on a call", calls({ name: "Bash", input: { command: "git push origin release" } }), "ask");
    const asks = await make("Waits on a question", calls({ name: "AskUserQuestion", input: { questions: [{ header: "Store", question: "Which store should hold the sessions?", options: [{ label: "SQLite" }, { label: "Files" }], multiSelect: false }] } }), "full-auto");
    const failed = await make("Fails at the top", "script:billing", "full-auto");
    const { session: rest } = await (await request.post("/api/sessions", { data: { model, title: "At rest at the top" } })).json();
    made.push(rest.id);
    await page.setViewportSize({ width: 1920, height: 1040 });
    // The paper of a head and of the bar's tools, as drawn.
    const paper = (id: string) => page.getByTestId("station").and(page.locator(`[data-station="${id}"]`)).evaluate((el) => {
      const bg = (e: Element | null) => (e ? getComputedStyle(e).backgroundColor : "");
      return { head: bg(el.querySelector('[data-testid="station-head"]')), tools: bg(el.querySelector('[data-testid="session-header"]')), under: getComputedStyle(el).getPropertyValue("--k-head-bg").trim() };
    });
    await page.goto(`/s/${rest.id}`);
    await expect(page.getByTestId("station").and(page.locator(`[data-station="${rest.id}"]`))).toHaveAttribute("data-watch", "idle", { timeout: 30_000 });
    const calm = await paper(rest.id);
    for (const [id, watch, said] of [[approve, "need", true], [asks, "need", true], [failed, "fail", false]] as const) {
      await page.goto(`/s/${id}`);
      const pane = page.getByTestId("station").and(page.locator(`[data-station="${id}"]`));
      await expect(pane).toHaveAttribute("data-watch", watch, { timeout: 30_000 });
      await page.mouse.move(1000, 700);
      const head = pane.getByTestId("station-head");
      // The strip: no colour of the state across the pane's top.
      expect(await pane.locator(":scope > .k-band").evaluate((el) => getComputedStyle(el).backgroundColor), `a pane that is ${watch} draws a strip`).toBe("rgba(0, 0, 0, 0)");
      // No tint: the head of a pane that calls the owner is the paper of a head at rest; its dot and word say the state.
      expect(await paper(id), `a pane that is ${watch} tints its head`).toEqual(calm);
      await expect(head.getByTestId("wake-line")).toHaveCount(0);
      // The card is in view: the bar does not say its reason again, nor does the dock's line over the message box.
      await expect(head.getByTestId("station-ask")).toHaveCount(0);
      if (!said) continue;
      const needs = id === approve ? "git push origin release" : "Which store should hold the sessions";
      await expect(pane.getByTestId(id === approve ? "approval" : "question")).toContainText(needs);
      await expect(head).not.toContainText(needs);
      // The bar says Needs you and the card says what for: the dock's line is not a third place for the word.
      await expect(head.getByTestId("station-word")).toContainText("Needs you");
      await expect(pane.getByTestId("dock-action")).toHaveCount(0);
      await expect(pane.getByTestId("dock-action-text")).toHaveCount(0);
      await shoot(page, `top-edge-ask-${id === approve ? "call" : "question"}`);
    }
  } finally {
    for (const id of made) {
      await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }).catch(() => {});
      await request.delete(`/api/sessions/${id}`).catch(() => {});
    }
  }
});
