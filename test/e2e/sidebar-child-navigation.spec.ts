import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

const script = (name: string, input: object) => `script:calls ${JSON.stringify([{ name, input }])}`;

test("a finished parent stays in the sidebar while viewing its agent", async ({ page, request }) => {
  const { models } = await (await request.get("/api/models")).json() as { models: { id: string; provider: string; context: number }[] };
  const model = models.filter((m) => m.provider === "scripted").sort((a, b) => b.context - a.context)[0];
  test.skip(!model, "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const workspace = mkdtempSync(join(tmpdir(), "keel-sidebar-"));
  const gate = join(workspace, "released");
  let parent: string | undefined;
  try {
    const created = await request.post("/api/sessions", { data: { model: model!.id, title: "Review the release", workspace } });
    expect(created.status()).toBe(201);
    parent = (await created.json()).session.id as string;
    const path = `/api/sessions/${parent}`;
    expect((await request.put(`${path}/permissions`, { data: { mode: "full-auto" } })).ok()).toBe(true);
    const message = `Check the release notes\n${script("wait_for", { kind: "file", path: gate })}`;
    expect((await request.post(`${path}/messages`, { data: { text: script("spawn_agent", { message, isolation: "none" }) } })).ok()).toBe(true);

    await page.goto(`/s/${parent}`);
    const row = page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${parent}"]`);
    const kids = row.locator("xpath=..").getByTestId("session-children");
    await expect(page.getByTestId("dock-agents")).toHaveAttribute("aria-label", /1 waiting/);
    await page.getByTestId("list-arrange").click();
    await page.getByTestId("arrange-hide-done").click();
    await page.keyboard.press("Escape");
    await row.locator("xpath=..").getByTestId("children-toggle").click();
    const child = kids.getByTestId("child-session");
    await child.press("Enter");
    await expect(page.getByTestId("task-notice")).toBeVisible();
    const childUrl = page.url();
    // Its own turn ended and its one agent is parked on a file: nothing of it runs, so it waits.
    await expect(row).toHaveAttribute("data-watch", "wait");

    // The agent and then its parent finish over the live socket. The parent
    // must not unmount the branch the owner is reading.
    writeFileSync(gate, "go\n");
    await expect(page.getByTestId("station-word")).toHaveText("Done");
    await expect(row).toHaveAttribute("data-watch", "done");
    await expect(child).toBeVisible();
    await shoot(page, "sidebar-child-navigation");

    await row.click();
    await expect(page).toHaveURL(`/s/${parent}`);
    await page.goBack();
    await expect(page).toHaveURL(childUrl);
    await expect(child).toBeVisible();
    await page.getByTestId("new-session").click();
    await expect(row).toHaveCount(0);
  } finally {
    writeFileSync(gate, "go\n");
    if (parent) await request.delete(`/api/sessions/${parent}`);
    rmSync(workspace, { recursive: true, force: true });
  }
});
