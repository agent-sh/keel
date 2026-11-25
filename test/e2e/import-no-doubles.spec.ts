import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { HAIKU, ask, shoot } from "./shots.ts";

// Feature: a session of another harness shows once. Before it is copied, a session another harness runs is in
// the list under a line of its own (External), below Keel's sessions. Once it is imported it moves up into
// Keel's list and the source shows only as a mark on the copy ("From Claude Code"): no row in the list, none in
// the import sheet (unless asked for), none in the running list; one still running says so on the copy; what
// it wrote since is offered there as resuming the import. The owner names a session by hand (its header, its
// row's menu, F2 on the row) and no auto title or import replaces that name. An Antigravity conversation of
// the real store layout imports the same way. Run the daemon with KEEL_IMPORT_CLAUDE_DIR and KEEL_IMPORT_AGY_DIR
// at scratch stores: this test writes its fixtures there.
test("an imported session is one row with its mark; the owner's name stays; agy imports", async ({ page, request }) => {
  const listed = await (await request.get("/api/import/sessions?limit=1")).json();
  const store = (h: string) => listed.harnesses?.find((x: any) => x.harness === h)?.store as string | undefined;
  const root = store("claude");
  const agyHome = store("agy");
  test.skip(!root?.includes("keel-work") || !agyHome?.includes("keel-work"), "needs scratch Claude Code and Antigravity stores (KEEL_IMPORT_*)");
  const tag = String(Date.now());
  const id = `0d0b1e00-0000-4000-8000-${tag.slice(-12).padStart(12, "0")}`;
  const cwd = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `doubles-${tag}`);
  mkdirSync(cwd, { recursive: true });
  const dir = join(root!, `-e2e-doubles-${tag}`);
  const path = join(dir, `${id}.jsonl`);
  const made: string[] = [];
  let parent: string | null = null;
  let n = 0;
  const write = (r: object) => {
    const uuid = `${id}-${n++}`;
    appendFileSync(path, JSON.stringify({ cwd, sessionId: id, version: "2.1.300", isSidechain: false, userType: "external", entrypoint: "cli", timestamp: new Date().toISOString(), uuid, parentUuid: parent, ...r }) + "\n");
    parent = uuid;
  };
  const reply = (mid: string, text: string, stop: string | null = "end_turn") =>
    write({ type: "assistant", message: { id: mid, role: "assistant", model: "claude-opus-4-5", content: [{ type: "text", text }], stop_reason: stop, usage: { input_tokens: 100, output_tokens: 20 } } });
  const sessions = async () => (await (await request.get("/api/sessions")).json()).sessions as any[];
  const watches = async () => (await (await request.get("/api/outside")).json()).watches as number;
  const list = page.getByTestId("session-list");
  const rowsOf = (word: string) => list.locator('[data-testid="session-row"]').filter({ hasText: word });
  const sheet = page.getByTestId("import-sheet");
  const sheetRows = sheet.getByTestId("import-row");
  const openSheet = async (tab: string, q: string) => {
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("Import sessions");
    await expect(page.getByRole("option", { name: "Import sessions" })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(sheet).toBeVisible();
    await page.getByTestId(`import-tab-${tab}`).click();
    await page.getByTestId("import-search").fill(q);
  };
  try {
    // Keel's own session first: the external ones stand below it.
    const { session: own } = await (await request.post("/api/sessions", { data: { workspace: cwd, model: HAIKU, title: `Own session ${tag}` } })).json();
    made.push(own.id);
    const before = await watches();
    mkdirSync(dir, { recursive: true });
    await expect.poll(watches, { timeout: 10_000 }).toBeGreaterThan(before);
    await page.goto("/");

    // The other harness runs a session: a row under the External line, below Keel's.
    write({ type: "user", message: { role: "user", content: `Name the doubles fixture ${tag}` } });
    reply("m1", `The fixture is ${tag}.`);
    write({ type: "system", subtype: "turn_duration", durationMs: 1000 });
    await expect.poll(async () => (await sessions()).find((s) => s.outside?.source_id === id)?.id, { timeout: 15_000 }).toBeTruthy();
    const outsideId = (await sessions()).find((s) => s.outside?.source_id === id)!.id as string;
    const ownRow = list.locator(`[data-testid="session-row"][data-session="${own.id}"]`);
    const line = list.locator('[data-testid="machine-sep"][data-section="external"]');
    await expect(line).toBeVisible();
    await expect(line).toContainText("External on this machine");
    await expect(list.locator(`[data-testid="external-group"] [data-session="${outsideId}"]`)).toBeVisible();
    expect((await line.boundingBox())!.y).toBeGreaterThan((await ownRow.boundingBox())!.y);
    await shoot(page, "doubles-01-external");

    // Imported from the sheet: it moves up into Keel's list, once.
    await openSheet("claude", tag);
    await expect(sheetRows).toHaveCount(1, { timeout: 20_000 });
    await sheetRows.first().click();
    await sheet.getByTestId("import-go").click();
    await expect(page).toHaveURL(/\/s\//);
    const copy = page.url().split("/s/")[1]!;
    made.push(copy);
    await expect(page.getByTestId("assistant-text").last()).toContainText(`The fixture is ${tag}.`);
    await expect(page.getByTestId("origin-mark")).toContainText("From Claude Code");
    await expect(page.getByTestId("origin-mark")).toContainText(id.slice(0, 8));
    await expect(rowsOf(`Name the doubles fixture ${tag}`)).toHaveCount(1);
    await expect(list.locator(`[data-session="${outsideId}"]`)).toHaveCount(0);
    await expect(line).toHaveCount(0);
    expect((await sessions()).filter((s) => s.outside?.source_id === id)).toHaveLength(0);
    await shoot(page, "doubles-02-imported");

    // The sheet lists it no more (its Imported switch brings the row back); the running list has none of it.
    await openSheet("claude", tag);
    await expect(sheet.getByTestId("import-total")).toHaveText("0 sessions", { timeout: 20_000 });
    await expect(sheetRows).toHaveCount(0);
    await sheet.getByTestId("import-copies").first().click();
    await expect(sheetRows).toHaveCount(1);
    await expect(sheetRows.first().getByTestId("import-imported")).toHaveText("imported");
    await shoot(page, "doubles-03-sheet");
    await page.keyboard.press("Escape");

    // The source goes on while the copy stands: no row of its own, the copy says it still runs.
    write({ type: "user", message: { role: "user", content: `And its colour ${tag}` } });
    write({ type: "assistant", message: { id: "m2", role: "assistant", model: "claude-opus-4-5", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "make" } }], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    await expect(page.getByTestId("live-source")).toContainText("still runs in Claude Code", { timeout: 20_000 });
    await expect(list.locator('[data-testid="session-row"]').filter({ has: page.getByTestId("row-outside") })).toHaveCount(0);
    expect((await sessions()).filter((s) => s.outside?.source_id === id)).toHaveLength(0);
    await shoot(page, "doubles-04-still-runs");

    // The owner names the session: from its header, its row's menu and F2 on its row. No title replaces it.
    const header = page.getByTestId("station-title");
    await header.click();
    await page.getByLabel("Session title").fill(`Mine ${tag}`);
    await page.getByLabel("Session title").press("Enter");
    await expect(header).toHaveText(`Mine ${tag}`);
    const row = list.locator(`[data-testid="session-row"][data-session="${copy}"]`);
    await row.click({ button: "right" });
    await page.getByTestId("row-menu-rename").click();
    await page.getByTestId("row-rename").fill(`Menu ${tag}`);
    await shoot(page, "doubles-05-row-rename");
    await page.getByTestId("row-rename").press("Enter");
    await expect(header).toHaveText(`Menu ${tag}`);
    await row.focus();
    await page.keyboard.press("F2");
    await page.getByTestId("row-rename").fill(`Kept ${tag}`);
    await page.getByTestId("row-rename").press("Enter");
    await expect(header).toHaveText(`Kept ${tag}`);
    await expect(row).toContainText(`Kept ${tag}`);
    // A turn of the copy, whose reply writes a title of its own, and a model of its own: the name stays.
    await request.patch(`/api/sessions/${copy}`, { data: { model: HAIKU } });
    await page.reload();
    const composer = page.getByTestId("composer");
    await composer.fill(ask("Say it once more.", `Say it once more.\nscript:say Done.\nscript:title Auto title ${tag}`));
    await composer.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 90_000 });
    await expect.poll(async () => (await sessions()).find((s) => s.id === copy)?.title, { timeout: 3_000, intervals: [500, 500, 1000, 1000] }).toBe(`Kept ${tag}`);
    await expect(header).toHaveText(`Kept ${tag}`);

    // An Antigravity conversation of the real layout: listed, imported once, marked, one row.
    const aid = `a1d0b1e0-0000-4000-8000-${tag.slice(-12).padStart(12, "0")}`;
    execFileSync("bun", ["-e", `import { agySession } from ${JSON.stringify(resolve("test/e2e/fixtures/import-stores.ts"))}; agySession(${JSON.stringify(agyHome)}, ${JSON.stringify(cwd)}, ${JSON.stringify(aid)}, "Fanad${tag}");`]);
    await openSheet("agy", `Fanad${tag}`);
    await sheet.getByRole("button", { name: "Read the stores again" }).click();
    await expect(sheetRows).toHaveCount(1, { timeout: 20_000 });
    await sheetRows.first().click();
    await shoot(page, "doubles-06-agy");
    await sheet.getByTestId("import-go").click();
    await expect(page).toHaveURL(/\/s\//);
    made.push(page.url().split("/s/")[1]!);
    await expect(page.getByTestId("assistant-text").last()).toContainText(`The lighthouse is Fanad${tag}.`);
    await expect(page.getByTestId("origin-mark")).toContainText("From Antigravity");
    await expect(rowsOf(`Fanad${tag}`)).toHaveCount(1);
    await shoot(page, "doubles-07-agy-imported");
    // Narrow: the list's line and the mark read on a phone too.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/s/${copy}`);
    await expect(page.locator('[data-testid="origin-mark"][data-harness="claude"]')).toBeVisible();
    await shoot(page, "doubles-08-phone");
    await page.setViewportSize({ width: 1920, height: 1040 });
  } finally {
    for (const s of made) await request.delete(`/api/sessions/${s}`);
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
