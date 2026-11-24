import { expect, test, type APIRequestContext } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the bell in the bottom bar counts what waits on the owner, in the color of that, and
// shows other news (a finished session) as a quiet dot with no number. Its name is on hover and on
// keyboard focus, and the same number is the Inbox's "Needs you".

const MODEL = "scripted:stand-in";
const scripted = async (request: APIRequestContext) => (await (await request.get("/api/models")).json()).models.some((m: any) => m.id === MODEL);
const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;
const bash = (command: string) => ({ name: "Bash", input: { command } });
async function make(request: APIRequestContext, title: string, mode: "ask" | "full-auto", text: string) {
  const s = (await (await request.post("/api/sessions", { data: { model: MODEL, title } })).json()).session;
  await request.put(`/api/sessions/${s.id}/permissions`, { data: { mode, sandbox: "off" } });
  await request.post(`/api/sessions/${s.id}/messages`, { data: { text } });
  return s.id as string;
}

test("the bell counts what waits on you; a finish is a dot, not a number", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const ids: string[] = [];
  try {
    await request.post("/api/alerts/read", { data: {} });
    await page.goto("/");
    await expect(page.getByTestId("new-composer")).toBeVisible();
    const bell = page.getByTestId("inbox-button");
    // A session finishes while the page shows the home: news, but nothing waits on the owner.
    ids.push(await make(request, "Bell: a finish", "full-auto", calls([bash("echo done")])));
    await expect(page.getByTestId("inbox-button")).toHaveAttribute("data-news", "true", { timeout: 30_000 });
    await expect(page.getByTestId("inbox-count")).toHaveCount(0);
    await expect(bell).toHaveAccessibleName(/1 unread: new since you last looked/);
    await shoot(page, "bell-badge-01-dot");
    // A session asks for an approval: that is counted, in the need color, beside the dot.
    ids.push(await make(request, "Bell: an approval", "ask", calls([bash("rm -rf dist")])));
    await expect(page.getByTestId("inbox-count")).toHaveText("1", { timeout: 30_000 });
    await expect(page.getByTestId("inbox-count")).toHaveAttribute("data-watch", "need");
    await expect(bell).toHaveAccessibleName(/1 thing waits on you/);
    await shoot(page, "bell-badge-02-need");
    // Reading everything clears the dot; what waits on the owner stays counted.
    await bell.click();
    await page.getByTestId("mark-all-read").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("inbox-button")).not.toHaveAttribute("data-news", "true");
    await expect(page.getByTestId("inbox-count")).toHaveText("1");
    // The bell's name shows on hover and on the keyboard's focus.
    await bell.hover();
    await expect(page.locator(".k-tip")).toContainText("Inbox", { timeout: 5_000 });
    await page.mouse.move(700, 500);
    await expect(page.locator(".k-tip")).toHaveCount(0);
    await bell.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(bell).toBeFocused();
    await expect(page.locator(".k-tip")).toContainText("Inbox", { timeout: 5_000 });
  } finally {
    for (const id of ids) {
      await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }).catch(() => {});
      await request.delete(`/api/sessions/${id}`).catch(() => {});
    }
    await request.post("/api/alerts/read", { data: {} });
  }
});

test("a failure among the unread colours the bell's dot and is said in its name", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const ids: string[] = [];
  try {
    await request.post("/api/alerts/read", { data: {} });
    await page.goto("/");
    await expect(page.getByTestId("new-composer")).toBeVisible();
    const bell = page.getByTestId("inbox-button");
    // A finish is a quiet dot that says nothing of failure.
    ids.push(await make(request, "Bell: finish before", "full-auto", calls([bash("echo ok")])));
    await expect(page.getByTestId("inbox-button")).toHaveAttribute("data-news", "true", { timeout: 30_000 });
    await expect(page.getByTestId("inbox-button")).not.toHaveAttribute("data-wrong", "true");
    await expect(bell).not.toHaveAccessibleName(/failed/);
    // A session fails: the dot takes the failed color and the bell's name says how many.
    ids.push(await make(request, "Bell: a failure", "full-auto", "script:billing"));
    await expect(page.getByTestId("inbox-button")).toHaveAttribute("data-wrong", "true", { timeout: 30_000 });
    await expect(page.getByTestId("inbox-count")).toHaveCount(0);
    await expect(bell).toHaveAccessibleName(/1 failed/);
    await expect(bell).toHaveAttribute("title", /1 failed/);
    await shoot(page, "bell-badge-03-failed-dot");
    // Reading clears both.
    await bell.click();
    await page.getByTestId("mark-all-read").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("inbox-button")).not.toHaveAttribute("data-news", "true");
    await expect(bell).not.toHaveAccessibleName(/failed/);
  } finally {
    for (const id of ids) {
      await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }).catch(() => {});
      await request.delete(`/api/sessions/${id}`).catch(() => {});
    }
    await request.post("/api/alerts/read", { data: {} });
  }
});
