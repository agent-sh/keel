import { mkdirSync } from "node:fs";
import { expect, test } from "./isolate.ts";
import { HAIKU, shoot } from "./shots.ts";

// Feature: the palette finds what was said in any session and opens the
// session at that message.
test("search conversations", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const word = `quokka${Date.now().toString(36)}`;
  const r = await request.post("/api/sessions", { data: { model: HAIKU, text: `Reply with only the word ok. The code word is ${word}.` } });
  const { session } = await r.json();
  await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.phase, { timeout: 60_000 }).toBe("idle");

  await page.goto("/");
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill(word.slice(0, -2));
  const hit = page.getByRole("option").filter({ hasText: word });
  await expect(hit.first()).toBeVisible();
  await expect(page.getByTestId("palette")).toContainText("In conversations");
  await shoot(page, "search-01-hit");
  await page.getByRole("option").filter({ has: page.locator("mark") }).first().click();
  await expect(page).toHaveURL(new RegExp(`/s/${session.id}`));
  await expect(page.locator(".flash")).toBeVisible();
  await shoot(page, "search-02-opened");
  // Opened from the keyboard, the message is where the keyboard is too.
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill(word);
  await expect(page.getByRole("option").filter({ has: page.locator("mark") })).toHaveCount(1);
  await page.keyboard.press("ArrowDown"); // from the session row to the hit
  await page.keyboard.press("Enter");
  await expect(page.locator(".flash")).toBeVisible();
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-event-id"));
  const hitEvent = (await (await request.get(`/api/search?q=${word}`)).json()).hits.find((h: any) => h.event_id).event_id;
  expect(focused).toBe(hitEvent);

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);

  // A failed search says so and offers Retry; it is not "Nothing matches".
  await page.keyboard.press("Control+k");
  const input = page.getByTestId("palette-input");
  await page.route(/\/api\/search\?/, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "the index is rebuilding" }) }));
  await input.fill(word);
  await expect(page.getByTestId("palette-search-failed")).toContainText("the index is rebuilding");
  await expect(page.getByTestId("palette")).not.toContainText("Nothing matches");
  await shoot(page, "search-03-failed");
  await page.unroute(/\/api\/search\?/);
  await page.getByTestId("palette-search-retry").click();
  await expect(page.getByTestId("palette-search-failed")).toHaveCount(0);
  await expect(page.getByRole("option").filter({ hasText: word })).toHaveCount(1);

  // The input names the highlighted row for assistive technology.
  await input.focus();
  const activeId = await input.getAttribute("aria-activedescendant");
  expect(activeId).toBeTruthy();
  await expect(page.locator(`#${activeId}`)).toHaveAttribute("aria-selected", "true");

  // A hit of the query just erased is not opened by Enter while the new
  // query's answer is out.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(/\/api\/search\?/, async (route) => { await held; await route.fallback(); });
  await input.fill(`zz${word}`);
  await expect(page.getByTestId("palette-searching")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("palette")).toBeVisible();
  release();
  await page.unroute(/\/api\/search\?/);
});

// What the palette finds besides prompts and replies: a command and its
// output (opening that tool card), an attached file by its name, a title
// copied with its accents, and an archived session's title, marked Archived
// and opened to read. Two sessions of same-named folders read apart.
test("search commands, outputs, files and archived titles", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const tag = `kx${Date.now().toString(36)}`;
  const M = "scripted:stand-in";
  const home = process.env.HOME!;
  const idle = (id: string) => expect.poll(async () => (await (await request.get(`/api/sessions/${id}`)).json()).session.phase, { timeout: 30_000 }).toBe("idle");

  // A declined reply's partial text is hidden in the transcript, and not found either.
  const refused = (await (await request.post("/api/sessions", { data: { model: M, text: `script:refuse veto${tag}` } })).json()).session;
  await idle(refused.id);
  expect((await (await request.get(`/api/sessions/${refused.id}`)).json()).events.some((e: any) => e.kind === "assistant" && e.data.stop === "refusal")).toBe(true);
  expect((await (await request.get(`/api/search?q=veto${tag}`)).json()).hits.filter((h: any) => h.session_id === refused.id && h.kind === "assistant")).toEqual([]);
  const run = (await (await request.post("/api/sessions", { data: { model: M, text: `script:calls [{"name":"Bash","input":{"command":"echo shout-${tag}-done"}}]` } })).json()).session;
  await idle(run.id);
  const ref = await (await request.post(`/api/attachments?name=saffron-${tag}.txt`, { headers: { "content-type": "text/plain" }, data: "ledger" })).json();
  const filed = (await (await request.post("/api/sessions", { data: { model: M, images: [ref] } })).json()).session;
  await idle(filed.id);
  expect((await (await request.get(`/api/sessions/${filed.id}`)).json()).session.title).toBe(`saffron-${tag}.txt`);
  for (const d of ["alpha", "beta"]) mkdirSync(`${home}/.cache/keel-work/bun/e2e-ws/${d}/api`, { recursive: true });
  const old = (await (await request.post("/api/sessions", { data: { model: M, workspace: `${home}/.cache/keel-work/bun/e2e-ws/alpha/api` } })).json()).session;
  await request.patch(`/api/sessions/${old.id}`, { data: { title: `École ${tag}`, archived: true } });
  const twin = (await (await request.post("/api/sessions", { data: { model: M, workspace: `${home}/.cache/keel-work/bun/e2e-ws/beta/api` } })).json()).session;
  await request.patch(`/api/sessions/${twin.id}`, { data: { title: `École ${tag}` } });

  await page.goto("/");
  const find = async (q: string) => { await page.keyboard.press("Control+k"); await page.getByTestId("palette-input").fill(q); };
  // The output of the command: its tool card opens.
  await find(`shout-${tag}`);
  const out = page.getByRole("option").filter({ hasText: "Tool output" });
  await expect(out).toHaveCount(1);
  await shoot(page, "search-03-tool-output");
  await out.click();
  await expect(page).toHaveURL(new RegExp(`/s/${run.id}`));
  await expect(page.locator('[data-testid="tool-call"][data-open]')).toHaveCount(1);

  // An attached file by its name, though the prompt had no words.
  await find(`saffron-${tag}`);
  await expect(page.getByRole("option").filter({ hasText: `saffron-${tag}` })).toHaveCount(1);
  await page.keyboard.press("Escape");

  // The title without its accent: both sessions, the archived one marked, the folders apart.
  await find(`ecole ${tag}`);
  const rows = page.getByRole("option").filter({ hasText: `École ${tag}` });
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ has: page.getByTestId("hit-archived") })).toHaveCount(1);
  await expect(rows.filter({ hasText: "alpha/api" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "beta/api" })).toHaveCount(1);
  await shoot(page, "search-04-archived-title");
  await rows.filter({ has: page.getByTestId("hit-archived") }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${old.id}`));
  expect((await (await request.get(`/api/sessions/${old.id}`)).json()).session.archived).toBe(true);

  // The full index: same-named folders read apart, and a tag picked in Sessions does not empty Archived.
  const near = (await (await request.post("/api/sessions", { data: { model: M, workspace: `${home}/.cache/keel-work/bun/e2e-ws/alpha/api` } })).json()).session;
  await request.patch(`/api/sessions/${near.id}`, { data: { title: `Near ${tag}`, tags: [`t${tag}`] } });
  const heads = page.getByTestId("session-list").locator(".k-group-head");
  await expect(heads.filter({ hasText: "alpha/api" })).toHaveCount(1);
  await expect(heads.filter({ hasText: "beta/api" })).toHaveCount(1);
  await shoot(page, "search-05-sidebar-folders");
  await page.getByTestId("tag-filter").getByRole("button", { name: `t${tag}` }).click();
  await expect(page.getByTestId("session-list")).toContainText(`Near ${tag}`);
  await page.getByTestId("tab-archived").click();
  await expect(page.getByTestId("session-list")).toContainText(`École ${tag}`);

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});

// Previous prompt and Next prompt (Alt Up and Alt Down, also in the palette
// and the shortcut sheet) move the keyboard through the prompts of the branch
// on screen, one at a time, back to one that was not among the rows rendered
// first. The branch and the draft stay as they were, and each end says so.
test("previous and next prompt walk the conversation by keyboard", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in-strict"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  test.setTimeout(240_000);
  const errors = async () => ((await (await request.get("/api/errors")).json()).errors as { count?: number }[]).reduce((n, e) => n + (e.count ?? 1), 0);
  const errorsBefore = await errors();
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in-strict", title: "Many prompts" } })).json();
  const id = session.id as string;
  const state = async () => (await (await request.get(`/api/sessions/${id}`)).json()) as { session: { head: string; phase: string }; events: any[] };
  const send = async (data: Record<string, unknown>) => {
    await request.post(`/api/sessions/${id}/messages`, { data });
    await expect.poll(async () => (await state()).session.phase, { timeout: 30_000 }).toBe("idle");
  };
  try {
    const N = 44;
    for (let i = 1; i <= N; i++) await send({ text: `Question ${i}: what comes after ${i}?` });
    // The last prompt gets a second version: the first stays as a branch that is not on screen.
    const before = await state();
    const lastPrompt = before.events.filter((e) => e.kind === "user").at(-1);
    await send({ text: `Question ${N}, asked again.`, edit_of: lastPrompt.id });
    const { session: s, events } = await state();
    const byId = new Map(events.map((e) => [e.id, e]));
    const branch: any[] = [];
    for (let e = byId.get(s.head); e; e = byId.get(e.parent)) branch.unshift(e);
    const prompts = branch.filter((e) => e.kind === "user" && !e.data.origin).map((e) => e.id as string);
    expect(prompts).toHaveLength(N);
    expect(prompts).not.toContain(lastPrompt.id);
    // The first prompts are before the rows a long transcript renders first.
    expect(branch.length).toBeGreaterThan(150 + 8);

    const writes: string[] = [];
    // What would change the conversation: a message, or a move to another branch.
    page.on("request", (r) => { if (r.method() !== "GET" && /\/api\/sessions\/[^/]+\/(messages|head)$/.test(r.url())) writes.push(`${r.method()} ${r.url()}`); });
    await page.goto(`/s/${id}`);
    const box = page.getByTestId("composer");
    await box.fill("A draft that stays where it is.");
    await expect(page.getByTestId("user-message").last()).toContainText("asked again");
    const on = () => page.evaluate(() => document.activeElement?.getAttribute("data-event-id") ?? "");
    const place = page.getByTestId("prompt-place");
    const said = page.getByTestId("announce-status");
    // The prompt with the keys is whole on screen, under the top of the conversation.
    const shown = async (at: number) => {
      await expect.poll(on).toBe(prompts[at]);
      const row = page.locator(`[data-testid="user-message"][data-event-id="${prompts[at]}"]`);
      await expect(row).toBeFocused();
      await expect(row).toBeInViewport({ ratio: 1 });
      await expect(row).toContainText(at === N - 1 ? "asked again" : `Question ${at + 1}:`);
    };

    // From the message box: back to the newest prompt, then one more.
    await page.keyboard.press("Alt+ArrowUp");
    await shown(N - 1);
    await expect(place).toHaveText(`Prompt ${N} of ${N}`);
    // Leaving the box, the way back is said and shown with the place.
    await expect(said).toHaveText(`Prompt ${N} of ${N}. Escape returns to the message box.`);
    await expect(page.getByTestId("prompt-place-back")).toHaveText("Esc message box");
    await page.keyboard.press("Alt+ArrowUp");
    await shown(N - 2);
    await expect(place).toHaveText(`Prompt ${N - 1} of ${N}`);
    await expect(said).toHaveText(`Prompt ${N - 1} of ${N}`);
    await shoot(page, "search-04-prompt-step");
    // Forward again, and the end says it is the end.
    await page.keyboard.press("Alt+ArrowDown");
    await shown(N - 1);
    await page.keyboard.press("Alt+ArrowDown");
    await shown(N - 1);
    await expect(place).toHaveText("This is the last prompt.");
    await expect(said).toHaveText(`This is the last prompt. Prompt ${N} of ${N}.`);
    await shoot(page, "search-05-prompt-last");
    // Every prompt in turn, back to the first.
    for (let at = N - 2; at >= 0; at--) {
      await page.keyboard.press("Alt+ArrowUp");
      await shown(at);
    }
    await page.keyboard.press("Alt+ArrowUp");
    await shown(0);
    await expect(place).toHaveText("This is the first prompt.");
    await expect(said).toHaveText(`This is the first prompt. Prompt 1 of ${N}.`);
    await shoot(page, "search-06-prompt-first");
    // Tab goes on to the prompt's own actions.
    await page.keyboard.press("Tab");
    await expect(page.locator(`[data-event-id="${prompts[0]}"]`).getByTestId("copy-message")).toBeFocused();

    // Nothing but the view moved: the same branch, the same draft, nothing written.
    expect((await state()).session.head).toBe(s.head);
    await expect(box).toHaveValue("A draft that stays where it is.");
    await expect(page.getByTestId("branch-preview")).toHaveCount(0);
    expect(writes).toEqual([]);

    // The two actions are found by name, with their keys.
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("prompt");
    const options = page.getByTestId("palette").getByRole("option");
    await expect(options.filter({ hasText: "Previous prompt" }).locator("kbd")).toHaveText(["Alt", "↑"]);
    await expect(options.filter({ hasText: "Next prompt" }).locator("kbd")).toHaveText(["Alt", "↓"]);
    await shoot(page, "search-07-prompt-commands");
    await page.getByTestId("palette-input").fill("message box");
    await expect(options.filter({ hasText: "Focus the message box" }).locator("kbd")).toHaveText(["Shift", "Esc"]);
    await page.keyboard.press("Escape");

    // Escape on a prompt reached this way goes back to the message box and ends there: a
    // turn that runs meanwhile is not stopped by it.
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto" } });
    await request.post(`/api/sessions/${id}/messages`, { data: { text: "script:long-tool" } });
    await expect(page.getByTestId("stop")).toBeVisible();
    await box.focus();
    await page.keyboard.press("Alt+ArrowUp");
    await expect(page.getByTestId("user-message").last()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(box).toBeFocused();
    await page.waitForTimeout(400);
    await expect(page.getByTestId("stop")).toBeVisible();
    expect((await state()).session.phase).toBe("working");
    // From a control further in (a prompt's own action), the command's key does the same.
    await page.keyboard.press("Alt+ArrowUp");
    await expect(page.locator('[data-testid="user-message"]:focus')).toHaveCount(1);
    await page.keyboard.press("Tab");
    await expect(page.locator('[data-testid="copy-message"]:focus')).toHaveCount(1);
    await page.keyboard.press("Shift+Escape");
    await expect(box).toBeFocused();
    expect((await state()).session.phase).toBe("working");
    await expect(box).toHaveValue("A draft that stays where it is.");
    await request.post(`/api/sessions/${id}/interrupt`);
    await expect(page.getByTestId("stop")).toHaveCount(0);

    // On a Mac, Option Up and Down are the text field's own (the caret moves by paragraph):
    // in the box the two commands leave them alone, and they work from the conversation.
    const mac = await page.context().newPage();
    await mac.addInitScript(() => Object.defineProperty(navigator, "platform", { get: () => "MacIntel" }));
    await mac.goto(`/s/${id}`);
    const macBox = mac.getByTestId("composer");
    await expect(macBox).toBeFocused();
    await expect(mac.getByTestId("user-message").last()).toBeVisible();
    await mac.keyboard.press("Alt+ArrowUp");
    await mac.waitForTimeout(300);
    await expect(macBox).toBeFocused();
    await expect(mac.getByTestId("prompt-place")).toHaveCount(0);
    await mac.getByTestId("assistant-text").last().click();
    await mac.keyboard.press("Alt+ArrowUp");
    await expect(mac.getByTestId("user-message").last()).toBeFocused();
    await mac.close();
    expect(await errors()).toBe(errorsBefore);
  } finally { await request.delete(`/api/sessions/${id}`); }
});
