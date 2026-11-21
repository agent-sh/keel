import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openPanel, shoot } from "./shots.ts";

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
});
