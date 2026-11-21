import { expect, test } from "./isolate.ts";
import type { Locator } from "./isolate.ts";
import { openPanel, shoot } from "./shots.ts";

// Feature: the secondary surfaces are one container. A side panel, the Errors
// drawer, the Inbox, the Loops dialog and the Settings page each have the ink
// band on top, a head of one height that names the surface in the title face,
// and (all but the page, whose way out is Back) the same close at its right end.
test("side panel, Errors, Inbox, Loops and Settings share one container grammar", async ({ page, request }) => {
  const model = process.env.KEEL_TEST_MODEL ?? "scripted:stand-in";
  const { session } = await (await request.post("/api/sessions", { data: { model, title: "One container grammar" } })).json();
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto(`/s/${session.id}`);
  await page.getByTestId("composer").first().waitFor();

  // Read in the light theme (a screenshot leaves the page in the dark one).
  const read = async (box: Locator) => {
    await box.waitFor();
    await page.evaluate(() => { document.documentElement.classList.add("theme-switch"); document.documentElement.classList.remove("dark"); });
    return box.evaluate(measureSurface);
  };
  const measureSurface = (el: Element) => {
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const px = (v: string) => r2(parseFloat(v));
    // The color painted behind an element: its own, or the nearest ancestor's.
    const behind = (x: Element | null) => { for (let p = x; p; p = p.parentElement) { const c = getComputedStyle(p).backgroundColor; if (!/, 0\)$|\/ 0\)$|transparent/.test(c)) return c; } return "none"; };
    const head = el.querySelector(".k-surface-head");
    const title = el.querySelector(".k-surface-title");
    const close = el.querySelector(".k-surface-close");
    // The band is the top border of the surface, or of a page's head.
    const banded = [el, head].find((x) => x && px(getComputedStyle(x).borderTopWidth) > 2);
    const b = banded ? getComputedStyle(banded) : null, t = title ? getComputedStyle(title) : null, h = head ? getComputedStyle(head) : null;
    return {
      band: b ? `${px(b.borderTopWidth)} ${b.borderTopColor}` : "none",
      head: h ? `${px(h.height)} ${h.borderBottomWidth} ${h.borderBottomColor}` : "none",
      title: t ? `${t.fontFamily.split(",")[0]} ${t.fontStretch} ${t.fontWeight} ${px(t.fontSize)} ${t.letterSpacing}` : "none",
      close: close ? `${r2(close.getBoundingClientRect().width)}x${r2(close.getBoundingClientRect().height)} ${getComputedStyle(close).borderRadius}` : "none",
      closeAtEnd: close && head ? Math.round(head.getBoundingClientRect().right - close.getBoundingClientRect().right) : -1,
      surface: behind(head),
    };
  };

  const got: Record<string, Awaited<ReturnType<typeof read>>> = {};
  await openPanel(page, "files");
  got.panel = await read(page.getByTestId("side-panel"));
  await shoot(page, "surfaces-01-side-panel");
  await page.getByTestId("errors-button").first().click();
  got.errors = await read(page.getByTestId("errors-panel"));
  await shoot(page, "surfaces-02-errors");
  await page.keyboard.press("Escape");
  await page.getByTestId("inbox-button").first().click();
  got.inbox = await read(page.getByTestId("inbox-panel"));
  await shoot(page, "surfaces-03-inbox");
  await page.keyboard.press("Escape");
  await page.getByTestId("loops-button").first().click();
  got.loops = await read(page.getByTestId("loops-panel"));
  await shoot(page, "surfaces-04-loops");
  await page.keyboard.press("Escape");
  await page.goto("/settings/general");
  await page.getByTestId("text-size").waitFor();
  got.settings = await read(page.getByTestId("settings"));
  await shoot(page, "surfaces-05-settings");
  console.log(Object.entries(got).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n"));

  const names = ["panel", "errors", "inbox", "loops", "settings"] as const;
  for (const key of ["band", "head", "title", "surface"] as const) {
    expect(new Set(names.map((n) => got[n]![key])).size, `${key}: ${names.map((n) => got[n]![key]).join(" | ")}`).toBe(1);
  }
  expect(got.panel!.band).not.toBe("none");
  expect(got.panel!.title).toContain("Martian Mono");
  // The four that close: the same button, at the head's right end.
  const closing = ["panel", "errors", "inbox", "loops"] as const;
  expect(new Set(closing.map((n) => got[n]!.close)).size, closing.map((n) => got[n]!.close).join(" | ")).toBe(1);
  expect(got.panel!.close).not.toBe("none");
  for (const n of closing) expect(got[n]!.closeAtEnd, n).toBeLessThanOrEqual(18);
});
