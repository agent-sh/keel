import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./isolate.ts";
import { choose, openPanel, shoot } from "./shots.ts";

test.use({ viewport: { width: 1700, height: 980 } });

// Feature: projects. A project made from the list, named, with instructions,
// a folder, a file and a default mode; a session in its folder joins it, a
// new session from the project starts in its folder and mode, a session
// dragged onto the project joins it and leaves it from its panel. The
// instructions are a block of each member's kept prompt, and a change to them
// is made again at the next turn and named.
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
  const k2 = await kept();
  expect(k2.text).toContain(`main-${word}`);
  expect(k2.changed.blocks).toEqual(["Project instructions"]);

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
