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
  await page.getByTestId("composer").fill(HAIKU.startsWith("scripted:")
    ? 'script:calls [{"name":"Bash","input":{"command":"sleep 4"}}]'
    : "Run the Bash command `sleep 4` and then reply with the word slept.");
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

test("a refused send stays separate from the next draft", async ({ page, request }) => {
  const mk = async (title: string) => (await (await request.post("/api/sessions", { data: { model: HAIKU, title } })).json()).session.id as string;
  const a = await mk("Draft recovery");
  const b = await mk("Other composer");
  const messages = `/api/sessions/${a}/messages`;
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const posts: { text: string; images: { data: string }[] }[] = [];
  await page.route(messages, async (r) => {
    posts.push(r.request().postDataJSON());
    if (posts.length > 1) return r.fallback();
    held.resolve();
    await release.promise;
    await r.fulfill({ status: 400, json: { error: "The daemon refused this message." } });
  });
  const attach = async (name: string) => {
    expect((await request.post(`/api/sessions/${a}/draft`, { data: { images: [{ name, mime: "image/png", data: PNG }], origin: "capture" } })).ok()).toBe(true);
    await expect(page.getByTestId("attachments").getByRole("img", { name })).toBeVisible();
  };
  const composer = page.getByTestId("composer");
  const saved = page.getByTestId("saved-draft");
  await page.goto(`/s/${a}`);
  await composer.fill("Review the first screenshot.");
  await attach("first.png");
  await composer.press("Enter");
  await held.promise;
  await composer.fill("A separate note for later.");
  await attach("next.png");

  // The response arrives with the original composer unmounted.
  const select = (id: string) => page.locator(`[data-testid="session-row"][data-session="${id}"]`).click();
  await select(b);
  await composer.fill("A draft in another session.");
  const refused = page.waitForResponse((r) => r.url().endsWith(messages) && r.status() === 400);
  release.resolve();
  await refused;
  await expect(saved).toHaveCount(0);
  await expect(composer).toHaveValue("A draft in another session.");
  // The session it was for says so on its row, while the other one is shown.
  const row = page.locator(`[data-testid="session-row"][data-session="${a}"]`);
  await expect(row).toHaveAttribute("data-watch", "need");
  await expect(row.getByTestId("unsent-mark")).toHaveText("not sent");
  await shoot(page, "draft-05-row-mark");
  await select(a);
  await expect(saved).toContainText("Review the first screenshot.");
  await expect(saved).toContainText("first.png");
  await expect(composer).toHaveValue("A separate note for later.");
  await expect(page.getByTestId("attachments").locator("img")).toHaveAttribute("alt", "next.png");
  await expect(saved).toContainText("The daemon refused this message.");
  await shoot(page, "draft-03-rejected-send");

  // A reload keeps the item with its own image; the box keeps only its own.
  await page.reload();
  await expect(saved).toContainText("Review the first screenshot.");
  await expect(saved).toContainText("first.png");
  await expect(composer).toHaveValue("A separate note for later.");
  await expect(page.getByTestId("attachments").locator("img")).toHaveCount(1);
  await expect(page.getByTestId("attachments").locator("img")).toHaveAttribute("alt", "next.png");

  // Two clicks before the page draws again: the second finds the item already sending.
  const retry = saved.getByRole("button", { name: "Retry send" });
  await expect(retry).toBeEnabled();
  await retry.evaluate((b: HTMLButtonElement) => { b.click(); b.click(); });
  await expect(saved).toHaveCount(0);
  await expect(row).not.toHaveAttribute("data-watch", "need");
  await expect(row.getByTestId("unsent-mark")).toHaveCount(0);
  await expect(composer).toHaveValue("A separate note for later.");
  await expect(page.getByTestId("attachments").locator("img")).toHaveAttribute("alt", "next.png");
  expect(posts.map((p) => p.text)).toEqual(["Review the first screenshot.", "Review the first screenshot."]);
  expect(posts[1]?.images.map((i) => i.data)).toEqual([PNG]);
  await expect(page.getByTestId("turn-end")).toHaveCount(1);

  // Lose a response only after the real daemon has accepted the message.
  await page.route(messages, async (r) => {
    posts.push(r.request().postDataJSON());
    expect((await r.fetch()).status()).toBe(201);
    await r.abort("failed");
  }, { times: 1 });
  await composer.press("Enter");
  await expect(saved).toContainText("Delivery unconfirmed");
  await expect(saved.getByTestId("saved-reason")).toHaveText("The daemon's answer did not arrive.");
  await expect(saved.getByRole("button", { name: "Retry send" })).toHaveCount(0);
  await expect(row.getByTestId("unsent-mark")).toHaveText("unconfirmed");
  await shoot(page, "draft-04-unconfirmed-send");
  await expect(composer).toHaveValue("");
  await composer.fill("Keep this one too.");
  await saved.getByRole("button", { name: "Restore draft" }).click();
  await expect(composer).toHaveValue("A separate note for later.");
  await expect(page.getByTestId("attachments").locator("img")).toHaveAttribute("alt", "next.png");
  await expect(saved).toContainText("Keep this one too.");
  expect(posts).toHaveLength(3);
  const events = (await (await request.get(`/api/sessions/${a}`)).json()).events;
  expect(events.filter((e: any) => e.kind === "user").map((e: any) => e.data.text)).toEqual([
    "Review the first screenshot.", "A separate note for later.",
  ]);

  // A deleted session takes what was kept for it.
  const kept = () => page.evaluate((k) => localStorage.getItem(k), `keel.sends.${a}`);
  expect(await kept()).toContain("Keep this one too.");
  await select(b);
  await request.delete(`/api/sessions/${a}`);
  await expect.poll(kept).toBeNull();
  await request.delete(`/api/sessions/${b}`);
});

// The New session box: a create the daemon refused is a certain non-send. Its
// words go back into the box with the daemon's reason; when the box holds a
// newer draft by then, it is kept beside it with the reason and a Retry. Only
// an answer lost after the session was made is "unconfirmed".
test("a refused create comes back to the New session box", async ({ page, request }) => {
  const gate: { hold?: Promise<void>; refuse: boolean; lose: boolean } = { refuse: true, lose: false };
  const made: string[] = [];
  await page.route("**/api/sessions", async (r) => {
    if (r.request().method() !== "POST") return r.fallback();
    const body = r.request().postDataJSON();
    await gate.hold;
    // The real daemon answers: a folder that is not there is its own 400.
    if (gate.refuse) return r.continue({ postData: JSON.stringify({ ...body, workspace: "/nonexistent/keel-e2e" }) });
    const res = await r.fetch({ postData: JSON.stringify({ ...body, model: HAIKU }) });
    made.push((await res.json()).session.id);
    if (gate.lose) return r.abort("failed");
    await r.fulfill({ response: res });
  });
  await page.goto("/");
  const box = page.getByTestId("new-composer");
  const composer = box.getByTestId("composer");
  const saved = box.getByTestId("saved-draft");

  // 1. The box is still empty when the refusal lands: the words come back.
  await composer.fill("Start in a folder that is gone.");
  await composer.press("Enter");
  await expect(box.getByTestId("composer-notice")).toContainText("not a directory: /nonexistent/keel-e2e");
  await expect(composer).toHaveValue("Start in a folder that is gone.");
  await expect(saved).toHaveCount(0);
  await shoot(page, "draft-06-new-refused");

  // 2. A newer draft is in the box by then: the refused one is kept beside it.
  const go = Promise.withResolvers<void>();
  gate.hold = go.promise;
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await composer.fill("The next idea.");
  go.resolve();
  await expect(saved).toContainText("Not sent");
  await expect(saved).toContainText("Start in a folder that is gone.");
  await expect(saved.getByTestId("saved-reason")).toContainText("not a directory: /nonexistent/keel-e2e");
  await expect(saved).not.toContainText("may have");
  await expect(composer).toHaveValue("The next idea.");
  await shoot(page, "draft-07-new-refused-kept");

  // 3. An answer lost after the daemon made the session is the unconfirmed case, with its reason.
  gate.hold = undefined;
  gate.refuse = false;
  gate.lose = true;
  await composer.press("Enter");
  await expect(saved.filter({ hasText: "Delivery unconfirmed" })).toContainText("The next idea.");
  await expect(saved.filter({ hasText: "Delivery unconfirmed" }).getByTestId("saved-reason")).not.toBeEmpty();
  await expect(saved.filter({ hasText: "Delivery unconfirmed" }).getByRole("button", { name: "Retry send" })).toHaveCount(0);
  expect(made).toHaveLength(1);
  await saved.filter({ hasText: "Delivery unconfirmed" }).getByRole("button", { name: "Discard" }).click();
  await expect(saved).toHaveCount(1);

  // 4. Retry sends the kept one: the session opens with its words.
  gate.lose = false;
  await saved.getByRole("button", { name: "Retry send" }).click();
  await expect(page).toHaveURL(/\/s\//);
  expect(made).toHaveLength(2);
  const users = (await (await request.get(`/api/sessions/${made[1]}`)).json()).events.filter((e: any) => e.kind === "user");
  expect(users.map((e: any) => e.data.text)).toEqual(["Start in a folder that is gone."]);
  await page.goto("/");
  for (const id of made) await request.delete(`/api/sessions/${id}`);
});

// The page's "taken" names the write it took: a newer write that lands while
// that acknowledgment is on its way stays, and is added to the box once.
// A draft image removed elsewhere while it loads is not added as its error.
test("a draft write is taken once and a newer one stays", async ({ page, request }) => {
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Two writes" } })).json();
  const at = `/api/sessions/${session.id}/draft`;
  // Every acknowledgment is held until the test lets it go.
  const gates: (() => void)[] = [];
  await page.route(new RegExp(`${at}$`), async (r) => {
    if (r.request().method() === "POST" && JSON.parse(r.request().postData() ?? "{}").taken !== undefined) await new Promise<void>((go) => gates.push(go));
    await r.fallback();
  });
  await page.goto(`/s/${session.id}`);
  await expect(page.getByTestId("composer")).toBeVisible();
  await request.post(at, { data: { text: "first note", origin: "capture" } });
  await expect(page.getByTestId("composer")).toHaveValue("first note");
  await request.post(at, { data: { text: "second note", origin: "capture" } });
  await expect(page.getByTestId("composer")).toHaveValue("first note\nsecond note");
  await expect.poll(() => gates.length).toBe(2);
  // The first write's acknowledgment lands: the second write stays on the daemon.
  gates[0]!();
  await expect.poll(async () => (await (await request.get(at)).json()).text).toBe("second note");
  gates[1]!();
  await expect.poll(async () => (await (await request.get(at)).json()).text).toBeUndefined();
  await page.unroute(new RegExp(`${at}$`));
  await page.reload();
  await expect(page.getByTestId("composer")).toHaveValue("first note\nsecond note");

  // An image whose file is gone by the time the page reads it is not attached.
  await page.route(/\/draft\/files\//, (r) => r.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "no such file" }) }));
  await request.post(at, { data: { images: [{ name: "late.png", mime: "image/png", data: PNG }], origin: "capture" } });
  await page.waitForTimeout(500);
  await expect(page.getByTestId("attachments").locator("img")).toHaveCount(0);
  await page.unroute(/\/draft\/files\//);
  await request.delete(`/api/sessions/${session.id}`);
});
