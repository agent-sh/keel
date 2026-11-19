import { expect, test } from "./isolate.ts";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

// A 2x2 PNG, sent as is: the bytes the model gets must be these.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGM4YaOh0XOHAUIBACUCBXmhkn0oAAAAAElFTkSuQmCC";

// Feature: the session draft. Text and an image put in from outside land in
// the message box once; the image survives a reload and a session switch; a
// capture without a session goes to the one the owner is typing in; the sent
// message carries the image byte for byte, and an image queued while a turn
// runs reaches the model with its prompt.
test("session draft", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const prev = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `draft-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const mk = async (title: string) => (await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU, title } })).json()).session.id as string;
  const a = await mk("Draft target");
  const b = await mk("Another session");

  await page.goto(`/s/${a}`);
  await expect(page.getByTestId("composer")).toBeVisible();

  // 1. Put in from outside while the page is open.
  const put = await request.post(`/api/sessions/${a}/draft`, { data: { text: "What is in this picture?", images: [{ name: "capture.png", mime: "image/png", data: PNG }], origin: "capture" } });
  expect(put.status()).toBe(200);
  await expect(page.getByTestId("composer")).toHaveValue("What is in this picture?");
  await expect(page.getByTestId("attachments").locator("img")).toHaveCount(1);
  await expect(page.getByText("Text added from capture.")).toBeVisible();
  await shoot(page, "draft-01-from-outside");
  // Taken once: the server draft keeps the image for the box, not the text.
  const d1 = await (await request.get(`/api/sessions/${a}/draft`)).json();
  expect(d1.text).toBeUndefined();
  expect(d1.attachments).toHaveLength(1);

  // 2. Typing makes this the target of a capture without a session.
  await page.getByTestId("composer").pressSequentially(" Short answer.");
  await expect.poll(async () => (await (await request.get("/api/draft/target")).json()).session_id).toBe(a);

  // 3. A reload and a switch to another session keep the image and the text.
  await page.reload();
  await expect(page.getByTestId("attachments").locator("img")).toHaveCount(1);
  await page.goto(`/s/${b}`);
  await expect(page.getByTestId("attachments")).toHaveCount(0);
  await page.goto(`/s/${a}`);
  await expect(page.getByTestId("attachments").locator("img")).toHaveCount(1);
  await expect(page.getByTestId("composer")).toHaveValue("What is in this picture? Short answer.");

  // 4. Send: the model gets the same bytes; the draft is empty after.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 120_000 });
  const ev = (await (await request.get(`/api/sessions/${a}`)).json()).events.find((e: any) => e.kind === "user");
  expect(ev.data.images?.[0]?.data).toBe(PNG);
  expect((await (await request.get(`/api/sessions/${a}/draft`)).json()).attachments).toHaveLength(0);

  // 5. Queue an image while a turn runs: it waits with its prompt and reaches the model.
  await page.getByTestId("composer").fill("Run the Bash command `sleep 4` and then reply with the word slept.");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("tool-call").last()).toBeVisible({ timeout: 60_000 });
  await request.post(`/api/sessions/${a}/draft`, { data: { images: [{ name: "second.png", mime: "image/png", data: PNG }], origin: "capture" } });
  await expect(page.getByTestId("attachments").locator("img")).toHaveCount(1);
  await page.getByTestId("composer").fill("And this one, in three words?");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("queue-images")).toHaveText("1 image");
  await shoot(page, "draft-02-queued-image");
  await expect(page.getByTestId("turn-end")).toHaveCount(3, { timeout: 180_000 });
  const users = (await (await request.get(`/api/sessions/${a}`)).json()).events.filter((e: any) => e.kind === "user");
  expect(users.at(-1).data.images?.[0]?.data).toBe(PNG);

  // Bad input is refused with a reason.
  expect((await request.post(`/api/sessions/${a}/draft`, { data: { images: [{ mime: "application/pdf", data: PNG }] } })).status()).toBe(400);
  expect((await request.post(`/api/sessions/nope/draft`, { data: { text: "x" } })).status()).toBe(404);

  // Deleting a session takes its unsent draft (text and files) with it.
  const gone = (await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Draft then delete" } })).json()).session.id;
  await request.post(`/api/sessions/${gone}/draft`, { data: { text: "unsent words", images: [{ mime: "image/png", data: PNG }] } });
  expect((await request.delete(`/api/sessions/${gone}`)).ok()).toBe(true);
  const { state_dir } = await (await request.get("/api/daemon")).json();
  const db = new DatabaseSync(join(state_dir, "keel.db"), { readOnly: true });
  const left = db.prepare("SELECT (SELECT COUNT(*) FROM drafts WHERE session_id = ?) + (SELECT COUNT(*) FROM draft_files WHERE session_id = ?) AS n").get(gone, gone) as { n: number };
  db.close();
  expect(left.n).toBe(0);

  await request.put("/api/permissions/settings", { data: { default_mode: prev } });
  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
