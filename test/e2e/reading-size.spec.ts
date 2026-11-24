import { expect, test } from "./isolate.ts";
import type { Page } from "./isolate.ts";
import { shoot, setPanes } from "./shots.ts";

// Feature: a reply is set at the body size of the type scale, a step above the rows of work and not
// twice them, in every pane, and so are the owner's words. A line holds 55 characters or more in a pane
// among four at 1920 px, and not more than 110 in a pane alone.
test("a reply in a four-pane bridge has 55 characters a line or more", async ({ page, request }) => {
  const model = process.env.KEEL_TEST_MODEL ?? "scripted:stand-in";
  test.skip(!model.startsWith("scripted:"), "the long reply is scripted");
  const mk = async (title: string) => (await (await request.post("/api/sessions", { data: { model, title } })).json()).session.id as string;
  const long = await mk("A long reply to read");
  const others = [await mk("Second pane"), await mk("Third pane"), await mk("Fourth pane")];
  await request.post(`/api/sessions/${long}/messages`, { data: { text: "Write at length. script:grow" } });
  await expect.poll(async () => {
    const r = await (await request.get(`/api/sessions/${long}`)).json();
    return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
  }, { timeout: 60_000 }).toBe(1);

  // The width of the reply's column in characters of its own text, and its size.
  const measure = (p: Page) => p.locator(`section.k-station[data-station="${long}"] .prose-keel p`).first().evaluate((el) => {
    const cs = getComputedStyle(el);
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const t = el.textContent!;
    const station = el.closest(".k-station")!;
    // The owner's own words in the same pane: they are the reply's size.
    const owner = parseFloat(getComputedStyle(station.querySelector(".k-user-words")!).fontSize);
    return { chars: Math.round(el.getBoundingClientRect().width / (ctx.measureText(t).width / t.length)), px: parseFloat(cs.fontSize), owner, pane: Math.round(station.getBoundingClientRect().width) };
  });

  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.addInitScript(([panes]) => { localStorage.setItem("keel.focus", "false"); localStorage.setItem("keel.panes", panes!); }, [JSON.stringify({ count: 4, slots: [long, ...others], sizes: {}, active: 0 })]);
  await page.goto(`/s/${long}`);
  await expect(page.locator("section.k-station")).toHaveCount(4);
  await page.locator(`section.k-station[data-station="${long}"] .prose-keel p`).first().waitFor();
  await document_fonts(page);
  const body = await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize));
  const row = await page.evaluate(() => { const probe = document.createElement("span"); probe.className = "text-caption"; document.body.append(probe); const px = parseFloat(getComputedStyle(probe).fontSize); probe.remove(); return px; });
  const four = await measure(page);
  console.log(`four panes: ${JSON.stringify(four)}`);
  expect(four.pane).toBeLessThan(520);
  expect(four.chars).toBeGreaterThanOrEqual(55);
  expect(four.owner).toBe(four.px);
  await shoot(page, "reading-size-four-panes");

  // One pane: the reading size, and still a readable measure.
  await setPanes(page, 1);
  await expect(page.locator("section.k-station")).toHaveCount(1);
  const one = await measure(page);
  console.log(`one pane: ${JSON.stringify(one)}`);
  expect(one.px, "the size does not depend on the pane").toBe(four.px);
  expect(one.px, "the body size of the type scale").toBe(body);
  expect(one.px / row, "the reply is a step above the rows of work").toBeLessThan(1.3);
  expect(one.chars).toBeLessThanOrEqual(110);
  expect(one.owner).toBe(one.px);

  // A phone is a narrow pane too: the same size, 48 characters a line or more.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await measure(page)).pane).toBeLessThanOrEqual(390);
  const phone = await measure(page);
  console.log(`phone: ${JSON.stringify(phone)}`);
  expect(phone.px).toBe(four.px);
  expect(phone.owner).toBe(phone.px);
  expect(phone.chars).toBeGreaterThanOrEqual(48);
  await shoot(page, "reading-size-phone");
});

const document_fonts = (page: Page) => page.evaluate(() => document.fonts.ready.then(() => undefined));
