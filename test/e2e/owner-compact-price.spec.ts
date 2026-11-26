import { expect, test } from "./isolate.ts";
import { shoot, SCRIPTED } from "./shots.ts";

// Feature: the owner's own session compacts by price when he says so. The switch is in the session's menu, in a
// dialog that says what it does and shows the session's own numbers (context, first token, dollars an hour,
// compactions, steps) before it was turned on and since, so he keeps it or turns it off by what it did. The
// engine's part (a summary ahead, put in place at a turn's first step when its meaning check holds) is
// src/engine/owner-compact.test.ts: a priced point needs a context far larger than a spec can afford.
test("the owner turns on compaction by price from the session's menu and sees its numbers before and since", async ({ page, request }) => {
  test.skip(!SCRIPTED, "needs the scripted stand-in: the session's steps are scripted");
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in-strict", title: "Owner's long session" } })).json();
  const id = session.id as string;
  try {
    // One turn, so the ledger has a step of the session's own.
    await request.post(`/api/sessions/${id}/messages`, { data: { text: "hello" } });
    await expect.poll(async () => { const d = await (await request.get(`/api/sessions/${id}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; }, { timeout: 60_000 }).toBe(true);

    await page.goto(`/s/${id}`);
    await page.getByTestId("session-menu").click();
    await page.getByTestId("menu-price-compaction").click();
    const dialog = page.getByTestId("price-compaction-dialog");
    await expect(dialog).toContainText("never on a warm cache inside a turn");
    await expect(dialog.getByTestId("price-compaction-range")).toContainText("It saves most in a session of short turns");
    const numbers = dialog.getByTestId("price-compaction-numbers");
    // Off: the last day of the session alone.
    await expect(numbers.locator("thead th")).toHaveText(["This session", /^Last /]);
    await expect(numbers.locator("tbody tr").filter({ hasText: "Steps" }).locator("td").nth(1)).toHaveText("1");

    const flip = dialog.getByTestId("price-compaction-switch");
    await expect(flip).toHaveAttribute("aria-checked", "false");
    await flip.click();
    await expect(flip).toHaveAttribute("aria-checked", "true");
    // On: the session setting and when it moved, and a column since then beside the one before.
    await expect.poll(async () => (await (await request.get(`/api/sessions/${id}`)).json()).session.settings.owner_compact_by_price).toBe(true);
    const got = await (await request.get(`/api/sessions/${id}/price-compaction`)).json();
    expect(got.on).toBe(true);
    expect(typeof got.on_ms).toBe("number");
    expect(got.before.steps).toBe(1);
    await expect(numbers.locator("thead th")).toHaveText(["This session", /^Before, /, /^Since on, /]);
    await shoot(page, "owner-compact-price-01-on");

    await dialog.getByTestId("price-compaction-close").click();
    await page.getByTestId("session-menu").click();
    await expect(page.getByTestId("menu-price-compaction")).toHaveText("Compacting by price");
    await page.keyboard.press("Escape");
  } finally {
    await request.delete(`/api/sessions/${id}`);
  }
});
