import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

// The Claude Code session gains a question and an answer.
function growClaude(path: string, cwd: string, id: string) {
  const base = { cwd, sessionId: id, version: "2.1.300", isSidechain: false, userType: "external", entrypoint: "cli", timestamp: new Date().toISOString() };
  appendFileSync(path, JSON.stringify({ ...base, type: "user", uuid: "u9", parentUuid: "a3", message: { role: "user", content: "And its colour?" } }) + "\n");
  appendFileSync(path, JSON.stringify({ ...base, type: "assistant", uuid: "a9", parentUuid: "u9", message: { id: "msg_9", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Yellow." }] } }) + "\n");
}

// Feature: import of other harnesses' sessions and export. The sheet lists
// Claude Code, Codex and Rust Keel sessions from their stores, previews one,
// imports a copy that a model goes on with, updates it when the source grew;
// a session exports to Markdown, to a Keel file another Keel imports, and as a
// new Claude Code transcript with the command that resumes it.
// Run the daemon with KEEL_IMPORT_CLAUDE_DIR, KEEL_IMPORT_CODEX_DIR and
// KEEL_IMPORT_KEEL_DB at scratch stores: this test writes its fixtures there.
test("import and export", async ({ page, request }) => {
  const first = await (await request.get("/api/import/sessions?limit=1")).json();
  const store = (h: string) => first.harnesses.find((x: any) => x.harness === h).store as string;
  test.skip(!store("claude").includes("keel-work"), "needs scratch import stores (KEEL_IMPORT_*)");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const tag = String(Date.now());
  const cwd = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `import-${tag}`);
  mkdirSync(cwd, { recursive: true });
  const made = JSON.parse(execFileSync("bun", [join(import.meta.dirname, "fixtures/import-stores.ts"), store("claude"), store("codex"), store("keel"), cwd, tag], { encoding: "utf8" }));

  // The sheet: harness tabs with counts, a list, a preview.
  await page.goto("/");
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Import sessions");
  await page.keyboard.press("Enter");
  const sheet = page.getByTestId("import-sheet");
  await expect(sheet).toBeVisible();
  await page.getByTestId("import-search").fill(tag);
  const rows = sheet.getByTestId("import-row");
  await expect(rows).toHaveCount(1, { timeout: 15_000 });
  await expect(rows.first()).toContainText("Name the quince fixture");
  await rows.first().click();
  const preview = page.getByTestId("import-preview");
  await expect(preview.getByTestId("import-counts")).toContainText("1prompts");
  await expect(preview).toContainText("not carried: signatures");
  await expect(preview).toContainText("The fruit is quince.");
  await shoot(page, "import-01-preview");

  // Import, then a model goes on with the copy.
  await preview.getByTestId("import-go").click();
  await expect(page).toHaveURL(/\/s\//);
  const id = page.url().split("/s/")[1]!;
  await expect(page.getByTestId("assistant-text").last()).toContainText("The fruit is quince.");
  await request.patch(`/api/sessions/${id}`, { data: { model: HAIKU } });
  await page.reload();
  await page.getByTestId("composer").fill("Which fruit did the file name? Answer with the one word.");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 120_000 });
  await expect(page.getByTestId("assistant-text").last()).toContainText(/quince/i);
  await shoot(page, "import-02-continued");

  // The source goes on: the list says so, and Update brings what it gained.
  growClaude(made.claude, cwd, `c0ffee00-0000-4000-8000-${tag.padStart(12, "0")}`);
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Import sessions");
  await page.keyboard.press("Enter");
  await page.getByTestId("import-search").fill(tag);
  await expect(rows.first().getByTestId("import-imported")).toHaveText("imported · grew", { timeout: 15_000 });
  await rows.first().click();
  await page.getByTestId("import-update").click();
  await expect(page.getByText("Yellow.")).toBeVisible();

  // Codex and the Rust Keel, from their own stores.
  for (const [tab, text] of [["codex", "The code word is bramble."], ["keel", "The harbour is Kythira."]] as const) {
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("Import sessions");
    await page.keyboard.press("Enter");
    await page.getByTestId(`import-tab-${tab}`).click();
    await page.getByTestId("import-search").fill(tag);
    await expect(rows.first()).toContainText(tab === "codex" ? "Pick a code word" : "Harbour Kythira");
    await rows.first().click();
    await expect(page.getByTestId("import-preview")).toContainText(text);
    if (tab === "keel") await shoot(page, "import-03-keel");
    await page.getByTestId("import-go").click();
    await expect(page.getByTestId("assistant-text").last()).toContainText(text);
  }

  // Export: Markdown and a Keel file to download, and a Claude Code transcript.
  const md = await request.get(`/api/sessions/${id}/export?format=md`);
  expect(md.headers()["x-keel-redacted"]).toBe("1");
  expect(await md.text()).toContain("quince");
  const keelFile = await (await request.get(`/api/sessions/${id}/export?format=jsonl`)).text();
  const again = await (await request.post("/api/sessions/import", { data: keelFile, headers: { "content-type": "application/x-ndjson" } })).json();
  expect(again.events_imported).toBeGreaterThan(3);
  await page.goto(`/s/${id}`);
  await page.getByRole("button", { name: "Export or continue elsewhere" }).click();
  const dialog = page.getByTestId("export-dialog");
  await expect(dialog.getByTestId("export-origin")).toContainText("Imported from Claude Code");
  await dialog.getByTestId("export-claude").click();
  await expect(dialog.getByTestId("export-command")).toContainText("claude --resume");
  await shoot(page, "import-04-export");
  const path = (await dialog.getByTestId("export-written").locator("p").last().textContent())!.trim();
  expect(path.startsWith(store("claude"))).toBe(true);
  expect(existsSync(path)).toBe(true);
  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.some((r) => r.type === "assistant" && JSON.stringify(r.message.content).includes("quince"))).toBe(true);
  // What was written reads back as a Claude Code session.
  const listed = await (await request.get(`/api/import/sessions?harness=claude&q=${tag}&refresh=1`)).json();
  expect(listed.total).toBe(2);

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
