import { expect, test } from "./isolate.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, ask, endsAre, openPanel, shoot, choose, inHead } from "./shots.ts";

// Feature: conversation operations. A recap written on demand; summarize from
// a prompt on (the prompt comes back to the message box) and everything up to
// a prompt (it and what follows stay verbatim); a skill kept on as the
// session's mode; and the model's own context tools: it reads how full its
// context is and starts a fresh one with a handoff note.
test("recap, summarize a part, skill mode, the model's context tools", async ({ page, request }) => {
  const word = `cv${Date.now().toString(36)}`;
  const prev = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  // A folder with a project skill the mode can keep on.
  const ws = join((await (await request.get("/api/workspaces")).json()).default, word);
  mkdirSync(join(ws, ".claude/skills/sign-off"), { recursive: true });
  writeFileSync(join(ws, ".claude/skills/sign-off/SKILL.md"), `---\nname: sign-off\ndescription: End every reply with a sign-off word.\n---\nEnd every reply with the word ${word.toUpperCase()} on its own line.\n`);
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: `Convo ${word}`, workspace: ws } })).json();
  const events = async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[];
  await page.goto(`/s/${session.id}`);
  const composer = page.getByTestId("composer");
  const send = async (text: string, turns: number) => {
    await composer.fill(text);
    await composer.press("Enter");
    await endsAre(page, turns, 90_000, true);
  };
  await send("Reply with only the word apple.", 1);
  await send("Reply with only the word banana.", 2);

  // Recap: written on demand, shown in the Session panel with a next prompt.
  await openPanel(page, "session");
  await page.getByTestId("recap-write").click();
  await expect(page.getByTestId("recap-text")).not.toBeEmpty({ timeout: 60_000 });
  await shoot(page, "convo-01-recap");

  // Summarize from the second prompt: it comes back to the box, the reply goes.
  await page.getByTestId("user-message").nth(1).hover();
  await page.getByRole("button", { name: "Summarize from here" }).nth(1).click();
  await expect(page.getByTestId("summarize-dialog")).toBeVisible();
  await shoot(page, "convo-02-summarize-dialog");
  await page.getByTestId("summarize-go").click();
  await expect(page.getByTestId("summarize-dialog")).toBeHidden({ timeout: 60_000 });
  await expect(composer).toHaveValue("Reply with only the word banana.");
  await expect(page.getByTestId("compacted")).toContainText("Summarized from a prompt on");
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  const s1 = (await (await request.get(`/api/sessions/${session.id}`)).json()).session;
  expect((await events()).find((e) => e.id === s1.head)).toMatchObject({ kind: "note", data: { kind: "summary", model: true } });

  // Send it again, then summarize everything up to it: it stays verbatim.
  await composer.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 90_000 });
  await page.getByTestId("user-message").nth(1).hover();
  await page.getByRole("button", { name: "Summarize up to here" }).last().click();
  await page.getByTestId("summarize-focus").fill("the word apple");
  await page.getByTestId("summarize-go").click();
  await expect(page.getByTestId("summarize-dialog")).toBeHidden({ timeout: 60_000 });
  await expect(page.getByTestId("compacted").last()).toContainText("Summarized everything before a prompt");
  const cp = (await events()).findLast((e) => e.kind === "compaction");
  expect(cp.data).toMatchObject({ range: "up_to", focus: "the word apple", mode: "summary" });
  await shoot(page, "convo-03-summarized");

  // Skill mode: the skill's instructions hold on the next turn.
  await choose(page.getByTestId("skill-mode-select"), "sign-off");
  await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.settings.skill_mode).toBe("sign-off");
  await send(ask("Reply with only the word cherry.", `script:find ${word.toUpperCase()}`), 3);
  await expect(page.getByTestId("assistant-text").last()).toContainText(word.toUpperCase());
  expect((await events()).some((e) => e.kind === "note" && e.data.kind === "skill_mode" && e.data.skill_mode === "sign-off")).toBe(true);
  await expect(page.getByTestId("note").filter({ hasText: "Skill mode: sign-off" })).toBeVisible();
  await choose(page.getByTestId("skill-mode-select"), "");
  await shoot(page, "convo-04-skill-mode");

  // The model's context tools: it reads its window, then starts fresh with a handoff.
  await send(ask("Call the keel__context_status tool, then reply with only the context_window number it gave.", 'script:calls [{"name":"keel__context_status","input":{}}]'), 4);
  const status = (await events()).flatMap((e) => (e.kind === "tool_result" ? e.data.results : [])).find((r: any) => /context_window/.test(String(r.content)));
  expect(JSON.parse(status.content).context_used_tokens).toBeGreaterThan(0);
  await send(ask(`Call the keel__new_context tool with the handoff "Goal: reply with the word ${word}.", then do what the handoff says.`, `script:calls [{"name":"keel__new_context","input":{"handoff":"Goal: reply with the word ${word}."}}]`), 5);
  const fresh = (await events()).findLast((e) => e.kind === "compaction");
  // The handoff is the story; the statements of the summary before it carry on in front of it.
  expect(fresh.data).toMatchObject({ trigger: "model" });
  expect(fresh.data.summary.endsWith(`Goal: reply with the word ${word}.`)).toBe(true);
  await expect(page.getByTestId("compacted").last()).toContainText("handoff note");
  await expect(page.getByTestId("assistant-text").last()).toContainText(word);
  await shoot(page, "convo-05-new-context");

  await request.delete(`/api/sessions/${session.id}`);
  await request.put("/api/permissions/settings", { data: { default_mode: prev } });
});

// The conversation dialogs (export, summarize, confirm) share one height and
// scroll contract: on a short window at the largest text size the details
// scroll inside the dialog and Close, Cancel and the main action stay in
// reach. Escape closes each and the keyboard goes back to what opened it.
test("export, summarize and confirm dialogs fit a short window", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === "scripted:stand-in"), "requires the scripted provider");
  const word = `dg${Date.now().toString(36)}`;
  const title = `Dialogs ${word} ` + "a title that runs on so the confirmation has many lines to show ".repeat(6).trim();
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title } })).json();
  for (const n of [1, 2]) {
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `Prompt ${n} of ${word}` } });
    await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).events.filter((e: any) => e.kind === "turn_end").length, { timeout: 30_000 }).toBe(n);
  }
  await page.goto(`/s/${session.id}`);
  // Export is in the session's menu; its dialog gives the keys back to the menu's button.
  const exportButton = { click: async () => (await inHead(page, "header-action-export")).click() };
  const menuButton = page.getByTestId("session-menu");
  const summarizeButton = page.getByRole("button", { name: "Summarize from here" }).last();
  const exported = page.getByTestId("export-dialog");
  const summarize = page.getByTestId("summarize-dialog");
  const confirm = page.getByTestId("confirm");
  const openSummarize = async () => {
    await page.getByTestId("user-message").nth(1).hover();
    await summarizeButton.click();
    await expect(summarize).toBeVisible();
  };
  const openConfirm = async () => {
    await page.getByTestId("session-menu").click();
    await page.getByTestId("menu-delete").click();
    await expect(confirm).toBeVisible();
  };
  // The whole dialog is on screen, and so is each control named.
  const fits = async (dialog: typeof confirm, ...controls: (typeof confirm)[]) => {
    const view = page.viewportSize()!;
    const box = (await dialog.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(view.height);
    expect(box.x + box.width).toBeLessThanOrEqual(view.width);
    for (const c of controls) await expect(c).toBeInViewport({ ratio: 1 });
  };

  // The usual window: each opens, Escape closes it and the keyboard returns.
  await exportButton.click();
  await exported.getByTestId("export-claude").click();
  await expect(exported.getByTestId("export-command")).toContainText("claude --resume");
  await fits(exported, exported.getByRole("button", { name: "Close" }), exported.getByTestId("export-written"));
  await shoot(page, "dialogs-01-export");
  await page.keyboard.press("Escape");
  await expect(exported).toBeHidden();
  await expect(menuButton).toBeFocused();
  await openSummarize();
  await fits(summarize, summarize.getByRole("button", { name: "Cancel" }), summarize.getByTestId("summarize-go"));
  await shoot(page, "dialogs-02-summarize");
  await page.keyboard.press("Escape");
  await expect(summarize).toBeHidden();
  await expect(summarizeButton).toBeFocused();
  await openConfirm();
  await fits(confirm, confirm.getByRole("button", { name: "Cancel" }), confirm.getByRole("button", { name: "Delete", exact: true }));
  await shoot(page, "dialogs-03-confirm");
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await expect(page.getByTestId("session-menu")).toBeFocused();

  // A phone on its side at the largest text size. Summarize opens from a
  // prompt's row, which that window has no room to show: it is opened first.
  await page.evaluate(() => localStorage.setItem("keel.textScale", "1.5"));
  await page.reload();
  await openSummarize();
  await page.setViewportSize({ width: 667, height: 375 });
  const scrolls = (l: typeof confirm) => l.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  await fits(summarize, summarize.getByRole("button", { name: "Cancel" }), summarize.getByTestId("summarize-go"));
  await shoot(page, "dialogs-04-summarize-short");
  // The details scroll inside the dialog; the page behind it stays where it was.
  expect(await scrolls(summarize.locator(".k-dialog-body"))).toBe(true);
  await summarize.getByTestId("summarize-focus").scrollIntoViewIfNeeded();
  await summarize.getByTestId("summarize-focus").fill("the failing test names");
  await expect(summarize.getByTestId("summarize-focus")).toBeInViewport({ ratio: 1 });
  await fits(summarize, summarize.getByRole("button", { name: "Cancel" }), summarize.getByTestId("summarize-go"));
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
  await page.keyboard.press("Escape");
  await expect(summarize).toBeHidden();

  await exportButton.click();
  await fits(exported, exported.getByRole("button", { name: "Close" }));
  await exported.getByTestId("export-claude").click();
  await expect(exported.getByTestId("export-command")).toContainText("claude --resume");
  // What the export wrote is brought into view, under a title bar that stayed.
  await expect(exported.getByTestId("export-command")).toBeInViewport({ ratio: 1 });
  await fits(exported, exported.getByRole("button", { name: "Close" }));
  await shoot(page, "dialogs-05-export-short");
  await exported.getByTestId("export-md").scrollIntoViewIfNeeded();
  await expect(exported.getByTestId("export-md")).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("Escape");
  await expect(exported).toBeHidden();
  await expect(menuButton).toBeFocused();

  await openConfirm();
  const body = confirm.getByRole("paragraph");
  await fits(confirm, confirm.getByRole("button", { name: "Cancel" }), confirm.getByRole("button", { name: "Delete", exact: true }));
  expect(await scrolls(body)).toBe(true);
  await shoot(page, "dialogs-06-confirm-short");
  // The wheel over the details reaches their last line; the actions stay.
  await body.hover();
  await page.mouse.wheel(0, 2000);
  await expect.poll(() => body.evaluate((el) => Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight)).toBe(true);
  await fits(confirm, confirm.getByRole("button", { name: "Cancel" }), confirm.getByRole("button", { name: "Delete", exact: true }));
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
  // The line over the actions says there is more below, in the stronger line color of each theme.
  await body.evaluate((el) => (el.scrollTop = 0));
  for (const dark of [false, true]) {
    await page.evaluate((d) => document.documentElement.classList.toggle("dark", d), dark);
    // (The line follows the scroll position at the page's next frame, and a theme's color once its
    // class is on: read until it stands, not in the instant after the scroll was set.)
    const read = () => confirm.evaluate((el) => {
      const probe = document.createElement("i");
      probe.style.color = "var(--line-strong)";
      el.append(probe);
      const strong = getComputedStyle(probe).color;
      probe.remove();
      // Both as the pixel they paint: one is written in oklch, the other comes out of an animation.
      const ctx = document.createElement("canvas").getContext("2d")!;
      const pixel = (c: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].join(","); };
      return { strong: pixel(strong), line: pixel(getComputedStyle(el.querySelector(".k-dialog-foot")!).borderTopColor) };
    });
    await expect.poll(async () => { const cue = await read(); return cue.line === cue.strong ? "the stronger line" : `${cue.line}, not ${cue.strong}`; }).toBe("the stronger line");
  }
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await expect(page.getByTestId("session-menu")).toBeFocused();
  expect((await request.get(`/api/sessions/${session.id}`)).ok()).toBe(true);

  // A confirmation whose title carries a long name with no place to break:
  // the title wraps, whole, and the actions stay on the screen.
  const name = `archive_${word}_` + "of_everything_kept_since_the_first_release_".repeat(3) + "end";
  const { project } = await (await request.post("/api/projects", { data: { name } })).json();
  await page.goto(`/p/${project.id}`);
  await page.getByTestId("project-delete").click();
  await expect(confirm).toBeVisible();
  const heading = confirm.getByRole("heading");
  await expect(heading).toContainText(name);
  expect(await heading.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await fits(confirm, confirm.getByRole("button", { name: "Cancel" }), confirm.getByRole("button", { name: "Delete project" }));
  await shoot(page, "dialogs-07-confirm-long-title-short");
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.evaluate(() => localStorage.setItem("keel.textScale", "1"));
  await page.reload();
  await page.getByTestId("project-delete").click();
  await expect(confirm).toBeVisible();
  expect(await heading.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await fits(confirm, confirm.getByRole("button", { name: "Cancel" }), confirm.getByRole("button", { name: "Delete project" }));
  await shoot(page, "dialogs-08-confirm-long-title");
  await page.keyboard.press("Escape");

  await request.delete(`/api/projects/${project.id}`);
  await request.delete(`/api/sessions/${session.id}`);
});
