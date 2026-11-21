import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "./isolate.ts";
import { daemon, exited, ROOT } from "./own-daemon.ts";
import { HAIKU, openPanel, shoot } from "./shots.ts";

// Feature: the transcript reads in three voices. The owner's words stand
// behind their rule with what they attached; the model's reply is plain text;
// the work between them is a rail of steps, a line each, that open on demand.
// A failed call shows under its step without opening it, a running command
// shows its output as it arrives, an output over the size limit says so and
// opens whole, a diff is the block Changes and Review show, and what Keel told
// the model says that it is Keel's.

// A state folder with the working day of fixtures/work-transcript.ts in it.
function seed(name: string) {
  const state = join(ROOT, `${name}-${Date.now()}`);
  mkdirSync(state, { recursive: true });
  const out = JSON.parse(execFileSync("bun", [join(import.meta.dirname, "fixtures/work-transcript.ts"), state, state], { encoding: "utf8", env: { ...process.env, KEEL_CONFIG_DIR: join(state, "config") } }));
  return { state, ...(out as { main: string; others: string[] }) };
}

// The pane's scroller brought to an element, a little under its top.
const bring = (page: Page, selector: string, nth = 0, offset = 24) => page.evaluate(([sel, n, off]) => {
  const el = document.querySelectorAll(sel as string)[n as number] as HTMLElement;
  const sc = document.querySelector<HTMLElement>(".k-reading")!;
  sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - (off as number);
}, [selector, nth, offset] as const);

test("a turn of forty calls is a rail of steps that open on demand", async ({ page }) => {
  const s = seed("work-rail");
  const d = await daemon(s.state);
  try {
    await page.addInitScript(() => localStorage.setItem("keel.focus", "true"));
    await page.goto(`${d.url}/s/${s.main}`);
    await expect(page.getByTestId("user-message").nth(1)).toBeVisible({ timeout: 30_000 });
    const stored = ((await (await fetch(`${d.url}/api/sessions/${s.main}/events`)).json()) as any).events as { kind: string; data: any }[];
    const calls = stored.filter((e) => e.kind === "assistant").flatMap((e) => (e.data.blocks as any[]).filter((b) => b.type === "tool_use")).length;
    expect(calls).toBe(40);

    // Forty calls are a handful of lines: steps of one family, plan updates, and no card.
    await bring(page, '[data-testid="user-message"]', 1);
    await shoot(page, "work-01-forty-calls-folded");
    const lines = await page.locator(".k-work .k-line").count();
    expect(lines).toBeLessThanOrEqual(22);
    const tall = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="work"]')].reduce((n, el) => n + el.getBoundingClientRect().height, 0));
    expect(tall).toBeLessThan(700); // the work of the turn, under a screen of the 1040 px window
    // What a line says is read from the calls: what was done, to what, with what result.
    const explored = page.locator('[data-testid="work-step"][data-family="explore"]').first();
    await expect(explored.locator(".k-line").first()).toContainText("Explored");
    await expect(explored.locator(".k-line").first()).toContainText("7 files, 5 searches");
    await expect(explored.locator(".k-line").first()).toContainText("exporter.ts");
    const edited = page.locator('[data-testid="work-step"][data-family="change"]').first();
    await expect(edited.locator(".k-line").first()).toContainText("stream.ts");
    await expect(edited.locator(".k-line").first()).toContainText("+59");
    // What the model said at length is on the page at the reading size; a line said in passing is quiet, on the rail.
    await expect(page.getByTestId("assistant-text").filter({ hasText: "Two ways to fix it" })).toBeVisible();
    await expect(page.locator(".k-aside").filter({ hasText: "I'll read the exporter and its callers first." })).toBeVisible();

    // A failure inside a folded step shows without opening it: the step says how many failed,
    // the failed call is under it with a line of its own output, and the step's edge is the failure color.
    const failedStep = page.locator('[data-testid="work-step"][data-state="error"]');
    await expect(failedStep).toHaveCount(1);
    await expect(failedStep.getByTestId("step-failed")).toHaveText("1 failed");
    await expect(failedStep.getByTestId("step-peek").getByTestId("tool-why")).toContainText("File does not exist: docs/progress.md");
    const failedRun = page.locator('[data-testid="tool-call"][data-tool="Bash"][data-state="error"]');
    await expect(failedRun.locator(".k-line")).toContainText("exit 1");
    await expect(failedRun.getByTestId("tool-why")).toContainText("expect(received).toEqual(expected)");

    // A step opens to its calls by the pointer and by the keyboard, and says so to a screen reader.
    const line = explored.locator(".k-line").first();
    await expect(line).toHaveAttribute("aria-expanded", "false");
    await expect(line).toHaveAttribute("aria-label", /^Explored 7 files, 5 searches/);
    await line.focus();
    await page.keyboard.press("ArrowRight");
    await expect(line).toHaveAttribute("aria-expanded", "true");
    await expect(explored.getByTestId("tool-call")).toHaveCount(12);
    await shoot(page, "work-02-step-open");
    await page.keyboard.press("ArrowDown");
    await expect(explored.locator(".k-line").nth(1)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowLeft");
    await expect(line).toHaveAttribute("aria-expanded", "false");
    await expect(explored.getByTestId("tool-call")).toHaveCount(0);
    // Shift with the key opens every step of the run, and closes them again.
    await page.keyboard.press("Shift+Enter");
    await expect(page.locator('[data-testid="work"]').first().locator('[data-testid="work-step"] > .k-line[aria-expanded="true"]')).toHaveCount(await page.locator('[data-testid="work"]').first().getByTestId("work-step").count());
    await page.keyboard.press("Shift+Enter");
    await expect(line).toHaveAttribute("aria-expanded", "false");

    // The browser's Find does not reach inside a folded step: on its key the page says so and offers its own search.
    await page.keyboard.press("Control+f");
    await expect(page.getByTestId("find-note")).toContainText("does not reach inside folded steps");
    await page.keyboard.press("Escape");

    // The plan is said once: the strip above the message box has the list while it is in
    // progress; an update in the conversation is a line with the count, and its list opens on demand.
    await expect(page.locator('.k-transcript [data-testid="plan"]')).toHaveCount(0);
    const planLine = page.locator('[data-testid="tool-call"][data-kind="plan"]').first();
    await expect(planLine.getByTestId("plan-count")).toHaveText("1/5");
    await expect(planLine.locator(".k-line")).toContainText("Writing the export in parts");

    // A diff is the block Changes and Review show: numbered from the file's own line, colored, unchanged lines folded.
    await edited.locator(".k-line").first().click();
    const edit = edited.locator('[data-tool="Edit"]').first();
    await edit.locator(".k-line").click();
    const diff = edit.getByTestId("diff-file");
    await expect(diff).toBeVisible();
    await expect(diff.locator(".k-diff-no").first()).toHaveText("1");
    await expect(diff.locator('[class^="th-"]').first()).toBeVisible({ timeout: 15_000 });
    await expect(diff).not.toContainText("/home/");
    const write = edited.locator('[data-tool="Write"]').first();
    await write.locator(".k-line").click();
    await expect(write.locator(".k-diff-no").nth(1)).toHaveText("1");
    await bring(page, '[data-tool="Edit"]', 0, 60);
    await shoot(page, "work-03-diff-open");

    // An output over the size limit: what is shown and how much there is, never the note written for the model.
    await page.locator('[data-testid="work-step"][data-family="run"] > .k-line', { hasText: "3 commands" }).click();
    const big = page.locator('[data-testid="tool-call"]', { hasText: "export-demo" });
    await big.locator(".k-line").click();
    await expect(big.getByTestId("output-more")).toContainText("The first 2KB of 39.0KB of output.");
    await expect(big).not.toContainText("Output too large");
    await expect(big).not.toContainText("Full output saved to");
    await bring(page, '[data-testid="output-more"]', 0, 520);
    await shoot(page, "work-04-output-over-limit");
    await big.getByTestId("output-whole").click();
    await expect(big.getByTestId("whole-output")).toContainText("[0900] exported part 900");
    await expect(big.getByTestId("output-log-bar")).toContainText("The whole output");
    await shoot(page, "work-05-output-whole");
    await big.getByTestId("output-leave").click();
    await expect(big.getByTestId("output-more")).toBeVisible();

    // The owner's message is one block: their words, then what they attached, inside it.
    await bring(page, '[data-testid="user-message"]', 0);
    const first = page.getByTestId("user-message").first();
    await expect(first.locator(".k-owner-words").getByTestId("message-image")).toHaveCount(2);
    const tint = await first.locator(".k-owner-words").evaluate((el) => { document.documentElement.classList.add("dark"); const c = getComputedStyle(el).backgroundColor; document.documentElement.classList.remove("dark"); return c; });
    expect(tint).not.toBe("rgba(0, 0, 0, 0)");
    // What Keel told the model says so, in Keel's words; the words sent are behind it, without the marks written for the model.
    const told = page.getByTestId("harness-note");
    await expect(told).toContainText("Keel to the model");
    await expect(told).toContainText("The wait the provider asked for is over.");
    const note = page.getByTestId("note").filter({ hasText: "task list" });
    await expect(note).toContainText("Keel to the model");
    await expect(note.locator("summary")).toContainText("You changed the task list. It now has 2 items.");
    await expect(page.getByTestId("transcript")).not.toContainText("[owner]");
    await expect(page.getByTestId("transcript")).not.toContainText("[harness]");
    await shoot(page, "work-06-owner-and-keel");

    // The timeline names a turn by the prompt that started it.
    await openPanel(page, "timeline");
    await expect(page.getByTestId("timeline-about").first()).toContainText("Yes. Make the export stream in parts");
    await shoot(page, "work-07-timeline");
  } finally {
    d.proc.kill();
    await exited(d.proc);
  }
});

test("a running command shows its output as it arrives, then folds", async ({ page, request }) => {
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  await page.goto(`/s/${session.id}`);
  const command = 'for i in 1 2 3 4 5 6; do echo "part $i of 6 written"; sleep 1; done';
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command, description: "Write the parts" } }])}` } });
  const call = page.locator('[data-testid="tool-call"][data-tool="Bash"]');
  // While it runs the line says so and the output is on the page, a line at a time.
  await expect(call).toHaveAttribute("data-state", "running", { timeout: 30_000 });
  await expect(call.locator(".k-line")).toContainText("Running");
  await expect(call.getByTestId("live-output")).toContainText("part 2 of 6 written", { timeout: 15_000 });
  await expect(call).toHaveAttribute("data-state", "running");
  await expect(call.getByTestId("live-output")).not.toContainText("part 6 of 6 written");
  await shoot(page, "work-08-running-output");
  // Over, it is a line again: what ran, and nothing to scroll past.
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 60_000 });
  await expect(call).toHaveAttribute("data-state", "ok");
  await expect(call.locator(".k-line")).toContainText("Ran");
  await expect(call.locator(".k-line")).toHaveAttribute("aria-expanded", "false");
  await expect(call.getByTestId("terminal")).toHaveCount(0);
  // Opened, it has the whole output.
  await call.locator(".k-line").click();
  await expect(call.getByTestId("terminal")).toContainText("part 6 of 6 written");
});

test("an edit's diff is numbered from the file's own lines and folds what did not change", async ({ page, request }) => {
  const ws = join(ROOT, `work-edit-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const file = join(ws, "limits.ts");
  const body = Array.from({ length: 40 }, (_, i) => `export const limit${i + 1} = ${i + 1};`);
  writeFileSync(file, body.join("\n") + "\n");
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, workspace: ws } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  await page.goto(`/s/${session.id}`);
  // Lines 10 to 30 with the last one changed: twenty unchanged lines lead the change.
  const old = body.slice(9, 30).join("\n");
  const calls = [{ name: "Read", input: { file_path: file } }, { name: "Edit", input: { file_path: file, old_string: old, new_string: old.replace("limit30 = 30", "limit30 = 300") } }];
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify(calls)}` } });
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 60_000 });
  const edit = page.locator('[data-testid="tool-call"][data-tool="Edit"]');
  await expect(edit.locator(".k-line")).toContainText("limits.ts");
  await expect(edit.locator(".k-line")).toContainText("+1");
  await edit.locator(".k-line").click();
  const diff = edit.getByTestId("diff-file");
  // The first line shown is line 10 of the file, the change is on line 30, and the unchanged run between folds.
  await expect(diff.locator('tr[data-kind="ctx"]').first().locator(".k-diff-no").first()).toHaveText("10");
  await expect(diff.locator('tr[data-kind="del"] .k-diff-no').first()).toHaveText("30");
  await expect(diff.locator('tr[data-kind="add"] .k-diff-no').nth(1)).toHaveText("30");
  await expect(diff.getByTestId("diff-unfold")).toHaveText("14 unchanged lines");
  await expect(diff.locator('tr[data-kind="ctx"]')).toHaveCount(6);
  await expect(diff.locator('[class^="th-"]').first()).toBeVisible({ timeout: 15_000 });
  await shoot(page, "work-09-edit-diff");
  await diff.getByTestId("diff-unfold").click();
  await expect(diff.locator('tr[data-kind="ctx"]')).toHaveCount(20);
});
