import { expect, test, type APIRequestContext } from "./isolate.ts";
import { asksToRun, calls, create, drop, folder, scripted, settle } from "./answering.ts";
import { shoot } from "./shots.ts";

// Feature: a restart asked from the page says what it does to the turns there are now. A turn
// that works gets time to finish; a turn that only waits on the owner (an approval, a question)
// is not waited for, and is counted apart.
const daemon = async (request: APIRequestContext) => (await (await request.get("/api/daemon")).json()) as { running: string[]; waiting?: string[] };

test("the restart question counts the turns that wait on you apart from those that work", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("restart-ask");
  // Two turns that wait on an approval, and one that works (a command that runs for a while).
  const one = await asksToRun(request, "Waits for an approval", ws, "first");
  const two = await asksToRun(request, "Waits for another", ws, "second");
  const busy = await create(request, "Works for a while", ws);
  await request.put(`/api/sessions/${busy}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  await request.post(`/api/sessions/${busy}/messages`, { data: { text: calls([{ name: "Bash", input: { command: "sleep 30" } }]) } });
  await expect.poll(async () => (await daemon(request)).running.includes(busy), { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await daemon(request)).running.filter((id) => id === one || id === two).length, { timeout: 30_000 }).toBe(2);

  await page.goto("/settings/daemon");
  const panel = page.getByTestId("daemon-panel");
  await expect(panel.getByTestId("daemon-running")).toHaveText("1, 2 need you");
  await panel.getByTestId("daemon-restart").click();
  const confirm = page.getByTestId("confirm");
  await expect(confirm).toContainText("1 turn is working. New work waits; working turns get two minutes to finish, and any still working then go on after the restart. 2 turns wait on you for an answer, and still wait after the restart.");
  await shoot(page, "restart-ask-01-counted");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);

  // With nothing working, the question says so: the waiting turns are no reason to wait.
  await request.post(`/api/sessions/${busy}/interrupt`, { data: { by: "owner" } });
  await expect.poll(async () => (await daemon(request)).running.includes(busy), { timeout: 30_000 }).toBe(false);
  await expect(panel.getByTestId("daemon-running")).toHaveText("0, 2 need you", { timeout: 15_000 });
  await panel.getByTestId("daemon-restart").click();
  await expect(confirm).toContainText("No turn is working. 2 turns wait on you for an answer, and still wait after the restart. The page reconnects by itself.");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await drop(request, one, two, busy);
});
