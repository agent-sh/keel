import { expect, test, type APIRequestContext, type Locator, type Page } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openPanel, shoot } from "./shots.ts";

// Feature: one palette for a state, wherever it shows. A row's dot sets the hue (blue works, yellow needs you,
// red failed; done is the quiet grey, with no hue of its own) and the state's word, its card's edge, its band and its chips wear that hue: a "Needs
// you" in violet beside a yellow dot was the bug. Yellow is the light one, so its word and its marks are a darker
// amber of the same hue in the light theme (their contrast is checked in contrast.spec.ts). The spec opens each
// surface that shows a state (the list, a pane's head, the approval and question cards, the agents line, the work
// board, the tree review, the errors) and reads the hue each one paints against the dot's, in both themes. A
// run with KEEL_SHOT_SIZES takes its pictures at each size.
const STAND_IN = "scripted:stand-in";
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
const script = (calls: unknown[]) => `script:calls ${JSON.stringify(calls)}`;
const send = (request: APIRequestContext, id: string, text: string) => request.post(`/api/sessions/${id}/messages`, { data: { text } });
const row = (page: Page, id: string) => page.locator(`[data-testid="session-row"][data-session="${id}"]`);
const dark = (page: Page, on: boolean) => page.evaluate((d) => document.documentElement.classList.toggle("dark", d), on);

// The hue and the chroma (OKLCH) of what the browser paints for a color, from the pixel it draws.
// (A card's edge is the bar its shadow draws inside its left side: the shadow's color, the first thing the computed value names.)
async function look(page: Page, el: Locator, prop: "color" | "backgroundColor" | "boxShadow" = "color") {
  return el.evaluate((node, prop) => {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    const value = getComputedStyle(node)[prop];
    ctx.fillStyle = prop === "boxShadow" ? value.replace(/\s-?[\d.]+px\b.*$/, "") : value;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map((v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }) as [number, number, number];
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return { hue: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360, chroma: Math.hypot(a, bb) };
  }, prop);
}
// How far two hues are from each other on the wheel.
const apart = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
// A color that sits at the dot's hue: a hue within 15 degrees and a color, not a grey.
async function sameHue(page: Page, what: string, el: Locator, dot: { hue: number }, prop: "color" | "backgroundColor" | "boxShadow" = "color") {
  const got = await look(page, el, prop);
  expect(got.chroma, `${what} is a color`).toBeGreaterThan(0.04);
  expect(apart(got.hue, dot.hue), `${what}: hue ${Math.round(got.hue)} against the dot's ${Math.round(dot.hue)}`).toBeLessThan(15);
}

test("every surface that shows a state wears the hue of its dot, in both themes", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "requires the scripted provider");
  test.setTimeout(300_000);
  const top = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `palette-${Date.now().toString(36)}`);
  const repo = join(top, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "src/a.ts"), Array.from({ length: 6 }, (_, i) => `export const a${i + 1} = ${i + 1};`).join("\n") + "\n");
  writeFileSync(join(repo, "b.md"), "# b\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  const gate = join(top, "gamma-may-end");
  const made: string[] = [];
  const mk = async (title: string, mode = "full-auto", workspace = repo) => {
    const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title, workspace } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode, sandbox: "off" } });
    made.push(session.id);
    return session.id as string;
  };
  const turned = (id: string) => expect.poll(async () => ((await (await request.get(`/api/sessions/${id}`)).json()).events as { kind: string }[]).some((e) => e.kind === "turn_end"), { timeout: 60_000 }).toBe(true);
  try {
    const asking = await mk("Palette: asks", "ask");
    const questioning = await mk("Palette: asks a question");
    const working = await mk("Palette: at work");
    const failed = await mk("Palette: failed");
    const done = await mk("Palette: done");
    const lead = await mk("Palette: coordinator");
    await send(request, asking, script([{ name: "Bash", input: { command: "echo palette > palette.txt" } }]));
    await send(request, questioning, script([{ name: "AskUserQuestion", input: { questions: [{ header: "Color", question: "Which color should I use?", options: [{ label: "Teal" }, { label: "Amber" }], multiSelect: false }] } }]));
    await send(request, working, script([{ name: "Bash", input: { command: "sleep 120; echo worked" } }]));
    await send(request, failed, "script:billing");
    await send(request, done, "script:say Done.");
    // The coordinator's agents: two leave a branch and end, one keeps working until the spec lets it end.
    const commit = (msg: string) => `git add -A && git -c user.name=k -c user.email=k@k commit -qm '${msg}'`;
    const lane = (title: string, steps: unknown[]) => ({ name: "spawn_agent", input: { message: `${title}\n${script(steps)}` } });
    await send(request, lead, `script:batch ${JSON.stringify([
      lane("Lane alpha", [{ name: "Bash", input: { command: `sed -i 's/a3 = 3/a3 = 30/' src/a.ts && ${commit("Lane alpha")}` } }]),
      lane("Lane beta", [{ name: "Bash", input: { command: `sed -i 's/a3 = 3/a3 = 300/' src/a.ts && ${commit("Lane beta")}` } }]),
      lane("Lane gamma", [{ name: "Bash", input: { command: `sed -i 's/a5 = 5/a5 = 50/' src/a.ts && ${commit("Lane gamma")} && while [ ! -e '${gate}' ]; do sleep 0.2; done`, timeout: 600_000 } }]),
    ])}`);
    for (const id of [failed, done]) await turned(id);
    const agents = async () => (await (await request.get(`/api/sessions/${lead}/agents`)).json()).agents as { status: string; branch?: string }[];
    await expect.poll(async () => (await agents()).filter((a) => a.status === "completed" && a.branch).length, { timeout: 90_000 }).toBe(2);
    await expect.poll(async () => (await agents()).some((a) => a.status === "running" && a.branch), { timeout: 60_000 }).toBe(true);
    await expect.poll(async () => { const st = (await (await request.get("/api/state")).json()).states ?? {}; return [asking, questioning, working, failed, done].map((id) => st[id]?.watch).join(" "); }, { timeout: 60_000 }).toBe("need need work fail done");

    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`/s/${asking}`);
    await expect(page.getByTestId("approval")).toBeVisible({ timeout: 30_000 });

    // The dots set the hues. Each state's word in its pane's head, and in its row, is that hue; so is the card of what needs the owner.
    for (const theme of [false, true]) {
      await dark(page, theme);
      const dots: Record<string, { hue: number; chroma?: number }> = {};
      for (const [id, watch] of [[asking, "need"], [working, "work"], [failed, "fail"], [done, "done"]] as const) {
        await page.goto(`/s/${id}`);
        const dot = row(page, id).locator(".k-mark");
        await expect(dot).toHaveAttribute("data-watch", watch, { timeout: 30_000 });
        await dark(page, theme);
        dots[watch] = await look(page, dot, "backgroundColor");
        const word = page.getByTestId("station-word").first();
        await expect(word).toBeVisible();
        const where = `${theme ? "dark" : "light"} ${watch}`;
        // Done is quiet: a muted grey dot and a muted word, colour being for what needs the owner, failed and at work.
        if (watch === "done") {
          expect((dots.done as { chroma?: number }).chroma, `${where}: the dot is a grey`).toBeLessThan(0.04);
          expect((await look(page, word)).chroma, `${where}: the word is a grey`).toBeLessThan(0.04);
        } else await sameHue(page, `${where}: the pane head's word`, word, dots[watch]!);
        // (A list row's word is quiet: only what needs the owner keeps its ink.)
        if (watch === "need") await sameHue(page, `${where}: the row's word`, row(page, id).getByTestId("row-state"), dots.need!);
        if (watch === "need") {
          await sameHue(page, `${where}: the approval card's edge`, page.getByTestId("approval"), dots.need!, "boxShadow");
          // (The pane's band says no state since UX-S113: the glyph and the word say it once.)
        }
      }
      // The question card is the same yellow.
      await page.goto(`/s/${questioning}`);
      await expect(page.getByTestId("question")).toBeVisible({ timeout: 30_000 });
      await dark(page, theme);
      await sameHue(page, `${theme ? "dark" : "light"} the question card's edge`, page.getByTestId("question"), dots.need!, "boxShadow");
    }
    await dark(page, false);

    // Pictures of each surface.
    await page.goto("/");
    await expect(row(page, asking).locator(".k-mark")).toHaveAttribute("data-watch", "need", { timeout: 30_000 });
    await shoot(page, "state-palette-01-list");
    await page.goto(`/s/${asking}`);
    await expect(page.getByTestId("approval")).toBeVisible();
    await shoot(page, "state-palette-02-needs-you");
    await page.goto(`/s/${questioning}`);
    await expect(page.getByTestId("question")).toBeVisible();
    await shoot(page, "state-palette-03-question");
    await page.goto(`/s/${working}`);
    await expect(page.getByTestId("station-word").first()).toBeVisible();
    await shoot(page, "state-palette-04-working");
    await page.goto(`/s/${failed}`);
    await expect(page.getByTestId("station-word").first()).toBeVisible();
    await shoot(page, "state-palette-05-failed");
    await page.goto(`/s/${done}`);
    await expect(page.getByTestId("station-word").first()).toBeVisible();
    await shoot(page, "state-palette-06-done");
    await page.goto(`/s/${lead}`);
    const line = page.getByTestId("dock-agents");
    await expect(line).toBeVisible({ timeout: 30_000 });
    await shoot(page, "state-palette-07-agents-line");
    await line.click();
    await expect(page.getByTestId("background-popup")).toBeVisible();
    await shoot(page, "state-palette-08-agents-open");
    await page.keyboard.press("Escape");
    await openPanel(page, "board");
    await expect(page.getByTestId("board-review-tree")).toBeVisible({ timeout: 30_000 });
    await shoot(page, "state-palette-09-board");
    await page.getByTestId("board-review-tree").click();
    await expect(page.getByTestId("tree-review")).toBeVisible();
    await shoot(page, "state-palette-10-tree-review");
    await page.keyboard.press("Escape");
    await request.post("/api/errors", { data: { message: `palette failure ${Date.now().toString(36)}: request timed out`, context: { url: `/s/${lead}` } } });
    await page.goto("/");
    await page.getByTestId("errors-button").click();
    await expect(page.getByTestId("errors-panel")).toBeVisible();
    await shoot(page, "state-palette-11-errors");
  } finally {
    writeFileSync(gate, "go\n");
    for (const id of made) await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }).catch(() => {});
    for (const id of made) await request.delete(`/api/sessions/${id}`).catch(() => {});
  }
});
