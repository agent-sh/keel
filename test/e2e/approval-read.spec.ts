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
  for (const id of ids) { await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }).catch(() => {}); await request.delete(`/api/sessions/${id}`).catch(() => {}); }
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
    // Over three screens of text: the card says how long it is, and the way that is not an allow.
    await expect(card.getByTestId("approval-long")).toHaveText("Long command: 161 lines. Deny, or scroll through to allow.");
    // One click opens it. The text stays where it was read, its first screen on show, and the
    // answers stay in the region with the count: the region does not jump to the text's end.
    await card.getByTestId("approval-expand").click();
    await page.waitForTimeout(1500);
    await expect(card).toHaveAttribute("data-must-open", "true");
    await expect(card).toHaveAttribute("data-foot", "");
    expect(await card.getByTestId("approval-summary").evaluate((el) => { const t = el.closest('[data-testid="composer-tray"]')!.getBoundingClientRect(), r = el.getBoundingClientRect(); return r.top >= t.top && r.bottom > t.bottom; })).toBe(true);
    const left = Number((await card.getByTestId("approval-left").innerText()).match(/\d+/)![0]);
    expect(left).toBeGreaterThan(80);
    await card.getByTestId("allow-once").focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    expect(await states(request, s.id)).toBe("pending");
    await shoot(page, "approval-read-06-lines-left");
    // Scrolled through by the owner, top to bottom: every line has been in view.
    await wheel(page, -400, 14);
    // (Where the answers stand in their own row: the row is as tall read as unread.)
    const row = async () => { const f = (await card.getByTestId("approval-actions").boundingBox())!, b = (await card.getByTestId("allow-once").boundingBox())!; return [Math.round(f.height), Math.round(b.y - f.y), Math.round(b.x - f.x)].join(); };
    await wheel(page, 70, 30);
    const before = await row();
    await wheel(page, 70, 60);
    await expect(card).not.toHaveAttribute("data-must-open", "true", { timeout: 10_000 });
    // Read: the line says so in its place, and the answers did not move in their row as they came alive.
    await expect(card.getByTestId("approval-long")).toHaveText("Long command: 161 lines, all seen.");
    await card.getByTestId("allow-once").scrollIntoViewIfNeeded();
    expect(await row()).toBe(before);
    await expect(card).toHaveAttribute("data-live", "true", { timeout: 10_000 });
    await card.getByTestId("allow-once").click();
    await expect.poll(() => states(request, s.id)).toBe("allowed/once");
  } finally {
    await drop(request, [s.id]);
  }
});

// A long command read by keys alone: Enter opens it, End reads on to its end (every line passes
// through view, a step at a time, as the owner's own scroll), and Enter allows: three keys. Space
// reads a page on, and stays the card's while lines are left (it does not go to the message box).
// The line that counts what is left names the key.
test("a long command is read by keys: Enter opens it, End reads it to its end, Enter allows; Space reads on", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  // (Not a high-risk one: its answer is the owner's to go to, Down then Enter, whatever was read.)
  const PLAIN = `${Array.from({ length: 40 }, (_, i) => `echo step ${i + 1}`).join("\n")}\necho done > last.txt`;
  const a = await asking(request, "Read by keys: End", [bash(PLAIN)]);
  const b = await asking(request, "Read by keys: Space", [bash(PLAIN)]);
  try {
    await waits(request, a.id);
    await waits(request, b.id);
    for (const [s, key] of [[a, "End"], [b, " "]] as const) {
      await page.goto(`/s/${s.id}`);
      const list = page.getByTestId("approvals"), card = list.getByTestId("approval").first();
      await expect(list).toBeFocused();
      await expect(card).toHaveAttribute("data-must-open", "true");
      await expect(list).toHaveAttribute("data-keys", "ready");
      let keys = 0;
      const press = async (k: string) => { keys++; await page.keyboard.press(k); };
      await press("Enter");
      await expect(card.getByTestId("approval-left")).toContainText("not seen yet. End reads on");
      const unseen = async () => Number(await card.getAttribute("data-unseen"));
      expect(await unseen()).toBeGreaterThan(5);
      if (key === "End") {
        await shoot(page, "approval-read-16-end-reads-on");
        await press("End");
      } else {
        const first = await unseen();
        await press(" ");
        await expect.poll(unseen).toBeLessThan(first);
        await expect(page.getByTestId("composer")).toHaveValue("");
        await expect(list).toBeFocused();
        for (let i = 0; i < 6 && (await unseen()) > 0; i++) { await press(" "); await page.waitForTimeout(250); }
      }
      await expect.poll(unseen, { timeout: 5000 }).toBe(0);
      expect(await states(request, s.id)).toBe("pending");
      // Read: Allow once takes the keyboard once it stood, and Enter allows.
      await expect(card.getByTestId("allow-once")).toBeFocused({ timeout: 8000 });
      await expect(card).toHaveAttribute("data-live", "true");
      await press("Enter");
      await expect.poll(() => states(request, s.id)).toBe("allowed/once");
      if (key === "End") expect(keys).toBe(3);
      await expect(page.getByTestId("composer")).toHaveValue("");
    }
  } finally {
    await drop(request, [a.id, b.id]);
  }
});

// End steps through a long command one painted view at a time. The page keeps, after each frame was
// painted, which lines of the text stood whole in the region (less the card's foot where it stays): when
// the card says every line was seen and takes an answer, each of the 201 lines was on screen in a frame.
test("End reads a long command on only through views that were painted, each line on screen", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  await page.setViewportSize({ width: 1920, height: 1040 });
  const MANY = `${Array.from({ length: 200 }, (_, i) => `echo step ${i + 1}`).join("\n")}\necho done > last.txt`;
  const s = await asking(request, "Read: two hundred and one lines by End", [bash(MANY)]);
  try {
    await waits(request, s.id);
    await page.goto(`/s/${s.id}`);
    const list = page.getByTestId("approvals"), card = list.getByTestId("approval").first();
    await expect(list).toBeFocused();
    await expect(list).toHaveAttribute("data-keys", "ready");
    await page.keyboard.press("Enter");
    await expect(card.getByTestId("approval-read-key")).toBeVisible();
    await page.evaluate(() => {
      const w = window as unknown as { __painted: { tops: number[]; lines: Set<number>; total: number } };
      w.__painted = { tops: [], lines: new Set(), total: 0 };
      const ch = new MessageChannel();
      // After a frame's paint: what it showed.
      ch.port1.onmessage = () => {
        const tray = document.querySelector<HTMLElement>('[data-testid="composer-tray"]'), pre = document.querySelector<HTMLElement>('[data-testid="approval-summary"]');
        const cardEl = pre?.closest<HTMLElement>('[data-testid="approval"]');
        if (tray && pre && cardEl) {
          const t = tray.getBoundingClientRect(), r = pre.getBoundingClientRect(), cs = getComputedStyle(pre);
          const foot = cardEl.hasAttribute("data-foot") ? cardEl.querySelector<HTMLElement>(":scope > .k-ask-foot")!.getBoundingClientRect().height : 0;
          const line = parseFloat(cs.lineHeight), pad = parseFloat(cs.paddingTop);
          const total = Math.round((pre.scrollHeight - pad - parseFloat(cs.paddingBottom)) / line);
          w.__painted.total = total;
          if (w.__painted.tops.at(-1) !== tray.scrollTop) w.__painted.tops.push(tray.scrollTop);
          for (let i = 0; i < total; i++) { const y0 = r.top + pad + i * line, y1 = y0 + line; if (y0 >= t.top - 0.5 && y1 <= t.bottom - foot + 0.5) w.__painted.lines.add(i); }
        }
        requestAnimationFrame(() => ch.port2.postMessage(0));
      };
      requestAnimationFrame(() => ch.port2.postMessage(0));
    });
    await page.keyboard.press("End");
    await expect.poll(async () => Number(await card.getAttribute("data-unseen")), { timeout: 10_000 }).toBe(0);
    const seen = await page.evaluate(() => { const p = (window as unknown as { __painted: { tops: number[]; lines: Set<number>; total: number } }).__painted; const missing: number[] = []; for (let i = 0; i < p.total; i++) if (!p.lines.has(i)) missing.push(i); return { tops: p.tops, total: p.total, missing }; });
    expect(seen.total).toBeGreaterThan(150);
    // (The lines in view before End were painted before the sampling began.)
    const before = seen.missing.filter((i) => i > 25);
    expect(before, `lines never painted on screen, scroll positions painted ${seen.tops.join(",")}`).toEqual([]);
    expect(seen.tops.length).toBeGreaterThan(3);
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
    // (In its other words while the list has the keyboard, where Enter does it.)
    await expect(card.getByTestId("approval-open-first")).toHaveText(/^(Open the whole command first|Enter opens the whole command)\.$/);
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

// An edit is read like a command: its card shows what it would write under the
// path, and counts those lines. A file of 300 lines is not allowed by an Enter
// with none of its content in view.
test("an edit's card shows what it writes, and takes no answer until that was read", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const content = `${Array.from({ length: 299 }, (_, i) => `line ${i + 1} of the notes`).join("\n")}\nrm -rf / # the last line\n`;
  const big = await asking(request, "Read: a file of 300 lines", [{ name: "Write", input: { file_path: "notes/long.md", content } }]);
  const small = await asking(request, "Read: a replacement", [{ name: "Edit", input: { file_path: "src/a.ts", old_string: "let total = 1;", new_string: "const total = 2;" } }]);
  try {
    for (const s of [big, small]) await waits(request, s.id);
    await page.goto(`/s/${big.id}`);
    const card = page.getByTestId("approval").first();
    const text = card.getByTestId("approval-summary");
    await expect(text).toContainText("notes/long.md");
    await expect(text).toContainText("line 1 of the notes");
    await expect(card).toHaveAttribute("data-must-open", "true");
    await expect(card.getByTestId("approval-expand")).toHaveText("Show all of it");
    await page.waitForTimeout(1500);
    expect(await focus(page)).not.toMatch(/allow/);
    await card.getByTestId("allow-once").click({ force: true });
    await page.waitForTimeout(300);
    expect(await states(request, big.id)).toBe("pending");
    await shoot(page, "approval-read-11-edit");
    // Opened and scrolled through, it is read.
    await card.getByTestId("approval-expand").click();
    await expect(text).toContainText("rm -rf / # the last line");
    await expect(card.getByTestId("approval-left")).toHaveText(/^\d+ (lines|rows) not seen yet/);
    await wheel(page, -6000, 3);
    await wheel(page, 90, 80);
    await expect(card).not.toHaveAttribute("data-must-open", "true", { timeout: 10_000 });
    await card.getByTestId("allow-once").scrollIntoViewIfNeeded();
    await expect(card).toHaveAttribute("data-live", "true", { timeout: 10_000 });
    await card.getByTestId("allow-once").click();
    await expect.poll(() => states(request, big.id)).toBe("allowed/once");

    // A replacement: what goes and what comes, whole on the card, which keeps its rule.
    await page.goto(`/s/${small.id}`);
    const c = page.getByTestId("approval").first();
    await expect(c.getByTestId("approval-summary")).toContainText("- let total = 1;");
    await expect(c.getByTestId("approval-summary")).toContainText("+ const total = 2;");
    await expect(c.getByTestId("allow-once")).toBeFocused({ timeout: 5000 });
    await shoot(page, "approval-read-12-replace");
    await page.keyboard.press("Enter");
    await expect.poll(() => states(request, small.id)).toBe("allowed/once");
  } finally {
    await drop(request, [big.id, small.id]);
  }
});

// A command for another machine of the fleet says which: the same text is a
// different act there.
test("a command for another machine names the machine on its card", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const s = await asking(request, "Read: a command for another machine", [{ name: "keel__run_on", input: { machine: "build-box", command: "rm -rf ./release", cwd: "/srv/app" } }]);
  try {
    await waits(request, s.id);
    await page.goto(`/s/${s.id}`);
    const card = page.getByTestId("approval").first();
    await expect(card.getByTestId("approval-summary")).toContainText("rm -rf ./release");
    await expect(card.getByTestId("approval-machine")).toHaveText("on build-box, in /srv/app");
    await shoot(page, "approval-read-13-machine");
  } finally {
    await drop(request, [s.id]);
  }
});

// A call the judge refused offers one retry. That button is under a box of
// text: it is held like any answer (it does nothing in its first second on
// the page), and the text over it is shown with nothing hidden.
test("Allow one retry is held like an answer", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const s = (await (await request.post("/api/sessions", { data: { model: MODEL, title: "Read: a refused call" } })).json()).session as { id: string };
  await request.put(`/api/sessions/${s.id}/permissions`, { data: { mode: "auto", sandbox: "off" } });
  // (The scripted judge refuses a command that names judge-deny.txt.)
  await request.post(`/api/sessions/${s.id}/messages`, { data: { text: `script:calls ${JSON.stringify([bash("printf marker\u00a0x > judge-deny.txt")])}` } });
  const blocked = async () => ((await (await request.get(`/api/sessions/${s.id}/blocked`)).json()).blocked as { retry?: boolean }[]);
  try {
    await expect.poll(async () => (await blocked()).length, { timeout: 30_000 }).toBe(1);
    await page.goto(`/s/${s.id}`);
    const card = page.getByTestId("blocked").first();
    const retry = card.getByTestId("blocked-retry");
    await expect(retry).toBeVisible();
    // Pressed as it appears: nothing is allowed, and the press is answered.
    await expect(retry).toHaveAttribute("aria-disabled", "true");
    await retry.click({ force: true });
    await expect(card.getByTestId("approval-refused")).toHaveText(/^Not yet/);
    expect((await blocked())[0]!.retry).toBeFalsy();
    await expect(card.getByTestId("hidden-char")).toHaveText("<U+00A0>");
    // Standing for the settle time, it acts.
    await expect(retry).not.toHaveAttribute("aria-disabled", "true", { timeout: 5000 });
    await retry.click();
    await expect.poll(async () => (await blocked())[0]!.retry).toBe(true);
  } finally {
    await drop(request, [s.id]);
  }
});

// A card the page itself flags asks for a deliberate step: its text must be opened (longer than
// its box, a character that hides or reorders text, an input the daemon shows in part). An Enter
// inside the settle time of the keyboard's arrival opens nothing, so the Enter after it is no
// allow; and where the text is marked or shown in part, Enter alone never both opens and allows:
// the answer is the owner's to go to (Down), and the card says so.
const FIXTURE = `${import.meta.dirname}/fixtures/echo-mcp.ts`;
test("an early Enter opens nothing, and Enter alone never both opens and allows a flagged card", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  test.setTimeout(420_000);
  const server = `readecho${Date.now().toString(36)}`;
  expect((await request.post("/api/mcp/servers", { data: { name: server, command: "bun", args: [FIXTURE] } })).ok()).toBe(true);
  await expect.poll(async () => ((await (await request.get("/api/mcp/servers")).json()).servers as { name: string; state: string }[]).find((x) => x.name === server)?.state, { timeout: 20_000 }).toBe("ready");
  const shapes: [string, { name: string; input: unknown }][] = [
    ["thirteen lines", bash(`${Array.from({ length: 12 }, (_, i) => `echo step ${i + 1}`).join("\n")}\ntouch thirteen.txt`)],
    ["a reordering character", bash("touch a\u202Etxt.b")],
    ["an input shown in part", { name: "mcp_call", input: { tool: `${server}__echo`, arguments: { text: `${"words ".repeat(120)}END-OF-TEXT` } } }],
  ];
  const made: string[] = [];
  const list = page.getByTestId("approvals").first(), card = page.getByTestId("approval").first();
  // The page keeps time itself: when the keyboard came to the list, when it had been there for
  // the settle time, and when each Enter went down.
  type Clock = { came: number; ready: number; enters: number[] };
  await page.addInitScript(() => {
    const w = window as unknown as { __r: { came: number; ready: number; enters: number[] } };
    w.__r = { came: 0, ready: 0, enters: [] };
    addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") w.__r.enters.push(performance.now()); }, true);
    new MutationObserver(() => {
      const keys = document.querySelector('[data-testid="approvals"]')?.getAttribute("data-keys");
      if (keys && !w.__r.came) w.__r.came = performance.now();
      if (keys === "ready" && !w.__r.ready) w.__r.ready = performance.now();
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-keys"] });
  });
  // One Enter `ms` after the keyboard came to the list (the press is sent a little before, for the
  // time it takes to land), and one 1.5 s later. (A machine too slow to press inside the settle
  // time proves nothing with that press: the page's own clock says so.)
  const schedule = async (id: string, what: string, ms: number) => {
    await expect(card).toBeVisible();
    await page.waitForFunction((at) => { const r = (window as unknown as { __r: Clock }).__r; return r.came > 0 && performance.now() - r.came >= at; }, ms - 70);
    await page.keyboard.press("Enter");
    const { ready, enters } = await page.evaluate(() => (window as unknown as { __r: Clock }).__r);
    if (ready && enters[0]! >= ready) { console.log(`slow at ${ms} ms (${what}): the first Enter came ${Math.round(enters[0]! - ready)} ms after the settle time`); return; }
    // Inside the settle time it opened nothing.
    await expect(card.getByTestId("approval-expand")).not.toHaveText("Fold");
    await page.waitForTimeout(1500);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    expect(await states(request, id), `${what}, Enter at ${ms} ms and 1.5 s later`).toBe("pending");
  };
  try {
    for (const [name, call] of shapes) {
      // The page loads on a session whose request waits.
      const loaded = await asking(request, `Read: ${name}, on a load`, [call]);
      made.push(loaded.id);
      await waits(request, loaded.id);
      for (const ms of [100, 500, 900]) {
        await page.goto(`/s/${loaded.id}`);
        await expect(card).toHaveAttribute("data-must-open", "true");
        await schedule(loaded.id, `${name}, page load`, ms);
      }
      // The request arrives in a page that is open.
      for (const ms of [100, 500, 900]) {
        const s = (await (await request.post("/api/sessions", { data: { model: MODEL, title: `Read: ${name}, arriving at ${ms}` } })).json()).session as { id: string };
        made.push(s.id);
        await request.put(`/api/sessions/${s.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
        await page.goto(`/s/${s.id}`);
        await expect(page.getByTestId("composer").first()).toBeVisible();
        await request.post(`/api/sessions/${s.id}/messages`, { data: { text: `script:calls ${JSON.stringify([call])}` } });
        await schedule(s.id, `${name}, arriving`, ms);
      }
      // Enter every 150 ms from the load. A text that is marked or shown in part stays pending however
      // long that goes on (3.3 s here). A plain long command is opened by the first Enter after the
      // settle time, and its Allow takes the keyboard only once its text has stood open for the
      // settle time too: by the page's own clock nothing is allowed 1.6 s after the keyboard came.
      const plain = name === "thirteen lines";
      await page.goto(`/s/${loaded.id}`);
      await expect(card).toBeVisible();
      const since = () => page.evaluate(() => { const r = (window as unknown as { __r: Clock }).__r; return r.came ? performance.now() - r.came : 0; });
      while ((await since()) < (plain ? 1600 : 3300)) { await page.keyboard.press("Enter"); await page.waitForTimeout(150); }
      expect(await states(request, loaded.id), `${name}, Enter every 150 ms`).toBe("pending");
      if (plain) continue;
      // What it takes: the text opened, then Down to the answer, then Enter. The card says so.
      await expect(card).not.toHaveAttribute("data-must-open", "true", { timeout: 10_000 });
      await list.focus();
      await expect(card.getByTestId("approval-arming")).toHaveText(/: Down, then Enter allows once$/);
      await expect(list).toHaveAttribute("data-keys", "ready");
      await page.keyboard.press("ArrowDown");
      await expect(card.getByTestId("allow-once")).toBeFocused();
      await expect(card).toHaveAttribute("data-live", "true", { timeout: 10_000 });
      await page.keyboard.press("Enter");
      await expect.poll(() => states(request, loaded.id)).toBe("allowed/once");
    }
  } finally {
    await drop(request, made);
    await request.delete(`/api/mcp/servers/${server}`);
  }
});

// What an edit writes is shown as it is written, like a command: a character in it that hides
// or reorders text is spelled out and marked, the card says so, and such an edit is opened and
// answered by a deliberate step, never by an Enter on a text that reads as something else.
test("an edit's content is spelled out: hidden and reordering characters in what it writes are marked", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const content = "export const check = (user) => {\n  if (user.role === 'admin') { /* \u202E } ;eurt = nimdAsi { \u2066*/\n  return f\u200Balse; // p\u0430ss\n};\n";
  const s = await asking(request, "Read: an edit with a reordering character", [{ name: "Write", input: { file_path: "src/auth.ts", content } }]);
  try {
    await waits(request, s.id);
    await page.goto(`/s/${s.id}`);
    const card = page.getByTestId("approval").first();
    const body = card.getByTestId("approval-body");
    await expect(body.getByTestId("hidden-char")).toHaveText(["<U+202E>", "<U+2066>", "<U+200B>"]);
    await expect(card.getByTestId("approval-hidden")).toBeVisible();
    await expect(card.getByTestId("approval-nonascii")).toContainText("U+0430");
    await expect(card).toHaveAttribute("data-must-open", "true");
    await expect(card.getByTestId("approval-expand")).toHaveText("Show the 3 marked characters");
    await shoot(page, "approval-read-14-edit-marked");
    // Enter well after the settle time: nothing is allowed, and no answer has the keyboard.
    await page.waitForTimeout(2600);
    expect(await focus(page)).not.toMatch(/^allow/);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);
    expect(await focus(page)).not.toMatch(/^allow/);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    expect(await states(request, s.id)).toBe("pending");
    // Opened, the answer is one deliberate key away, and the card says which.
    await expect(card).not.toHaveAttribute("data-must-open", "true", { timeout: 10_000 });
    await page.getByTestId("approvals").first().focus();
    await expect(card.getByTestId("approval-arming")).toHaveText("Marked characters: Down, then Enter allows once");
    await page.keyboard.press("ArrowDown");
    await expect(card.getByTestId("allow-once")).toBeFocused();
    await expect(card).toHaveAttribute("data-live", "true", { timeout: 10_000 });
    await page.keyboard.press("Enter");
    await expect.poll(() => states(request, s.id)).toBe("allowed/once");
  } finally {
    await drop(request, [s.id]);
  }
});

// A card taller than the region above the message box keeps its foot in view: what is left to
// read is said there, and Deny can be pressed at once, without scrolling to the card's end. The
// rows the foot lies over are not counted as seen. And the control that opened the text stays in
// its place as the one that folds it, at the same width: no answer comes under a resting pointer.
test("a tall card keeps its answers and the count in view, and no answer takes the opener's place", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const LOW = `${Array.from({ length: 40 }, (_, i) => `echo step ${i + 1}`).join("\n")}\ntouch done.txt`;
  const s = await asking(request, "Read: forty-one lines, opened", [bash(LOW)]);
  try {
    await waits(request, s.id);
    await page.goto(`/s/${s.id}`);
    const list = page.getByTestId("approvals").first(), card = page.getByTestId("approval").first();
    const opener = card.getByTestId("approval-expand");
    await expect(card.getByTestId("approval-open-first")).toHaveText("Enter opens the whole command.");
    const slot = (await opener.boundingBox())!;
    await page.keyboard.press("Enter");
    await expect(card.getByTestId("approval-summary")).toContainText("touch done.txt");
    // The card is taller than its room: the count, Deny and the other answers are in the region.
    const tray = (await page.getByTestId("composer-tray").first().boundingBox())!;
    expect((await card.boundingBox())!.height).toBeGreaterThan(tray.height);
    await expect(card).toHaveAttribute("data-foot", "");
    for (const id of ["approval-left", "deny", "allow-once", "approval-expand"]) {
      const b = (await card.getByTestId(id).boundingBox())!;
      expect(b.y, id).toBeGreaterThanOrEqual(tray.y);
      expect(b.y + b.height, id).toBeLessThanOrEqual(tray.y + tray.height + 0.5);
    }
    await expect(card.getByTestId("approval-left")).toHaveText(/^\d+ lines not seen yet(\. End reads on)?$/);
    await shoot(page, "approval-read-15-foot");
    // The rows under the foot are not in view: they are still to be seen after the text has stood.
    await page.waitForTimeout(1300);
    const under = await card.evaluate((el) => {
      const pre = el.querySelector('[data-testid="approval-summary"]')!, foot = el.querySelector('[data-testid="approval-actions"]')!;
      return Math.floor((pre.getBoundingClientRect().bottom - foot.getBoundingClientRect().top) / parseFloat(getComputedStyle(pre).lineHeight));
    });
    expect(under).toBeGreaterThan(0);
    expect(Number(await card.getAttribute("data-unseen"))).toBeGreaterThanOrEqual(under);
    // The opener's place holds the fold, as wide as it was: a second and a third press at the same
    // point fold and open the text, and answer nothing.
    await expect(opener).toHaveText("Fold");
    const now = (await opener.boundingBox())!;
    expect(Math.abs(now.x - slot.x)).toBeLessThan(1);
    expect(Math.abs(now.width - slot.width)).toBeLessThan(1);
    await page.mouse.click(now.x + now.width / 2, now.y + now.height / 2);
    await expect(opener).toHaveText("Show the whole command");
    await page.waitForTimeout(1300);
    const again = (await opener.boundingBox())!;
    await page.mouse.click(again.x + again.width / 2, again.y + again.height / 2);
    await expect(opener).toHaveText("Fold");
    expect(await states(request, s.id)).toBe("pending");
    // Deny is pressed at once, by the pointer, and its reason form is in view too.
    await card.getByTestId("deny").click();
    const reason = (await card.getByTestId("deny-reason").boundingBox())!;
    expect(reason.y + reason.height).toBeLessThanOrEqual(tray.y + tray.height + 0.5);
    await page.keyboard.press("Enter");
    await expect.poll(() => states(request, s.id)).toMatch(/^denied/);
    void list;
  } finally {
    await drop(request, [s.id]);
  }
});

// Reading a long text to its end does not throw the reader back to its start. On a narrow page
// the count has a line of its own in the card's foot, so the card changes height when the last
// line was seen; with the keyboard on the list (a high-risk request: its answer never takes
// it by itself) the region stays where the text was read.
test("the region stays where a long text was read when the card's own words change", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const s = await asking(request, "Read: forty-one lines on a narrow page", [bash(LONG)]);
  try {
    await waits(request, s.id);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/s/${s.id}`);
    const card = page.getByTestId("approval").first();
    await expect(card).toHaveAttribute("data-risk", "high");
    await expect(card.getByTestId("approval-open-first")).toHaveText("Enter opens the whole command.");
    await page.keyboard.press("Enter");
    await expect(card.getByTestId("approval-summary")).toContainText("git push --force origin main");
    await expect(card.getByTestId("approval-left")).toBeVisible();
    for (let i = 0; i < 160 && (await card.getAttribute("data-must-open")); i++) await wheel(page, 40, 1);
    await expect(card).not.toHaveAttribute("data-must-open", "true");
    await expect(card.getByTestId("approval-left")).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(await focus(page)).toBe("approvals");
    expect(await page.getByTestId("composer-tray").first().evaluate((el) => el.scrollTop)).toBeGreaterThan(200);
    expect(await states(request, s.id)).toBe("pending");
  } finally {
    await drop(request, [s.id]);
  }
});

// One rule for every way the owner asks for a waiting session: a row of the rail, the palette, a
// row of the home screen, an Inbox row, a link that names the request, the key that goes to what
// waits; in one pane, and where the session is shown as a look over a pane that keeps its own
// underneath. The keyboard lands on the list of requests, never on an answer; a key pressed on
// the way in answers nothing; once the keyboard has been there for the settle time the Allow
// once of a request that is whole, read and asks for no second look takes it, and Enter allows.
test("every way to a waiting session lands the keyboard on its list, then on Allow once after the settle time", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  test.setTimeout(240_000);
  // The page keeps what took the keyboard, and when: the list of requests, a card, an answer.
  await page.addInitScript(() => {
    const w = window as unknown as { __f: { at: number; on: string; view: string }[] };
    w.__f = [];
    addEventListener("focusin", (e) => {
      const el = e.target as HTMLElement;
      if (el.closest?.('[data-testid="approvals"]')) w.__f.push({ at: performance.now(), on: el.dataset.testid ?? el.tagName, view: el.closest<HTMLElement>("[data-view]")?.dataset.view ?? "" });
    }, true);
  });
  const quiet = (await (await request.post("/api/sessions", { data: { model: MODEL, title: "Read: nothing waits here" } })).json()).session as { id: string };
  const other = (await (await request.post("/api/sessions", { data: { model: MODEL, title: "Read: a second pane" } })).json()).session as { id: string };
  const made = [quiet.id, other.id];
  const one = async (word: string) => { const s = await asking(request, `Read: land ${word}`, [bash(`touch ${word}.txt`)]); made.push(s.id); await waits(request, s.id); return s; };
  const panes = async (ids: string[]) => {
    await page.goto("/api/daemon");
    await page.evaluate((slots) => { localStorage.setItem("keel.focus", "false"); localStorage.setItem("keel.panes", JSON.stringify({ count: slots.length, slots, sizes: {}, active: 0 })); }, ids);
  };
  const palette = async (title: string) => {
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill(title);
    await expect(page.getByTestId("palette").getByRole("option").first()).toContainText(title);
    await page.keyboard.press("Enter");
  };
  // What the keyboard did after `act`: where it landed, what an Enter pressed there within the
  // settle time did, when the Allow took it, and what Enter did then.
  const lands = async (way: string, id: string, act: () => Promise<void>, view = "") => {
    await act();
    const card = page.locator(`[data-testid="approval"]:visible`).first();
    await expect(card).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __f: unknown[] }).__f.length), { message: `${way}: the keyboard came to the list` }).toBeGreaterThan(0);
    await page.keyboard.press("Enter");
    await expect(card.getByTestId("allow-once")).toBeFocused({ timeout: 8000 });
    const log = await page.evaluate(() => (window as unknown as { __f: { at: number; on: string; view: string }[] }).__f);
    // It landed on the list of requests (in the look, where there is one), and stayed off the answers for the settle time.
    expect(log[0]!.on, way).toBe("approvals");
    if (view) expect(log[0]!.view, way).toBe(view);
    const answer = log.find((x) => x.on.startsWith("allow"))!;
    expect(answer.at - log[0]!.at, `${way}: when its Allow took the keyboard`).toBeGreaterThanOrEqual(950);
    expect(await states(request, id), `${way}: an Enter on the way in`).toBe("pending");
    await expect(card).toHaveAttribute("data-live", "true", { timeout: 8000 });
    await page.keyboard.press("Enter");
    await expect.poll(() => states(request, id), { message: way }).toBe("allowed/once");
    table.push(`| ${way} | list of requests, then Allow once ${Math.round(answer.at - log[0]!.at)} ms later | Enter on the way in: pending; Enter after: allowed |`);
    await page.evaluate(() => { (window as unknown as { __f: unknown[] }).__f.length = 0; });
  };
  try {
    await panes([quiet.id]);
    let s = await one("rail");
    await lands("Rail row", s.id, async () => { await page.goto(`/s/${quiet.id}`); await page.getByTestId("sidebar").locator(`[data-session="${s.id}"]`).first().click(); });
    s = await one("palette");
    await lands("Palette", s.id, async () => { await page.goto(`/s/${quiet.id}`); await palette("Read: land palette"); });
    s = await one("home");
    await lands("Home row's title", s.id, async () => { await page.goto("/"); const r = page.locator(`[data-testid="home-session"][data-session="${s.id}"]`).getByTestId("home-open"); await r.focus(); await page.keyboard.press("Enter"); });
    s = await one("inbox");
    await lands("Inbox row", s.id, async () => { await page.goto(`/s/${quiet.id}`); await page.getByTestId("inbox-button").click(); await page.getByTestId("inbox-item").filter({ hasText: "Read: land inbox" }).first().locator("button").first().click(); });
    s = await one("link");
    const aid = (await (await request.get(`/api/sessions/${s.id}/approvals`)).json()).approvals[0].id as string;
    await lands("?approval= link", s.id, async () => { await page.goto(`/s/${s.id}?approval=${aid}`); });
    s = await one("key");
    await lands("Alt+A", s.id, async () => { await page.goto(`/s/${quiet.id}`); await expect(page.getByTestId("composer").first()).toBeVisible(); await page.keyboard.press("Alt+a"); });
    // Two panes: the palette opens the waiting session as a look over the pane worked in, which
    // keeps its own session underneath. The keyboard is in the look.
    await panes([quiet.id, other.id]);
    s = await one("look");
    await lands("Palette, as a look over a pane", s.id, async () => {
      await page.goto(`/s/${quiet.id}`);
      await expect(page.locator(`section.k-station[data-station="${other.id}"]`)).toBeVisible();
      await palette("Read: land look");
      await expect(page.locator('.k-view[data-view="look"]')).toBeVisible();
    }, "look");
  } finally {
    await drop(request, made);
    console.log(`\nPATH-TABLE-LANDS\n| Way | Keyboard | Keys |\n| --- | --- | --- |\n${table.filter((x) => x.includes("then Allow once")).join("\n")}\nPATH-TABLE-LANDS-END`);
  }
});

// A card reached by the Inbox's Review, as a look over a pane beside another: it stands where it
// lands from its first frame (it fades in, it does not slide; its column does not shift as the
// conversation under it is drawn), and the Inbox on its way out lies over none of it, so its Allow
// once, judged by how long it stood still and whole, takes a press 1.1 s after the card shows.
// Three times out of three.
test("a card reached by the Inbox's Review stands still from its first frame, and a press 1.1 s after it is taken", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1920, height: 1040 });
  const reader = (await (await request.post("/api/sessions", { data: { model: MODEL, title: "Review: the pane I read" } })).json()).session as { id: string };
  const other = (await (await request.post("/api/sessions", { data: { model: MODEL, title: "Review: the pane beside" } })).json()).session as { id: string };
  const made = [reader.id, other.id];
  try {
    await page.goto("/api/daemon");
    await page.evaluate((slots) => { localStorage.setItem("keel.focus", "false"); localStorage.setItem("keel.panes", JSON.stringify({ count: 2, slots, sizes: {}, active: 0 })); }, [reader.id, other.id]);
    const takes: string[] = [];
    for (let rep = 0; rep < 3; rep++) {
      const s = await asking(request, `Review: rotate ${rep}`, [bash(`touch rotated-${rep}.txt`)]);
      made.push(s.id);
      await waits(request, s.id);
      await page.goto(`/s/${reader.id}`);
      await page.locator(`section.k-station[data-station="${reader.id}"]`).getByTestId("composer").click();
      await page.getByTestId("inbox-button").click();
      const item = page.getByTestId("inbox-item").filter({ hasText: `Review: rotate ${rep}` }).first();
      await expect(item).toBeVisible();
      // Every frame from the press on: where its Allow once stands.
      await page.evaluate(() => {
        const w = window as unknown as { __at: { t: number; x: number; y: number; hit: boolean }[] };
        w.__at = [];
        const look = () => {
          const b = [...document.querySelectorAll<HTMLElement>('[data-testid="allow-once"]')].find((el) => !el.closest("[inert]"));
          // Where it stands, and whether a press at its middle would reach it (nothing on its way out lies over it).
          // (A layer on its way out takes no press, so a point does not hit it: it is looked for by its place.)
          if (b) {
            const r = b.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
            const leaving = [...document.querySelectorAll<HTMLElement>("[data-ending-style]")].some((g) => { const q = g.getBoundingClientRect(); return !g.contains(b) && x >= q.left && x <= q.right && y >= q.top && y <= q.bottom; });
            w.__at.push({ t: performance.now(), x: r.x, y: r.y, hit: !leaving && b.contains(document.elementFromPoint(x, y)) });
          }
          if (w.__at.length < 120) requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
      });
      await item.getByTestId("inbox-open").first().click();
      const card = page.locator('.k-view[data-view="look"] [data-testid="approval"]');
      await expect(card).toBeVisible();
      await page.waitForTimeout(1100);
      const moves = await page.evaluate(() => { const a = (window as unknown as { __at: { x: number; y: number }[] }).__at; return a.filter((p, i) => i > 0 && (Math.abs(p.x - a[i - 1]!.x) >= 0.5 || Math.abs(p.y - a[i - 1]!.y) >= 0.5)).length; });
      expect(moves, `rep ${rep}: frames where Allow once moved after it was drawn`).toBe(0);
      // Once nothing lies over it any more (the Inbox on its way out may for a frame or two), nothing does again.
      const covered = await page.evaluate(() => { const a = (window as unknown as { __at: { hit: boolean }[] }).__at; const from = a.findIndex((p) => p.hit); return from < 0 ? -1 : a.slice(from).filter((p) => !p.hit).length; });
      expect(covered, `rep ${rep}: frames where something lay over Allow once after it was first clear`).toBe(0);
      await card.getByTestId("allow-once").click();
      await expect.poll(() => states(request, s.id), { message: `rep ${rep}: the press 1.1 s after the card showed`, timeout: 5000 }).toBe("allowed/once");
      takes.push("taken");
    }
    expect(takes).toEqual(["taken", "taken", "taken"]);
  } finally {
    await drop(request, made);
  }
});
