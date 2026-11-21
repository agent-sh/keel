import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: a request is answered only for what was read. A card whose text is
// not all on it (cut by its box or by the daemon, or holding a character that
// had to be spelled out) takes no answer and never has the keyboard on one,
// whatever way the owner came to it: the rail, a link that names the request,
// a phone, an agent's request (the ways from the home screen are in
// home.spec.ts). Allow once and Always allow refuse until the whole text was
// opened. A card that is whole keeps today's rule.

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
async function enters(page: Page) {
  await page.waitForTimeout(1200);
  const at = await focus(page);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  return at;
}
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
    at = await enters(page);
    expect(at).toBe("approvals");
    expect(await states(request, s.id)).toBe("pending");
    said("Rail row", at, `Enter at 1.2 s and 2.7 s: ${await states(request, s.id)}`);
    await shoot(page, "approval-read-01-cut");

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
    await card.getByTestId("allow-once").click({ force: true });
    await expect(card.getByTestId("approval-open-first")).toHaveText("Open the whole command first.");
    if (await card.getByTestId("allow-always").count()) {
      await card.getByTestId("allow-always").click({ force: true });
      await expect(card.getByTestId("allow-always")).not.toHaveAttribute("aria-expanded", "true");
    }
    expect(await states(request, s.id)).toBe("pending");
    said("Allow once and Always allow on the cut card", "the button pressed", `refused, "Open the whole command first": ${await states(request, s.id)}`);
    // Opened, the last line is on the card, and after the settle time the answer acts.
    await card.getByTestId("approval-expand").click();
    await expect(card).not.toHaveAttribute("data-must-open", "true");
    await expect(card.getByTestId("approval-summary")).toContainText("git push --force origin main");
    await expect(card.getByTestId("approval-open-first")).toHaveCount(0);
    await shoot(page, "approval-read-02-opened");
    // (Forty-one lines are taller than the tray: the answer is under them, and acts once it has stood in view.)
    await card.getByTestId("allow-once").scrollIntoViewIfNeeded();
    await expect(card.getByTestId("allow-once")).toBeEnabled({ timeout: 10_000 });
    await card.getByTestId("allow-once").click();
    await expect.poll(() => states(request, s.id)).toBe("allowed/once");
    said("Allow once after the whole command was opened", "the button pressed", await states(request, s.id));
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
        expect(await text.evaluate((el) => { const s = getComputedStyle(el); return `${s.direction} ${s.unicodeBidi}`; })).toBe("ltr bidi-override");
        await expect(c.getByTestId("approval-rtl")).toContainText("in the order the command is written");
        const xs = await text.evaluate((el) => {
          const node = [...el.childNodes].find((n) => n.nodeType === 3 || (n as HTMLElement).tagName === "SPAN" && !(n as HTMLElement).className) as Node;
          const t = (node.nodeType === 3 ? node : node.firstChild) as Text;
          const x = (ch: string) => { const i = t.data.indexOf(ch); const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 1); return r.getBoundingClientRect().left; };
          return [x("\u05d0"), x("\u05d1"), x("\u05d2")];
        });
        expect(xs[0]!).toBeLessThan(xs[1]!);
        expect(xs[1]!).toBeLessThan(xs[2]!);
        await shoot(page, "approval-read-03-rtl");
      }
    }
    await shoot(page, "approval-read-04-marked");
  } finally {
    await drop(request, ids);
  }
});
