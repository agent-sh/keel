import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./isolate.ts";
import { choose, openPanel, shoot } from "./shots.ts";

test.use({ viewport: { width: 1700, height: 980 } });

// Feature: projects. A project made from the list, named, with instructions,
// a folder, a file and a default mode; a session in its folder joins it, a
// new session from the project starts in its folder and mode, a session
// dragged onto the project joins it and leaves it from its panel. The
// instructions are a block of each member's kept prompt; a change to them is
// told at the tail of a warm session, and a compaction folds it into the
// prompt and names it.
test("projects: instructions, folders, defaults, membership", async ({ page, request }) => {
  const word = `pj${Date.now().toString(36)}`;
  const root = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", word);
  const inside = join(root, "app"), outside = join(root, "elsewhere");
  mkdirSync(inside, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(inside, "SPEC.md"), "# Spec\n");
  const MODEL = "scripted:stand-in";
  const turns = (id: string, n: number) => expect.poll(async () => {
    const r = await (await request.get(`/api/sessions/${id}`)).json();
    return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
  }, { timeout: 60_000 }).toBe(n);

  // A session already working in the folder, before there is a project.
  const a = (await (await request.post("/api/sessions", { data: { workspace: inside, model: MODEL, title: `Parser ${word}` } })).json()).session;
  const b = (await (await request.post("/api/sessions", { data: { workspace: outside, model: MODEL, title: `Notes ${word}` } })).json()).session;

  await page.goto("/");
  await page.getByTestId("list-arrange").click();
  await page.getByTestId("arrange-group-project").click();
  await page.keyboard.press("Escape");
  await page.getByTestId("project-create").click();
  await expect(page.getByTestId("project-page")).toBeVisible();
  const pid = (await page.getByTestId("project-page").getAttribute("data-project"))!;
  await page.getByTestId("project-name").fill(`Atlas ${word}`);
  await page.getByTestId("project-name").press("Enter");
  await page.getByTestId("project-instructions-text").fill(`Target the branch next-${word}. Keep replies short.`);
  await page.getByTestId("project-instructions-save").click();
  await expect(page.getByTestId("project-instructions-save")).toHaveText("Saved");
  await request.patch(`/api/projects/${pid}`, { data: { folders: [inside], defaults: { model: MODEL } } });
  await expect(page.getByTestId("project-folder")).toHaveCount(1);
  await page.getByTestId("project-file-input").fill("SPEC.md");
  await page.getByTestId("project-file-input").press("Enter");
  await expect(page.getByTestId("project-file")).toHaveCount(1);
  await choose(page.getByTestId("project-mode"), "auto-edits");
  const project = async () => (await (await request.get(`/api/projects/${pid}`)).json());
  await expect.poll(async () => (await project()).project).toMatchObject({ name: `Atlas ${word}`, files: [join(inside, "SPEC.md")], defaults: { model: MODEL, mode: "auto-edits" } });
  // The session in its folder joined it.
  await expect.poll(async () => (await project()).sessions).toContain(a.id);
  await expect(page.getByTestId("project-session")).toHaveCount(1);
  await page.getByTestId("project-name").scrollIntoViewIfNeeded();
  await shoot(page, "projects-01-page");

  // The list by project: the project with its session, the rest under No project.
  const group = page.locator(`[data-testid="project-group"][data-project="${pid}"]`);
  await expect(group.locator(`[data-session="${a.id}"]`)).toBeVisible();
  await expect(page.locator('[data-testid="project-group"][data-project="none"]').locator(`[data-session="${b.id}"]`)).toBeVisible();

  // A new session from the project: its folder, its project, its mode.
  await page.getByTestId("project-new-session").click();
  await expect(page.getByTestId("new-project-select")).toContainText(`Atlas ${word}`);
  await shoot(page, "projects-02-new-session");
  await page.getByTestId("composer").fill("Hello from the project.");
  await page.getByTestId("composer").press("Enter");
  await page.waitForURL(/\/s\//);
  const c = page.url().split("/s/")[1]!;
  const cs = (await (await request.get(`/api/sessions/${c}`)).json()).session;
  expect(cs.workspace).toBe(inside);
  expect(cs.model).toBe(MODEL);
  expect((await (await request.get(`/api/sessions/${c}/permissions`)).json()).perm.mode).toBe("auto-edits");
  await expect.poll(async () => (await project()).sessions).toContain(c);

  // The instructions are a block of the member's own prompt; a change is named at the next turn.
  await request.post(`/api/sessions/${a.id}/messages`, { data: { text: "first" } });
  await turns(a.id, 1);
  const kept = async () => (await (await request.get(`/api/telemetry/prompt?session_id=${a.id}&text=1`)).json());
  const k1 = await kept();
  expect(k1.blocks.map((x: any) => x.name)).toContain("Project instructions");
  expect(k1.text).toContain(`next-${word}`);
  expect(k1.text).toContain(join(inside, "SPEC.md"));
  // Past the cache split: the shared part holds none of it.
  expect(k1.text.slice(0, k1.split)).not.toContain(`next-${word}`);
  await page.goto(`/p/${pid}`);
  await page.getByTestId("project-instructions-text").fill(`Target the branch main-${word}.`);
  await page.getByTestId("project-instructions-save").click();
  await expect(page.getByTestId("project-instructions-save")).toHaveText("Saved");
  await request.post(`/api/sessions/${a.id}/messages`, { data: { text: "second" } });
  await turns(a.id, 2);
  // The cache is warm, so the kept prompt stays as it was sent and the change
  // is told at the tail of the history as a note (src/engine/prompt-note.ts).
  const k2 = await kept();
  expect(k2.text).toContain(`next-${word}`);
  expect(k2.text).not.toContain(`main-${word}`);
  const told = (await (await request.get(`/api/sessions/${a.id}`)).json()).events.filter((e: any) => e.kind === "note" && e.data.kind === "prompt_update");
  expect(told.map((e: any) => Object.keys(e.data.blocks))).toEqual([["Project instructions"]]);
  expect(told[0].data.text).toContain(`main-${word}`);
  // A compaction folds it into the prompt, which names the block that changed.
  await request.post(`/api/sessions/${a.id}/compact`, { data: {} });
  await request.post(`/api/sessions/${a.id}/messages`, { data: { text: "third" } });
  await turns(a.id, 3);
  const k3 = await kept();
  expect(k3.text).toContain(`main-${word}`);
  expect(k3.changed.blocks).toEqual(["Project instructions"]);

  // Drag a session from No project onto the project's head: it joins.
  await page.goto(`/s/${b.id}`);
  await page.locator(`[data-testid="project-group"][data-project="none"] [data-session="${b.id}"]`).dragTo(group.getByTestId("project-head"));
  await expect(group.locator(`[data-session="${b.id}"]`)).toBeVisible();
  expect((await (await request.get(`/api/sessions/${b.id}`)).json()).session.settings.project).toBe(pid);
  await shoot(page, "projects-03-list");
  // And leaves it from its panel.
  await openPanel(page, "session");
  await expect(page.getByTestId("session-organize")).toBeVisible();
  await choose(page.getByTestId("session-project"), "none");
  await expect(page.locator('[data-testid="project-group"][data-project="none"]').locator(`[data-session="${b.id}"]`)).toBeVisible();
  await shoot(page, "projects-04-panel");

  // Deleting the project leaves its sessions where they are.
  await request.delete(`/api/projects/${pid}`);
  expect((await (await request.get(`/api/sessions/${b.id}`)).json()).session.settings.project).toBe("none");
  for (const id of [a.id, b.id, c]) await request.delete(`/api/sessions/${id}`);
});

// The page lays out by its own width, not the window's: beside the session
// list and at a large text size it is one column while a second would squeeze
// the forms, and on a phone every control of a row stays whole inside it.
test("the project page lays out by its own width", async ({ page, request }) => {
  const word = `pw${Date.now().toString(36)}`;
  const root = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", word);
  const first = join(root, "services/billing-reconciliation"), second = join(root, "packages/shared-contracts");
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  mkdirSync(join(first, "docs"), { recursive: true });
  writeFileSync(join(first, "docs/reconciliation-spec.md"), "# Spec\n");
  const s = (await (await request.post("/api/sessions", { data: { workspace: first, model: "scripted:stand-in", title: `Reconcile the ledger exports ${word}` } })).json()).session;
  const p = (await (await request.post("/api/projects", { data: { name: `Ledger ${word}`, folders: [first, second], files: [join(first, "docs/reconciliation-spec.md")], instructions: "Target the release branch. Keep replies short." } })).json()).project;
  const box = async (id: string) => (await page.getByTestId(id).boundingBox())!;
  const rem = () => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  // Whole inside the window, and inside the block it belongs to.
  const whole = async (l: ReturnType<typeof page.getByTestId>, block?: string) => {
    await l.scrollIntoViewIfNeeded();
    const b = (await l.boundingBox())!, w = page.viewportSize()!.width;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(w);
    if (block) { const o = await box(block); expect(b.x).toBeGreaterThanOrEqual(o.x); expect(b.x + b.width).toBeLessThanOrEqual(o.x + o.width); }
  };
  const noPan = () => page.getByTestId("project-page").evaluate((el) => [el, ...el.querySelectorAll("*")].every((n) => n.scrollWidth <= n.clientWidth + 1 || !["auto", "scroll"].includes(getComputedStyle(n).overflowX)));

  // A wide page: the sessions stand beside the forms.
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto(`/p/${p.id}`);
  await expect(page.getByTestId("project-session")).toHaveCount(1);
  expect((await box("project-sessions")).x).toBeGreaterThan((await box("project-instructions")).x + (await box("project-instructions")).width);
  await shoot(page, "projects-05-wide");

  // 1024 px with the session list open and the text at 150%: one column, the forms at a working width.
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.evaluate(() => { localStorage.setItem("keel.textScale", "1.5"); localStorage.setItem("keel.list", "true"); });
  await page.reload();
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await expect(page.getByTestId("project-session")).toHaveCount(1);
  const form = await box("project-instructions"), list = await box("project-sessions");
  expect(list.y).toBeGreaterThan(form.y + form.height);
  expect(Math.abs(list.x - form.x)).toBeLessThan(2);
  expect(form.width).toBeGreaterThan(24 * (await rem()));
  expect(await noPan()).toBe(true);
  await shoot(page, "projects-06-1024-text-150");
  await page.evaluate(() => localStorage.removeItem("keel.textScale"));

  // A phone: each row's controls are whole.
  await page.setViewportSize({ width: 320, height: 568 });
  await page.reload();
  await expect(page.getByTestId("project-folder")).toHaveCount(2);
  await whole(page.getByTestId("project-new-session"));
  await whole(page.getByTestId("project-delete"));
  await shoot(page, "projects-07-phone-head");
  await whole(page.getByTestId("project-instructions-save"), "project-instructions");
  await whole(page.getByTestId("project-instructions-text"), "project-instructions");
  const folder = page.getByTestId("project-folder").nth(1);
  await whole(folder.getByRole("button", { name: "Make primary" }), "project-folders");
  await whole(folder.getByRole("button", { name: /^Remove / }), "project-folders");
  await whole(page.getByTestId("project-add-folder").getByRole("button"), "project-folders");
  await shoot(page, "projects-08-phone-folders");
  await whole(page.getByTestId("project-file-input"), "project-files");
  await whole(page.getByTestId("project-files").getByRole("button", { name: "Add" }), "project-files");
  await whole(page.getByTestId("project-mode"), "project-defaults");
  await shoot(page, "projects-09-phone-files");
  expect(await noPan()).toBe(true);
  // The controls still work there: the second folder becomes the primary one.
  await folder.getByRole("button", { name: "Make primary" }).click();
  await expect.poll(async () => (await (await request.get(`/api/projects/${p.id}`)).json()).project.folders[0]).toBe(second);

  await request.delete(`/api/projects/${p.id}`);
  await request.delete(`/api/sessions/${s.id}`);
});
