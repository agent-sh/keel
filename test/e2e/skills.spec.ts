import { expect, test } from "./isolate.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

// Feature: SKILL.md skills. A project skill is listed for the folder, the
// owner runs it from the message box with an argument, and the model loads
// another one itself with the Skill tool; both follow the skill's body.
test("skills: listed, run by the owner, loaded by the model", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const ws = join(process.env.KEEL_DEV_DIR ?? `${process.env.HOME}/.cache/keel-work/bun/dev-tools`, `skills-${Date.now()}`);
  const skill = (name: string, body: string, extra = "") => {
    mkdirSync(join(ws, ".claude/skills", name), { recursive: true });
    writeFileSync(join(ws, ".claude/skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${extra || `Test skill ${name}`}\n---\n${body}\n`);
  };
  skill("stamp-word", "Reply with exactly one line: STAMP-$0-STAMP. Nothing else.", "Stamp a word. Run with the word as the argument.");
  skill("bird-fact", "Reply with exactly one line: BIRDFACT-$ARGUMENTS. Nothing else.", "Use when asked for a bird fact; pass the bird's name.");

  const listed = (await (await request.get(`/api/skills?cwd=${encodeURIComponent(ws)}`)).json()).skills.map((s: any) => s.name);
  expect(listed).toEqual(expect.arrayContaining(["stamp-word", "bird-fact"]));

  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await page.goto(`/s/${session.id}`);
  const box = page.getByTestId("composer");
  await box.fill("/stamp");
  await expect(page.getByTestId("slash-menu")).toContainText("stamp-word");
  await shoot(page, "skills-01-slash-menu");
  await box.fill("/stamp-word pelican");
  await box.press("Escape");
  await box.press("Enter");
  await expect(page.getByTestId("note").first()).toContainText("Loaded the stamp-word skill");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 90_000 });
  await expect(page.getByTestId("assistant-text").last()).toContainText("STAMP-pelican-STAMP");
  await shoot(page, "skills-02-owner-ran");

  await box.fill("Load the bird-fact skill with the Skill tool, with args heron, and follow it.");
  await box.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 90_000 });
  await expect(page.locator('[data-tool="Skill"]')).toBeVisible();
  await expect(page.getByTestId("assistant-text").last()).toContainText("BIRDFACT-heron");
  await shoot(page, "skills-03-model-loaded");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
