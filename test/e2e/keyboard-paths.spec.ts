import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the daily paths by keyboard. Each test names the path it holds.
const MODEL = "scripted:stand-in";
// Every pane on screen: no focus mode (the config's default for the other specs).
test.use({ storageState: { cookies: [], origins: [] } });

async function scripted(request: APIRequestContext) {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === MODEL), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
}
const folder = (name: string) => {
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `${name}-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  return ws;
};
const create = async (request: APIRequestContext, title: string, workspace?: string) =>
  (await (await request.post("/api/sessions", { data: { model: MODEL, title, ...(workspace && { workspace }) } })).json()).session.id as string;
const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;

test("the palette shows only rows of the query that is typed", async ({ page, request }) => {
  await scripted(request);
  const ws = folder("palette");
  const word = `stale${Date.now()}`;
  const id = await create(request, "Check the types", ws);
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  // A command and its output: two hits in one event, on one call.
  await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([{ name: "Bash", input: { command: `echo ${word}` } }]) } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${id}`)).json()).events.some((e: any) => e.kind === "turn_end"), { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await (await request.get(`/api/search?q=${word}&limit=12`)).json()).hits.filter((h: any) => h.kind.startsWith("tool_")).length).toBe(2);

  await page.goto(`/s/${id}`);
  await page.keyboard.press("Control+k");
  const input = page.getByTestId("palette-input");
  const rows = page.getByTestId("palette").getByRole("option");
  await input.fill(word);
  await expect(rows.filter({ hasText: "Command" }).first()).toContainText(word);
  await expect(rows.filter({ hasText: "Tool output" }).first()).toContainText(word);
  await shoot(page, "keyboard-paths-04-palette-query");

  // Another query: no row of the first one is left, and one row is the highlighted one.
  for (const next of ["settings", "theme", "zzqq-nothing"]) {
    await input.fill(next);
    await expect(page.getByTestId("palette-searching")).toHaveCount(0);
    await expect(rows.filter({ hasText: word })).toHaveCount(0);
    expect(await page.getByTestId("palette").locator('[role="option"][aria-selected="true"]').count()).toBeLessThanOrEqual(1);
  }
  await expect(page.getByTestId("palette")).toContainText('Nothing matches "zzqq-nothing".');
  await input.fill("theme");
  await expect(rows.first()).toContainText("Theme");
  await shoot(page, "keyboard-paths-05-palette-next-query");
  await page.keyboard.press("Escape");
  await request.delete(`/api/sessions/${id}`);
});
