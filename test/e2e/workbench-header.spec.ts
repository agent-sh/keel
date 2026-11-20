import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

test.use({ storageState: { cookies: [], origins: [] } });

test("the active pane has a single identity line and a background pane keeps its preview", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string; provider: string; context: number }[];
  const model = models.filter((m) => m.provider === "scripted").sort((a, b) => b.context - a.context)[0];
  test.skip(!model, "requires a scripted scratch daemon");
  const made: string[] = [];
  const create = async (title: string) => {
    const { session } = await (await request.post("/api/sessions", { data: { title, model: model!.id } })).json();
    made.push(session.id);
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "Review the release checklist." } });
    await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).events.some((e: { kind: string }) => e.kind === "turn_end")).toBe(true);
    return session.id as string;
  };
  const pane = (id: string) => page.getByTestId("station").and(page.locator(`[data-station="${id}"]`));
  try {
    const first = await create("Review the release checklist");
    const second = await create("Check the app update");
    await page.goto(`/s/${first}`);
    await expect(pane(first)).toHaveAttribute("data-helm", "true");
    await expect(pane(first).getByTestId("composer")).toBeVisible();
    const other = page.getByTestId("session-list").locator(`[data-session="${second}"]`);
    await other.hover();
    await other.getByTestId("row-beside").click();
    const active = pane(second);
    const background = pane(first);
    await expect(active).toHaveAttribute("data-helm", "true");
    await expect(active.getByTestId("station-word")).toHaveText("Done");
    await expect(active.getByTestId("session-menu")).toBeVisible();
    await expect(background.locator(".k-station-line")).toBeVisible();
    await shoot(page, "workbench-head");
    await expect(active.locator(".k-station-line")).toBeHidden();
    const title = (await active.getByRole("heading", { name: "Check the app update", level: 2 }).boundingBox())!;
    const state = (await active.getByTestId("station-word").boundingBox())!;
    expect(Math.abs(title.y + title.height / 2 - state.y - state.height / 2)).toBeLessThan(5);
    await active.getByTestId("session-menu").click();
    await page.getByTestId("menu-rename").click({ timeout: 5000 });
    const name = active.getByRole("textbox", { name: "Session title" });
    await name.fill("App update ready");
    await name.press("Enter");
    await expect(active.getByRole("heading", { name: "App update ready", level: 2 })).toBeVisible();
  } finally {
    for (const id of made) await request.delete(`/api/sessions/${id}`);
  }
});
