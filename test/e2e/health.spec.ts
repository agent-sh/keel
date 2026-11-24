import { expect, test } from "./isolate.ts";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { shoot } from "./shots.ts";

// Feature: Settings > Health, the page behind `keel doctor`. One list of what is wrong:
// a skill file whose front matter never closes and a hook matcher that matches no tool are
// broken rows, each with its fix and a button to the section that fixes it; what is well is
// listed too. The check changes none of the owner's files and spends no tokens: a provider is asked for its listing, never for an answer.
// Runs on a scratch daemon: the spec writes its owner hooks file and a skill into its config folder.
test("health: a broken skill and a dead hook matcher are rows with their fix and a link", async ({ page, request }) => {
  const info = await (await request.get("/api/hooks")).json();
  const config = dirname(info.owner_path);
  test.skip(!config.includes("keel-work") && !config.includes("/dev"), "needs a scratch owner config folder: this test writes a hooks file and a skill there");
  const hooks: string = info.owner_path;
  const skill = join(config, "skills", "torn-skill");
  const was = existsSync(hooks) ? readFileSync(hooks, "utf8") : undefined;
  try {
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: torn-skill\ndescription: its front matter never closes\n\nBody of the skill.\n");
    writeFileSync(hooks, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bsh", hooks: [{ type: "command", command: "true" }] }] } }));

    // The answer, before the page: both are broken, and nothing was paid for.
    const report = await (await request.get("/api/health/check")).json();
    expect(report.counts.broken).toBeGreaterThanOrEqual(2);
    expect(report.rows.find((r: any) => r.group === "providers" && r.id === "provider:scripted")?.how).toBe("no call made");

    await page.goto("/settings/health");
    const panel = page.getByTestId("health-panel");
    await expect(panel).toHaveAttribute("data-state", "done");
    await expect(page.getByTestId("health-note")).toContainText("changes none of your files or settings and spends no tokens");
    const broken = page.locator('[data-testid="health-row"][data-level="broken"]');
    const torn = broken.filter({ hasText: "torn-skill" });
    await expect(torn).toHaveCount(1);
    await expect(torn).toContainText("never closes");
    await expect(torn.getByTestId("health-fix")).toContainText("closing ---");
    const dead = broken.filter({ hasText: '"Bsh"' });
    await expect(dead).toHaveCount(1);
    await expect(dead).toContainText("matches none of Keel's tools");
    await expect(page.locator('[data-testid="health-count"][data-level="broken"]')).toContainText(String(report.counts.broken));
    // What is well is in the list too.
    await expect(page.locator('[data-testid="health-row"][data-level="ok"]').first()).toBeVisible();
    await shoot(page, "health-01-broken");

    // A narrow page keeps the row's fix and its button.
    await page.setViewportSize({ width: 420, height: 900 });
    await expect(torn.getByTestId("health-open")).toBeVisible();
    await shoot(page, "health-02-narrow");
    await page.setViewportSize({ width: 1920, height: 1040 });

    // The whole list on a tall page.
    await page.setViewportSize({ width: 1920, height: 2200 });
    await shoot(page, "health-04-all");
    await page.setViewportSize({ width: 1920, height: 1040 });

    // The button goes where the file is fixed.
    await torn.getByTestId("health-open").click();
    await expect(page).toHaveURL(/\/customize\/skills$/);

    // Fixed, and asked again: the two rows are gone.
    writeFileSync(join(skill, "SKILL.md"), "---\nname: torn-skill\ndescription: closed now\n---\nBody of the skill.\n");
    writeFileSync(hooks, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "true" }] }] } }));
    await page.goto("/settings/health");
    await expect(page.getByTestId("health-panel")).toHaveAttribute("data-state", "done");
    await expect(page.locator('[data-testid="health-row"]').filter({ hasText: "torn-skill" })).toHaveCount(0);
    await expect(page.locator('[data-testid="health-row"]').filter({ hasText: '"Bsh"' })).toHaveCount(0);
    await shoot(page, "health-03-fixed");
  } finally {
    rmSync(skill, { recursive: true, force: true });
    if (was === undefined) rmSync(hooks, { force: true });
    else writeFileSync(hooks, was);
  }
});

// A check that cannot be read is an error with a way to ask again, never "Checking." for good; and the check
// reads the folder the owner works in (the start box's folder here), not only the daemon's own.
test("health: a failed check shows its error and asks again; the owner's folder goes with the ask", async ({ page }) => {
  const asked: string[] = [];
  let failing = true;
  await page.addInitScript(() => localStorage.setItem("keel.newWorkspace", JSON.stringify("/tmp/health-folder")));
  await page.route("**/api/health/check*", (route) => {
    asked.push(route.request().url());
    return failing ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "the check broke" }) }) : route.continue();
  });
  await page.goto("/settings/health");
  await expect(page.getByTestId("health-failed")).toBeVisible();
  await expect(page.getByTestId("health-wait")).toHaveCount(0);
  failing = false;
  await page.getByTestId("health-again").click();
  await expect(page.getByTestId("health-panel")).toHaveAttribute("data-state", "done");
  expect(asked.length).toBe(2);
  expect(asked.every((u) => new URL(u).searchParams.get("cwd") === "/tmp/health-folder")).toBe(true);
});
