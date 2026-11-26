import { expect, test, type Page } from "./isolate.ts";
import { rmSync } from "node:fs";
import { daemon, exited, seeded } from "./own-daemon.ts";
import { shoot } from "./shots.ts";

// Feature: the page's own Find in a conversation. The find key over the
// transcript opens a bar of the page's own (the browser's Find reaches only
// what is drawn): it counts every place of the branch shown that holds the
// text, a call folded in its closed card and a prompt older than the part the
// page holds and one far from the view included, and Enter and Shift+Enter go
// to each, opening the card, drawing the far row and reading the part around
// the old prompt. The key stays the field's in a
// text field that is not the conversation's.

const WORD = "quokkaroo";

// The words the current match marks, and how many matches are marked.
const marked = (page: Page) => page.evaluate(() => {
  const h = (CSS as any).highlights as Map<string, { values(): IterableIterator<Range>; size: number }>;
  const now = h.get("keel-find-now");
  return { now: now ? [...now.values()].map((r) => r.toString()).join("|") : "", all: h.get("keel-find")?.size ?? 0 };
});

test("the find bar counts every match of a conversation and goes to each, folded or not loaded", async ({ page }) => {
  // 300 events: the page opens with the newest 200; the word is in the second prompt, in a prompt half way down
  // that part, and in the output of a call near the end.
  const { state, ids: [id] } = seeded("find", 300, { shape: "turns", env: { KEEL_FIXTURE_FIND: WORD } }, "Find across a long conversation");
  const d = await daemon(state);
  try {
    const all = ((await (await fetch(`${d.url}/api/sessions/${id}/events`)).json()) as any).events as { id: string; kind: string; data: any }[];
    const [old, mid] = all.filter((e) => e.kind === "user" && String(e.data.text).includes(WORD));
    const result = all.find((e) => e.kind === "tool_result" && JSON.stringify(e.data).includes(WORD))!;
    const call = result.data.results[0].tool_use_id as string;
    expect(String(old!.data.text)).toMatch(/^Prompt 2:/);
    // (A store written before its daemon started is indexed once the start's own work is over.)
    await expect.poll(async () => ((await (await fetch(`${d.url}/api/search?q=${WORD}`)).json()) as any).hits.length, { timeout: 60_000 }).toBe(3);

    await page.goto(`${d.url}/s/${id}`);
    await expect(page.getByTestId("turn-end").last()).toBeInViewport({ timeout: 30_000 });
    // The old prompt is not loaded and the output is folded in its card; the prompt half way is loaded, far above the view.
    await expect(page.locator(`#e-${old!.id}`)).toHaveCount(0);
    await expect(page.locator(`#e-${mid!.id}`)).not.toBeInViewport();

    // A text field that is not the conversation's keeps the key.
    const kept = await page.evaluate(() => {
      const i = document.createElement("input");
      i.dataset.testid = "other-field";
      document.body.append(i);
      i.focus();
      let prevented: boolean | null = null;
      addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "f") prevented = e.defaultPrevented; }, { once: true });
      i.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
      i.remove();
      return prevented;
    });
    expect(kept).toBe(false);
    await expect(page.getByTestId("find-bar")).toHaveCount(0);

    // From the message box the key is the conversation's.
    await page.getByTestId("composer").focus();
    await page.keyboard.press("Control+f");
    await expect(page.getByTestId("find-input")).toBeFocused();
    await page.keyboard.type(WORD);
    // Three matches. None is under the view at the end, so the nearest above it is taken: the call's,
    // whose card opens, the match in view and marked.
    await expect(page.getByTestId("find-count")).toHaveText("3 of 3", { timeout: 15_000 });
    const card = page.locator(`[data-testid="tool-call"][data-call="${call}"]`).last();
    await expect(card).toHaveAttribute("data-open", "");
    await expect.poll(async () => (await marked(page)).now).toBe(WORD);
    await expect(card.getByText(WORD)).toBeInViewport();
    await expect(page.getByTestId("find-input")).toBeFocused();
    await shoot(page, "find-01-folded-call");

    // Enter: on round to the first, in the part not loaded. That part is read and the prompt is in view, marked.
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 3");
    await expect(page.locator(`#e-${old!.id}`)).toBeInViewport({ timeout: 30_000 });
    await expect.poll(async () => (await marked(page)).now).toBe(WORD);
    await expect(page.getByTestId("find-count")).toHaveText("1 of 3");
    await expect(page.getByTestId("find-input")).toBeFocused();
    await shoot(page, "find-02-not-loaded");

    // Enter: the prompt half way, drawn where it stands and marked.
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("find-count")).toHaveText("2 of 3");
    await expect(page.locator(`[data-testid="user-message"]#e-${mid!.id}`)).toBeInViewport({ timeout: 30_000 });
    await expect.poll(async () => (await marked(page)).now).toBe(WORD);

    // Enter again reaches the folded call from far away.
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("find-count")).toHaveText("3 of 3");
    await expect(card.getByText(WORD)).toBeInViewport({ timeout: 30_000 });

    // Reading elsewhere does not drop the current match. The middle row is redrawn as it comes
    // into view; back at the end, the matching call stays open and its text stays marked.
    const middle = page.locator(`#e-${mid!.id}`);
    await middle.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await expect(page.locator(`[data-testid="user-message"]#e-${mid!.id}`)).toBeInViewport();
    await expect(card).not.toBeInViewport();
    await expect(card).toHaveAttribute("data-open", "");
    await expect.poll(async () => (await marked(page)).now).toBe(WORD);

    // Shift+Enter back releases the call's block and reaches the middle prompt as a Find match.
    await page.keyboard.press("Shift+Enter");
    await expect(page.getByTestId("find-count")).toHaveText("2 of 3");
    await expect(page.locator(`[data-testid="user-message"]#e-${mid!.id}`)).toBeInViewport({ timeout: 30_000 });
    await expect(card).toHaveCount(0);

    // A text that is nowhere says so.
    await page.getByTestId("find-input").fill(`${WORD}zz`);
    await expect(page.getByTestId("find-count")).toHaveText("No matches", { timeout: 15_000 });
    await expect.poll(async () => (await marked(page)).now).toBe("");

    // Escape closes it, takes its marks away, and gives the keyboard back to the message box.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("find-bar")).toHaveCount(0);
    await expect(page.getByTestId("composer")).toBeFocused();
    expect(await marked(page)).toEqual({ now: "", all: 0 });

    // On a phone: the bar is the column's width, and it finds the same.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press("Control+f");
    await page.keyboard.type(WORD);
    await expect(page.getByTestId("find-count")).toHaveText(/of 3$/, { timeout: 15_000 });
    const bar = (await page.getByTestId("find-bar").boundingBox())!;
    expect(bar.x).toBeGreaterThanOrEqual(0);
    expect(bar.x + bar.width).toBeLessThanOrEqual(390);
    await shoot(page, "find-03-phone");
    await page.keyboard.press("Escape");
  } finally {
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    rmSync(state, { recursive: true, force: true });
  }
});
