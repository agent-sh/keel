import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { appendFileSync, mkdirSync } from "node:fs";
import { relative } from "node:path";

export const SHOTS = process.env.KEEL_SHOTS ?? `${process.env.HOME}/.cache/keel-work/bun/shots`;
mkdirSync(SHOTS, { recursive: true });

// A screenshot of the current page in light and dark. A run that names sizes (KEEL_SHOT_SIZES, such as
// "1920x1040,390x844": the before and after pictures of src/pictures) takes each at every size, the
// spec's own first, named <name>-<W>x<H>-<theme>.png, and gives the page its own size back after.
// KEEL_SHOT_THEMES ("light,dark") names the themes.
export async function shoot(page: Page, name: string) {
  const themes = (process.env.KEEL_SHOT_THEMES || "light,dark").split(",").filter((t): t is "light" | "dark" => t === "light" || t === "dark");
  const sizes = (process.env.KEEL_SHOT_SIZES ?? "").split(",").map((s) => /^(\d+)x(\d+)$/.exec(s.trim())).filter((m): m is RegExpExecArray => !!m).map((m) => ({ width: Number(m[1]), height: Number(m[2]) }));
  const was = page.viewportSize();
  const own = sizes.findIndex((s) => s.width === was?.width && s.height === was?.height);
  const order = own > 0 ? [sizes[own]!, ...sizes.filter((_, i) => i !== own)] : sizes;
  // (Two frames after a resize: the page has laid itself out at the new size.)
  const settled = () => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  for (const size of order.length ? order : [null]) {
    if (size && (size.width !== page.viewportSize()?.width || size.height !== page.viewportSize()?.height)) { await page.setViewportSize(size); await settled(); }
    for (const theme of themes) {
      await page.evaluate((t) => {
        document.documentElement.classList.add("theme-switch");
        document.documentElement.classList.toggle("dark", t === "dark");
      }, theme);
      await page.waitForTimeout(60);
      const file = `${name}${size ? `-${size.width}x${size.height}` : ""}-${theme}.png`;
      await page.screenshot({ path: `${SHOTS}/${file}` });
      // (Which spec took it: a pictures run takes the base again with only the specs whose pictures differ.)
      if (sizes.length) appendFileSync(`${SHOTS}/shots.tsv`, `${file}\t${relative(process.cwd(), test.info().file)}\n`);
    }
  }
  if (was && order.length && (was.width !== page.viewportSize()?.width || was.height !== page.viewportSize()?.height)) { await page.setViewportSize(was); await settled(); }
  await page.evaluate(() => document.documentElement.classList.remove("theme-switch"));
}

// The turns of the session open in the page that have ended, counted in the session's events. The
// transcript draws only the blocks near its view, so after a long reply the footers of the turns above
// it are not in the page and counting `turn-end` elements comes up short. Use this wherever a spec
// waits for a number of turns; check an element's own footer where the footer itself is the subject.
export const turnEnds = async (page: Page): Promise<number> => {
  // (By the page's own origin: a spec's daemon of its own is not the run's daemon.)
  const at = new URL(page.url());
  const events = (await (await page.request.get(`${at.origin}/api/sessions/${at.pathname.split("/").pop()}`)).json()).events as { kind: string }[];
  return events.filter((e) => e.kind === "turn_end").length;
};
export const endsAre = async (page: Page, n: number, timeout = 30_000, atLeast = false) => {
  // (`atLeast`: for a step after which the session goes on by itself, so the count may pass n between two looks.)
  if (atLeast) await expect.poll(() => turnEnds(page), { timeout }).toBeGreaterThanOrEqual(n);
  else await expect.poll(() => turnEnds(page), { timeout }).toBe(n);
  // The newest footer is always drawn: the page has caught up with the count.
  await expect(page.getByTestId("turn-end").last()).toBeVisible();
};

export const HAIKU = process.env.KEEL_TEST_MODEL ?? "bedrock:global.anthropic.claude-haiku-5-5";
// A spec written for a real model also runs on the scripted stand-in
// (KEEL_TEST_MODEL=scripted:stand-in): there it sends the `script:` words of
// src/providers/scripted.ts that make the stand-in do what the prompt asks a
// real model for.
export const SCRIPTED = HAIKU.startsWith("scripted:");
export const ask = (real: string, scripted: string) => (SCRIPTED ? scripted : real);
// Picks a model in the open page's model picker by its exact id (the run's model unless named).
export async function pickModel(page: Page, id = HAIKU) {
  await page.getByTestId("model-picker").click();
  await page.getByPlaceholder("Search models").fill(id);
  await page.locator('[data-group="exact"] [data-testid="model-option"]').click();
}
// The stand-in's words for "run this one shell command", made `afterMs` into the turn when given
// (a real model takes a moment before its first call; the stand-in makes it at once).
export const scriptBash = (command: string, afterMs?: number) => `script:calls ${JSON.stringify([{ name: "Bash", input: { command }, ...(afterMs ? { after_ms: afterMs } : {}) }])}`;

// Sets how many panes are open from the Arrange menu above the session list, where the choice is
// (the menu closes on the choice). The list must be open.
export async function setPanes(page: Page, n: number) {
  const item = page.getByTestId(`panes-${n}`);
  if (!(await item.isVisible())) await page.getByTestId("list-arrange").click();
  await item.click();
  await expect(page.getByTestId("arrange-menu")).toBeHidden();
}

// Opens a side panel of the session on screen from the Panels picker.
// Nothing happens when it is already open.
export async function openPanel(page: Page, id: string) {
  await page.getByTestId("panel-menu").waitFor();
  const side = page.getByTestId("side-panel");
  if ((await side.count()) && (await side.getAttribute("data-panel")) === id) return;
  await page.getByTestId("panel-menu").click();
  await page.getByTestId(`panel-pick-${id}`).click();
}

// Headers of a remote device: a proxy's forwarding header and the daemon's
// access token (read at the desk), so the request reaches the route as remote.
export async function remoteHeaders(request: APIRequestContext, base = ""): Promise<Record<string, string>> {
  const { path } = await (await request.get(`${base}/api/remote-access`)).json();
  return { "x-forwarded-for": "10.0.0.2", authorization: `Bearer ${new URL(path, "http://x").searchParams.get("token")}` };
}

// Customize > MCP servers with one server picked; its reader is the
// `mcp-server` element (data-name, data-state).
export async function openMcp(page: Page, name?: string) {
  if (!page.url().endsWith("/customize/mcp")) await page.goto("/customize/mcp");
  if (name) await page.locator(`[data-testid="mcp-entry"][data-name="${name}"]`).click();
  return page.locator(`[data-testid="mcp-server"]${name ? `[data-name="${name}"]` : ""}`);
}

// Picks an option of a select (components/Select.tsx) by its value, or by its
// label with `{ label }`.
export async function choose(select: Locator, pick: string | { label: string }) {
  await select.click();
  const list = select.page().getByRole("listbox");
  const option = typeof pick === "string" ? list.locator(`[role="option"][data-value=${JSON.stringify(pick)}]`) : list.getByRole("option", { name: pick.label, exact: true });
  await option.click();
  await list.waitFor({ state: "hidden" });
}

// Enters a group of controls the way the Tab key does: focus on whatever comes
// before it, then one Tab (a group that leads the page is entered from what
// follows it, with Shift Tab).
export async function tabInto(page: Page, group: Locator) {
  const back = await group.evaluate((g) => {
    const all = [...document.querySelectorAll<HTMLElement>("a[href], button, input, textarea, select, [tabindex]")].filter((el) => el.tabIndex >= 0 && !el.hasAttribute("disabled") && el.getClientRects().length > 0 && !g.contains(el));
    const before = all.filter((el) => g.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING).pop();
    (before ?? all[0]!).focus();
    return !before;
  });
  await page.keyboard.press(back ? "Shift+Tab" : "Tab");
}

// A tool of the session's header that rests in its one menu (the cost, background work, the machine,
// snooze, the features' actions): the menu is opened when the tool is not in view already.
export async function inHead(page: Page, id: string): Promise<Locator> {
  const tool = page.getByTestId(id);
  if (await tool.isVisible()) return tool;
  if (!(await page.getByTestId("header-more").isVisible())) await page.getByTestId("session-menu").first().click();
  await tool.waitFor({ state: "visible" });
  return tool;
}
// After a control opened from the session's menu was closed (Escape), the menu itself is closed too
// (a menu over the page takes every press outside it until it closes).
export async function leaveHead(page: Page) {
  const menu = page.getByTestId("header-more");
  for (let i = 0; i < 3 && (await menu.isVisible()); i++) await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
}

// The elements of a locator's subtree that scroll sideways inside their own box (a table wider than its
// box): a phone's page shows no figure behind a scroll bar.
export async function scrollsSideways(root: Locator): Promise<string[]> {
  return root.evaluate((el) => [el, ...el.querySelectorAll("*")].filter((e) => {
    const o = getComputedStyle(e).overflowX;
    return (o === "auto" || o === "scroll") && e.scrollWidth > e.clientWidth + 1;
  }).map((e) => `${e.tagName.toLowerCase()}.${e.className}`));
}
