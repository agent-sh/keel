import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the permission modes and the side panels are found by what they
// do, without reading a description of each. Modes are grouped by who decides
// (you, a model, or nothing changes) and each says in a few words what runs
// and what asks; the long description shows only for the mode in use. Panels
// are grouped by what the owner is after (the work, what happened, how the
// session is set up, what runs beside it), each with a few words of what it
// is, and the search matches those words.
test("modes and panels are grouped and say what they do", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "requires the scripted provider");
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "Find by name" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  try {
    await page.goto(`/s/${session.id}`);

    // First use: the mode for "edits run, commands ask" is the row that says so.
    const started = Date.now();
    await page.getByTestId("permission-menu").click();
    await page.getByRole("radio", { name: /edits run; commands ask/i }).click();
    expect(Date.now() - started).toBeLessThan(5000);
    await expect(page.getByTestId("permission-mode")).toHaveText("Auto edits");
    // The row says when a command does not ask: the sandbox and read-only commands are in its words.
    await expect(page.locator('[data-testid="mode-row"][data-mode="auto-edits"]').getByTestId("mode-summary")).toHaveText(/unless read-only or sandboxed/);
    // The groups are headed as the Panels picker's are: the same class, so the same face and size.
    const modeHead = await page.getByTestId("mode-group").first().evaluate((el) => { const c = getComputedStyle(el); return [el.className.includes("k-picker-group"), c.fontFamily, c.fontSize, c.fontWeight].join("|"); });
    expect(modeHead.startsWith("true|")).toBe(true);

    // Three groups, by who decides, and the three that sounded alike are told apart in a line each.
    const groups = page.getByTestId("mode-group");
    await expect(groups).toHaveText(["You decide", "A model decides", "Nothing changes"]);
    const row = (id: string) => page.locator(`[data-testid="mode-row"][data-mode="${id}"]`);
    for (const id of ["ask", "auto-edits", "reviewer", "auto", "full-auto", "read-only", "plan"]) await expect(row(id).getByTestId("mode-summary")).not.toBeEmpty();
    const lines = await Promise.all(["reviewer", "auto", "full-auto"].map((id) => row(id).getByTestId("mode-summary").innerText()));
    expect(new Set(lines).size).toBe(3);
    // The long description is shown for the mode in use only.
    await expect(page.getByTestId("mode-description")).toHaveCount(1);
    await expect(row("auto-edits").getByTestId("mode-description")).toBeVisible();
    // The groups do not change the keyboard: the arrows cross a group's line and move the focus only,
    // so a mode is never chosen by an arrow.
    await page.getByTestId("mode-auto-edits").focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("mode-reviewer")).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(page.getByTestId("mode-ask")).toBeFocused();
    await expect(page.getByTestId("permission-mode")).toHaveText("Auto edits");
    await shoot(page, "find-01-modes");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(row("plan")).toBeInViewport({ ratio: 1 });
    await shoot(page, "find-02-modes-phone");
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.keyboard.press("Escape");

    // Panels: the five at hand and the rest under More, with what each is beside its name.
    await page.getByTestId("panel-menu").click();
    const picker = page.getByTestId("panel-picker");
    await expect(picker.locator(".k-picker-group")).toHaveText(["At hand", "More"]);
    expect(await picker.locator(".k-picker-group").first().evaluate((el) => { const c = getComputedStyle(el); return [true, c.fontFamily, c.fontSize, c.fontWeight].join("|"); })).toBe(modeHead);
    const picks = picker.locator('[data-testid^="panel-pick-"]');
    for (const p of await picks.all()) await expect(p.getByTestId("panel-hint")).not.toBeEmpty();
    await shoot(page, "find-03-panels");
    // Found by what it does, not by its name.
    await page.getByTestId("panel-search").fill("cost");
    await expect(picks).toHaveCount(1);
    await expect(picks.first()).toHaveAttribute("data-testid", "panel-pick-usage");
    await page.getByTestId("panel-search").fill("without adding");
    await expect(picks.first()).toHaveAttribute("data-testid", "panel-pick-side");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("panel-search").fill("");
    await expect(picker).toBeInViewport({ ratio: 1 });
    await shoot(page, "find-04-panels-phone");
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.keyboard.press("Escape");

    // The search palette lists a panel once: its own row (the Work board, Landing and Review had that and a
    // generic "Open the ... panel" row beside it).
    await page.keyboard.press("Control+k");
    for (const name of ["work board", "landing", "review the branch"]) {
      await page.getByTestId("palette-input").fill(name);
      await expect(page.getByRole("option").filter({ hasText: new RegExp(name, "i") }).first()).toBeVisible();
      await expect(page.getByRole("option").filter({ hasText: /^Open the .* panel/ }), `"${name}" has no second row`).toHaveCount(0);
    }
    await page.getByTestId("palette-input").fill("work board");
    await shoot(page, "find-05-palette-panels");
    await page.keyboard.press("Escape");
  } finally { await request.delete(`/api/sessions/${session.id}`); }
});
