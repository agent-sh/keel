import { expect, test, type Locator, type Page } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot, inHead } from "./shots.ts";

// Feature: the shell shows a control where it is needed and keeps the rest out
// of sight until it is pointed at or the keyboard reaches it. A control that
// stays quiet is still in the page (its place does not move when it shows), so
// these read its opacity: Playwright counts a transparent control as visible.
const opacity = (l: Locator) => l.evaluate((el) => Number(getComputedStyle(el).opacity));
// Opacity is eased (a short transition): poll until it settles.
const settles = (l: Locator, to: number) => expect.poll(() => opacity(l)).toBe(to);

// Two panes side by side, laid out before the page loads: the pane's tools rest only where there are panes to choose between.
const twoPanes = (page: Page, a: string, b: string) => page.addInitScript(([x, y]) => {
  localStorage.setItem("keel.focus", "false"); localStorage.setItem("keel.workbench", "true");
  localStorage.setItem("keel.panes", JSON.stringify({ count: 2, slots: [x, y], sizes: {}, active: 0 }));
}, [a, b]);

test("a pane's head keeps its tools out of sight at rest and shows them when it is pointed at or focused", async ({ page, request }) => {
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Quiet pane head" } })).json();
  const { session: beside } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Quiet pane beside" } })).json();
  await twoPanes(page, session.id, beside.id);
  await page.goto(`/s/${session.id}`);
  const head = page.getByTestId("station-head").first();
  const tools = head.locator(".k-station-tools");
  const close = head.getByTestId("station-close");
  await expect(close).toBeAttached();
  // Pointer away from the head: its tools keep their place, out of sight.
  await page.mouse.move(5, 900);
  await settles(tools, 0);
  await shoot(page, "quiet-01-head");
  // Pointed at, the head shows them.
  await head.hover({ position: { x: 20, y: 10 } });
  await settles(tools, 1);
  await page.mouse.move(5, 900);
  await settles(tools, 0);
  // The keyboard reaches them as before, and shows them while it is there.
  await head.getByTestId("station-pin").focus();
  await settles(tools, 1);
});

test("the head says what the session cost, once, and opens Usage", async ({ page, request }) => {
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Head cost" } })).json();
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "script:say Done." } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.usage.output, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.goto(`/s/${session.id}`);
  // It is the first row of the session's menu (the bar rests with the mode, the panels and the menu).
  await expect(page.getByTestId("session-header").getByTestId("session-usage")).toHaveCount(0);
  const usage = await inHead(page, "session-usage");
  // One figure: the cost, no token counts beside it (they are in its title).
  await expect(usage).toHaveText(/^\$\d+\.\d+$/);
  await expect(usage).toHaveAttribute("title", /in \(\d+% cached\), .* out/);
  // The keyboard reaches the counts too: its tip shows them on focus, and a screen reader is told them
  // (the title steps aside while its tip shows, so they are the button's description of their own).
  await usage.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(usage).toBeFocused();
  await expect(page.getByRole("tooltip")).toHaveText(/in \(\d+% cached\), .* out/);
  await expect(usage).toHaveAccessibleDescription(/^\S+ in \(\d+% cached\), \S+ out$/);
  await shoot(page, "quiet-02-head-cost-focus");
  await usage.click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "usage");
  await shoot(page, "quiet-02-head-cost");
});

// On a touch screen there is no pointer to bring them out: a pane's tools are always there.
test.describe("on a touch screen", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 1180, height: 820 } });
  test("a pane's head shows its tools with nothing pointed at", async ({ page, request }) => {
    const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Touch pane head" } })).json();
    const { session: beside } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Touch pane beside" } })).json();
    await twoPanes(page, session.id, beside.id);
    await page.goto(`/s/${session.id}`);
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
    const tools = page.getByTestId("station-head").first().locator(".k-station-tools");
    await expect(page.getByTestId("station-head").first().getByTestId("station-close")).toBeAttached();
    await settles(tools, 1);
    await shoot(page, "quiet-06-touch-head");
  });
});

test("the list's top rows say their shortcut only where the pointer or the keyboard is", async ({ page }) => {
  await page.goto("/");
  const key = (id: string) => page.getByTestId(id).locator(".k-act-key");
  await expect(key("open-palette")).toBeAttached();
  await page.mouse.move(1100, 900);
  for (const id of ["new-session", "open-palette", "open-helper"]) await settles(key(id), 0);
  await page.getByTestId("open-palette").hover();
  await settles(key("open-palette"), 1);
  await settles(key("open-helper"), 0);
  await page.mouse.move(1100, 900);
  await page.getByTestId("open-helper").focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await settles(key("open-helper"), 1);
  await shoot(page, "quiet-03-rail-keys");
});

test("an agent's line names its type only when the call picked one", async ({ page, request }) => {
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:claude-stand-in", title: "Agent lines" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  const agent = (description: string, subagent_type?: string) => ({ name: "Agent", input: { description, prompt: "script:say Looked.", ...(subagent_type ? { subagent_type } : {}) } });
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([agent("Plain look"), agent("Default look", "general-purpose"), agent("Search look", "Explore")])}` } });
  await page.goto(`/s/${session.id}`);
  const line = (t: string) => page.getByTestId("agent-call").filter({ hasText: t });
  // A finished turn's agents fold into one line: opened, it lists each.
  await page.getByRole("button", { name: /^Started 3 agents/ }).click({ timeout: 60_000 });
  await expect(line("Search look").getByTestId("agent-call-status")).toBeAttached();
  await expect(line("Search look").getByTestId("agent-call-type")).toHaveText("Explore");
  await expect(line("Plain look").getByTestId("agent-call-type")).toHaveCount(0);
  await expect(line("Default look").getByTestId("agent-call-type")).toHaveCount(0);
  await expect(page.getByTestId("agent-call").filter({ hasText: "general-purpose" })).toHaveCount(0);
  await shoot(page, "quiet-04-agent-lines");
});

test("the start page says the keys to know only while there are no sessions", async ({ page, request }) => {
  // A session of this test's own, so the daemon has one whatever ran before.
  await request.post("/api/sessions", { data: { model: HAIKU, title: "Keys to know" } });
  await page.goto("/");
  await expect(page.getByTestId("new-composer")).toBeVisible();
  await expect(page.getByTestId("home-start")).not.toContainText("all shortcuts");
  await shoot(page, "quiet-05-home");
});

// A live agent's mark stands at its line's end: the lines without one keep its room, so the branch chips of
// a run of agents end in one column whichever of them still runs.
test("agents' branch chips end in one column, live or done", async ({ page, request }) => {
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `chips-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=Keel Test", "-c", "user.email=test@example.invalid", ...a], { cwd: ws, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(ws, "notes.txt"), "notes\n");
  git("add", ".");
  git("commit", "-q", "-m", "start");
  const gate = join(ws, "..", `chips-gate-${Date.now()}`);
  const { session } = await (await request.post("/api/sessions", { data: { title: "Agent chips", model: "scripted:claude-stand-in", workspace: ws } })).json();
  try {
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
    const agent = (description: string, prompt: string) => ({ name: "Agent", input: { description, prompt, isolation: "worktree", run_in_background: true } });
    const calls = [agent("Fix", "script:say Done."), agent("Rework the parser and its tests", `script:hold ${gate}`), agent("Check the release checklist again", "script:say Done.")];
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify(calls)}` } });
    await page.goto(`/s/${session.id}`);
    await page.getByRole("button", { name: /^Started 3 agents/ }).click({ timeout: 60_000 });
    const chips = page.getByTestId("agent-call-branch");
    await expect(chips).toHaveCount(3, { timeout: 60_000 });
    await expect(page.getByTestId("agent-call").filter({ has: page.locator(".k-line-run") })).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId("agent-call").filter({ hasText: "Fix" }).getByTestId("agent-call-status")).toHaveAttribute("data-watch", "done", { timeout: 30_000 });
    await page.mouse.move(5, 900);
    const edges = await chips.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().right)));
    expect(new Set(edges).size, `chip right edges ${edges.join(", ")}`).toBe(1);
    await shoot(page, "quiet-07-agent-chips");
  } finally {
    // The held agent ends before its session goes with the test.
    writeFileSync(gate, "");
    await expect.poll(async () => ((await (await request.get(`/api/sessions/${session.id}/agents`)).json()).agents as { status: string }[]).some((a) => a.status === "running"), { timeout: 30_000 }).toBe(false);
  }
});

test("a session's box on a desk is one quiet line in the workbench: the pickers behind its +, no ring, Send an icon's size", async ({ page, request }) => {
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "Quiet box" } })).json();
  await page.goto(`/s/${session.id}`);
  await expect(page.locator(".k-shell")).not.toHaveAttribute("data-mode", "focus");
  const box = page.getByTestId("composer-box");
  await page.getByTestId("composer").click();
  await expect(page.getByTestId("composer")).toBeFocused();
  const look = await box.evaluate((el) => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize), s = getComputedStyle(el);
    const send = el.querySelector<HTMLElement>('[data-testid="send"]')!.getBoundingClientRect(), field = el.querySelector("textarea")!;
    return { height: el.getBoundingClientRect().height / rem, ring: s.boxShadow, send: send.width / rem, sendRow: Math.abs(send.bottom - field.getBoundingClientRect().bottom) < rem, words: parseFloat(getComputedStyle(field).fontSize) };
  });
  // One row: the field with Send beside it, at the body's size; a hairline frame, no ring around it.
  expect(look.height).toBeLessThanOrEqual(3.25);
  expect(look.sendRow).toBe(true);
  expect(look.ring).toBe("none");
  expect(look.send).toBeLessThanOrEqual(1.75);
  expect(look.words).toBe(15);
  // What the next turn runs with is behind the +.
  await expect(box.getByTestId("model-picker")).toHaveCount(0);
  await box.getByTestId("box-more").click();
  await expect(page.getByTestId("box-more-popup").getByTestId("model-picker")).toBeVisible();
  await expect(page.getByTestId("box-more-popup").getByTestId("permission-menu")).toBeVisible();
  await shoot(page, "quiet-08-box-one-line");
});

test("a step of long commands is one row beside the reply", async ({ page, request }) => {
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "Quiet step" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  const long = (n: number) => ({ name: "Bash", input: { command: `echo ${n} && echo "a command long enough to pass the width of the reading column when it stands beside another one of its kind ${n}"` } });
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:batch ${JSON.stringify([long(1), long(2), long(3)])}` } });
  await expect.poll(async () => ((await (await request.get(`/api/sessions/${session.id}`)).json()).events as { kind: string }[]).filter((e) => e.kind === "turn_end").length, { timeout: 60_000 }).toBe(1);
  await page.goto(`/s/${session.id}`);
  const line = page.locator('.k-work [data-testid="work-step"] > .k-line[data-step] > .k-line-text').first();
  await expect(line).toContainText("3 commands", { timeout: 30_000 });
  const rows = await line.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
  expect(rows).toBe(1);
  await shoot(page, "quiet-09-step-one-row");
});

test("a finished conversation is one ink: nothing in it is set in a saturated colour or over the reply's size", async ({ page, request }) => {
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "Calm prose" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  const todos = (done: number) => ({ name: "TodoWrite", input: { todos: ["Write the note", "Change a line", "Check it"].map((content, i) => ({ content, activeForm: content, status: i < done ? "completed" : i === done ? "in_progress" : "pending" })) } });
  const file = `calm-${Date.now()}.txt`;
  const calls = [todos(1), { name: "Write", input: { file_path: file, content: "one\ntwo\nthree\n" } }, todos(2), { name: "Edit", input: { file_path: file, old_string: "two", new_string: "2" } }, { name: "Bash", input: { command: `cat ${file}`, description: "Read the note back" } }, todos(3)];
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `A plan, a small change and a command, please.\nscript:calls ${JSON.stringify(calls)}` } });
  await expect.poll(async () => ((await (await request.get(`/api/sessions/${session.id}`)).json()).events as { kind: string }[]).filter((e) => e.kind === "turn_end").length, { timeout: 60_000 }).toBe(1);
  await page.goto(`/s/${session.id}`);
  await expect(page.getByTestId("small-change").first()).toBeVisible({ timeout: 30_000 });
  await page.mouse.move(5, 900);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => { document.documentElement.classList.add("theme-switch"); document.documentElement.classList.toggle("dark", t === "dark"); }, theme);
    // How far a colour is from grey (0 to 1, with its alpha), read as the page paints it.
    const loud = await page.getByTestId("transcript").evaluate((root) => {
      const c = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
      const far = (css: string) => { c.clearRect(0, 0, 1, 1); c.fillStyle = css; c.fillRect(0, 0, 1, 1); const [r, g, b, a] = c.getImageData(0, 0, 1, 1).data; return ((Math.max(r!, g!, b!) - Math.min(r!, g!, b!)) / 255) * (a! / 255); };
      const out: string[] = []; let largest = 0;
      for (const el of root.querySelectorAll<HTMLElement>("*")) {
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        if (r.width < 1 || r.height < 1 || s.visibility === "hidden" || Number(s.opacity) === 0) continue;
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim());
        const inks: [string, string][] = [["background", s.backgroundColor], ...(own || el.tagName === "svg" ? [["color", s.color] as [string, string]] : []), ...(parseFloat(s.borderLeftWidth) > 0 ? [["border", s.borderLeftColor] as [string, string]] : [])];
        for (const [what, ink] of inks) if (far(ink) > 0.2) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} ${what} ${ink}`);
        if (own) largest = Math.max(largest, parseFloat(s.fontSize));
      }
      return { out: [...new Set(out)], largest };
    });
    expect(loud.out, `${theme}: saturated in a finished conversation`).toEqual([]);
    expect(loud.largest).toBeLessThanOrEqual(15);
  }
  await shoot(page, "quiet-10-calm-prose");
});
