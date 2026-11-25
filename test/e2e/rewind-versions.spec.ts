import { expect, test } from "./isolate.ts";
import { HAIKU, SCRIPTED, shoot } from "./shots.ts";
import { branch, send, twoTurns } from "./rewind.ts";

// Feature: a prompt typed after a rewind is a version of the prompt it replaced (the arrows reach the abandoned
// branch), the first prompt can be rewound to, and the dialog lists every prompt of a long conversation.
test.skip(!SCRIPTED, "needs the scripted stand-in");

test("the prompt typed after a rewind stands beside the one it replaced, arrows between", async ({ page, request }) => {
  const { id } = await twoTurns(request, page, { files: false });
  const old = (await branch(request, id)).filter((e) => e.kind === "user")[1].data.text as string;
  await page.getByTestId("user-message").nth(1).hover();
  await page.getByRole("button", { name: "Rewind to before this prompt" }).nth(1).click();
  await page.getByTestId("rewind-prompt-go").click();
  await expect(page.getByTestId("rewind-dialog")).toBeHidden();
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  await send(page, "script:say the new second", 3);
  await expect(page.getByTestId("user-message").nth(1)).toContainText("the new second");
  await expect(page.getByTestId("branch-pos").last()).toHaveText("2/2");
  await shoot(page, "rewind-versions-01-arrows");
  await page.getByRole("button", { name: "Previous version" }).last().click();
  await expect(page.getByTestId("user-message").nth(1)).toContainText(old);
  await expect(page.getByTestId("branch-pos").last()).toHaveText("1/2");
});

test("rewinding to the first prompt leaves a conversation that reads, and the new first prompt is a version of the old", async ({ page, request }) => {
  const { id } = await twoTurns(request, page, { files: false });
  const first = (await branch(request, id)).filter((e) => e.kind === "user")[0].data.text as string;
  await page.getByTestId("user-message").nth(0).hover();
  await page.getByRole("button", { name: "Rewind to before this prompt" }).nth(0).click();
  const dialog = page.getByTestId("rewind-dialog");
  await expect(dialog.getByTestId("rewind-prompt")).toHaveCount(2);
  await dialog.getByTestId("rewind-prompt-go").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("user-message")).toHaveCount(0);
  await expect(page.getByTestId("rewound")).toContainText("rewound the chat");
  await expect(page.getByTestId("composer")).toHaveValue(first);
  await shoot(page, "rewind-versions-02-first");
  // The dialog still opens (the rewind line is the whole branch), and Undo brings both turns back.
  await page.getByTestId("composer").fill("");
  await page.getByTestId("undo-rewind").click();
  await expect(page.getByTestId("user-message")).toHaveCount(2);
  // Rewind again and send a new first prompt: it is a version of the old one.
  await page.getByTestId("user-message").nth(0).hover();
  await page.getByRole("button", { name: "Rewind to before this prompt" }).nth(0).click();
  await page.getByTestId("rewind-prompt-go").click();
  await expect(page.getByTestId("user-message")).toHaveCount(0);
  await send(page, "script:say a new start", 3);
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  await expect(page.getByTestId("branch-pos")).toHaveText("2/2");
  await page.getByRole("button", { name: "Previous version" }).click();
  await expect(page.getByTestId("user-message")).toHaveCount(2);
  await expect(page.getByTestId("branch-pos").first()).toHaveText("1/2");
});

test("the dialog lists every prompt of a long conversation, not only the ones the page holds", async ({ page, request }) => {
  test.setTimeout(240_000);
  const { session } = await (await request.post("/api/sessions", { data: { workspace: process.env.HOME + "/.cache/keel-work/bun/e2e-ws", model: HAIKU } })).json();
  const N = 70;
  for (let i = 1; i <= N; i++) {
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:say prompt ${i}` } });
    await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}?events=0`)).json()).session.phase, { timeout: 30_000 }).toBe("idle");
  }
  await page.goto(`/s/${session.id}`);
  await expect(page.getByTestId("composer")).toBeVisible();
  // The page holds its newest part only.
  await expect.poll(async () => page.getByTestId("user-message").count()).toBeLessThan(N);
  await page.getByTestId("composer").fill("/rewind");
  await page.getByTestId("composer").press("Enter");
  const dialog = page.getByTestId("rewind-dialog");
  await expect(dialog.getByTestId("rewind-prompt")).toHaveCount(N);
  await expect(dialog.getByTestId("rewind-prompt").first()).toContainText("script:say prompt 1");
  await shoot(page, "rewind-versions-03-long");
});
