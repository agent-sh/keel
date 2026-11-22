import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./isolate.ts";
import { openPanel, shoot } from "./shots.ts";

test.use({ viewport: { width: 1700, height: 980 } });

// A 1x1 PNG, written by a command into the artifacts folder.
const DOT = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// Feature: artifacts. A session writes a report, changes a file, puts a chart,
// a page and an image in its artifacts folder and makes a file by a command;
// the panel lists each as it lands (made or changed), previews markdown, the
// page in a sandbox that reaches nothing, the image, and the diff of the
// changed file; download and the path work; the project's page lists them too.
test("artifacts: indexed from tool calls, previewed, per session and per project", async ({ page, request, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const word = `af${Date.now().toString(36)}`;
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", word);
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "README.md"), "# Tool\n\nOld line.\n");
  execFileSync("git", ["init", "-q"], { cwd: ws });
  const s = (await (await request.post("/api/sessions", { data: { workspace: ws, model: "scripted:stand-in", title: `Report ${word}` } })).json()).session;
  await request.put(`/api/sessions/${s.id}/permissions`, { data: { mode: "full-auto" } });
  const list = async () => (await (await request.get(`/api/sessions/${s.id}/artifacts`)).json());
  const { dir } = await list();

  await page.goto(`/s/${s.id}`);
  await openPanel(page, "artifacts");
  await expect(page.getByTestId("artifacts-empty")).toBeVisible();

  const page_ = `<!doctype html><h1 id="h">Waiting</h1><script>document.getElementById("h").textContent = "Script ran";
fetch("/api/sessions").then(() => document.body.append(" reached the daemon"), () => document.body.append(" network blocked"));</script>`;
  const calls = [
    { name: "Write", input: { file_path: join(ws, "report.md"), content: `# Findings ${word}\n\n- **one** thing\n- another\n` } },
    { name: "Read", input: { file_path: join(ws, "README.md") } },
    { name: "Edit", input: { file_path: join(ws, "README.md"), old_string: "Old line.", new_string: "New line." } },
    { name: "Write", input: { file_path: `${dir}/chart.svg`, content: `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#3a7"/></svg>` } },
    { name: "Write", input: { file_path: `${dir}/page.html`, content: page_ } },
    { name: "Bash", input: { command: `echo ${DOT} | base64 -d > ${dir}/dot.png && echo made > made-by-shell.txt` } },
  ];
  await request.post(`/api/sessions/${s.id}/messages`, { data: { text: `script:calls ${JSON.stringify(calls)}` } });
  const rows = page.getByTestId("artifact-row");
  // They land while the session works; the command's file comes with the turn's end.
  await expect(rows).toHaveCount(6, { timeout: 30_000 });
  const got = Object.fromEntries((await list()).artifacts.map((a: any) => [a.name, a]));
  expect(got["report.md"]).toMatchObject({ created: true, kind: "markdown", source: "edit", tool: "Write" });
  expect(got["README.md"]).toMatchObject({ created: false, source: "edit", tool: "Edit" });
  expect(got["page.html"]).toMatchObject({ created: true, kind: "html" });
  expect(got["dot.png"]).toMatchObject({ kind: "image", source: "folder" });
  expect(got["made-by-shell.txt"]).toMatchObject({ created: true, source: "shell" });

  // The prompt names the folder in the session's own part, after the cache split.
  const kept = await (await request.get(`/api/telemetry/prompt?session_id=${s.id}&text=1`)).json();
  expect(kept.blocks.map((b: any) => b.name)).toContain("Artifacts");
  expect(kept.text.slice(kept.split)).toContain(dir);
  expect(kept.text.slice(0, kept.split)).not.toContain(dir);

  // Markdown, rendered.
  await rows.filter({ hasText: "report.md" }).click();
  await expect(page.getByTestId("artifact-body").getByRole("heading", { name: `Findings ${word}` })).toBeVisible();
  await page.getByTestId("artifact-copy-path").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(join(ws, "report.md"));
  await shoot(page, "artifacts-01-markdown");

  // The page runs its script in a sandbox that reaches nothing.
  await rows.filter({ hasText: "page.html" }).click();
  await expect(page.getByTestId("artifact-frame")).toHaveAttribute("sandbox", "allow-scripts");
  const frame = page.frameLocator('[data-testid="artifact-frame"]');
  await expect(frame.locator("#h")).toHaveText("Script ran");
  await expect(frame.locator("body")).toContainText("network blocked");
  await shoot(page, "artifacts-02-page");

  // The image, and the changed file's diff.
  await rows.filter({ hasText: "dot.png" }).click();
  await expect(page.getByTestId("artifact-image")).toBeVisible();
  await rows.filter({ hasText: "README.md" }).click();
  await page.getByTestId("artifact-view-diff").click();
  await expect(page.getByTestId("diff-view")).toContainText("New line.");
  await shoot(page, "artifacts-03-diff");

  // Download; nothing outside the session's artifacts is served.
  const dl = await request.get(await page.getByTestId("artifact-download").getAttribute("href") as string);
  expect(dl.headers()["content-disposition"]).toContain("README.md");
  expect((await request.get(`/api/sessions/${s.id}/artifacts/raw?path=${encodeURIComponent("/etc/hostname")}`)).status()).toBe(404);
  const html = await request.get(`/api/sessions/${s.id}/artifacts/raw?path=${encodeURIComponent(`${dir}/page.html`)}`);
  expect(html.headers()["content-security-policy"]).toContain("sandbox");

  // The project of the folder lists them with the session's name.
  const p = (await (await request.post("/api/projects", { data: { name: `Docs ${word}`, folders: [ws] } })).json()).project;
  await page.goto(`/p/${p.id}`);
  const all = page.getByTestId("project-artifacts-list");
  await expect(all.getByTestId("artifact-row")).toHaveCount(6);
  await all.getByTestId("artifact-row").filter({ hasText: "chart.svg" }).click();
  await expect(all.getByTestId("artifact-image")).toBeVisible();
  await page.getByTestId("project-artifacts").scrollIntoViewIfNeeded();
  await shoot(page, "artifacts-04-project");

  await request.delete(`/api/projects/${p.id}`);
  await request.delete(`/api/sessions/${s.id}`);
});

// The browser lays out by the room it has. On a small screen the list and the
// preview take turns: a picked artifact gets the whole panel, its actions are
// all in reach, and going back finds the list where it was left, on the row
// that was open. With width to spare the list stands beside the preview.
test("artifacts on a small screen and beside the preview", async ({ page, request }) => {
  const word = `as${Date.now().toString(36)}`;
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", word);
  mkdirSync(ws, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: ws });
  const s = (await (await request.post("/api/sessions", { data: { workspace: ws, model: "scripted:stand-in", title: `Small screen ${word}` } })).json()).session;
  await request.put(`/api/sessions/${s.id}/permissions`, { data: { mode: "full-auto" } });
  const page_ = `<!doctype html><h1 id="h">Waiting</h1><script>document.getElementById("h").textContent = "Script ran";
fetch("/api/sessions").then(() => document.body.append(" reached the daemon"), () => document.body.append(" network blocked"));</script>`;
  // The page first, so it is the oldest: the last row of a list longer than the screen.
  const names = ["status-page.html", "release-notes.md", "migration-plan.md", "load-test-results.md", "rollback-steps.md", "api-changes.md", "open-questions.md", "cost-estimate.md", "handover.md", "risk-register.md", "timeline.md", "owners.md"];
  const calls = names.map((n) => ({ name: "Write", input: { file_path: join(ws, n), content: n.endsWith(".html") ? page_ : `# ${n}\n\nNotes ${word}.\n` } }));
  await request.post(`/api/sessions/${s.id}/messages`, { data: { text: `script:calls ${JSON.stringify(calls)}` } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${s.id}/artifacts`)).json()).artifacts.length, { timeout: 60_000 }).toBe(names.length);
  await expect.poll(async () => (await (await request.get(`/api/sessions/${s.id}`)).json()).running).toBe(false);

  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(`/s/${s.id}`);
  await openPanel(page, "artifacts");
  const panel = page.getByTestId("artifacts-panel");
  const list = panel.getByTestId("artifact-list");
  const rows = panel.getByTestId("artifact-row");
  const preview = panel.getByTestId("artifact-preview");
  await expect(rows).toHaveCount(names.length);
  // The list has the panel to itself: no preview yet, and nothing marked as open.
  await expect(preview).toHaveCount(0);
  await expect(panel).toHaveAttribute("data-layout", "one");
  await expect(panel.locator('[data-testid="artifact-row"][aria-current]')).toHaveCount(0);
  const room = async () => (await list.boundingBox())!.height / (await panel.boundingBox())!.height;
  expect(await room()).toBeGreaterThan(0.75);
  await shoot(page, "artifacts-05-small-list");

  // The last row, reached by scrolling: its preview takes the list's place.
  const target = rows.filter({ hasText: "status-page.html" });
  await target.scrollIntoViewIfNeeded();
  const at = await list.evaluate((el) => el.scrollTop);
  expect(at).toBeGreaterThan(0);
  await target.click();
  await expect(preview).toBeVisible();
  await expect(list).toBeHidden();
  await expect(panel.getByTestId("artifact-name")).toHaveText("status-page.html");
  expect((await preview.boundingBox())!.height / (await panel.boundingBox())!.height).toBeGreaterThan(0.7);
  // Three views, and Open, Copy path and Download all whole inside the panel, with nothing to pan.
  await expect(preview.getByRole("tab")).toHaveText(["Preview", "Source", "Diff"]);
  const bar = panel.getByTestId("artifact-toolbar");
  expect(await bar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const edge = (await panel.boundingBox())!;
  for (const id of ["artifact-view-show", "artifact-view-source", "artifact-view-diff", "artifact-open", "artifact-copy-path", "artifact-download"]) {
    const b = (await panel.getByTestId(id).boundingBox())!;
    expect(b.x, id).toBeGreaterThanOrEqual(edge.x);
    expect(b.x + b.width, id).toBeLessThanOrEqual(edge.x + edge.width);
  }
  // The page still runs in the sandbox that reaches nothing.
  await expect(panel.getByTestId("artifact-frame")).toHaveAttribute("sandbox", "allow-scripts");
  const frame = page.frameLocator('[data-testid="artifact-frame"]');
  await expect(frame.locator("#h")).toHaveText("Script ran");
  await expect(frame.locator("body")).toContainText("network blocked");
  await shoot(page, "artifacts-06-small-preview");
  await panel.getByTestId("artifact-view-source").click();
  await expect(panel.getByTestId("artifact-code")).toContainText("Script ran");

  // Back: the list where it was left, on the row that was open.
  await panel.getByTestId("artifacts-back").click();
  await expect(list).toBeVisible();
  await expect(preview).toHaveCount(0);
  await expect(target).toHaveAttribute("aria-current", "true");
  await expect(target).toBeFocused();
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(at);
  await shoot(page, "artifacts-07-small-back");

  // The project page at full width: the list beside the preview, each with the block's height.
  const p = (await (await request.post("/api/projects", { data: { name: `Docs ${word}`, folders: [ws] } })).json()).project;
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto(`/p/${p.id}`);
  const all = page.getByTestId("project-artifacts-list");
  await expect(all).toHaveAttribute("data-layout", "beside");
  await all.getByTestId("artifact-row").filter({ hasText: "status-page.html" }).click();
  const lb = (await all.getByTestId("artifact-list").boundingBox())!, pb = (await all.getByTestId("artifact-preview").boundingBox())!;
  expect(pb.x).toBeGreaterThanOrEqual(lb.x + lb.width - 1);
  expect(Math.abs(pb.y - lb.y)).toBeLessThan(2);
  await expect(all.getByTestId("artifact-frame")).toHaveAttribute("sandbox", "allow-scripts");
  await page.getByTestId("project-artifacts").scrollIntoViewIfNeeded();
  await shoot(page, "artifacts-08-project-beside");
  // The same page on the small screen: one at a time inside its block.
  await page.setViewportSize({ width: 320, height: 568 });
  await expect(all).toHaveAttribute("data-layout", "one");
  await page.getByTestId("project-artifacts").scrollIntoViewIfNeeded();
  await shoot(page, "artifacts-09-project-small");

  await request.delete(`/api/projects/${p.id}`);
  await request.delete(`/api/sessions/${s.id}`);
});

// The review's loop case: a page that asks for the keyboard as fast as it can, from the moment
// it loads, with no press of the owner's in it. An engine that refuses a frame the focus it
// was not given never lets it (the desktop app's do); in a browser that does not, the page takes
// the frame away at its second take and says so, and what the owner types is the message box's.
test("artifacts: a page that keeps taking the keyboard is stopped, and typing stays in the message box", async ({ page, request }) => {
  const word = `lp${Date.now().toString(36)}`;
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", word);
  mkdirSync(ws, { recursive: true });
  const s = (await (await request.post("/api/sessions", { data: { workspace: ws, model: "scripted:stand-in", title: `Loop ${word}` } })).json()).session;
  await request.put(`/api/sessions/${s.id}/permissions`, { data: { mode: "full-auto" } });
  const { dir } = await (await request.get(`/api/sessions/${s.id}/artifacts`)).json();
  const loop = `<!doctype html><input id="i" autofocus><script>
const i = document.getElementById("i");
setInterval(() => { window.focus(); i.focus(); i.click(); }, 0);
</script>`;
  try {
    await page.goto(`/s/${s.id}`);
    await openPanel(page, "artifacts");
    await request.post(`/api/sessions/${s.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Write", input: { file_path: `${dir}/loop.html`, content: loop } }])}` } });
    const rows = page.getByTestId("artifact-row");
    await expect(rows).toHaveCount(1, { timeout: 30_000 });
    const box = page.getByTestId("composer");
    await rows.first().click();
    // The frame carries the policy an engine can refuse the focus by.
    const shown = page.getByTestId("artifact-frame");
    await expect(shown).toHaveAttribute("allow", "focus-without-user-activation 'none'");
    const field = page.frameLocator('[data-testid="artifact-frame"]').locator("#i");
    await expect(field).toBeVisible();
    // The owner goes to the message box and types while the frame asks: every character is the box's.
    await box.click();
    const typed = "k".repeat(41);
    await page.keyboard.type(typed, { delay: 20 });
    await expect(box).toHaveValue(typed);
    if (await shown.count()) await expect(field).toHaveValue("");
    // The owner's own press in the frame gives it the keyboard.
    if (await shown.count()) {
      await field.click();
      await page.keyboard.type("abc");
      await expect(field).toHaveValue("abc");
    }
    // The owner goes back to the message box; the frame goes on asking. Where the engine lets a
    // frame the owner was in take the keyboard, the page takes the frame away at its second
    // take and says so in its place.
    await box.click();
    const stopped = page.getByTestId("frame-stopped");
    await expect(stopped).toBeVisible({ timeout: 15_000 });
    await expect(stopped).toContainText("kept taking the keyboard and was stopped");
    await expect(shown).toHaveCount(0);
    await box.click();
    await page.keyboard.type("more", { delay: 20 });
    // (Where in the text the click put the caret is not the point: all of it is in the box.)
    await expect.poll(async () => (await box.inputValue()).replace("more", "")).toBe(typed);
    await shoot(page, "artifacts-06-frame-stopped");
    // The owner may have it back.
    await stopped.getByTestId("frame-show-again").click();
    await expect(shown).toBeVisible();
  } finally {
    await request.delete(`/api/sessions/${s.id}`).catch(() => {});
  }
});

// A page a session wrote gets the keyboard by the owner's own act (a press over it, Tab into
// it), never by asking for it. The review's page: once clicked in, it asks for the focus again
// and again from a timer; the owner then clicks the message box and types or pastes, and the
// words landed in the page's field.
test("artifacts: a page takes the keyboard only by the owner's press or Tab", async ({ page, request }) => {
  const word = `fr${Date.now().toString(36)}`;
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", word);
  mkdirSync(ws, { recursive: true });
  const s = (await (await request.post("/api/sessions", { data: { workspace: ws, model: "scripted:stand-in", title: `Frame ${word}` } })).json()).session;
  await request.put(`/api/sessions/${s.id}/permissions`, { data: { mode: "full-auto" } });
  const { dir } = await (await request.get(`/api/sessions/${s.id}/artifacts`)).json();
  const steal = `<!doctype html><textarea id="t" style="width:90%;height:6rem"></textarea><script>
const t = document.getElementById("t");
document.addEventListener("click", (e) => { if (e.isTrusted) for (let i = 1; i <= 60; i++) setTimeout(() => t.focus(), i * 70); });
</script>`;
  try {
    await page.goto(`/s/${s.id}`);
    await openPanel(page, "artifacts");
    await request.post(`/api/sessions/${s.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Write", input: { file_path: `${dir}/steal.html`, content: steal } }])}` } });
    const rows = page.getByTestId("artifact-row");
    await expect(rows).toHaveCount(1, { timeout: 30_000 });
    await rows.first().click();
    const frame = page.frameLocator('[data-testid="artifact-frame"]');
    const field = frame.locator("#t");
    await expect(field).toBeVisible();
    const inFrame = () => page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "artifact-frame");

    // The owner's press in the page: it has the keyboard, and what they type lands in it.
    await field.click();
    await page.keyboard.type("in the page");
    await expect(field).toHaveValue("in the page");
    expect(await inFrame()).toBe(true);

    // The owner goes to the message box. The page asks for the keyboard again within a moment,
    // and again: at its second take it is taken away, the page says so in its place, and the
    // keyboard is the message box's.
    const box = page.getByTestId("composer");
    await box.click();
    await expect(page.getByTestId("frame-stopped")).toBeVisible();
    await expect(page.getByTestId("artifact-frame")).toHaveCount(0);
    await expect(box).toBeFocused();
    await page.keyboard.type("the owner's words, typed after the page asked for the keyboard", { delay: 45 });
    await expect(box).toHaveValue("the owner's words, typed after the page asked for the keyboard");
    expect(await inFrame()).toBe(false);
    await expect(box).toBeFocused();
    await shoot(page, "artifacts-05-keyboard-stays");
    // Shown again, it is a page like any other (this one asks only once it was clicked in).
    await page.getByTestId("frame-show-again").click();
    await expect(field).toBeVisible();

    // Tab from the control before it still reaches the page.
    await page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>('[data-testid="artifact-frame"]')!;
      const stops = [...document.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, textarea, [tabindex]:not([tabindex="-1"]), iframe')].filter((el) => el.offsetParent !== null);
      stops[stops.indexOf(frame) - 1]!.focus();
    });
    await page.keyboard.press("Tab");
    await expect.poll(inFrame).toBe(true);
    await page.waitForTimeout(400);
    expect(await inFrame()).toBe(true);
  } finally {
    await request.delete(`/api/sessions/${s.id}`).catch(() => {});
  }
});
