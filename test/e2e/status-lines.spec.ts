import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the block over the message box is two lines and the box takes the height its text needs.
// Above: the plan and the agents. Below: what the turn does now, with a marker that says thinking, acting
// or waiting, then the folder, the project and what the session changed. The agents open their list, the
// changes open the Changes panel, the folder and a file named in the action open the Files panel.
// On a phone the same two lines fold to what fits, every target a finger's size. The scripted stand-in
// writes the turns.
const STAND_IN = "scripted:stand-in";
const E2E = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws");
const calls = (list: object[]) => `script:calls ${JSON.stringify(list)}`;

async function made(request: APIRequestContext, title: string, ws: string) {
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title, workspace: ws } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  return session.id as string;
}
const send = (request: APIRequestContext, id: string, text: string) => request.post(`/api/sessions/${id}/messages`, { data: { text } });
const rested = (request: APIRequestContext, id: string, turns: number) => expect.poll(async () => {
  const d = await (await request.get(`/api/sessions/${id}`)).json();
  return !d.running && d.events.filter((e: any) => e.kind === "turn_end").length;
}, { timeout: 60_000 }).toBe(turns);

// A folder with a repository in it and a file to name.
function folder(name: string) {
  const ws = join(E2E, `${name}-${Date.now()}`);
  mkdirSync(join(ws, "src"), { recursive: true });
  writeFileSync(join(ws, "src/a.ts"), "export const a = 1;\n");
  execFileSync("git", ["init", "-q"], { cwd: ws });
  return ws;
}

// A session with a plan, two agents at work, files changed, and a command that runs: its action names src/a.ts.
async function busy(request: APIRequestContext, ws: string) {
  const id = await made(request, "Release notes and the changelog", ws);
  const todos = ["Read the notes", "Check the changelog", "Write the summary"].map((content, i) => ({ content, activeForm: `${content} (now)`, status: ["completed", "in_progress", "pending"][i] }));
  await send(request, id, calls([{ name: "TodoWrite", input: { todos } }, { name: "Bash", input: { command: "echo more >> src/a.ts; echo new > src/b.ts" } }]));
  await rested(request, id, 1);
  const slow = (title: string) => ({ name: "spawn_agent", input: { message: `${title}\n${calls([{ name: "Bash", input: { command: "sleep 100" } }])}`, isolation: "none" } });
  await send(request, id, `script:batch ${JSON.stringify([slow("Reader"), slow("Checker")])}`);
  await rested(request, id, 2);
  // (A command's own description is what its line says: this one names the file it works on.)
  await send(request, id, calls([{ name: "Bash", input: { command: "sleep 100", description: "Editing src/a.ts" } }]));
  return id;
}
const stop = async (request: APIRequestContext, ids: string[]) => {
  for (const id of ids) await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }).catch(() => {});
};

// The errors the page reports for a size observer that changes what it watches from inside its own call
// ("ResizeObserver loop completed with undelivered notifications"): started before the page loads, read at the end.
function watchLoops(page: Page) {
  const seen: string[] = [];
  void page.exposeFunction("__loopSeen", (m: string) => seen.push(m));
  void page.addInitScript(() => addEventListener("error", (e: ErrorEvent) => { if (/ResizeObserver loop/.test(e.message)) (window as any).__loopSeen(e.message); }));
  return async () => seen;
}

// The block over the box and the box, as laid out (px).
const measure = (page: Page) => page.evaluate(() => {
  const pane = document.querySelector<HTMLElement>(".k-station[data-helm]") ?? document.body;
  const r = (el: Element | null | undefined) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, height: b.height, width: b.width }; };
  const q = (id: string) => pane.querySelector(`[data-testid="${id}"]`);
  const dock = q("session-dock")!;
  const ta = q("composer") as HTMLTextAreaElement;
  const lineOf = (line: Element | null) => {
    const box = line?.getBoundingClientRect();
    // Every part that shows something lies whole inside its line, and a finger's part is as big as a finger.
    const out: string[] = [], small: string[] = [];
    for (const el of line?.querySelectorAll<HTMLElement>("*") ?? []) {
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height || !box) continue;
      if (b.left < box.left - 1 || b.right > box.right + 1 || b.top < box.top - 1 || b.bottom > box.bottom + 1) out.push(`${el.dataset.testid ?? el.className}`);
      if (el.matches("button, [role=button]") && (b.height < 43.5 || b.width < 43.5)) small.push(`${el.dataset.testid ?? el.className}: ${Math.round(b.width)}x${Math.round(b.height)}`);
    }
    return { rect: r(line), out, small };
  };
  return {
    rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
    dock: r(dock),
    kids: [...dock.children].map((c) => (c as HTMLElement).dataset.testid),
    top: lineOf(q("dock-top")),
    now: lineOf(q("dock-now")),
    plan: r(q("dock-plan")),
    agents: r(q("dock-agents-line")),
    box: r(q("composer-box")),
    ta: r(ta),
    lh: parseFloat(getComputedStyle(ta).lineHeight),
    tools: r(q("composer-tools")),
  };
});
type Seen = Awaited<ReturnType<typeof measure>>;

test.describe("at a desk", () => {
  test("the block is two lines, the marker says what the turn is in, and the parts open their panels", async ({ page, request }) => {
    const made_: string[] = [];
    const loops = watchLoops(page);
    try {
      const ws = folder("status");
      const id = await busy(request, ws);
      made_.push(id);
      await page.setViewportSize({ width: 1920, height: 1040 });
      await page.goto(`/s/${id}`);
      await expect(page.getByTestId("dock-agents")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("dock-changes-count")).toHaveText(/^2 files\s*\+\d+\s*-\d+$/, { timeout: 30_000 });
      await expect(page.getByTestId("dock-action-path")).toHaveText("src/a.ts", { timeout: 30_000 });

      // 1. The heights. The block was three lines of 1.75rem and the box held 1.5rem of air over its text and 0.5rem
      // under its tools; now two lines, and the text sits close to the top, its row of tools close under it.
      for (const [width, height] of [[1920, 1040], [1366, 768]] as const) {
        await page.setViewportSize({ width, height });
        await expect.poll(async () => (await measure(page)).dock!.height, { message: `the block at ${width}` }).toBeLessThanOrEqual(4.4 * 16);
        const m = await measure(page);
        expect(m.dock!.height / m.rem, `the block at ${width} is two lines of 1.75rem and no more`).toBeLessThanOrEqual(4.1);
        expect(m.box!.height / m.rem, `the box at ${width} holds one line of text and its tools`).toBeLessThanOrEqual(5.4);
        // No band between the text and the tools, and the text's own air is small.
        expect(Math.abs(m.tools!.top - m.ta!.bottom), "the tools start where the text ends").toBeLessThanOrEqual(1);
        expect((m.ta!.height - m.lh) / m.rem, "air in the text field").toBeLessThanOrEqual(1);
        expect(m.kids, "the block is two lines").toEqual(["dock-top", "dock-now"]);
        expect(Math.abs((m.plan!.top + m.plan!.bottom) - (m.agents!.top + m.agents!.bottom)), "the plan and the agents share a line").toBeLessThanOrEqual(2);
        expect(m.top.out, "nothing of the top line leaves it").toEqual([]);
        expect(m.now.out, "nothing of the bottom line leaves it").toEqual([]);
        await shoot(page, `status-01-${width}`);
      }

      // A narrow window with a mouse: the plan's step stays inside its line (it was a column of letters over the conversation).
      await page.setViewportSize({ width: 390, height: 844 });
      await expect.poll(async () => (await measure(page)).top.out, { message: "nothing of the top line leaves it at 390" }).toEqual([]);
      await shoot(page, "status-01-390-mouse");

      // 2. The marker: acting while a command runs, its word for a reader, its own shape with the motion off.
      await page.setViewportSize({ width: 1366, height: 768 });
      const now = page.getByTestId("dock-now");
      await expect(now).toHaveAttribute("data-moment", "acting");
      await expect(page.getByTestId("dock-action-text")).toContainText("Editing");
      // The line says the action once: the conversation has no running line of its own that says it again.
      await expect(page.getByTestId("dock-action-clock")).toHaveText(/\d+s/);
      await expect(page.getByTestId("working"), "the transcript does not say the action again").toHaveCount(0);
      const mark = page.getByTestId("dock-moment");
      await expect(mark).toHaveAttribute("aria-label", "Working");
      const shape = () => mark.evaluate((m) => ({ moment: (m as HTMLElement).dataset.moment, parts: [...m.children].map((i) => { const s = getComputedStyle(i); return `${s.width}x${s.height}:${s.borderRadius}:${s.display}`; }), runs: getComputedStyle(m.children[0]!).animationDuration }));
      const moving = await shape();
      expect(moving.runs, "the marker moves").not.toMatch(/^(0s|0\.001s)$/);
      await page.emulateMedia({ reducedMotion: "reduce" });
      const still = await shape();
      expect(still.runs, "with motion off it stands still").toMatch(/^0\.001s$/);
      await shoot(page, "status-02-acting");

      // 3. The other two moments, in sessions of their own: thinking while the model has said half a reply, waiting
      // when only the agents go on. With the motion off the three markers still differ.
      const gate = join(ws, "release");
      const thinking = await made(request, "Thinking", ws);
      made_.push(thinking);
      await send(request, thinking, `script:hold ${gate}`);
      const waiting = await made(request, "Waiting", ws);
      made_.push(waiting);
      await send(request, waiting, `script:batch ${JSON.stringify([{ name: "spawn_agent", input: { message: `Slow\n${calls([{ name: "Bash", input: { command: "sleep 100" } }])}`, isolation: "none" } }])}`);
      const shapes: Record<string, string> = { acting: JSON.stringify(still.parts) };
      for (const [sid, moment] of [[thinking, "thinking"], [waiting, "waiting"]] as const) {
        await page.goto(`/s/${sid}`);
        await expect(page.getByTestId("dock-now")).toHaveAttribute("data-moment", moment, { timeout: 30_000 });
        await expect(page.getByTestId("dock-moment")).toHaveAttribute("aria-label", moment === "waiting" ? "Waiting" : "Working");
        shapes[moment] = JSON.stringify((await shape()).parts);
        await shoot(page, `status-03-${moment}`);
      }
      expect(new Set(Object.values(shapes)).size, "three shapes at rest").toBe(3);
      writeFileSync(gate, "go");
      await page.emulateMedia({ reducedMotion: "no-preference" });

      // 4. The clicks. The word Agents: the list of agents, each to open. An agent's name: that agent. The changes: the
      // Changes panel. The folder and the file the action names: the Files panel, the file open.
      await page.goto(`/s/${id}`);
      await expect(page.getByTestId("dock-agents")).toBeVisible({ timeout: 30_000 });
      await page.getByTestId("dock-agents").click();
      await expect(page.getByTestId("background-popup")).toBeVisible();
      await expect(page.getByTestId("bg-agent")).toHaveCount(2);
      await shoot(page, "status-04-agents");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("background-popup")).toHaveCount(0);
      // Each live agent is named over the box by its dot and title, and a press opens it.
      const named = page.getByTestId("dock-agent");
      await expect(named).toHaveCount(2);
      await expect(named.filter({ hasText: "Reader" }).locator(".k-mark")).toBeVisible();
      await expect(named.filter({ hasText: "Checker" })).toHaveAttribute("data-watch", "work");
      const kids = (await (await request.get(`/api/sessions/${id}/agents`)).json()).agents as { session_id: string; title?: string }[];
      await named.filter({ hasText: "Reader" }).click();
      await expect(page).toHaveURL(new RegExp(`/s/(${kids.map((k) => k.session_id).join("|")})$`));
      await expect(page).not.toHaveURL(new RegExp(`/s/${id}$`));
      await page.goto(`/s/${id}`);
      await expect(page.getByTestId("dock-action-path")).toHaveText("src/a.ts", { timeout: 30_000 });

      await page.getByTestId("dock-changes-open").click();
      await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "changes");
      await expect(page.getByTestId("changes-panel")).toBeVisible();
      await shoot(page, "status-05-changes");

      await page.getByTestId("dock-folder").click();
      await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "files");
      await expect(page.getByTestId("files-panel")).toBeVisible();
      await expect(page.getByTestId("file-view")).toHaveCount(0);

      await page.getByTestId("dock-action-path").click();
      await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "files");
      await expect(page.getByTestId("file-view")).toHaveAttribute("aria-label", "File src/a.ts");
      await shoot(page, "status-06-file");
      expect(await loops(), "the page reports no observer loop").toEqual([]);
    } finally {
      await stop(request, made_);
      for (const id of made_) await request.delete(`/api/sessions/${id}`).catch(() => {});
    }
  });

  test("a session at rest has no line over the box that the bar already says: no state word, no folder, no height", async ({ page, request }) => {
    const ws = folder("rest");
    const id = await made(request, "Rests with nothing changed", ws);
    try {
      await send(request, id, calls([{ name: "Read", input: { file_path: join(ws, "src/a.ts") } }]));
      await rested(request, id, 1);
      await page.setViewportSize({ width: 1920, height: 1040 });
      await page.goto(`/s/${id}`);
      const pane = page.locator(".k-station[data-helm]");
      // The bar says the state and the folder.
      await expect(pane.getByTestId("station-word")).toContainText("Done", { timeout: 30_000 });
      await expect(pane.locator(".k-station-where")).toBeVisible();
      // The line over the box says neither again, and with nothing else to say it is not drawn.
      await expect(pane.getByTestId("dock-action")).toHaveCount(0);
      await expect(pane.getByTestId("dock-folder")).toBeHidden();
      await expect(pane.getByTestId("dock-now")).toBeHidden();
      // (The block is loaded on its own: it is there, with nothing drawn, before it is measured.)
      await expect(pane.getByTestId("session-dock")).toBeAttached();
      const m = await measure(page);
      expect(m.dock!.height, "the block over the box takes no height").toBeLessThanOrEqual(1);
      await shoot(page, "status-07-rest-1920");
      // In a narrow pane the bar has no room for the folder: the line names it.
      await page.setViewportSize({ width: 480, height: 900 });
      await expect(pane.getByTestId("dock-folder")).toBeVisible();
      await expect(pane.getByTestId("dock-action")).toHaveCount(0);
      await shoot(page, "status-07-rest-480");
    } finally {
      await request.delete(`/api/sessions/${id}`).catch(() => {});
    }
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("the same two lines fold to what fits, with targets a finger can press", async ({ page, request }) => {
    const ids: string[] = [];
    const loops = watchLoops(page);
    try {
      const id = await busy(request, folder("status-phone"));
      ids.push(id);
      await page.goto(`/s/${id}`);
      // (On a phone every open session is a page of its own: this one is the pane at the helm.)
      const pane = page.locator(".k-station[data-helm]");
      await expect(pane.getByTestId("dock-agents")).toBeVisible({ timeout: 30_000 });
      await expect(pane.getByTestId("dock-changes-open")).toBeVisible({ timeout: 30_000 });
      await expect(pane.getByTestId("dock-action-path")).toBeVisible({ timeout: 30_000 });
      await expect.poll(async () => (await measure(page)).dock!.height, { message: "two lines" }).toBeLessThanOrEqual(2 * 3.4 * 16);
      const m: Seen = await measure(page);
      expect(m.kids).toEqual(["dock-top", "dock-now"]);
      // Nothing is cut: every part lies inside its line, and every button is a finger's size (2.75rem).
      expect(m.top.out).toEqual([]);
      expect(m.now.out).toEqual([]);
      expect(m.top.small).toEqual([]);
      expect(m.now.small).toEqual([]);
      expect(m.now.rect!.right).toBeLessThanOrEqual(390);
      await shoot(page, "status-07-phone");

      // The three clicks, by tap.
      await pane.getByTestId("dock-agents").tap();
      await expect(page.getByTestId("background-popup")).toBeVisible();
      await page.keyboard.press("Escape");
      await pane.getByTestId("dock-changes-open").tap();
      await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "changes");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("side-panel")).toHaveCount(0);
      await pane.getByTestId("dock-action-path").tap();
      await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "files");
      await expect(page.getByTestId("file-view")).toHaveAttribute("aria-label", "File src/a.ts");
      expect(await loops(), "the page reports no observer loop").toEqual([]);
    } finally {
      await stop(request, ids);
      for (const id of ids) await request.delete(`/api/sessions/${id}`).catch(() => {});
    }
  });
});
