import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: a row says where its session works, beside its title in small quiet words: its project's name, else
// its folder's. Where the list is grouped by project or by working folder the group's head says it, and the row
// does not; a session in no project still says its folder under "No project".
const MODEL = "scripted:stand-in";
test.use({ viewport: { width: 1920, height: 1040 } });

const made: { sessions: string[]; projects: string[] } = { sessions: [], projects: [] };
test.afterEach(async ({ request }) => {
  for (const id of made.sessions.splice(0)) await request.delete(`/api/sessions/${id}`).catch(() => {});
  for (const id of made.projects.splice(0)) await request.delete(`/api/projects/${id}`).catch(() => {});
});

test("a row shows its project or folder beside the title unless the list is grouped by it", async ({ page, request }) => {
  const tag = Date.now().toString(36);
  const root = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `row-place-${tag}`);
  const loose = join(root, `loose-${tag}`), inProject = join(root, `kit-${tag}`);
  mkdirSync(loose, { recursive: true });
  mkdirSync(inProject, { recursive: true });
  const project = (await (await request.post("/api/projects", { data: { name: `Kit ${tag}`, folders: [inProject] } })).json()).project;
  made.projects.push(project.id);
  const start = async (workspace: string, title: string) => {
    const { session } = await (await request.post("/api/sessions", { data: { model: MODEL, workspace } })).json();
    made.sessions.push(session.id);
    await request.patch(`/api/sessions/${session.id}`, { data: { title } });
    return session.id as string;
  };
  const a = await start(loose, `Loose work ${tag}`);
  const b = await start(inProject, `Kit work ${tag}`);
  const row = (id: string) => page.locator(`[data-testid="session-row"][data-session="${id}"]`);
  const arrange = async (group: string) => {
    await page.getByTestId("list-arrange").click();
    await page.getByTestId(`arrange-group-${group}`).click();
    await page.keyboard.press("Escape");
    // (The pointer and the keyboard off the menu's button: the pictures show rows at rest, with no tooltip.)
    await page.mouse.move(1200, 700);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  };

  await page.goto("/");
  await page.getByTestId("list-filter").fill(tag);

  // One list: each row says where, on the title's own line, after it, in regular weight and the quiet ink.
  await arrange("flat");
  await expect(row(a).getByTestId("row-folder")).toHaveText(`loose-${tag}`);
  await expect(row(b).getByTestId("row-folder")).toHaveText(`Kit ${tag}`);
  const title = await row(a).locator(".k-row-title").boundingBox();
  const place = await row(a).getByTestId("row-folder").boundingBox();
  expect(Math.abs(title!.y + title!.height / 2 - (place!.y + place!.height / 2))).toBeLessThan(6);
  expect(place!.x).toBeGreaterThan(title!.x + title!.width - 1);
  expect(await row(a).getByTestId("row-folder").evaluate((el) => getComputedStyle(el).fontWeight)).toBe("400");
  await shoot(page, "row-place-01-one-list");

  // By working folder: the folder is the group's head, so no row says it.
  await arrange("folder");
  await expect(row(a)).toBeVisible();
  await expect(row(a).getByTestId("row-folder")).toHaveCount(0);
  await expect(row(b).getByTestId("row-folder")).toHaveCount(0);
  await shoot(page, "row-place-02-by-folder");

  // By project: the project's rows say nothing; a session in no project still says its folder.
  await arrange("project");
  await expect(page.locator(`[data-testid="project-group"][data-project="${project.id}"]`).locator(`[data-session="${b}"]`)).toBeVisible();
  await expect(row(b).getByTestId("row-folder")).toHaveCount(0);
  await expect(row(a).getByTestId("row-folder")).toHaveText(`loose-${tag}`);
  await shoot(page, "row-place-03-by-project");
});
