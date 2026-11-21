import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: answering what waits on the owner by keyboard. Each test names the rule it holds.
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
const create = async (request: APIRequestContext, title: string, workspace: string) =>
  (await (await request.post("/api/sessions", { data: { model: MODEL, title, workspace } })).json()).session.id as string;
const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;
// Stops every turn an earlier test left open: what waits on the owner is read across the daemon's sessions.
async function settle(request: APIRequestContext) {
  const { sessions } = (await (await request.get("/api/sessions")).json()) as { sessions: { id: string; phase: string }[] };
  for (const s of sessions) if (s.phase === "working") await request.post(`/api/sessions/${s.id}/interrupt`);
}
// A session that waits on an approval of one command.
async function asksToRun(request: APIRequestContext, title: string, ws: string, word: string) {
  const id = await create(request, title, ws);
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([{ name: "Bash", input: { command: `echo ${word} > ${word}.txt` } }]) } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${id}/approvals`)).json()).approvals.length).toBe(1);
  return id;
}
const approvals = async (request: APIRequestContext, id: string) =>
  (await (await request.get(`/api/sessions/${id}/approvals?all`)).json()).approvals as { state: string; choice?: string }[];
const keysOn = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? document.activeElement?.tagName ?? "");

test("Esc twice on an approval gives the keyboard back to Allow once", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const id = await asksToRun(request, "Esc and back", folder("esc"), "escback");
  await page.goto(`/s/${id}`);
  const card = page.getByTestId("approval");
  const allow = card.getByTestId("allow-once");
  await expect(allow).toBeFocused();
  // Esc opens the reason, Esc again leaves it: the keyboard is on Allow once, not on the page.
  await page.keyboard.press("Escape");
  await expect(card.getByTestId("deny-reason")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(allow).toBeFocused();
  expect(await keysOn(page)).toBe("allow-once");
  await shoot(page, "answer-keys-01-esc-back");
  // The Back button does the same.
  await page.keyboard.press("Escape");
  await card.getByRole("button", { name: "Back" }).click();
  await expect(allow).toBeFocused();
  // And Enter still allows, once the button has stood for its second.
  await expect(card).toHaveAttribute("data-live", "true");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await approvals(request, id))[0]).toMatchObject({ state: "allowed", choice: "once" });
  await expect(page.getByTestId("composer")).toBeFocused();
  await request.delete(`/api/sessions/${id}`);

  // A card whose command is not all on it takes no answer: leaving the reason puts the keyboard
  // on the list of requests, where the card's own rule keeps it, and Enter there answers nothing.
  const long = await create(request, "Esc and back, cut", folder("esc-cut"));
  await request.put(`/api/sessions/${long}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  const lines = `${Array.from({ length: 40 }, (_, i) => `echo step ${i + 1}`).join("\n")}\necho last > last.txt`;
  await request.post(`/api/sessions/${long}/messages`, { data: { text: calls([{ name: "Bash", input: { command: lines } }]) } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${long}/approvals`)).json()).approvals.length).toBe(1);
  await page.goto(`/s/${long}`);
  await expect(card).toHaveAttribute("data-must-open", "true");
  const list = page.getByTestId("approvals");
  await expect(list).toBeFocused();
  await card.getByTestId("deny").click();
  await expect(card.getByTestId("deny-reason")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(list).toBeFocused();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  expect((await approvals(request, long))[0]).toMatchObject({ state: "pending" });
  await request.post(`/api/sessions/${long}/interrupt`);
  await request.delete(`/api/sessions/${long}`);
});
