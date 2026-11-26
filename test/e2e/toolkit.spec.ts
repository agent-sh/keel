import { expect, test, type Page } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

// Feature: the toolkit pages of Settings. Everything the daemon loads from
// files is listed by where it comes from, readable and writable: skills,
// commands, agent definitions, instruction files, the owner's hooks file and
// plugins.toml. One test per page, on a scratch repository; what a test writes
// in the daemon's config folder (its own scratch one) it removes.
const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `toolkit-${Date.now()}`);
const outside = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `toolkit-shared-${Date.now()}.md`);
const put = (p: string, t: string) => (mkdirSync(join(p, ".."), { recursive: true }), writeFileSync(p, t));

test.beforeAll(async ({ request }) => {
  put(join(ws, "AGENTS.md"), "# Scratch repository\n\nKeep replies short.\n");
  put(join(ws, ".agents/skills/ship-notes/SKILL.md"), "---\nname: ship-notes\ndescription: Use when writing release notes for this repository.\n---\n\n# ship-notes\n\nList the merged changes.\n");
  put(join(ws, ".claude/commands/deploy-notes.md"), "---\ndescription: Write the deploy notes for $ARGUMENTS\nargument-hint: <version>\n---\n\nWrite deploy notes for version $ARGUMENTS.\n");
  put(join(ws, ".claude/agents/diff-checker.md"), "---\nname: diff-checker\ndescription: Use to check a diff before it lands.\ntools: Read, Grep\n---\n\nRead the diff and report problems.\n");
  put(join(ws, ".codex/agents/pr-explorer.toml"), 'name = "pr_explorer"\ndescription = "Read-only explorer that gathers evidence before a change."\nmodel = "not-a-listed-model"\nmodel_reasoning_effort = "high"\ndeveloper_instructions = """\nStay in exploration mode.\nDo not edit files.\n"""\n\n[features]\nshell_tool = false\n');
  put(outside, "Shared rule: answer in one line.\n");
  execFileSync("git", ["init", "-q", ws]);
  // A session in the folder puts it first among the recent folders the pages are seen from.
  await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } });
});
test.afterAll(() => rmSync(outside, { force: true }));

async function open(page: Page, section: string) {
  await page.goto(`/customize/${section}`);
  await expect(page.getByTestId("toolkit-folder")).toContainText(ws.split("/").pop()!);
}

test("toolkit: skills", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  await open(page, "skills");
  const entry = page.locator('[data-testid="skill-entry"][data-name="ship-notes"]');
  await entry.click();
  await expect(page.getByTestId("reader-title")).toHaveText("ship-notes");
  await expect(page.locator('[data-testid="toolkit-group"]').filter({ has: entry })).toContainText("This repository");
  await shoot(page, "toolkit-skills-01-list");

  // Off and on again: a local override, the file is untouched.
  await page.getByTestId("skill-toggle").click();
  await expect(entry).toHaveAttribute("data-mark", "off");
  const off = (await (await request.get(`/api/skills?cwd=${encodeURIComponent(ws)}`)).json()).skills.find((s: any) => s.name === "ship-notes");
  expect(off.enabled).toBe(false);
  await page.getByTestId("skill-toggle").click();
  await expect(entry).toHaveAttribute("data-mark", "on");

  // The file itself, edited and saved.
  const text = page.getByTestId("editor-text");
  await text.fill((await text.inputValue()).replace("List the merged changes.", "List the merged changes, newest first."));
  await expect(page.getByTestId("editor-dirty")).toBeVisible();
  await shoot(page, "toolkit-skills-02-editing");
  await page.getByTestId("editor-save").click();
  await expect(page.getByTestId("editor-saved")).toBeVisible();
  expect(readFileSync(join(ws, ".agents/skills/ship-notes/SKILL.md"), "utf8")).toContain("newest first");

  // A new one of the owner's, in the daemon's config folder.
  await page.getByTestId("toolkit-add-+new").click();
  await page.getByTestId("new-name").fill("toolkit-check");
  await page.getByTestId("new-description").fill("Use when checking the toolkit pages.");
  await shoot(page, "toolkit-skills-03-new");
  await page.getByTestId("new-create").click();
  await expect(page.getByTestId("reader-title")).toHaveText("toolkit-check");
  await expect(page.locator('[data-testid="skill-entry"][data-name="toolkit-check"]')).toHaveAttribute("aria-current", "true");
  const { homes } = await (await request.get(`/api/skills?cwd=${encodeURIComponent(ws)}`)).json();
  expect(existsSync(join(homes.personal, "toolkit-check/SKILL.md"))).toBe(true);
  await shoot(page, "toolkit-skills-04-created");
  rmSync(join(homes.personal, "toolkit-check"), { recursive: true, force: true });
  expect((await (await request.get("/api/errors")).json()).errors.length).toBe(errorsBefore);
});

test("toolkit: commands", async ({ page }) => {
  await open(page, "commands");
  await expect(page.locator('[data-testid="command-entry"][data-name="/loop"]')).toBeVisible();
  const file = page.locator('[data-testid="command-entry"][data-name="/deploy-notes"]');
  await expect(page.locator('[data-testid="toolkit-group"]').filter({ has: file })).toContainText("command files");
  await file.click();
  await expect(page.getByTestId("reader-title")).toHaveText("/deploy-notes");
  await expect(page.locator(".k-facts")).toContainText("command file");
  await expect(page.locator(".k-facts")).toContainText("<version>");
  await shoot(page, "toolkit-commands-01-file");
  await page.locator('[data-testid="command-entry"][data-name="/loop"]').click();
  await expect(page.locator(".k-reader-body")).toContainText("no file to edit");
  await shoot(page, "toolkit-commands-02-builtin");
});

test("toolkit: agents", async ({ page, request }) => {
  await open(page, "agents");
  await expect(page.getByTestId("advisor-setting")).toBeVisible();
  const def = page.locator('[data-testid="agent-entry"][data-name="diff-checker"]');
  await def.click();
  await expect(page.locator(".k-facts")).toContainText("this repository");
  const text = page.getByTestId("editor-text");
  await expect(text).toHaveValue(/Read the diff/);
  await text.fill((await text.inputValue()).replace("report problems.", "report problems with file and line."));
  await page.getByTestId("editor-save").click();
  await expect(page.getByTestId("editor-saved")).toBeVisible();
  expect(readFileSync(join(ws, ".claude/agents/diff-checker.md"), "utf8")).toContain("file and line");
  await shoot(page, "toolkit-agents-01-file");

  // A Codex agent file (TOML) is read the same way: its instructions, its model
  // as a preference, no shell; a save is checked as TOML first.
  await page.locator('[data-testid="agent-entry"][data-name="pr_explorer"]').click();
  await expect(page.getByTestId("agents-ledger")).toContainText("This repository, Codex");
  await expect(page.locator(".k-facts")).toContainText("not-a-listed-model when listed");
  await expect(page.locator(".k-facts")).toContainText("Bash");
  await expect(text).toHaveValue(/Stay in exploration mode/);
  await text.fill((await text.inputValue()).replace('name = "pr_explorer"', 'name = "pr_explorer'));
  await page.getByTestId("editor-save").click();
  await expect(page.getByTestId("editor-note")).toContainText("not TOML");
  expect(readFileSync(join(ws, ".codex/agents/pr-explorer.toml"), "utf8")).toContain('name = "pr_explorer"');
  await shoot(page, "toolkit-agents-03-codex");
  const codex = (await (await request.get(`/api/agents?cwd=${encodeURIComponent(ws)}`)).json()).agents.find((a: any) => a.name === "pr_explorer");
  expect(codex).toMatchObject({ format: "codex", effort: "high", disallowed: ["Bash"], source: "project" });
  expect(codex.body).toContain("Do not edit files.");

  // A built-in one reads, without an editor.
  await page.locator('[data-testid="agent-entry"]').first().click();
  await expect(page.locator(".k-editor-pre")).toBeVisible();
  await page.getByTestId("toolkit-add-+new").click();
  await page.getByTestId("new-name").fill("toolkit-scout");
  await page.getByTestId("new-description").fill("Use to look around a repository before a change.");
  await page.getByTestId("new-create").click();
  await expect(page.getByTestId("reader-title")).toHaveText("toolkit-scout");
  await shoot(page, "toolkit-agents-02-created");
  const { homes } = await (await request.get(`/api/agents/files?cwd=${encodeURIComponent(ws)}`)).json();
  rmSync(join(homes.owner, "toolkit-scout.md"), { force: true });
});

test("toolkit: instructions", async ({ page, request }) => {
  await open(page, "instructions");
  const mine = page.locator('[data-testid="instruction-entry"]').filter({ hasText: ws.split("/").pop()! });
  await mine.click();
  await expect(page.getByTestId("reader-title")).toHaveText("This folder");
  const text = page.getByTestId("editor-text");
  await text.fill("# Scratch repository\n\nKeep replies short and plain.\n");
  await page.getByTestId("editor-save").click();
  await expect(page.getByTestId("editor-saved")).toBeVisible();
  expect(readFileSync(join(ws, "AGENTS.md"), "utf8")).toContain("short and plain");
  await shoot(page, "toolkit-instructions-01-folder");

  // The owner's own file, not written yet: written here with an @ line that brings in a file outside any repository.
  await page.locator('[data-testid="instruction-create"][data-name="AGENTS.md"]').filter({ hasText: "every folder" }).click();
  await page.getByTestId("editor-text").fill(`Answer the owner first.\n\n@${outside}\n`);
  await page.getByTestId("editor-save").click();
  const entries = page.locator('[data-testid="instruction-entry"]');
  const listed = async () => (await (await request.get(`/api/instructions?cwd=${encodeURIComponent(ws)}`)).json()).files;
  await expect.poll(async () => (await listed()).some((f: any) => f.scope === "owner")).toBe(true);
  await expect(entries).toHaveCount((await listed()).length);
  const first = entries.first();
  await first.click();
  await expect(page.getByTestId("reader-title")).toHaveText("Yours, in every folder");
  await page.getByTestId("seg-loaded").click();
  await expect(page.getByTestId("instruction-loaded")).toContainText("Shared rule: answer in one line.");
  await shoot(page, "toolkit-instructions-02-imports");
  const v = await (await request.get(`/api/instructions?cwd=${encodeURIComponent(ws)}`)).json();
  rmSync(v.files.find((f: any) => f.scope === "owner").path, { force: true });
});

test("toolkit: a nested instructions file is named in full on a phone", async ({ page }) => {
  const path = join(ws, ".claude/CLAUDE.md");
  put(path, "# Claude rules\n\nKeep tests narrow.\n");
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, "instructions");
    const entry = page.getByTestId("instruction-entry").filter({ hasText: ".claude" }).last();
    await entry.scrollIntoViewIfNeeded();
    await shoot(page, "instructions-nested-file");
    const name = entry.locator(".k-entry-name");
    await expect(name).toHaveText(/\.claude\/CLAUDE\.md$/);
    expect(await name.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    const desc = entry.locator(".k-entry-desc");
    await expect(desc).toHaveText(`this folder · ${ws.split("/").pop()}/.claude`);
    expect(await desc.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  } finally {
    rmSync(path, { force: true });
  }
});

test("toolkit: hooks", async ({ page, request }) => {
  const owner = await (await request.get("/api/hooks/owner")).json();
  test.skip(!String(owner.path).includes("keel-work"), "needs a scratch owner hooks file");
  await page.goto("/customize/hooks");
  await page.locator('[data-testid="hook-source"][data-scope="owner"]').click();
  const text = page.getByTestId("editor-text");
  await text.fill('{ "hooks": { "Stop": [ ');
  await page.getByTestId("editor-save").click();
  await expect(page.getByTestId("editor-note")).toContainText("not JSON");
  await shoot(page, "toolkit-hooks-01-invalid");
  await text.fill(`{ "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "echo started ${Date.now()}" }] }] } }\n`);
  await page.getByTestId("editor-save").click();
  await expect(page.getByTestId("editor-saved")).toBeVisible();
  await expect(page.locator('[data-testid="hook-source"][data-scope="owner"]')).toHaveAttribute("data-active", "true");
  await shoot(page, "toolkit-hooks-02-saved");
  if (owner.text === null) rmSync(owner.path, { force: true });
  else writeFileSync(owner.path, owner.text);
});

test("toolkit: plugins", async ({ page }) => {
  await page.goto("/customize/plugins");
  await expect(page.locator('[data-testid="plugin-entry"]').filter({ hasText: "Chrome" }).first()).toBeVisible();
  await page.locator('[data-testid="plugin-entry"][data-name="plugins.toml"]').click();
  await expect(page.getByTestId("reader-title")).toHaveText("plugins.toml");
  await shoot(page, "toolkit-plugins-01-file");
  // A file that is not TOML is refused before it is written.
  await page.getByTestId("editor-text").fill("[plugins.broken\ncommand = ");
  await page.getByTestId("editor-save").click();
  await expect(page.getByTestId("editor-note")).toContainText("not TOML");
  const first = page.locator('[data-testid="plugin-entry"]').first();
  await first.click();
  await shoot(page, "toolkit-plugins-02-plugin");
});
