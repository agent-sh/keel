import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the page of a session that waits for an approval says what it waits for once. The
// command's step row says it is not run yet (never "No output.", which reads as ran and printed
// nothing), and the running line under the transcript is not there while the approval card is.

const MODEL = "scripted:stand-in";
const scripted = async (request: APIRequestContext) => (await (await request.get("/api/models")).json()).models.some((m: any) => m.id === MODEL);

async function asking(request: APIRequestContext, page: Page, title: string) {
  const s = (await (await request.post("/api/sessions", { data: { model: MODEL, title } })).json()).session;
  await request.put(`/api/sessions/${s.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await request.post(`/api/sessions/${s.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "rm -rf dist build node_modules/.cache" } }])}` } });
  await page.goto(`/s/${s.id}`);
  await expect(page.getByTestId("approval")).toBeVisible({ timeout: 30_000 });
  return s as { id: string };
}
async function drop(request: APIRequestContext, id: string) {
  await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }).catch(() => {});
  await request.delete(`/api/sessions/${id}`).catch(() => {});
}

test("a command that waits for approval says it is not run, not that it printed nothing", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const s = await asking(request, page, "Approval page: a command that waits");
  try {
    // The step row's terminal, when it is not open, opens from its row.
    if (!(await page.getByTestId("terminal").count())) await page.getByTestId("tool-call").first().getByRole("button").first().click();
    await expect(page.getByTestId("terminal")).toBeVisible();
    await expect(page.getByTestId("no-output")).toHaveText("Not run: waits for your approval");
    await shoot(page, "approval-page-1920");
    await page.setViewportSize({ width: 1400, height: 900 });
    await shoot(page, "approval-page-1400");
  } finally {
    await drop(request, s.id);
  }
});

test("the approval page has no running line under the card that asks the same", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const s = await asking(request, page, "Approval page: one line of it");
  try {
    await expect(page.getByTestId("working")).toHaveCount(0);
  } finally {
    await drop(request, s.id);
  }
});
