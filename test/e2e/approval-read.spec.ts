import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: a request is answered only for what was read. A card whose text is
// not all on it (cut by its box or by the daemon, or holding a character that
// had to be spelled out) takes no answer and never has the keyboard on one,
// whatever way the owner came to it: the rail, a link that names the request,
// a phone, an agent's request (the ways from the home screen are in
// home.spec.ts). Allow once and Always allow refuse until every line of the
// text has been in view (the card keeps count of the lines not seen yet). A
// card that is whole and all in view keeps today's rule.

const MODEL = "scripted:stand-in";
const scripted = async (request: APIRequestContext) => (await (await request.get("/api/models")).json()).models.some((m: any) => m.id === MODEL);
const bash = (command: string) => ({ name: "Bash", input: { command } });
// Forty-one lines: the card shows the first few, and the last one is what matters.
const LONG = `${Array.from({ length: 40 }, (_, i) => `echo step ${i + 1}`).join("\n")}\nrm -rf ./release && git push --force origin main`;
async function asking(request: APIRequestContext, title: string, calls: { name: string; input: unknown }[], mode = "ask") {
  const s = (await (await request.post("/api/sessions", { data: { model: MODEL, title } })).json()).session;
  await request.put(`/api/sessions/${s.id}/permissions`, { data: { mode, sandbox: "off" } });
  await request.post(`/api/sessions/${s.id}/messages`, { data: { text: `script:calls ${JSON.stringify(calls)}` } });
  return s as { id: string };
}
// Every request of a session and how it ended: "pending", "allowed/once", "denied".
const states = async (request: APIRequestContext, id: string) =>
  ((await (await request.get(`/api/sessions/${id}/approvals?all`)).json()).approvals as any[]).map((a) => `${a.state}${a.choice ? `/${a.choice}` : ""}`).join(",") || "none";
const waits = (request: APIRequestContext, id: string) => expect.poll(() => states(request, id), { timeout: 30_000 }).toBe("pending");
const focus = (page: Page) => page.evaluate(() => { const el = document.activeElement as HTMLElement | null; return el?.dataset.testid ?? el?.tagName ?? "none"; });
async function drop(request: APIRequestContext, ids: string[]) {
  for (const id of ids) { await request.post(`/api/sessions/${id}/interrupt`).catch(() => {}); await request.delete(`/api/sessions/${id}`).catch(() => {}); }
  await request.post("/api/alerts/read", { data: {} });
}
// Enter 1.2 s after arriving and again at 2.7 s: past the card's own settle time, when a whole card would act.
// (On the list of requests the first Enter opens the text of a card that must be opened; it answers nothing.)
async function enters(page: Page) {
  await page.waitForTimeout(1200);
  const at = await focus(page);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  return at;
}
// The owner's own scroll of the region the cards stand in.
const wheel = async (page: Page, by: number, times: number) => {
  const tray = (await page.getByTestId("composer-tray").boundingBox())!;
  await page.mouse.move(tray.x + tray.width / 2, tray.y + tray.height / 2);
  for (let i = 0; i < times; i++) { await page.mouse.wheel(0, by); await page.waitForTimeout(35); }
};
const table: string[] = [];
const said = (path: string, at: string, then: string) => table.push(`| ${path} | ${at} | ${then} |`);

test("a cut command takes no answer, and no keyboard on one: the rail, a link, the card itself", async ({ page, request, browser, baseURL }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const ids: string[] = [];
  const one = async (title: string) => { const s = await asking(request, title, [bash(LONG)]); ids.push(s.id); await waits(request, s.id); return s; };
  try {
    const s = await one("Read: a command of forty-one lines");
    let at = "";
    // The rail's row: no home screen is involved, the card decides alone.
    await page.goto("/");
    await page.getByTestId("sidebar").locator(`[data-session="${s.id}"]`).first().click();
    await expect(page).toHaveURL(new RegExp(`/s/${s.id}`));
    await expect(page.getByTestId("approval")).toHaveAttribute("data-must-open", "true");
    await shoot(page, "approval-read-01-cut");
    at = await enters(page);
    expect(at).toBe("approvals");
    expect(await states(request, s.id)).toBe("pending");
    said("Rail row", at, `Enter at 1.2 s and 2.7 s: ${await states(request, s.id)}`);

    // A link that names the request, at a desk and at a phone's width.
    const aid = (await (await request.get(`/api/sessions/${s.id}/approvals`)).json()).approvals[0].id as string;
    for (const [name, viewport] of [["desk", { width: 1920, height: 1040 }], ["phone width", { width: 390, height: 844 }]] as const) {
      const c = await browser.newContext({ baseURL, viewport });
      const p = await c.newPage();
      await p.goto(`/s/${s.id}?approval=${aid}`);
      await expect(p.getByTestId("approval").first()).toBeVisible();
      at = await enters(p);
      expect(at).not.toMatch(/allow/);
      expect(await states(request, s.id)).toBe("pending");
      said(`?approval= link, ${name}`, at, `Enter at 1.2 s and 2.7 s: ${await states(request, s.id)}`);
      await c.close();
    }

    // On the card itself: both answers refuse, and say what to do; the denial is always open.
    await page.goto(`/s/${s.id}`);
    const card = page.getByTestId("approval").first();
    await expect(card.getByTestId("allow-once")).toBeDisabled();
    await page.waitForTimeout(1300);
    // The reason stands beside the answers before any press; a refused press says it again, once, for a screen reader.
    await expect(card.getByTestId("approval-open-first")).toHaveText(/^(Open the whole command first|Enter opens the whole command)\.$/);
    await card.getByTestId("allow-once").click({ force: true });
    await expect(card.getByTestId("approval-refused").first()).toHaveText("Open the whole command first");
    if (await card.getByTestId("allow-always").count()) {
      await card.getByTestId("allow-always").click({ force: true });
      await expect(card.getByTestId("allow-always")).not.toHaveAttribute("aria-expanded", "true");
    }
    expect(await states(request, s.id)).toBe("pending");
    said("Allow once and Always allow on the cut card", "the button pressed", `refused, "Open the whole command first": ${await states(request, s.id)}`);
    // Opened, the last line is on the card; scrolled through, every line has been in view, and
    // after the settle time the answer acts.
    await card.getByTestId("approval-expand").click();
    await expect(card.getByTestId("approval-summary")).toContainText("git push --force origin main");
    await expect(card.getByTestId("approval-open-first")).toHaveCount(0);
    await expect(card.getByTestId("approval-left")).toHaveText(/^\d+ lines not seen yet/);
    await shoot(page, "approval-read-02-opened");
    await wheel(page, -400, 6);
    await wheel(page, 70, 24);
    await expect(card).not.toHaveAttribute("data-must-open", "true", { timeout: 10_000 });
    // (Forty-one lines are taller than the tray: the answer is under them, and acts once it has stood in view.)
    await card.getByTestId("allow-once").scrollIntoViewIfNeeded();
    await expect(card.getByTestId("allow-once")).toBeEnabled({ timeout: 10_000 });
    await card.getByTestId("allow-once").click();
    await expect.poll(() => states(request, s.id)).toBe("allowed/once");
    said("Allow once after the whole command was opened and scrolled through", "the button pressed", await states(request, s.id));
  } finally {
    await drop(request, ids);
    console.log(`\nPATH-TABLE\n| Path | Keyboard after arrival | Next key or click |\n| --- | --- | --- |\n${table.join("\n")}\nPATH-TABLE-END`);
  }
});

// An agent's request is answered on its parent's page: the same card, the same rule.
test("an agent's cut request, reached from the rail, takes no answer until it was opened", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const parent = await asking(request, "Read: parent of an asking agent", [{ name: "spawn_agent", input: { message: `Check the build\nscript:calls ${JSON.stringify([bash(LONG)])}`, isolation: "none" } }, { name: "wait_agent", input: {} }]);
  const rows: string[] = [];
  try {
    let kid = "";
    await expect.poll(async () => (kid = (await (await request.get(`/api/sessions/${parent.id}/agents`)).json()).agents?.[0]?.session_id ?? ""), { timeout: 30_000 }).not.toBe("");
    await waits(request, kid);
    await page.goto("/");
    await page.getByTestId("sidebar").locator(`[data-session="${parent.id}"]`).first().click();
    await expect(page.getByTestId("approval").first()).toHaveAttribute("data-must-open", "true");
    let at = await enters(page);
    expect(at).not.toMatch(/allow/);
    expect(await states(request, kid)).toBe("pending");
    rows.push(`| Agent's request, rail row of its parent | ${at} | Enter at 1.2 s and 2.7 s: ${await states(request, kid)} |`);
  } finally {
    await drop(request, [parent.id]);
    console.log(`\nPATH-TABLE-AGENT\n${rows.join("\n")}\nPATH-TABLE-AGENT-END`);
  }
});

// A card that is whole keeps the rule it had: after the settle time its Allow
// once takes the keyboard and Enter answers it. A command with letters written
// right to left is shown in the order it is written; a character that draws
// nothing, or as a plain space, is spelled out, and such a card is opened
// before it is answered.
test("a whole card keeps its rule; hidden and reordering characters are shown and opened first", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const ids: string[] = [];
  try {
    const plain = await asking(request, "Read: a whole command", [bash("mkdir -p out/reports")]);
    ids.push(plain.id);
    await waits(request, plain.id);
    await page.goto(`/s/${plain.id}`);
    const card = page.getByTestId("approval").first();
    await expect(card).not.toHaveAttribute("data-must-open", "true");
    await expect(card.getByTestId("allow-once")).toBeFocused({ timeout: 5000 });
    await page.keyboard.press("Enter");
    await expect.poll(() => states(request, plain.id)).toBe("allowed/once");

    const cases: [string, string, RegExp | null][] = [
      ["Read: Hebrew letters", "cp \u05d0 1 2 \u05d1 > \u05d2", null],
      ["Read: a Hangul filler", "rm -rf out\u3164 build", /<U\+3164>/],
      ["Read: a variation selector", "touch out\ufe0f", /<U\+FE0F>/],
      ["Read: a grapheme joiner", "touch o\u034fut", /<U\+034F>/],
      ["Read: a braille blank", "rm -rf out\u2800build", /<U\+2800>/],
      ["Read: a no-break space", "rm -rf out\u00a0build", /<U\+00A0>/],
      ["Read: an ideographic space", "rm -rf out\u3000build", /<U\+3000>/],
    ];
    const made: { id: string; title: string; command: string; mark: RegExp | null }[] = [];
    for (const [title, command, mark] of cases) { const s = await asking(request, title, [bash(command)]); ids.push(s.id); made.push({ id: s.id, title, command, mark }); }
    for (const m of made) await waits(request, m.id);
    for (const m of made) {
      await page.goto(`/s/${m.id}`);
      const c = page.getByTestId("approval").first();
      const text = c.getByTestId("approval-summary");
      if (m.mark) {
        // Spelled out and marked; the card is not whole until it was opened.
        await expect(text).toContainText(m.mark);
        await expect(c.getByTestId("approval-hidden")).toBeVisible();
        await expect(c).toHaveAttribute("data-must-open", "true");
        await page.waitForTimeout(1300);
        await c.getByTestId("allow-once").click({ force: true });
        await expect(c.getByTestId("approval-open-first")).toBeVisible();
        expect(await states(request, m.id)).toBe("pending");
        await c.getByTestId("approval-expand").click();
        await expect(c).not.toHaveAttribute("data-must-open", "true");
      } else {
        // Letters written right to left stand where they are written: the text is not mirrored.
        await expect(text).toHaveAttribute("dir", "ltr");
        await expect(c.getByTestId("approval-rtl")).toContainText("in the order the command is written");
        const xs = await text.getByTestId("rtl-run").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().left));
        expect(xs).toHaveLength(3);
        expect(xs[0]!).toBeLessThan(xs[1]!);
        expect(xs[1]!).toBeLessThan(xs[2]!);
        await shoot(page, "approval-read-03-rtl");
      }
    }
    await shoot(page, "approval-read-04-marked");

    // The same for every kind of request, and a word reads as a word: an edit's path keeps the
    // order it is written in, with the notice, and the letters of one word run right to left.
    const edit = await asking(request, "Read: a path with letters written right to left", [{ name: "Write", input: { file_path: "notes/\u05d0 1 2 \u05d1.md", content: "x" } }]);
    ids.push(edit.id);
    const word = await asking(request, "Read: a word written right to left", [bash("touch \u05d3\u05d5\u05d7.txt")]);
    ids.push(word.id);
    for (const s of [edit, word]) await waits(request, s.id);
    await page.goto(`/s/${edit.id}`);
    const path = page.getByTestId("approval").first();
    await expect(path).toHaveAttribute("data-tool", "Write");
    await expect(path.getByTestId("approval-rtl")).toContainText("in the order the text is written");
    const ps = await path.getByTestId("approval-summary").getByTestId("rtl-run").evaluateAll((els) => els.map((el) => [el.textContent, el.getBoundingClientRect().left] as const));
    expect(ps.map((x) => x[0])).toEqual(["\u05d0", "\u05d1"]);
    expect(ps[0]![1]).toBeLessThan(ps[1]![1]);
    await shoot(page, "approval-read-09-rtl-path");
    await page.goto(`/s/${word.id}`);
    const run = page.getByTestId("approval").first().getByTestId("approval-summary").getByTestId("rtl-run");
    await expect(run).toHaveText("\u05d3\u05d5\u05d7");
    const letters = await run.evaluate((el) => { const t = el.firstChild as Text; return [0, 2].map((i) => { const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 1); return r.getBoundingClientRect().left; }); });
    expect(letters[0]!).toBeGreaterThan(letters[1]!);
  } finally {
    await drop(request, ids);
  }
});

// The lines of a text the owner has had in view are what the card counts: a
// card the region above the message box cuts although its own box is whole
// takes no answer for the lines outside it, and a long command opened by one
// click is not read by having its first and its last screen on show.
test("a card the window cuts takes no answer for lines that were never in view", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const EIGHT = ["rm -rf ./release", ...Array.from({ length: 7 }, (_, i) => `echo step ${i + 2}`)].join("\n");
  const s = await asking(request, "Read: eight lines in a short window", [bash(EIGHT)]);
  try {
    await waits(request, s.id);
    // A window too short for the card: some of its lines are outside what the region shows.
    await page.setViewportSize({ width: 1920, height: 330 });
    await page.goto(`/s/${s.id}`);
    const card = page.getByTestId("approval").first();
    await expect(card).toBeVisible();
    await expect.poll(() => card.getByTestId("approval-summary").evaluate((el) => { const tray = el.closest('[data-testid="composer-tray"]')!.getBoundingClientRect(), r = el.getBoundingClientRect(); return r.top < tray.top || r.bottom > tray.bottom; })).toBe(true);
    await page.waitForTimeout(2200);
    expect(await focus(page)).not.toMatch(/allow/);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    expect(await states(request, s.id)).toBe("pending");
    await expect(card).toHaveAttribute("data-must-open", "true");
    await expect(card.getByTestId("approval-left")).toHaveText(/^\d+ lines? not seen yet/);
    await expect(card.getByTestId("approval-hint")).toBeHidden();
    await shoot(page, "approval-read-05-tray-cut");
    // Scrolled through by the owner, the lines the window cut have been in view too: the card is read,
    // and its answer takes the keyboard.
    await wheel(page, 40, 16);
    await wheel(page, -40, 16);
    await expect(card).not.toHaveAttribute("data-must-open", "true");
    await expect(card.getByTestId("approval-left")).toHaveCount(0);
    // (The answer is under the text in a window this short: it acts once it has stood in view.)
    await card.getByTestId("allow-once").scrollIntoViewIfNeeded();
    await expect(card.getByTestId("allow-once")).toBeFocused();
    await expect(card).toHaveAttribute("data-live", "true", { timeout: 10_000 });
    await page.keyboard.press("Enter");
    await expect.poll(() => states(request, s.id)).toBe("allowed/once");
  } finally {
    await drop(request, [s.id]);
  }
});

test("a long command opened by one click is read once its lines have been in view", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const MANY = `${Array.from({ length: 160 }, (_, i) => `echo step ${i + 1}`).join("\n")}\nrm -rf ./release && git push --force origin main`;
  const s = await asking(request, "Read: a hundred and sixty lines", [bash(MANY)]);
  try {
    await waits(request, s.id);
    await page.goto(`/s/${s.id}`);
    const card = page.getByTestId("approval").first();
    await expect(card).toHaveAttribute("data-must-open", "true");
    // One click opens it, and the region jumps to its end: the first and the last screen were on show, the middle never.
    await card.getByTestId("approval-expand").click();
    await page.waitForTimeout(1500);
    await expect(card).toHaveAttribute("data-must-open", "true");
    const left = Number((await card.getByTestId("approval-left").innerText()).match(/\d+/)![0]);
    expect(left).toBeGreaterThan(80);
    await card.getByTestId("allow-once").focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    expect(await states(request, s.id)).toBe("pending");
    await shoot(page, "approval-read-06-lines-left");
    // Scrolled through by the owner, top to bottom: every line has been in view.
    await wheel(page, -400, 14);
    await wheel(page, 70, 70);
    await expect(card).not.toHaveAttribute("data-must-open", "true", { timeout: 10_000 });
    await card.getByTestId("allow-once").scrollIntoViewIfNeeded();
    await expect(card).toHaveAttribute("data-live", "true", { timeout: 10_000 });
    await card.getByTestId("allow-once").click();
    await expect.poll(() => states(request, s.id)).toBe("allowed/once");
  } finally {
    await drop(request, [s.id]);
  }
});

// The step a card asks for first is the one it leads with. A card that must be
// opened shows that as its first button, says why its Allow once waits before
// anything was pressed, and Enter on the list of requests opens it: two keys,
// each meant, for a command that then fits.
test("a card that must be opened leads with opening it, and Enter on the list does that", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  // Twelve lines: more than the card's box, less than the region once opened.
  const TWELVE = `${Array.from({ length: 11 }, (_, i) => `echo step ${i + 1}`).join("\n")}\nrm -rf ./release`;
  const cut = await asking(request, "Read: twelve lines", [bash(TWELVE)]);
  const odd = await asking(request, "Read: a marked character", [bash("rm -rf out\u00a0build")]);
  try {
    for (const s of [cut, odd]) await waits(request, s.id);
    await page.goto(`/s/${cut.id}`);
    const card = page.getByTestId("approval").first();
    await expect(card).toHaveAttribute("data-must-open", "true");
    // The first button opens the text, and the reason stands beside the answers before any press.
    const open = card.getByTestId("approval-expand");
    await expect(open).toHaveText("Show the whole command");
    expect(await card.getByTestId("approval-actions").locator("button").first().getAttribute("data-testid")).toBe("approval-expand");
    expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(30);
    await expect(card.getByTestId("approval-open-first")).toHaveText("Open the whole command first.");
    await expect(card.getByTestId("allow-once")).toBeDisabled();
    await shoot(page, "approval-read-07-lead");
    // The keyboard is on the list of requests: Enter opens the text, and says so.
    await expect.poll(() => focus(page), { timeout: 5000 }).toBe("approvals");
    await expect(card.getByTestId("approval-open-first")).toHaveText("Enter opens the whole command.");
    await page.keyboard.press("Enter");
    await expect(card.getByTestId("approval-summary")).toContainText("rm -rf ./release");
    expect(await states(request, cut.id)).toBe("pending");
    // All of it shows now: read, the answer takes the keyboard, and the second Enter allows.
    await expect(card.getByTestId("allow-once")).toBeFocused({ timeout: 5000 });
    await page.keyboard.press("Enter");
    await expect.poll(() => states(request, cut.id)).toBe("allowed/once");

    // A short command with a marked character is all on the card already: its first button says what it does.
    await page.goto(`/s/${odd.id}`);
    const c = page.getByTestId("approval").first();
    await expect(c).toHaveAttribute("data-must-open", "true");
    await expect(c.getByTestId("approval-expand")).toHaveText("Show the 1 marked character");
    await expect(c.getByTestId("approval-open-first")).toContainText("marked character");
    await c.getByTestId("approval-expand").click();
    await expect(c.getByTestId("approval-summary")).toHaveAttribute("data-marks", "shown");
    await expect(c).not.toHaveAttribute("data-must-open", "true");
    await shoot(page, "approval-read-08-marks");
  } finally {
    await drop(request, [cut.id, odd.id]);
  }
});

// Letters from another alphabet that look like plain ones are not hidden, so
// they are not spelled out: the card names them. And an answer is never given
// from a popup the card opened while it was whole, once it is not.
test("look-alike letters are named, and a grant popup closes when its card is no longer read", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const alike = await asking(request, "Read: a look-alike letter", [bash("touch p\u0430ss.txt")]);
  // One line of 800 characters: whole in the card's box at a desk, cut in a narrow window.
  const wide = await asking(request, "Read: whole at a desk, cut when narrow", [bash(`echo ${"word ".repeat(158)}> wide.txt`)]);
  try {
    for (const s of [alike, wide]) await waits(request, s.id);
    await page.goto(`/s/${alike.id}`);
    const c = page.getByTestId("approval").first();
    await expect(c.getByTestId("approval-nonascii")).toContainText("U+0430");
    await expect(c.getByTestId("approval-hidden")).toHaveCount(0);
    await shoot(page, "approval-read-10-look-alike");

    await page.goto(`/s/${wide.id}`);
    const card = page.getByTestId("approval").first();
    await expect(card).not.toHaveAttribute("data-must-open", "true", { timeout: 10_000 });
    await expect(card).toHaveAttribute("data-live", "true", { timeout: 10_000 });
    await card.getByTestId("allow-always").click();
    await expect(page.getByTestId("grant-session")).toBeVisible();
    await page.setViewportSize({ width: 820, height: 1040 });
    await expect(card).toHaveAttribute("data-must-open", "true");
    await expect(page.getByTestId("grant-session")).toHaveCount(0);
    expect(await states(request, wide.id)).toBe("pending");
  } finally {
    await drop(request, [alike.id, wide.id]);
  }
});
