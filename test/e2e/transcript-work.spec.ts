import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "./isolate.ts";
import { daemon, exited, ROOT } from "./own-daemon.ts";
import { HAIKU, shoot } from "./shots.ts";

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
  return { state, ...(out as { main: string; others: string[]; risk: string }) };
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

    // A failure inside a folded step shows without opening it: the step says how many failed and the failed
    // call is under it with a line of its own output. A read of a file that is not there is a note, not an
    // alarm: its words are quiet and its part of the rail is not the failure color.
    const failedStep = page.locator('[data-testid="work-step"]', { has: page.getByTestId("step-state") });
    await expect(failedStep).toHaveCount(1);
    await expect(failedStep).toHaveAttribute("data-family", "explore");
    await expect(failedStep.getByTestId("step-state")).toHaveText("1 failed");
    await expect(failedStep.getByTestId("step-state")).toHaveAttribute("data-tone", "note");
    await expect(failedStep.getByTestId("step-peek").getByTestId("tool-why")).toContainText("File does not exist: docs/progress.md");
    // The command that ran and failed is the one failure of the turn: its part of the rail says so.
    await expect(page.locator('.k-step[data-state="error"]')).toHaveCount(1);
    const failedRun = page.locator('[data-testid="tool-call"][data-tool="Bash"][data-state="error"]');
    await expect(page.locator('.k-step[data-state="error"]').locator('[data-testid="tool-call"]')).toHaveAttribute("data-call", (await failedRun.getAttribute("data-call"))!);
    // How it stands is said beside the verb: it ran, and ended with exit 1. Its reason is under its target.
    await expect(failedRun.locator(".k-line-verb")).toHaveText("Ran");
    await expect(failedRun.getByTestId("call-state")).toHaveText("exit 1");
    await expect(failedRun.getByTestId("call-state")).toHaveAttribute("data-tone", "fail");
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

    // The browser's Find does not reach inside a folded step: on its key the page says how many calls of how
    // many steps it will not look in, each time, and offers its own search.
    const hidden = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="work-step"]')].map((st) => Number(st.dataset.calls) - st.querySelectorAll('[data-testid="step-peek"] [data-testid="tool-call"]').length).filter((n) => n > 0));
    const findNote = `Find in page does not reach ${hidden.reduce((a, b) => a + b, 0)} calls in ${hidden.length} folded steps.`;
    await page.keyboard.press("Control+f");
    await expect(page.getByTestId("find-note")).toContainText(findNote);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("find-note")).toHaveCount(0);
    await page.keyboard.press("Control+f");
    await expect(page.getByTestId("find-note")).toContainText(findNote);
    await page.keyboard.press("Escape");
    // A line's words are selected and copied as one line, not a part a row.
    const copied = await line.locator(".k-line-text").evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection()!; s.removeAllRanges(); s.addRange(r); const t = s.toString(); s.removeAllRanges(); return t; });
    expect(copied.replace(/\s+/g, " ").trim()).toMatch(/^Explored 7 files, 5 searches exporter\.ts, rows\.ts, encode\.ts, cli\.ts \+\d+ more$/);
    expect(copied.trim()).not.toContain("\n");
    // A closed line shows that it opens before the pointer is on it, and a copied selection of its targets has them apart.
    expect(Number(await line.locator(".k-line-end").evaluate((el) => getComputedStyle(el, "::after").opacity))).toBeGreaterThan(0.5);
    expect(await line.locator(".k-line-what").evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection()!; s.removeAllRanges(); s.addRange(r); const t = s.toString(); s.removeAllRanges(); return t; })).toBe("exporter.ts, rows.ts, encode.ts, cli.ts");

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

  } finally {
    d.proc.kill();
    await exited(d.proc);
  }
});

test("a running command shows its output as it arrives, stays as it stood when it ends, and is a line once it has left the view", async ({ page, request }) => {
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
  // Over, its line says it ran, and its card stays as it stood with the end of its output: folding it
  // under a reader who follows the end would drop every line below it. It asks for no more output.
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 60_000 });
  await expect(call).toHaveAttribute("data-state", "ok");
  await expect(call.locator(".k-line")).toContainText("Ran");
  await expect(call.locator(".k-line")).toHaveAttribute("aria-expanded", "true");
  await expect(call.getByTestId("live-output")).toContainText("part 6 of 6 written");
  let asked = 0;
  page.on("request", (r) => { if (r.url().includes("/terminal/") && r.url().includes("/log")) asked++; });
  await page.waitForTimeout(3500);
  // (At most the one read of what was left when it ended.)
  expect(asked).toBeLessThanOrEqual(1);
  // Once it has left the view it is a line: what ran, and nothing to scroll past. A long reply pushes it out.
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:say ${Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} of a long reply.`).join("\\n\\n")}` } });
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 60_000 });
  await expect(call.locator(".k-line")).toHaveAttribute("aria-expanded", "false");
  await expect(call.getByTestId("terminal")).toHaveCount(0);
  // The owner's own fold is theirs: opened, it has the whole output; closed, it stays closed.
  await call.locator(".k-line").scrollIntoViewIfNeeded();
  await call.locator(".k-line").click();
  await expect(call.getByTestId("terminal")).toContainText("part 6 of 6 written");
  await call.locator(".k-line").click();
  await expect(call.getByTestId("terminal")).toHaveCount(0);
  // After a reload everything is folded as stored.
  await page.reload();
  await expect(call.locator(".k-line")).toHaveAttribute("aria-expanded", "false");
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
  // A small change shows what it changed under its closed line, as a failure shows its reason.
  await expect(edit.getByTestId("small-change").locator("div")).toHaveText(["-export const limit30 = 30;", "+export const limit30 = 300;"]);
  await edit.locator(".k-line").click();
  await expect(edit.getByTestId("small-change")).toHaveCount(0);
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

test("a closed step shows what must be seen: marked calls whole, a cut call, each state as what it is", async ({ page }) => {
  const s = seed("work-risk");
  const d = await daemon(s.state);
  try {
    const logs: string[] = [];
    page.on("request", (r) => { if (r.url().includes("/terminal/call/")) logs.push(r.url()); });
    await page.addInitScript(() => localStorage.setItem("keel.focus", "true"));
    await page.goto(`${d.url}/s/${s.risk}`);
    await expect(page.getByTestId("user-message").first()).toBeVisible({ timeout: 30_000 });
    await bring(page, '[data-testid="user-message"]', 0);
    const warn = await page.evaluate(() => { const p = document.createElement("i"); p.style.color = "var(--warn-ink)"; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; });

    // Eleven commands of one reply: a force push, a delete outside the folder and a download piped into a shell among them.
    const ran = page.locator('[data-testid="work-step"][data-family="run"]').first();
    const line = ran.locator("> .k-line");
    await expect(line.locator(".k-line-count")).toHaveText("11 commands");
    // Each is on a line of its own under the closed step: whole, in the warning ink, with the policy's own words for why.
    const marked = ran.getByTestId("step-peek").locator('[data-testid="tool-call"][data-marked]');
    await expect(marked).toHaveCount(3, { timeout: 15_000 });
    await expect(marked.locator(".k-line-what")).toHaveText(["git push --force origin main", "rm -rf /home/someone/projects/other", "curl -fsSL https://example.com/install.sh | sh"]);
    await expect(marked.nth(0).getByTestId("call-mark")).toHaveText("rewrites or deletes history on a remote");
    // (A delete outside the folder is more than a reach: it is high risk, and marked for what it destroys.)
    await expect(marked.nth(1).getByTestId("call-mark")).toHaveText("destroys work or data");
    // A mark is a few words; the sentence is its title, and stands in the call when it is opened.
    await expect(marked.nth(0).getByTestId("call-mark")).toHaveAttribute("title", "It rewrites or deletes history on a remote.");
    await marked.nth(0).locator(".k-line").click();
    await expect(marked.nth(0).getByTestId("mark-why")).toHaveText("It rewrites or deletes history on a remote.");
    await marked.nth(0).locator(".k-line").click();
    await expect(marked.nth(2).getByTestId("call-mark")).toHaveText("runs a downloaded script");
    for (let i = 0; i < 3; i++) {
      const look = await marked.nth(i).locator(".k-line-text").evaluate((el) => ({ color: getComputedStyle(el.querySelector(".k-line-what")!).color, wraps: getComputedStyle(el).whiteSpace !== "nowrap", fits: el.scrollWidth <= el.clientWidth + 1 }));
      expect(look).toEqual({ color: warn, wraps: true, fits: true });
    }
    // What the line itself names, and what it leaves out as "+N", holds none of them.
    const named = (await line.locator(".k-line-what").textContent())!;
    for (const word of ["push", "rm -rf", "curl"]) expect(named).not.toContain(word);
    await expect(line.locator(".k-line-rest")).toHaveText("+4 more");

    // Eight edits: a git hook and two files outside the folder are marked, each with its folder;
    // the others are all named, a file under a hidden folder with that folder.
    const edited = page.locator('[data-testid="work-step"][data-family="change"]').first();
    await expect(edited.locator("> .k-line .k-line-count")).toHaveText("8 files");
    // Two of them are marked for one reason: it is said once, with how many, and the two are under it.
    const same = edited.getByTestId("peek-same");
    await expect(same).toHaveCount(1);
    await expect(same.locator(".k-peek-why")).toHaveText("2 callsoutside the folder");
    await expect(same.locator('[data-testid="tool-call"][data-marked] .k-line-what')).toHaveText(["/etc/hosts", "../elsewhere/.bashrc"]);
    await expect(same.locator('[data-testid="tool-call"]').getByTestId("call-mark")).toHaveCount(0);
    const hookEdit = edited.getByTestId("step-peek").locator('[data-testid="tool-call"][data-marked]', { hasText: ".git/hooks/pre-commit" });
    await expect(hookEdit.getByTestId("call-mark")).toHaveText("runs later, outside the sandbox");
    await expect(hookEdit.getByTestId("call-mark")).toHaveAttribute("title", "It changes .git/hooks/pre-commit, which runs or configures things outside the sandbox later.");
    await expect(edited.locator("> .k-line .k-line-what")).toHaveText("a.ts, b.ts, c.ts, d.ts, .changes/notes.yml");
    await expect(edited.locator("> .k-line .k-line-rest")).toHaveCount(0);
    await shoot(page, "work-10-marked-calls");

    // A command of several lines says how many follow its first; a call a restart cut says so and shows through.
    const cut = page.locator('[data-testid="work-step"][data-state="warn"]', { hasText: "cut by a restart" });
    await expect(cut.getByTestId("step-state")).toHaveText("1 cut by a restart");
    await expect(cut.locator("> .k-line .k-line-what")).toContainText("cd build (+2 lines)");
    const cutCall = cut.getByTestId("step-peek").getByTestId("tool-call");
    await expect(cutCall).toHaveCount(1);
    await expect(cutCall.locator(".k-line-what")).toHaveText("make deploy");
    await expect(cutCall.getByTestId("tool-ended")).toHaveText("cut by a restart");
    // A denial, a refusal and a failure are three things. The owner's own denial is in no failure color and
    // carries their reason; the reviewer's refusal says who refused and why, once; the step did run a command.
    const turned = page.locator('[data-testid="work-step"]', { hasText: "denied by you" });
    await expect(turned.locator("> .k-line .k-line-verb")).toHaveText("Ran");
    await expect(turned.getByTestId("step-state")).toHaveText(["1 denied by you", "1 refused"]);
    await expect(turned).toHaveAttribute("data-state", "warn");
    const deniedCall = turned.getByTestId("step-peek").locator('[data-testid="tool-call"][data-state="denied"]');
    await expect(deniedCall.locator(".k-line-verb")).toHaveText("Run");
    await expect(deniedCall.getByTestId("call-state")).toHaveAttribute("data-tone", "own");
    await expect(deniedCall.getByTestId("tool-denial")).toHaveText("Youkeep the build for now");
    await expect(deniedCall).not.toContainText("The owner denied this call");
    const danger = await page.evaluate(() => { const p = document.createElement("i"); p.style.color = "var(--danger-ink)"; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; });
    expect(await deniedCall.evaluate((el, red) => [...el.querySelectorAll("*")].some((x) => getComputedStyle(x).color === red), danger)).toBe(false);
    const refusedCall = turned.getByTestId("step-peek").locator('[data-testid="tool-call"][data-state="refused"]');
    await expect(refusedCall.getByTestId("tool-refused")).toHaveText("refused");
    await expect(refusedCall.getByTestId("tool-refusal")).toHaveText("Reviewerit publishes a release.");
    await expect(refusedCall.getByTestId("tool-why")).toHaveCount(0);
    // The step's line names what has no line of its own under it: the command that ran.
    await expect(turned.locator("> .k-line .k-line-what")).toHaveText("bun test test/export");
    // A command that asked to leave the sandbox says so, and an edit a language server found an error in
    // shows it under its closed step, in the same rows as every other word under a line.
    const left = page.locator('[data-testid="tool-call"][data-marked]', { hasText: "git gc --prune=now" });
    await expect(left.getByTestId("call-mark")).toHaveText("asks to leave the sandbox");
    const checked = page.locator('[data-testid="work-step"]', { has: page.getByTestId("tool-diagnostics") });
    await expect(checked.locator("> .k-line .k-line-count")).toHaveText("2 files");
    await expect(checked.getByTestId("step-peek").getByTestId("tool-call")).toHaveCount(1);
    await expect(checked.getByTestId("tool-diagnostics")).toHaveAttribute("data-state", "errors");
    await expect(checked.getByTestId("tool-diagnostics-head")).toHaveText("1 new error");
    await expect(checked.getByTestId("tool-diagnostic")).toContainText("src/math.ts:2:3");
    // Every word under a line is a row of one grammar: its name in the verbs' column.
    const names = await page.locator(".k-under-row").evaluateAll((rows) => rows.map((r) => Math.round(r.querySelector(".k-under-what")!.getBoundingClientRect().left - r.closest(".k-tool-call, .k-under")!.getBoundingClientRect().left)));
    expect(new Set(names).size).toBe(1);
    // A command a hook of the owner's changed and let through shows under its closed step: the command that ran,
    // whole, that a hook changed it, and what the model had asked for.
    const hooked = page.locator('[data-testid="work-step"]', { has: page.getByTestId("tool-hook") });
    await expect(hooked.locator("> .k-line .k-line-count")).toHaveText("3 commands");
    const changed = hooked.getByTestId("step-peek").getByTestId("tool-call");
    await expect(changed).toHaveCount(1);
    await expect(changed.locator(".k-line-what")).toHaveText("touch hook-made.txt");
    await expect(changed.getByTestId("tool-rewritten")).toHaveText("changed by a hook");
    await expect(changed.getByTestId("tool-asked")).toHaveText("echo asked-by-model");
    await expect(changed.getByTestId("tool-hook-allowed")).toHaveText("Hookallowed it: commands in this repository are fine");
    await expect(hooked.locator("> .k-line .k-line-what")).toHaveText("pwd, date");
    // Five reads of files that are not there: three shown with their reasons, the rest counted as what they
    // are. They are notes: nothing on the page is in the failure color for them.
    const failed = page.locator('[data-testid="work-step"][data-family="explore"]', { has: page.getByTestId("step-state") });
    await expect(failed.getByTestId("step-state")).toHaveText("failed");
    await expect(failed).toHaveAttribute("data-state", "ok");
    await expect(page.locator('.k-step[data-state="error"]')).toHaveCount(0);
    await expect(failed.getByTestId("step-peek").getByTestId("tool-call")).toHaveCount(3);
    await expect(failed.getByTestId("peek-more")).toHaveText("and 2 more failed");

    // What the model thought before a card of its own is on the rail above it, one press away; the agent is a line of the rail.
    const agent = page.getByTestId("agent-call");
    // What stands at a line's end is apart from its words in a copied selection: the agent's name, then its kind.
    expect((await agent.first().locator(".k-line").evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection()!; s.removeAllRanges(); s.addRange(r); const t = s.toString(); s.removeAllRanges(); return t; })).replace(/\s+/g, " ")).toContain("Map the exporter general-purpose");
    await expect(agent.locator(".k-line-verb")).toHaveText("Agent");
    const before = page.locator(".k-step", { has: agent }).getByTestId("thinking");
    await expect(before).toBeVisible();
    await before.locator("summary").click();
    await expect(before).toContainText("an agent can map it while I go on");
    // What it thought before a plain call is marked on the closed line, and shown when the line is opened.
    const read = page.locator('[data-testid="tool-call"][data-tool="Read"]').filter({ hasText: "package.json" });
    await expect(read.getByTestId("thought-mark")).toBeVisible();
    await read.locator(".k-line").click();
    await expect(read.getByTestId("thinking")).toBeVisible();
    await bring(page, '[data-testid="work-step"][data-state="warn"]', 0, 80);
    await shoot(page, "work-11-cut-failed-thought");

    // A reply whose hundred calls never got a result, in a session that is idle: nothing is said to run or
    // to have failed, and no call asks for a command's output.
    const none = page.locator('[data-testid="work-step"]').last();
    await expect(none.locator("> .k-line .k-line-verb")).toHaveText("Run");
    await expect(none.getByTestId("step-state")).toHaveText("no result");
    await expect(none.locator("> .k-line .k-line-count")).toHaveText("100 commands");
    await expect(none.getByTestId("step-peek")).toHaveCount(0);
    await none.locator("> .k-line").click();
    await expect(none.getByTestId("tool-call")).toHaveCount(100);
    await expect(none.getByTestId("terminal")).toHaveCount(0);
    await page.waitForTimeout(2500);
    expect(logs).toEqual([]);
    await none.locator("> .k-line").click();

    // In a pane as narrow as a phone the count and what is left out are still on the line, inside it.
    await page.setViewportSize({ width: 390, height: 844 });
    await bring(page, '[data-testid="work-step"][data-family="run"]', 0, 80);
    for (const part of [".k-line-count", ".k-line-rest"]) {
      const at = await line.evaluate((el, sel) => { const p = el.querySelector(sel as string)!.getBoundingClientRect(), l = el.getBoundingClientRect(); return p.width > 0 && p.left >= l.left && p.right <= l.right + 1; }, part);
      expect(at).toBe(true);
    }
    await expect(line.locator(".k-line-count")).toHaveText("11 commands");
    // There a marked call is its verb, why in a few words and what it was made on under that: the reason is a line
    // (the policy's longest is two), and the line's end stays on the verb's row.
    for (let i = 0; i < 3; i++) {
      const at = await marked.nth(i).locator(".k-line").evaluate((line) => {
        const mark = line.querySelector('[data-testid="call-mark"]')!, verb = line.querySelector(".k-line-verb")!.getBoundingClientRect(), end = line.querySelector(".k-line-end")!.getBoundingClientRect();
        return { rows: Math.round(mark.getBoundingClientRect().height / parseFloat(getComputedStyle(mark).lineHeight)), endOnFirst: end.top < verb.bottom && end.bottom > verb.top };
      });
      expect(at.rows).toBeLessThanOrEqual(i === 0 ? 2 : 1);
      expect(at.endOnFirst).toBe(true);
    }
    await shoot(page, "work-12-marked-phone");
  } finally {
    d.proc.kill();
    await exited(d.proc);
  }
});

test("a call waiting for approval says so, closed, and asks for no output", async ({ page, request }) => {
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  const logs: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/terminal/call/")) logs.push(r.url()); });
  await page.goto(`/s/${session.id}`);
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "rm -rf build-out" } }])}` } });
  await expect(page.getByTestId("approval")).toBeVisible({ timeout: 60_000 });
  const call = page.locator('[data-testid="tool-call"][data-tool="Bash"]');
  // Not running: it has not started. The line says what it waits for in the owner's color, and stays closed.
  await expect(call).toHaveAttribute("data-state", "waiting");
  await expect(call.locator(".k-line-verb")).toHaveText("Run");
  await expect(call.getByTestId("call-state")).toHaveText("needs you: an approval");
  await expect(call.locator(".k-line")).toHaveAttribute("aria-expanded", "false");
  await expect(call.getByTestId("terminal")).toHaveCount(0);
  await expect(page.locator('.k-step[data-state="need"]')).toHaveCount(1);
  await page.waitForTimeout(2500);
  expect(logs).toEqual([]);
  await shoot(page, "work-13-waiting-approval");
  // Allowed, it runs and ends as any command.
  await page.getByTestId("approval").getByRole("button", { name: /Allow once/i }).click();
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 60_000 });
  await expect(call).toHaveAttribute("data-state", "ok");
  await expect(call.locator(".k-line-verb")).toHaveText("Ran");
  await request.delete(`/api/sessions/${session.id}`);
});

test("a search hit in a failed call of a folded step opens the step and the call", async ({ page, request }) => {
  const tag = Date.now().toString(36);
  const calls = [{ name: "Bash", input: { command: "echo first" } }, { name: "Bash", input: { command: `echo veto-${tag}; exit 3` } }, { name: "Bash", input: { command: "echo last" } }];
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:batch ${JSON.stringify(calls)}` } });
  await expect.poll(async () => { const r = await (await request.get(`/api/sessions/${session.id}`)).json(); return !r.running && r.events.some((e: any) => e.kind === "turn_end"); }, { timeout: 60_000 }).toBe(true);
  await page.goto("/");
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill(`veto-${tag}`);
  const hit = page.getByRole("option").filter({ hasText: "Tool output" });
  await expect(hit).toHaveCount(1, { timeout: 30_000 });
  await hit.click();
  await expect(page).toHaveURL(new RegExp(`/s/${session.id}`));
  // The three commands are one step, and the failed one showed under it: the hit opens the step, and the call in it.
  const step = page.getByTestId("work-step");
  await expect(step.locator("> .k-line")).toHaveAttribute("aria-expanded", "true");
  const opened = page.locator('[data-testid="tool-call"][data-open]');
  await expect(opened).toHaveCount(1);
  await expect(opened).toHaveAttribute("data-state", "error");
  await expect(opened.getByTestId("terminal")).toContainText(`veto-${tag}`);
  await request.delete(`/api/sessions/${session.id}`);
});

// Where every line on screen stands at each frame of a turn: how often one of them moved down, how
// often any moved at all. A line is counted when it was on screen in the frame before and is in this
// one (what folds once it has left the view moves nothing that is seen). `foot`: the reader follows
// the end, and reads against the message box: a line dropped when it moved down on the screen and
// against the view's foot (a message box that changes height moves the foot: the lines that go with
// it, or that it passes, did not drop); else, when it moved down on the screen.
// The conversation of a session, as a page may hold more than one (other panes, a pane under a look):
// the one in that session's pane that is not covered.
const READING = (id: string) => `[data-station="${id}"] .k-reading`;
const watchMoves = (page: Page, id: string, foot: boolean) => page.evaluate(([sel, foot]) => {
  const sc = ([...document.querySelectorAll<HTMLElement>(sel)].find((x) => !x.closest("[inert]")) ?? document.querySelector<HTMLElement>(sel))!, c = sc.querySelector<HTMLElement>('[data-testid="transcript"]')!;
  const w = window as any;
  w.__moves = { frames: 0, down: 0, up: 0, largestDown: 0, awayFromEnd: 0, at: [] as string[] };
  const seen = () => {
    const v = sc.getBoundingClientRect();
    const out = new Map<Element, [number, number]>();
    for (const el of c.querySelectorAll("p, li, pre, tr, .k-line, [data-testid='user-message']")) {
      const b = el.getBoundingClientRect();
      if (!(b.height > 0 && b.bottom > v.top && b.top < v.bottom)) continue;
      // What is seen of it: not what a closed block holds, and not the part a folding card has cut off
      // (a card that folds above the view still has its lines' boxes reaching into it).
      if (!el.checkVisibility()) continue;
      const cut = el.closest(".k-tool-panel")?.getBoundingClientRect();
      if (cut && !(Math.min(b.bottom, cut.bottom) > v.top && Math.max(b.top, cut.top) < v.bottom)) continue;
      out.set(el, [b.top, b.top - v.bottom]);
    }
    return out;
  };
  // The conversation's own children and their heights (the padding a row keeps as room apart): a drop names what changed.
  const kids = () => [...c.children].slice(-8).map((x) => { const h = x as HTMLElement; return `${h.dataset.testid ?? h.className.split(" ")[0]}:${Math.round(h.getBoundingClientRect().height)}${h.style.paddingBottom ? `(room ${h.style.paddingBottom})` : ""}`; }).join(" ");
  let was = seen(), height = sc.scrollHeight, rows = kids();
  const tick = () => {
    const m = w.__moves;
    const now = seen();
    let d = 0, u = 0, who = "";
    for (const [el, [y, f]] of now) {
      const old = was.get(el);
      if (!old) continue;
      const fell = foot ? Math.min(y - old[0], f - old[1]) : y - old[0], rose = foot ? Math.min(old[0] - y, old[1] - f) : old[0] - y;
      if (fell > d) { d = fell; who = (el.textContent ?? "").trim().slice(0, 40); }
      if (rose > u) u = rose;
    }
    m.frames++;
    if (d > 1) { m.down++; m.largestDown = Math.max(m.largestDown, Math.round(d)); if (m.at.length < 8) m.at.push(`down ${Math.round(d)}px at frame ${m.frames} ("${who}"), height ${height} to ${sc.scrollHeight}; the end was [${rows}], is [${kids()}]`); }
    else if (u > 1) m.up++;
    if (sc.scrollHeight - sc.scrollTop - sc.clientHeight > 2) m.awayFromEnd++;
    was = now; height = sc.scrollHeight; rows = kids();
    w.__raf = requestAnimationFrame(tick);
  };
  w.__raf = requestAnimationFrame(tick);
}, [READING(id), foot] as const);
const movesSeen = (page: Page) => page.evaluate(() => { const w = window as any; cancelAnimationFrame(w.__raf); return w.__moves as { frames: number; down: number; up: number; largestDown: number; awayFromEnd: number; at: string[] }; });

// The turns that fold something as they go: commands that print 1, 12 and 200 lines with a read between
// them (each card opens as it runs), and one that ends right after a command of 200 lines.
const printing = (n: number, each: number) => `for i in $(seq 1 ${n}); do echo "line $i of ${n} ... ok"; sleep ${each}; done`;
const SEVEN = [
  { name: "Bash", input: { command: printing(1, 0.6) }, after_ms: 300 },
  { name: "Read", input: { file_path: "package.json" }, after_ms: 600 },
  { name: "Bash", input: { command: printing(12, 0.2) }, after_ms: 300 },
  { name: "Read", input: { file_path: "package.json" }, after_ms: 900 },
  { name: "Bash", input: { command: printing(200, 0.012) }, after_ms: 300 },
  { name: "Read", input: { file_path: "package.json" }, after_ms: 900 },
  { name: "Bash", input: { command: printing(12, 0.2) }, after_ms: 300 },
];
const TWO_HUNDRED = [{ name: "Read", input: { file_path: "package.json" }, after_ms: 300 }, { name: "Bash", input: { command: printing(200, 0.012) }, after_ms: 300 }];
type Watched = { name: string; calls: typeof SEVEN; width?: number; height?: number; scale?: number; reduced?: boolean; panes?: boolean; scrolledUp?: boolean; late?: boolean };
const WATCHED: Watched[] = [
  { name: "seven calls", calls: SEVEN },
  { name: "a 200-line command", calls: TWO_HUNDRED },
  { name: "seven calls, four panes", calls: SEVEN, panes: true },
  { name: "a 200-line command, text size 1.5", calls: TWO_HUNDRED, scale: 1.5 },
  { name: "seven calls, 390 px", calls: SEVEN, width: 390, height: 844 },
  { name: "a 200-line command, reduced motion", calls: TWO_HUNDRED, reduced: true },
  { name: "seven calls, scrolled up", calls: SEVEN, scrolledUp: true },
  // The session is told it is at rest a moment before its turn's end line comes (the two are frames of
  // their own, and a busy page draws them apart): the working line goes with nothing yet in its place.
  { name: "seven calls, the turn's end line comes late", calls: SEVEN, late: true },
];

test("no line moves down while a turn runs, at its end or after it, and nothing moves at all while scrolled up", async ({ page, request }) => {
  test.setTimeout(480_000);
  const table: string[] = [];
  // The page's socket, with a turn's end held back half a second when a case asks for it.
  let late = false;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (late) {
        try { const f = JSON.parse(String(m)); if (f.t === "event" && f.event?.kind === "turn_end") return void setTimeout(() => ws.send(m), 500); } catch { /* not a frame of words */ }
      }
      ws.send(m);
    });
  });
  for (const w of WATCHED) {
    late = false;
    const make = async () => ((await (await request.post("/api/sessions", { data: { model: "scripted:stand-in" } })).json()).session.id as string);
    const id = await make();
    const others = w.panes ? [await make(), await make(), await make()] : [];
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
    const ends = async () => (await (await request.get(`/api/sessions/${id}`)).json()).events.filter((e: any) => e.kind === "turn_end").length;
    // An earlier reply, so there are lines above the turn to move. Its end is the ordinary gap to the message box.
    await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:say ${"A line of the earlier reply. ".repeat(160)}` } });
    await expect.poll(ends, { timeout: 30_000 }).toBe(1);
    await page.setViewportSize({ width: w.width ?? 1920, height: w.height ?? 1040 });
    await page.emulateMedia({ reducedMotion: w.reduced ? "reduce" : "no-preference" });
    await page.addInitScript(([scale, slots]) => {
      localStorage.setItem("keel.textScale", JSON.stringify(scale));
      if (slots) localStorage.setItem("keel.panes", JSON.stringify({ count: 4, slots, sizes: {}, active: 0 }));
      else localStorage.removeItem("keel.panes");
      localStorage.setItem("keel.focus", slots ? "false" : "true");
    }, [w.scale ?? 1, w.panes ? [id, ...others] : null] as const);
    await page.goto(`/s/${id}`);
    const pane = page.locator(READING(id)).first();
    await expect(pane.getByTestId("turn-end")).toHaveCount(1);
    await page.waitForTimeout(500);
    const ordinary = (await endOf(page, id)).lastToViewBottom;
    late = !!w.late;
    await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:calls ${JSON.stringify(w.calls)}` } });
    await expect(pane.getByTestId("user-message")).toHaveCount(2, { timeout: 30_000 });
    if (w.scrolledUp) {
      // The reader goes up to the earlier reply and stays there.
      await pane.evaluate((el) => { el.scrollTop = 40; });
      await page.mouse.move(900, 400);
      await page.mouse.wheel(0, -10);
      await page.waitForTimeout(300);
    }
    await watchMoves(page, id, !w.scrolledUp);
    await expect.poll(async () => (await (await request.get(`/api/sessions/${id}`)).json()).events.filter((e: any) => e.kind === "tool_result").length, { timeout: 120_000 }).toBe(w.calls.length);
    if (w.name === "seven calls") await shoot(page, "work-14-followed-turn");
    // Through the turn's end, and a moment past it.
    await expect.poll(ends, { timeout: 60_000 }).toBe(2);
    await page.waitForTimeout(1000);
    const end = await endOf(page, id);
    if (w.name === "a 200-line command") await shoot(page, "work-17-turn-ended-card-as-it-stood");
    // A second prompt right after: its arrival moves nothing down either.
    await request.post(`/api/sessions/${id}/messages`, { data: { text: "script:say A short second reply." } });
    await expect.poll(ends, { timeout: 60_000 }).toBe(3);
    await page.waitForTimeout(600);
    const seen = await movesSeen(page);
    const after = await endOf(page, id);
    table.push(`${w.name} | frames ${seen.frames} | down ${seen.down} (largest ${seen.largestDown}) | gap at the end ${end.lastToViewBottom}, ordinary ${ordinary} | blank kept ${end.blank} | gap after a second prompt ${after.lastToViewBottom}`);
    const where = `${w.name}: ${JSON.stringify({ ...seen, ordinary, end, after })}`;
    expect(seen.frames, where).toBeGreaterThan(200);
    if (w.scrolledUp) expect([seen.down, seen.up], where).toEqual([0, 0]);
    else {
      // The cards did open (the lines above went up as they grew), the reader stayed at the end, and no
      // line dropped in any frame: not as a card's command ended, not at the turn's end, not after it.
      expect(seen.up, where).toBeGreaterThan(2);
      expect([seen.down, seen.at], where).toEqual([0, []]);
      // The conversation ends at the message box as after any turn: no room is kept under it.
      expect(Math.abs(end.lastToViewBottom - ordinary), where).toBeLessThanOrEqual(4);
      expect(Math.abs(after.lastToViewBottom - ordinary), where).toBeLessThanOrEqual(4);
      expect(end.gap, where).toBe(0);
    }
    for (const sid of [id, ...others]) await request.delete(`/api/sessions/${sid}`);
  }
  console.log(`MOVES\n${table.join("\n")}`);
});

// Where one line of text stands at every frame, found again by its words (the element that holds it is
// made again when the streamed reply becomes a row). `after`: counted only once these words are on the page.
const watchLine = (page: Page, id: string, needle: string, after: string) => page.evaluate(([sel, needle, after]) => {
  // (Following a reply, its line is not looked for in the owner's own message: a scripted prompt holds the words of its reply.)
  const sc = ([...document.querySelectorAll<HTMLElement>(sel)].find((x) => !x.closest("[inert]")) ?? document.querySelector<HTMLElement>(sel))!, c = sc.querySelector<HTMLElement>('[data-testid="transcript"]')!;
  const w = window as any;
  const m = (w.__line = { frames: 0, tracked: 0, largestDown: 0, largestUp: 0, snaps: 0, drift: 0, lost: 0, at: [] as string[] });
  let was: number | null = null, first: number | null = null, on = !after;
  const tick = () => {
    m.frames++;
    const said = [...c.querySelectorAll<HTMLElement>("p, li, td, pre")].filter((p) => !after || !p.closest('[data-testid="user-message"]'));
    if (!on) on = said.some((p) => (p.textContent ?? "").includes(after!));
    if (on) {
      const el = said.findLast((p) => (p.textContent ?? "").startsWith(needle!));
      if (!el) m.lost++;
      else {
        // A reader at the end reads against the message box: the view's foot. (A box that changes height
        // moves the foot, and the lines with it.) A reader further up reads against the view's head.
        const view = sc.getBoundingClientRect();
        const y = el.getBoundingClientRect().top - (after ? view.bottom : view.top);
        if (was !== null) {
          const d = y - was;
          if (d > m.largestDown) m.largestDown = Math.round(d);
          if (d > 3) m.snaps++;
          if (Math.abs(d) > 3 && m.at.length < 12) m.at.push(`scroll ${Math.round(w.__top ?? 0)} to ${Math.round(sc.scrollTop)}`);
          if (-d > m.largestUp) m.largestUp = Math.round(-d);
          if (Math.abs(d) > 3 && m.at.length < 12) m.at.push(`${d > 0 ? "down" : "up"} ${Math.round(Math.abs(d))}px at frame ${m.frames}`);
        }
        first ??= y; was = y; m.drift = Math.round(y - first); m.tracked++;
        w.__top = sc.scrollTop;
      }
    }
    w.__lineRaf = requestAnimationFrame(tick);
  };
  w.__lineRaf = requestAnimationFrame(tick);
}, [READING(id), needle, after] as const);
const lineSeen = (page: Page) => page.evaluate(() => { const w = window as any; cancelAnimationFrame(w.__lineRaf); return w.__line as { frames: number; tracked: number; largestDown: number; largestUp: number; snaps: number; drift: number; lost: number; at: string[] }; });
// How the conversation stands in its view: how far its last child in the flow ends above the view's
// foot, how many lines of it are on screen, and how much blank its rows keep (a row that took a taller
// draft's place stands at the draft's height until it has left the view).
const endOf = (page: Page, id: string) => page.evaluate((sel) => {
  const sc = ([...document.querySelectorAll<HTMLElement>(sel)].find((x) => !x.closest("[inert]")) ?? document.querySelector<HTMLElement>(sel))!, c = sc.querySelector<HTMLElement>('[data-testid="transcript"]')!;
  const flow = [...c.children].filter((k) => getComputedStyle(k).position !== "absolute");
  const view = sc.getBoundingClientRect();
  const lines = [...c.querySelectorAll("p, li, pre, tr, .k-line")].filter((el) => { const b = el.getBoundingClientRect(); return b.height > 0 && b.bottom > view.top && b.top < view.bottom; }).length;
  const blank = [...c.children].reduce((n, k) => n + (parseFloat((k as HTMLElement).style.paddingBottom) || 0), 0);
  return { lastToViewBottom: Math.round(view.bottom - flow.at(-1)!.getBoundingClientRect().bottom), lines, blank, kept: c.style.minHeight, gap: Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight) };
}, READING(id));

// The replies a turn can end with: short and long ones, one paragraph of many screens, one with a table,
// code and a picture, and one that ends in a call. `needle`: a line near its end; `last`: its last words.
const DOT = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const paragraphs = (n: number) => Array.from({ length: n }, (_, i) => `Line ${i + 1} of the reply says something of its own about part ${i + 1}.`).join("\n\n");
// (The scripted model reads its words from one line: a line break is written out.)
const say = (text: string) => `script:say ${text.replaceAll("\n", "\\n")}`;
const mixed = `${paragraphs(30)}\n\n| File | Change |\n| --- | ---: |\n${Array.from({ length: 14 }, (_, i) => `| \`src/part-${i}.ts\` | +${i * 3} |`).join("\n")}\n\n\`\`\`ts\n${Array.from({ length: 30 }, (_, i) => `export const part${i} = ${i};`).join("\n")}\n\`\`\`\n\n![a dot](data:image/png;base64,${DOT})\n\nThe last words of the mixed reply.`;
// `slow`: the pace at which it streams for about three seconds.
const REPLIES: { name: string; prompt: string; needle: string; last: string; slow: number }[] = [
  { name: "25 paragraphs", prompt: say(paragraphs(25)), needle: "Line 23 of the reply", last: "about part 25.", slow: 70 },
  { name: "60 paragraphs", prompt: say(paragraphs(60)), needle: "Line 58 of the reply", last: "about part 60.", slow: 30 },
  { name: "300 paragraphs", prompt: say(paragraphs(300)), needle: "Line 298 of the reply", last: "about part 300.", slow: 6 },
  { name: "one long paragraph", prompt: "script:fill", needle: "Filling the context.", last: "dolor sit amet", slow: 5 },
  { name: "a table, code and a picture", prompt: say(mixed), needle: "The last words of the mixed reply.", last: "The last words of the mixed reply.", slow: 30 },
  { name: "ends in a call", prompt: `script:calls ${JSON.stringify([{ name: "Read", input: { file_path: "package.json" }, say: paragraphs(60) }])}`, needle: "Line 58 of the reply", last: "about part 60.", slow: 30 },
];

for (const view of [{ name: "1920x1040", width: 1920, height: 1040 }, { name: "390x844", width: 390, height: 844 }]) {
  test(`a reply's last line stays where it stood when the reply ends, at ${view.name}`, async ({ page, request }) => {
    test.setTimeout(420_000);
    await page.setViewportSize({ width: view.width, height: view.height });
    await page.addInitScript(() => localStorage.setItem("keel.focus", "true"));
    const table: string[] = [];
    for (const reply of REPLIES) {
      for (const scrolledUp of [false, true]) {
        const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in" } })).json();
        await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
        const ends = async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).events.filter((e: any) => e.kind === "turn_end").length;
        // An earlier reply, so the turn watched starts below a screen of lines.
        await request.post(`/api/sessions/${session.id}/messages`, { data: { text: say(Array.from({ length: 40 }, (_, j) => `Earlier paragraph ${j + 1}.`).join("\n\n")) } });
        await expect.poll(ends, { timeout: 30_000 }).toBe(1);
        await page.goto(`/s/${session.id}`);
        await expect(page.getByTestId("turn-end")).toHaveCount(1);
        // (While the reader goes up, the reply streams slowly enough to end after they are there.)
        await request.post(`/api/sessions/${session.id}/messages`, { data: { text: scrolledUp ? `${reply.prompt}\nscript:pace ${reply.slow}` : reply.prompt } });
        await expect(page.getByTestId("user-message")).toHaveCount(2, { timeout: 30_000 });
        let needle = reply.needle;
        if (scrolledUp) {
          // The reader goes up into the reply as it streams, and reads a line there.
          await expect(page.getByTestId("draft")).toBeVisible({ timeout: 30_000 });
          await page.waitForTimeout(250);
          const box = (await page.locator(READING(session.id)).first().boundingBox())!;
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.wheel(0, -Math.round(box.height * 0.6));
          await page.waitForTimeout(200);
          needle = await page.evaluate((sel) => {
            const sc = ([...document.querySelectorAll<HTMLElement>(sel)].find((x) => !x.closest("[inert]")) ?? document.querySelector<HTMLElement>(sel))!.getBoundingClientRect();
            const seen = [...document.querySelectorAll<HTMLElement>(`${sel} [data-testid="transcript"] p`)].find((p) => { const b = p.getBoundingClientRect(); return b.bottom > sc.top + 8 && b.top < sc.bottom; });
            return (seen?.textContent ?? "").slice(0, 60);
          }, READING(session.id));
          expect(needle.length).toBeGreaterThan(5);
        }
        await watchLine(page, session.id, needle, scrolledUp ? "" : reply.last);
        await expect.poll(ends, { timeout: 120_000 }).toBe(2);
        await page.waitForTimeout(900);
        const seen = await lineSeen(page);
        const end = await endOf(page, session.id);
        table.push(`${view.name} | ${reply.name} | ${scrolledUp ? "scrolled up" : "following"} | frames ${seen.tracked} | down ${seen.largestDown} | up ${seen.largestUp} | drift ${seen.drift} | last line to view bottom ${end.lastToViewBottom} | lines on screen ${end.lines} | kept ${end.kept || "none"}`);
        const where = `${reply.name}, ${scrolledUp ? "scrolled up" : "following"}: ${JSON.stringify({ ...seen, ...end })}`;
        expect(seen.tracked, where).toBeGreaterThan(20);
        expect(seen.lost, where).toBe(0);
        expect(end.lines, where).toBeGreaterThan(0);
        if (scrolledUp) {
          // Nothing the reader looks at moves, in any frame, and no room is kept under them.
          expect([seen.largestDown, seen.largestUp, seen.drift], where).toEqual([0, 0, 0]);
        } else {
          // The reply's row takes the draft's place where it stood: no line drops, the last line is at
          // the view's foot, and nothing is kept once the turn has ended.
          expect(seen.snaps, where).toBe(0);
          expect(end.lastToViewBottom, where).toBeGreaterThanOrEqual(0);
          expect(end.lastToViewBottom, where).toBeLessThanOrEqual(100);
          expect([end.gap, end.kept], where).toEqual([0, ""]);
        }
        if (reply.name === "60 paragraphs" && !scrolledUp) await shoot(page, `work-15-long-reply-ended-${view.width}`);
        await request.delete(`/api/sessions/${session.id}`);
      }
    }
    console.log(`REPLIES\n${table.join("\n")}`);
  });
}

test("a program's calls stand under its line and mark it, after a reload too", async ({ page, request }) => {
  test.setTimeout(180_000);
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `program-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "notes.txt"), "one line\n");
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: "scripted:stand-in" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await page.goto(`/s/${session.id}`);
  // One program: a read, and a forced push the policy rates high.
  const code = `const got = await Promise.allSettled([tools.Read({ file_path: ${JSON.stringify(join(ws, "notes.txt"))} }), tools.Bash({ command: "git push --force origin main" })]);\nconsole.log(got.map((g) => g.status).join(" "));`;
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "run_code", input: { code } }])}` } });
  // The program asks as a command does; the push inside it asks on a card of its own, and is denied.
  const card = page.getByTestId("approval");
  await expect(card.getByTestId("approval-summary")).toContainText("bun -e", { timeout: 60_000 });
  await card.getByTestId("allow-once").click();
  await expect(card.getByTestId("approval-summary")).toContainText("git push --force", { timeout: 60_000 });
  await card.getByTestId("deny").click();
  await page.getByTestId("deny-reason").fill("not from a program");
  await page.getByTestId("deny-send").click();
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 60_000 });

  // The push is part of what happened: it stands under the program's closed line with why it is
  // marked, how it ended and the owner's own words, and the program's part of the rail says so.
  const program = page.locator('[data-testid="tool-call"][data-tool="run_code"]');
  const stands = async () => {
    await expect(program).toHaveAttribute("data-calls-marked", "", { timeout: 15_000 });
    // The program's own line is one row: what marks it is said on the call under it.
    expect((await program.locator("> .k-line").boundingBox())!.height).toBeLessThan(40);
    // (The owner's denial is counted as that, apart from a failure.)
    await expect(program.getByTestId("code-call-count")).toHaveText("2 calls, 1 denied by you");
    const under = program.getByTestId("code-peek").getByTestId("tool-call");
    await expect(under).toHaveCount(1);
    await expect(under.locator(".k-line-what")).toHaveText("git push --force origin main");
    await expect(under.getByTestId("call-state")).toHaveText("denied by you");
    await expect(under.getByTestId("call-mark")).toHaveText("rewrites or deletes history on a remote");
    await expect(under.getByTestId("tool-denial")).toHaveText("Younot from a program");
    await expect(under).toHaveAttribute("data-marked", "");
  };
  // It ran on this page, so it stays open as it stood, with both its calls, until it leaves the view;
  // folded, as after a reload, the push stands under its line.
  const made = program.getByTestId("code-calls").getByTestId("tool-call");
  await expect(made).toHaveCount(2);
  await expect(made.nth(1).getByTestId("call-state")).toHaveText("denied by you");
  await expect(made.nth(1).getByTestId("call-mark")).toHaveText("rewrites or deletes history on a remote");
  await page.reload();
  await stands();
  await shoot(page, "work-16-program-calls");
  // Opened: its code, both calls and what it printed.
  await program.locator("> .k-line").click();
  await expect(program.getByTestId("code-calls").getByTestId("tool-call")).toHaveCount(2);
  await expect(program.getByTestId("code-peek")).toHaveCount(0);
  await expect(program.getByTestId("code-output")).toContainText("fulfilled rejected");
  // A program whose calls fail by the dozen: the first three stand under its line, the rest are
  // counted, and the count opens the program. Then a call to a tool the session does not have (it did
  // not run), and a wait for agents, said in words.
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  const many = `const got = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => tools.Read({ file_path: "no-such-" + i + ".md" })));\nconsole.log(got.length);`;
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "run_code", input: { code: many } }, { name: "exec_command", input: { cmd: "ls" } }, { name: "wait_agent", input: { timeout_ms: 1000 } }])}` } });
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 90_000 });
  const second = page.locator('[data-testid="tool-call"][data-tool="run_code"]').nth(1);
  // (A program that ran on this page stays open as it stood until it leaves the view; folded, as after a reload:)
  await page.reload();
  await expect(second.getByTestId("code-call-count")).toHaveText("12 calls, 12 failed");
  await expect(second.getByTestId("code-peek").getByTestId("tool-call")).toHaveCount(3);
  await expect(second.getByTestId("code-peek-more")).toHaveText("and 9 more like these: open the program");
  expect((await second.boundingBox())!.height).toBeLessThan(260);
  const noTool = page.locator('[data-testid="tool-call"][data-tool="exec_command"]');
  await expect(noTool.locator(".k-line-verb")).toHaveText("Run");
  await expect(noTool.getByTestId("call-state")).toHaveText("no such tool");
  await expect(noTool.getByTestId("tool-why")).toHaveText("No tool named exec_command.");
  const waited = page.locator('[data-testid="tool-call"][data-tool="wait_agent"]');
  console.log("WAIT_AGENT", JSON.stringify(await waited.locator(".k-line-text").textContent()));
  await bring(page, '[data-testid="tool-call"][data-tool="run_code"]', 1, 80);
  await shoot(page, "work-18-program-many-and-no-tool");
  await second.getByTestId("code-peek-more").click();
  await expect(second.getByTestId("code-calls").getByTestId("tool-call")).toHaveCount(12);
  // A request with no body is answered as one that names no event.
  const none = await request.post(`/api/sessions/${session.id}/call-marks`, { data: null as any, headers: { "content-type": "application/json" } });
  expect([none.status(), await none.json()]).toEqual([200, { marks: {} }]);
  await request.delete(`/api/sessions/${session.id}`);
});
