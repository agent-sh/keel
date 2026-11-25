import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ask, HAIKU, SCRIPTED, shoot } from "./shots.ts";

// Feature: a session's title says its task. Until the first reply it is the
// first prompt's first line; then one of the owner's small models writes a
// few words for it, and the list, the header and a search read them. A first
// prompt that held no task yet (a greeting) gets its title written once more
// after the next reply. A new version of the first prompt is a new task and
// is titled again. A title the owner gave is never replaced.
test("a small model titles a session after its first reply, and never over the owner's", async ({ page, request }) => {
  const tag = `tq${Date.now().toString(36)}`;
  const header = page.getByTestId("session-title");
  const list = page.getByTestId("session-list");
  const titleOf = async (id: string) => (await (await request.get(`/api/sessions/${id}?events=0`)).json()).session.title as string;

  // The owner's small model writes it: a model other than the session's, so its use is seen in the usage.
  const { models, default: def } = await (await request.get("/api/models")).json();
  const small = (models as any[]).find((m) => m.id !== def && m.provider === (models as any[]).find((x) => x.id === def)?.provider && !m.hidden)?.id;
  if (small) expect((await request.patch("/api/settings", { data: { small_models: { ids: [small] } } })).ok()).toBe(true);

  // A long first prompt: the title is its first line until the reply, then the task in a few words.
  await page.goto("/");
  const long = `Point 1: the cart total must handle discounts given as a percentage (10 means ten percent), not only amounts (${tag})`;
  await page.getByTestId("composer").fill(ask(long, `${long}\nscript:say Done.\nscript:title Percentage discounts in cart ${tag}`));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/s\//);
  const id = new URL(page.url()).pathname.split("/s/")[1]!;
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 90_000 });
  if (SCRIPTED) await expect(header).toHaveText(`Percentage discounts in cart ${tag}`, { timeout: 30_000 });
  else await expect.poll(() => titleOf(id), { timeout: 60_000 }).not.toContain("Point 1");
  const title = await titleOf(id);
  expect(title.length).toBeLessThanOrEqual(80);
  await expect(list).toContainText(title);
  if (small) {
    const used = (await (await request.get(`/api/usage?group=model&session_id=${id}`)).json()).buckets.map((b: any) => b.key);
    expect(used).toContain(small);
  }
  await shoot(page, "titles-01-made");

  // A search finds it by its new words.
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill(`discounts in cart ${tag}`);
  await expect(page.getByTestId("palette").getByRole("option").first()).toContainText(title);
  await shoot(page, "titles-02-search");
  await page.keyboard.press("Escape");

  // A new version of the first prompt is a new task: its title is made again.
  const other = `Count the cart items one by one and say how many there are (${tag})`;
  await page.getByTestId("user-message").hover();
  await page.getByTestId("edit-message").click();
  await page.getByTestId("edit-box").fill(ask(other, `${other}\nscript:say Three.\nscript:title Count cart items ${tag}`));
  await page.getByTestId("edit-send").click();
  await expect(page.getByTestId("branch-pos")).toHaveText("2/2", { timeout: 30_000 });
  if (SCRIPTED) await expect(header).toHaveText(`Count cart items ${tag}`, { timeout: 30_000 });
  else await expect.poll(() => titleOf(id), { timeout: 60_000 }).not.toBe(title);

  // A greeting first: a title is written, and once more after the next reply, and not again.
  const { session: hi } = await (await request.post("/api/sessions", { data: { model: HAIKU } })).json();
  await page.goto(`/s/${hi.id}`);
  const composer = page.getByTestId("composer");
  await composer.fill(ask("hi", `hi\nscript:say Hello.\nscript:title Greeting ${tag}`));
  await composer.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 90_000 });
  if (SCRIPTED) await expect(header).toHaveText(`Greeting ${tag}`, { timeout: 30_000 });
  const task = `The uploader must retry a part three times before it gives up (${tag})`;
  await composer.fill(ask(task, `${task}\nscript:say On it.\nscript:title Uploader part retries ${tag}`));
  await composer.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 90_000 });
  if (SCRIPTED) await expect(header).toHaveText(`Uploader part retries ${tag}`, { timeout: 30_000 });
  else await expect.poll(() => titleOf(hi.id), { timeout: 60_000 }).toMatch(/upload|retr/i);
  const settled = await titleOf(hi.id);
  await composer.fill(ask("Also log each retry.", `Also log each retry.\nscript:say Logged.\nscript:title Something else ${tag}`));
  await composer.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(3, { timeout: 90_000 });
  await expect(header).toHaveText(settled);
  await shoot(page, "titles-03-after-greeting");

  // The owner's title stays: a rename before the first reply is not replaced, nor after an edit.
  const { session: named } = await (await request.post("/api/sessions", { data: { model: HAIKU } })).json();
  await page.goto(`/s/${named.id}`);
  await page.getByTestId("session-menu").click();
  await page.getByTestId("menu-rename").click();
  await page.getByLabel("Session title").fill(`Mine ${tag}`);
  await page.getByLabel("Session title").press("Enter");
  await expect(header).toHaveText(`Mine ${tag}`);
  await composer.fill(ask("Fix the build of the docs site.", `Fix the build of the docs site.\nscript:say Fixed.\nscript:title Docs build fix ${tag}`));
  await composer.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 90_000 });
  await page.getByTestId("user-message").hover();
  await page.getByTestId("edit-message").click();
  await page.getByTestId("edit-box").fill(ask("Fix the docs links.", `Fix the docs links.\nscript:say Fixed.\nscript:title Docs links ${tag}`));
  await page.getByTestId("edit-send").click();
  await expect(page.getByTestId("branch-pos")).toHaveText("2/2", { timeout: 30_000 });
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 90_000 });
  // The title request of the reply would have come by now on the scripted model (it answers at once).
  await expect.poll(() => titleOf(named.id), { timeout: 3_000, intervals: [500, 500, 1000, 1000] }).toBe(`Mine ${tag}`);
  await expect(header).toHaveText(`Mine ${tag}`);

  // The phone reads the same titles.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/s/${hi.id}`);
  await expect(header).toHaveText(settled);
  await shoot(page, "titles-04-phone");
  await page.setViewportSize({ width: 1920, height: 1040 });
});

// A session started from the start box in a new worktree is titled the same way: its first words until the
// reply, then the small model's title (its title was once kept as one the owner gave, and never replaced).
test("a session started in a worktree gets a model title after its first reply", async ({ page, request }) => {
  test.skip(!SCRIPTED, "needs the scripted provider: its title stand-in answers the title request");
  const tag = `tw${Date.now().toString(36)}`;
  // The owner's small model writes it: a model other than the session's.
  const { models, default: def } = await (await request.get("/api/models")).json();
  const small = (models as any[]).find((m) => m.id !== def && m.provider === (models as any[]).find((x) => x.id === def)?.provider && !m.hidden)?.id;
  test.skip(!small, "needs a second model of the default's provider: the title is never written by the session's own model");
  expect((await request.patch("/api/settings", { data: { small_models: { ids: [small] } } })).ok()).toBe(true);
  const repo = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `title-wt-${Date.now()}`);
  mkdirSync(repo, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  await page.addInitScript((ws) => {
    localStorage.setItem("keel.newWorkspace", JSON.stringify(ws));
    localStorage.setItem("keel.startInWorktree", "0");
  }, repo);
  await page.goto("/");
  await page.getByTestId("start-in-worktree").click();
  await expect(page.getByTestId("start-in-worktree")).toHaveAttribute("aria-checked", "true");
  const long = `Point 1: round the invoice tax per line, not on the total (${tag})`;
  await page.getByTestId("composer").fill(ask(long, `${long}\nscript:say Done.\nscript:title Per line tax rounding ${tag}`));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/s\//);
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 90_000 });
  await expect(page.getByTestId("session-title")).toHaveText(`Per line tax rounding ${tag}`, { timeout: 30_000 });
  await shoot(page, "titles-05-worktree");
});
