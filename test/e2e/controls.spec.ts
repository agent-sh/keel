import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boxTools, openPanel, shoot } from "./shots.ts";

// Feature: controls come in four heights (1.5, 1.75, 2 and 2.25 rem) and none
// is a target under 24 px. Checked on a session with its Changes panel open:
// the pane count, the tags, a turn's note chips, a diff's Collapse and Revert
// hunk, the header's icon buttons.
test("no control is under 24 px and icon buttons keep to the four heights", async ({ page, request }) => {
  const model = process.env.KEEL_TEST_MODEL ?? "scripted:stand-in";
  test.skip(!model.startsWith("scripted:"), "the turns are scripted");
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `controls-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  execFileSync("git", ["init", "-q"], { cwd: ws });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model, title: "Control sizes", settings: { tags: ["sizes"] } } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `Change the file. script:calls ${JSON.stringify([{ name: "Edit", input: { file_path: join(ws, "a.ts"), old_string: "export const b = 2;", new_string: "export const b = 3;" } }])}` } });
  await expect.poll(async () => {
    const r = await (await request.get(`/api/sessions/${session.id}`)).json();
    return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
  }, { timeout: 60_000 }).toBe(1);
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto(`/s/${session.id}`);
  await openPanel(page, "changes");
  await page.getByTestId("revert-hunk").first().waitFor();
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity));

  const got = await page.evaluate(() => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const small: string[] = [], icons: Record<string, string[]> = {};
    let n = 0;
    for (const el of document.querySelectorAll<HTMLElement>("button, [role=button], [role=tab], [role=radio]")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight || getComputedStyle(el).visibility === "hidden") continue;
      n++;
      const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30) || el.getAttribute("data-testid") || el.className.toString().slice(0, 40);
      if (r.width < 24 || r.height < 24) small.push(`${Math.round(r.width)}x${Math.round(r.height)} ${name}`);
      // An icon button: no words of its own.
      if (!el.textContent?.trim() && el.querySelector("svg")) (icons[(r.height / rem).toFixed(2)] ??= []).push(name);
    }
    return { n, small, icons };
  });
  console.log(`${got.n} controls, ${got.small.length} under 24 px\n${got.small.join("\n")}\nicon button heights (rem): ${Object.entries(got.icons).map(([h, v]) => `${h} x${v.length}`).join(", ")}`);
  expect(got.n).toBeGreaterThan(30);
  expect(got.small).toEqual([]);
  for (const h of Object.keys(got.icons)) expect(["1.50", "1.75", "2.00", "2.25"], `${h}rem: ${got.icons[h]!.slice(0, 3).join(", ")}`).toContain(h);
  await shoot(page, "controls-sizes");

  // The same holds past that one screen: a diff's comment mark, the permission menu's modes and
  // its switch, the model chooser's pin and hide, the session panel's switches, a settings page.
  const small = () => page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("button, [role=button], [role=tab], [role=radio], [role=switch], [role=checkbox]")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight || getComputedStyle(el).visibility === "hidden") continue;
      if (r.width < 24 || r.height < 24) out.push(`${Math.round(r.width)}x${Math.round(r.height)} ${el.getAttribute("data-testid") ?? (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}`);
    }
    return out;
  });
  const seen: Record<string, string[]> = {};
  await openPanel(page, "review");
  await page.getByTestId("review-panel").or(page.getByTestId("side-panel")).first().waitFor();
  await page.waitForTimeout(600);
  seen.review = await small();
  await (await boxTools(page)).getByTestId("permission-menu").first().click();
  await page.getByTestId("mode-ask").waitFor();
  seen.permissions = await small();
  await page.keyboard.press("Escape");
  await (await boxTools(page)).getByTestId("model-picker").first().click();
  await page.getByPlaceholder("Search models").waitFor();
  await page.waitForTimeout(300);
  seen.models = await small();
  await page.keyboard.press("Escape");
  await openPanel(page, "session");
  await page.getByTestId("pin-toggle").waitFor();
  seen.session = await small();
  for (const section of ["alerts", "providers", "machines"]) {
    await page.goto(`/settings/${section}`);
    await page.getByTestId("settings-title").waitFor();
    await page.waitForTimeout(400);
    seen[section] = await small();
  }
  console.log(Object.entries(seen).map(([k, v]) => `${k}: ${v.length} under 24 px ${v.slice(0, 6).join(", ")}`).join("\n"));
  expect(seen).toEqual({ review: [], permissions: [], models: [], session: [], alerts: [], providers: [], machines: [] });
  // Which alert goes where is a grid of marks, not a wall of switches.
  await page.goto("/settings/alerts");
  await page.getByTestId("alert-routes").waitFor();
  expect(await page.getByTestId("alert-groups").getByRole("checkbox").count()).toBe(12);
  await page.getByTestId("alert-fine-toggle").click();
  expect(await page.getByTestId("alert-routes").getByRole("checkbox").count()).toBeGreaterThan(50);
  // (The one switch there is "Play a sound", outside the grid.)
  expect(await page.getByTestId("alert-groups").getByRole("switch").count()).toBe(0);
  expect(await page.getByTestId("alert-routes").getByRole("switch").count()).toBe(1);
  await shoot(page, "controls-alert-routes");
  // A switch's thumb keeps its color inside a side panel, where a card's surface is the page's paper.
  await page.goto(`/s/${session.id}`);
  await openPanel(page, "session");
  const thumb = await page.getByTestId("pin-toggle").evaluate((el) => ({ thumb: getComputedStyle(el.firstElementChild!).backgroundColor, card: getComputedStyle(el.closest("[class*=border-line]") ?? el.parentElement!).backgroundColor }));
  expect(thumb.thumb).not.toBe(thumb.card);
  await shoot(page, "controls-session-switches");
});

// On a touch screen a segmented option is a full control tall, not the 26 px of a pointer.
test.describe("on a touch screen", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test("segmented options are a full control tall", async ({ page }) => {
    await page.goto("/settings/general");
    await page.getByTestId("text-size").waitFor();
    const heights = await page.locator(".k-seg > button").evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height > 0).map((e) => Math.round(e.getBoundingClientRect().height)));
    console.log(`segmented option heights on a phone: ${[...new Set(heights)].join(", ")}`);
    expect(heights.length).toBeGreaterThan(5);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(34);
    await shoot(page, "controls-phone-settings");
  });
});
