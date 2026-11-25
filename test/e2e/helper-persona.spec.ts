import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the helper has a name and a face, and reads the errors that appear at the bottom of the left bar.
//  1. In its settings the owner names it and makes its picture: an image model of their providers (here the scripted
//     stand-in, found from the provider's listing by its image output) draws a few from a description they edit, they
//     pick one, and the name and picture show wherever it speaks: the list's entry, its panel, its replies. Uploading
//     a picture is the other way, and the only one when no provider lists an image model.
//  2. A new error is read once by the helper (a stand-in for its model answers from the error's own text): what it
//     is, whose it is, the step to take, or for a bug of Keel's a task the owner starts an agent on by pressing it.
//     A second row of the same cause is not read again. Each look shows what it cost.
test.use({ viewport: { width: 1700, height: 980 } });
// The helper is daemon-wide: off, unnamed and without a picture after the spec, so other specs find it as it was.
test.afterEach(async ({ request }) => {
  await request.put("/api/helper", { data: { on: false, name: null } });
  await request.delete("/api/helper/avatar");
});

const fresh = async (request: any) => {
  const was = await (await request.get("/api/helper")).json();
  if (was.session_id) await request.patch(`/api/sessions/${was.session_id}`, { data: { archived: true } });
};

test("helper: a name and a picture an image model made, shown wherever it speaks", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "needs the scripted provider: the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  test.setTimeout(120_000);
  await fresh(request);
  await page.goto("/");
  await page.getByTestId("open-helper").click();
  await expect(page.getByTestId("helper-panel")).toBeVisible();
  const helper = await (await request.get("/api/helper")).json();
  await expect(page.getByTestId("helper-head-name")).toHaveText("Helper");

  // Settings: the name, then the picture maker, which finds the stand-in image model from the listing.
  await page.goto("/settings/helper");
  await expect(page.getByTestId("helper-settings")).toBeVisible();
  await page.getByTestId("helper-name").fill("Pip");
  await page.getByTestId("helper-name").press("Enter");
  // Keel's own source folder is found by itself (this daemon runs from a checkout) and said where it came from.
  await expect(page.getByTestId("helper-repo-found")).toContainText("the checkout this daemon runs from");
  await expect(page.getByTestId("helper-rail-name")).toHaveText("Pip");
  await expect.poll(async () => (await (await request.get(`/api/sessions/${helper.session_id}`)).json()).session.title).toBe("Pip");
  await page.getByTestId("helper-avatar-open").click();
  await expect(page.getByTestId("helper-avatar-model")).toContainText("Scripted image maker");
  const prompt = page.getByTestId("helper-avatar-prompt");
  await expect(prompt).toHaveValue(/Pip/);
  await prompt.fill("A round fox in a green scarf, flat colors, friendly");
  await shoot(page, "helper-persona-01-maker");
  await page.getByTestId("helper-avatar-make").click();
  await expect(page.getByTestId("helper-avatar-candidate")).toHaveCount(4);
  await shoot(page, "helper-persona-02-candidates");
  // Nothing is kept until one is picked.
  expect((await (await request.get("/api/helper")).json()).avatar).toBeNull();
  await page.getByTestId("helper-avatar-candidate").nth(2).click();
  await expect(page.getByTestId("helper-avatar-candidates")).toHaveCount(0);
  await expect(page.getByTestId("helper-picture")).toHaveAttribute("src", /\/api\/helper\/avatar\?v=/);
  await expect(page.getByTestId("helper-rail-face")).toHaveAttribute("src", /\/api\/helper\/avatar/);
  const served = await request.get((await (await request.get("/api/helper")).json()).avatar.url);
  expect(served.headers()["content-type"]).toBe("image/png");
  // The description is kept for next time.
  expect((await (await request.get("/api/helper")).json()).avatar_prompt).toContain("green scarf");
  await shoot(page, "helper-persona-03-settings");

  // Its panel, its replies and its empty conversation use them.
  await page.getByTestId("open-helper").click();
  await expect(page.getByTestId("helper-head-name")).toHaveText("Pip");
  await expect(page.getByTestId("helper-head-face")).toHaveAttribute("src", /\/api\/helper\/avatar/);
  await page.getByTestId("composer").fill("Hello script:say Good morning.");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("helper-voice-name").first()).toHaveText("Pip", { timeout: 30_000 });
  await expect(page.getByTestId("helper-voice-face").first()).toHaveAttribute("src", /\/api\/helper\/avatar/);
  await shoot(page, "helper-persona-04-reply");

  // Uploading replaces it; removing brings the mark back; the name is reset to the default.
  await page.goto("/settings/helper");
  const before = await page.getByTestId("helper-picture").getAttribute("src");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
  await page.getByTestId("helper-avatar-upload").setInputFiles({ name: "face.png", mimeType: "image/png", buffer: png });
  await expect.poll(() => page.getByTestId("helper-picture").getAttribute("src")).not.toBe(before);
  await page.getByTestId("helper-avatar-remove").click();
  await expect(page.getByTestId("helper-picture")).not.toHaveAttribute("src", /.+/);
  await page.getByTestId("helper-name").fill("");
  await page.getByTestId("helper-name").press("Enter");
  await expect(page.getByTestId("helper-rail-name")).toHaveText("Helper");
  // Not a picture: refused with the reason, nothing kept.
  const bad = await request.post("/api/helper/avatar", { data: "<html>no</html>", headers: { "content-type": "text/html" } });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).error).toContain("not a PNG");
});

// Renamed where any session is renamed (its conversation's title, in the header): the list's entry, its panel and
// the conversation's own title say the new name at once, with no reload; cleared in its settings, it is the default again.
test("helper: a rename of its conversation names it everywhere at once", async ({ page, request }) => {
  await page.setViewportSize({ width: 1920, height: 1040 });
  await fresh(request);
  await page.goto("/");
  await page.getByTestId("open-helper").click();
  await expect(page.getByTestId("helper-panel")).toBeVisible();
  await expect(page.getByTestId("helper-rail-name")).toHaveText("Helper");
  await expect(page.getByTestId("panel-switch")).toContainText("Helper");
  const helper = await (await request.get("/api/helper")).json();

  await shoot(page, "helper-persona-06-before-rename");
  await page.getByTestId("session-menu").click();
  await page.getByTestId("menu-rename").click();
  await page.getByLabel("Session title").fill("Dana");
  await page.getByLabel("Session title").press("Enter");
  await expect(page.getByTestId("session-title")).toHaveText("Dana");
  await expect(page.getByTestId("helper-rail-name")).toHaveText("Dana");
  await expect(page.getByTestId("open-helper")).toHaveAttribute("aria-label", "Dana");
  await expect(page.getByTestId("helper-head-name")).toHaveText("Dana");
  await expect(page.getByTestId("panel-switch")).toContainText("Dana");
  // The name is the helper's own now: its settings, and what a notification or the phone says of it.
  const named = await (await request.get("/api/helper")).json();
  expect(named).toMatchObject({ name: "Dana", named: true, session_id: helper.session_id });
  await shoot(page, "helper-persona-07-renamed");

  // Cleared in its settings: the default name again, and the conversation's title with it.
  await page.goto("/settings/helper");
  await expect(page.getByTestId("helper-name")).toHaveValue("Dana");
  await page.getByTestId("helper-name").fill("");
  await page.getByTestId("helper-name").press("Enter");
  await expect(page.getByTestId("helper-rail-name")).toHaveText("Helper");
  await expect.poll(async () => (await (await request.get(`/api/sessions/${helper.session_id}`)).json()).session.title).toBe("Helper");
});

test("helper: a new error is read once, with the fix offered; a bug of Keel's comes with a task started only on a press", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "needs the scripted provider: the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  test.setTimeout(120_000);
  await fresh(request);
  await page.goto("/");
  await page.getByTestId("open-helper").click();
  await expect(page.getByTestId("helper-panel")).toBeVisible();
  const helper = await (await request.get("/api/helper")).json();
  await request.patch(`/api/sessions/${helper.session_id}`, { data: { model: "scripted:stand-in" } });
  await request.put("/api/helper", { data: { name: "Pip" } });
  const tag = Date.now().toString(36);

  // The stand-in answers from the error's own text (its `script:say` line), as the helper's model would from its reading.
  const task = `Fix the crash in the tool runner (${tag}): it reads a field of an undefined call. Add a test that fails before the fix.`;
  const bug = { what: "The tool runner read a field of a call that was never made. That is a bug in Keel.", blame: "keel", task };
  const rows = [
    `TypeError: undefined is not an object (evaluating 'call.input') in /src/tools/run-${tag}.ts\nscript:say ${JSON.stringify(bug)}`,
    `TypeError: undefined is not an object (evaluating 'call.input') in /src/tools/run-${tag}-other.ts\nscript:say ${JSON.stringify(bug)}`,
  ];
  for (const message of rows) await request.post("/api/errors", { data: { message, context: { tool: "Bash" } } });
  const setup = { what: "The provider's key is not set, so the request was refused.", blame: "setup", step: `Add the key for ${tag} in Settings > Providers.` };
  await request.post("/api/errors", { data: { message: `HTTP 401: no api key for provider ${tag}\nscript:say ${JSON.stringify(setup)}` } });

  const ours = async () => ((await (await request.get("/api/helper/looks")).json()).looks as any[]).filter((l) => l.title.includes(tag));
  await expect.poll(async () => (await ours()).filter((l) => l.state === "done").length, { timeout: 30_000 }).toBe(2);
  const looks = await ours();
  // The two rows of one cause share one look: the second row is on it, and no second request was made for it.
  const mine = looks.find((l) => l.blame === "keel" && l.task?.includes(tag));
  expect(mine.error_ids.length).toBe(2);
  expect(looks.filter((l) => l.blame === "keel" && l.task?.includes(tag)).length).toBe(1);

  await page.goto("/");
  await page.getByTestId("errors-button").click();
  const panel = page.getByTestId("errors-panel");
  const look = panel.getByTestId("helper-look").filter({ hasText: "never made" });
  // Under its first row the whole look; under the second row of the cause, that it is the same.
  await expect(look).toHaveCount(1);
  await expect(panel.getByTestId("helper-look-same")).toHaveCount(1);
  await expect(look.first().getByTestId("helper-look-name")).toHaveText("Pip");
  await expect(look.first().getByTestId("helper-look-what")).toContainText("a bug in Keel");
  await expect(look.first().getByTestId("helper-look-whose")).toHaveText("A bug in Keel");
  await expect(look.first().getByTestId("helper-look-task")).toHaveValue(task);
  await expect(look.first().getByTestId("helper-look-cost")).toContainText("Scripted");
  await expect(panel.getByTestId("helper-look").filter({ hasText: "key is not set" })).toHaveCount(1);
  await expect(panel.getByTestId("helper-look").filter({ hasText: "key is not set" }).getByTestId("helper-look-whose")).toHaveText("Your setup");
  await expect(panel.getByTestId("helper-look").filter({ hasText: "key is not set" }).getByTestId("helper-look-step")).toContainText(`Add the key for ${tag}`);
  // A setup problem offers a step and no task to start.
  await expect(panel.getByTestId("helper-look").filter({ hasText: "key is not set" }).getByTestId("helper-look-start")).toHaveCount(0);
  await shoot(page, "helper-persona-05-errors");

  // Nothing started by itself; pressing the button starts an agent on Keel's repository with the task (edited here).
  const sessionsBefore = (await (await request.get("/api/sessions")).json()).sessions.length;
  await look.first().getByTestId("helper-look-task").fill(`${task} Keep the change small.`);
  await look.first().getByTestId("helper-look-start").click();
  await expect(page).toHaveURL(/\/s\//);
  const id = new URL(page.url()).pathname.split("/").pop()!;
  const s = (await (await request.get(`/api/sessions/${id}`)).json());
  expect((await (await request.get("/api/sessions")).json()).sessions.length).toBe(sessionsBefore + 1);
  expect(s.session.workspace).toMatch(/keel/i);
  await expect.poll(async () => JSON.stringify((await (await request.get(`/api/sessions/${id}`)).json()).events)).toContain("Keep the change small.");
});
