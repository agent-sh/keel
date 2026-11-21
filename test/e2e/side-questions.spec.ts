import { expect, test } from "./isolate.ts";
import { HAIKU, openPanel, shoot, SCRIPTED } from "./shots.ts";

// Feature: /btw asks a side question answered from the session's context with
// no tools; it opens the side panel, a follow-up continues the thread, and
// nothing is added to the conversation. Clear forgets the threads.
test("side questions stay out of the conversation", async ({ page, request }) => {
  test.skip(SCRIPTED, "needs a real model: a side question is answered from what was said before");
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU } })).json();
  await page.goto(`/s/${session.id}`);
  const composer = page.getByTestId("composer");
  await composer.fill("The project codename is Heron-42. Reply with only the word noted.");
  await composer.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 90_000 });
  const before = (await (await request.get(`/api/sessions/${session.id}`)).json()).events.length;

  await composer.fill("/btw what is the project codename? Answer with the codename only.");
  await composer.press("Enter");
  const panel = page.getByTestId("side-questions");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("side-answer").last()).toContainText("Heron-42", { timeout: 60_000 });

  // A follow-up sees the thread so far.
  await panel.getByTestId("side-input").fill("Repeat your previous answer in lower case, nothing else.");
  await panel.getByTestId("side-input").press("Enter");
  await expect(panel.getByTestId("side-exchange")).toHaveCount(2, { timeout: 60_000 });
  await expect(panel.getByTestId("side-answer").last()).toContainText("heron-42", { timeout: 60_000 });
  await shoot(page, "side-01-thread");

  // The conversation is as it was: no prompt, reply or turn was added.
  const after = await (await request.get(`/api/sessions/${session.id}`)).json();
  expect(after.events.length).toBe(before);
  await expect(page.getByTestId("turn-end")).toHaveCount(1);
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  // Yet both side answers are requests the usage report counts, as the spend guard does.
  const usage = await (await request.get(`/api/usage?group=model&session_id=${session.id}`)).json();
  expect(usage.by_purpose.find((p: any) => p.purpose === "side").calls).toBe(2);
  expect(usage.total.calls).toBeGreaterThanOrEqual(3);

  // The threads come back after a reload, and Clear forgets them.
  await page.reload();
  await expect(page.getByTestId("side-exchange")).toHaveCount(2);
  await page.getByTestId("side-clear").click();
  await expect(page.getByTestId("side-exchange")).toHaveCount(0);
  expect((await (await request.get(`/api/sessions/${session.id}/side`)).json()).threads).toEqual([]);
});

// Follow-ups wait for the answer before them, a failed question keeps its
// words to retry, New thread holds against an answer still on its way, and a
// thread does not follow the conversation onto another branch.
test("side questions in order, retried, and per branch", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", text: "first" } })).json();
  const idle = () => expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.phase, { timeout: 20_000 }).toBe("idle");
  await idle();
  await page.goto(`/s/${session.id}`);
  await page.getByTestId("composer").fill("/btw warm up");
  await page.getByTestId("composer").press("Enter");
  const panel = page.getByTestId("side-questions");
  await expect(panel.getByTestId("side-exchange")).toHaveCount(1, { timeout: 20_000 });
  const input = panel.getByTestId("side-input");
  const side = new RegExp(`/api/sessions/${session.id}/side$`);

  // A failed question stays, with Retry; Retry answers it.
  await page.route(side, (r) => (r.request().method() === "POST" ? r.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "the provider is down" }) }) : r.fallback()));
  await input.fill("Which check failed?");
  await input.press("Enter");
  await expect(panel.getByTestId("side-failed")).toContainText("Which check failed?");
  await expect(panel.getByTestId("side-failed")).toContainText("the provider is down");
  await shoot(page, "side-02-failed");
  await page.unroute(side);
  await panel.getByTestId("side-retry").click();
  await expect(panel.getByTestId("side-exchange")).toHaveCount(2, { timeout: 20_000 });
  await expect(panel.getByTestId("side-failed")).toHaveCount(0);

  // Two asked at once go in order, the second after the first's answer.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let posts = 0;
  await page.route(side, async (r) => { if (r.request().method() === "POST" && posts++ === 0) await held; await r.fallback(); });
  await input.fill("A?");
  await input.press("Enter");
  await input.fill("B?");
  await input.press("Enter");
  await expect(panel.getByTestId("side-pending")).toHaveCount(2);
  expect(posts).toBe(1);
  // New thread while A is out: A's answer lands in its thread, the next one starts fresh.
  await panel.getByRole("button", { name: "New thread" }).click();
  release();
  await expect(panel.getByTestId("side-pending")).toHaveCount(0, { timeout: 20_000 });
  await page.unroute(side);
  const threads = (await (await request.get(`/api/sessions/${session.id}/side`)).json()).threads;
  expect(threads.flatMap((t: any) => t.exchanges.map((x: any) => x.question))).toEqual(["warm up", "Which check failed?", "A?", "B?"]);
  expect(threads.length).toBe(2); // B went after New thread
  expect(threads[1].exchanges.map((x: any) => x.question)).toEqual(["B?"]);

  // On a sibling branch the old thread's follow-up starts a new thread.
  const first = (await (await request.get(`/api/sessions/${session.id}`)).json()).events.find((e: any) => e.kind === "user");
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "second version", edit_of: first.id } });
  await idle();
  const r = await (await request.post(`/api/sessions/${session.id}/side`, { data: { question: "still there?", thread_id: threads[0].id } })).json();
  expect(r.branched).toBe(true);
  expect(r.thread_id).not.toBe(threads[0].id);
  await request.delete(`/api/sessions/${session.id}`);
});

// A word being composed (an input method's candidates on screen) is confirmed
// with Enter: that Enter belongs to the input method, and the question is not
// asked until an Enter after it. The same holds for the other fields that act
// on Enter: the message box, a prompt being edited, the palette, Panels search.
test("the Enter that confirms a composed word is not the field's Enter", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", text: "first" } })).json();
  try {
    await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.phase, { timeout: 20_000 }).toBe("idle");
    await page.goto(`/s/${session.id}`);
    await openPanel(page, "side");
    const panel = page.getByTestId("side-questions");
    const input = panel.getByTestId("side-input");
    const posts: string[] = [];
    page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith(`/api/sessions/${session.id}/side`)) posts.push(r.postData() ?? ""); });
    await input.fill("东京の天気は");
    // The two ways browsers mark it: the event says it is composing, or carries the input method's key code.
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      const prevented = await input.evaluate((el, init) => !el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, ...init })), init);
      expect(prevented).toBe(false);
    }
    await page.waitForTimeout(300);
    await expect(input).toHaveValue("东京の天気は");
    await expect(panel.getByTestId("side-pending")).toHaveCount(0);
    expect(posts).toHaveLength(0);
    await shoot(page, "side-03-composing");
    // The composition is over: Enter asks, once.
    await input.press("Enter");
    await expect(panel.getByTestId("side-exchange")).toHaveCount(1, { timeout: 20_000 });
    await expect(input).toHaveValue("");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]!).question ?? JSON.parse(posts[0]!).text).toBe("东京の天気は");

    // The same two marks on the Enter of other fields: nothing is sent, opened or picked.
    const sent: string[] = [];
    page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith(`/api/sessions/${session.id}/messages`)) sent.push(r.postData() ?? ""); });
    const composed = async (field: import("@playwright/test").Locator) => {
      for (const init of [{ isComposing: true }, { keyCode: 229 }]) await field.evaluate((el, init) => { el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, ...init })); }, init);
      await page.waitForTimeout(200);
    };
    const box = page.getByTestId("composer");
    await box.fill("返事を書く");
    await composed(box);
    await expect(box).toHaveValue("返事を書く");
    // A prompt being edited.
    await page.getByTestId("user-message").first().hover();
    await page.getByTestId("edit-message").first().click();
    const edit = page.getByTestId("edit-box");
    await edit.fill("最初の質問");
    await composed(edit);
    await expect(edit).toHaveValue("最初の質問");
    await edit.press("Escape");
    expect(sent).toHaveLength(0);
    // Panels search: the top match is not opened.
    const shownPanel = await page.getByTestId("side-panel").getAttribute("data-panel");
    await page.getByTestId("panel-menu").click();
    const search = page.getByTestId("panel-search");
    await search.fill("files");
    await composed(search);
    await expect(page.getByTestId("panel-picker")).toBeVisible();
    await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", shownPanel!);
    await page.keyboard.press("Escape");
    // The palette: nothing is picked, it stays open with its words.
    await page.keyboard.press("Control+k");
    const palette = page.getByTestId("palette-input");
    await palette.fill("設定");
    await composed(palette);
    await expect(page.getByTestId("palette")).toBeVisible();
    await expect(palette).toHaveValue("設定");
    await page.keyboard.press("Escape");
    // With the composition over, Enter in the message box sends, once.
    await box.focus();
    await page.keyboard.press("Enter");
    await expect(box).toHaveValue("");
    expect(sent).toHaveLength(1);
  } finally { await request.delete(`/api/sessions/${session.id}`); }
});

// The same in the fields where a name, a tag or a label is typed, in any
// script: the Enter that confirms a composed word saves nothing and leaves
// the field open with its words. An Enter after it saves.
test("an input method's Enter does not save a title, a folder name, a tag, a label or a memory key", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const word = `ime${Date.now().toString(36)}`;
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: `Before ${word}`, text: "first" } })).json();
  const { folder } = await (await request.post("/api/session-folders", { data: { name: `Before ${word}` } })).json();
  const key = `pref.${word}`;
  const now = async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session;
  const memory = async () => ((await (await request.get("/api/helper/memory")).json()).items as { key: string }[]).filter((m) => m.key === key).length;
  try {
    await expect.poll(async () => (await now()).phase, { timeout: 20_000 }).toBe("idle");
    await page.goto(`/s/${session.id}`);
    // The two ways browsers mark the key: the event says it is composing, or carries the input method's key code.
    const composed = async (field: import("@playwright/test").Locator) => {
      for (const init of [{ isComposing: true }, { keyCode: 229 }]) await field.evaluate((el, init) => { el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, ...init })); }, init, { timeout: 5000 }); // a field that saved and closed fails here
      await page.waitForTimeout(200);
    };

    // The session's title.
    await page.getByTestId("session-menu").click();
    await page.getByTestId("menu-rename").click();
    const title = page.getByLabel("Session title");
    await title.fill(`会議の記録 ${word}`);
    await composed(title);
    await expect(title).toHaveValue(`会議の記録 ${word}`);
    expect((await now()).title).toBe(`Before ${word}`);
    await title.press("Enter");
    await expect(page.getByTestId("session-title")).toHaveText(`会議の記録 ${word}`);

    // A tag.
    await openPanel(page, "session");
    const tag = page.getByTestId("tag-input");
    await tag.fill("確認");
    await composed(tag);
    await expect(tag).toHaveValue("確認");
    await expect(page.getByTestId("session-tag")).toHaveCount(0);
    await tag.press("Enter");
    await expect(page.getByTestId("session-tag")).toHaveCount(1);
    expect((await now()).settings.tags).toEqual(["確認"]);

    // A label on a message.
    await page.getByTestId("assistant-text").first().hover();
    await page.getByRole("button", { name: "Label this message" }).first().click();
    const label = page.getByTestId("label-input");
    await label.fill("最初の答え");
    await composed(label);
    await expect(label).toHaveValue("最初の答え");
    await expect(page.getByTestId("label-row")).toHaveCount(0);
    await shoot(page, "side-04-composing-label");
    await label.press("Enter");
    await expect(page.getByTestId("labels")).toContainText("最初の答え");

    // A folder's name.
    await page.getByTestId("list-arrange").click();
    await page.getByTestId("arrange-group-mine").click();
    await page.keyboard.press("Escape");
    const head = page.getByTestId("session-list").locator(`[data-testid="folder-head"][data-folder="${folder.id}"]`);
    await head.locator('span[title="Double-click to rename"]').dblclick();
    const name = page.getByTestId("folder-rename");
    await name.fill(`仕事 ${word}`);
    await composed(name);
    await expect(name).toHaveValue(`仕事 ${word}`);
    expect(((await (await request.get("/api/session-folders")).json()).folders as any[]).find((f) => f.id === folder.id).name).toBe(`Before ${word}`);
    await name.press("Enter");
    await expect(head).toContainText(`仕事 ${word}`);

    // The key of something the helper remembers.
    await page.getByTestId("open-helper").click();
    // The helper's page shows its panel by itself, unless another panel was left open there: then it is picked.
    await page.getByTestId("helper-panel").waitFor({ timeout: 3000 }).catch(() => openPanel(page, "helper"));
    await expect(page.getByTestId("helper-panel")).toBeVisible();
    await page.getByTestId("memory-new").fill("通知は必要なときだけ");
    const newKey = page.getByTestId("memory-new-key");
    await newKey.fill(key);
    await composed(newKey);
    await expect(newKey).toHaveValue(key);
    expect(await memory()).toBe(0);
    await newKey.press("Enter");
    await expect.poll(memory).toBe(1);

    // On a phone a panel is a sheet, and Escape in one of its fields puts it away: an input
    // method's Escape (it drops the word being composed) does not.
    await page.goto(`/s/${session.id}`);
    await openPanel(page, "session");
    const sheet = page.getByTestId("side-panel");
    await expect(sheet).toHaveAttribute("data-panel", "session");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(sheet).toHaveAttribute("data-mode", "sheet");
    const field = page.getByTestId("tag-input");
    await field.fill("作業");
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      await field.evaluate((el, init) => {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true, ...init }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", code: "Escape", bubbles: true }));
      }, init);
    }
    await page.waitForTimeout(200);
    await expect(sheet).toBeVisible();
    await expect(field).toHaveValue("作業");
    await field.press("Escape");
    await expect(sheet).toHaveCount(0);
  } finally {
    await request.delete(`/api/helper/memory/${encodeURIComponent(key)}`);
    await request.delete(`/api/session-folders/${folder.id}`);
    await request.delete(`/api/sessions/${session.id}`);
  }
});
