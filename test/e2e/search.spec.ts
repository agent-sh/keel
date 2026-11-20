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
