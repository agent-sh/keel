import { expect, test } from "./isolate.ts";
import { rmSync } from "node:fs";
import { daemon, exited, seeded } from "./own-daemon.ts";
import { shoot } from "./shots.ts";

// Feature: a long session costs what its end costs. Rows of finished turns are
// made and rendered once: a reply that streams below them, and the events it
// stores, leave them alone.

test("a reply under a long transcript renders only its own rows", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const EVENTS = 2000;
  const { state, ids: [id] } = seeded("rows", EVENTS, "turns", "Two thousand events");
  const d = await daemon(state);
  try {
    const stored = async () => ((await (await fetch(`${d.url}/api/sessions/${id}/events`)).json()) as any).events as { id: string; kind: string; data: any }[];
    const before = await stored();
    const prompts = before.filter((e) => e.kind === "user").length;
    await page.goto(`${d.url}/s/${id}`);
    await expect(page.getByTestId("compacted")).toBeVisible({ timeout: 30_000 });
    // The whole branch is in the page (the side branch's three prompts are not on it).
    await expect(page.getByTestId("user-message")).toHaveCount(prompts - 3, { timeout: 60_000 });

    // From here on: every row model made and every row rendered, by event id.
    await page.evaluate(() => {
      const w = window as any;
      w.__made = []; w.__rendered = [];
      w.__keelRows.made = (id: string) => w.__made.push(id);
      w.__keelRows.rendered = (id: string) => w.__rendered.push(id);
    });
    await page.getByTestId("composer").fill("script:render");
    await page.getByTestId("composer").press("Enter");
    await expect(page.getByTestId("draft")).toBeVisible({ timeout: 15_000 });
    await shoot(page, "long-transcript-01-streaming");
    await expect(page.getByTestId("turn-end")).toHaveCount(prompts - 3 + 1, { timeout: 60_000 });
    await expect(page.getByTestId("working")).toHaveCount(0);

    const fresh = new Set((await stored()).slice(before.length).map((e) => e.id));
    expect(fresh.size).toBeGreaterThanOrEqual(4);
    const { made, rendered } = await page.evaluate(() => ({ made: (window as any).__made as string[], rendered: (window as any).__rendered as string[] }));
    // Rows were made and rendered for the turn's events only. The footer that
    // stopped being the last one changed by itself: its Answer again went.
    expect(made.length).toBeGreaterThan(0);
    expect(made.filter((x) => !fresh.has(x))).toEqual([]);
    expect(rendered.filter((x) => fresh.has(x)).length).toBeGreaterThan(0);
    expect([...new Set(rendered.filter((x) => !fresh.has(x)))]).toEqual([]);
    await expect(page.getByTestId("retry")).toHaveCount(1);

    // The history is still all there: the page's own find reaches the first
    // prompt, and a finished turn's footer copies its reply.
    expect(await page.evaluate(() => (window as any).find("Prompt 1:", false, true, true))).toBe(true);
    await page.getByTestId("copy-reply").nth(4).click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain("Looking at **step 5**.");
    expect(clip).toContain("Reply 5 ends here.");
    await shoot(page, "long-transcript-02-after-reply");
  } finally {
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    rmSync(state, { recursive: true, force: true });
  }
});
