import { expect, test, type Page } from "./isolate.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { shoot } from "./shots.ts";

// Feature: the session list squeezed. Its edge drags from the default width
// down to the narrowest (14.5rem), and at every width on the way, at every
// text size, nothing leaves the bar, nothing is cut without an ellipsis, no
// word runs under another or onto a second line, and rows of a kind are
// equally high. What says least gives way first: the shortcut hints, the
// brand's name, the Settings word, a row's tag. The rows are real ones: a
// session that needs the owner with a long reason, a parent at work with two
// agents, a failed one with its class, one waiting on a timer, a pinned and
// tagged one, a folder with more sessions than it shows, a first message that
// did not go, unread failures. The scripted stand-in makes the states. A row
// is one line by default; the same holds with two lines a row (the choice in
// the Arrange menu), where the reason is always on the row, cut, not dropped.
const STAND_IN = "scripted:stand-in";
const script = (calls: unknown[]) => `script:calls ${JSON.stringify(calls)}`;

// Runs in the page: what does not fit in the rail now.
function audit() {
  const rail = document.querySelector<HTMLElement>(".k-rail")!;
  const R = rail.getBoundingClientRect();
  const issues: string[] = [];
  const name = (el: Element) => `${el.tagName.toLowerCase()}${el.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : ""}${typeof el.className === "string" ? el.className.split(/\s+/).filter((c) => c.startsWith("k-")).slice(0, 2).map((c) => `.${c}`).join("") : ""}`;
  const where = (el: Element) => { const row = el.closest('[data-testid="session-row"]'); return row ? ` in the row "${(row.querySelector(".k-row-title")?.textContent ?? "").slice(0, 24)}"` : ""; };
  // The folded rail's mark for a kept first message is a dot: its word is for a screen reader.
  // Its count of failures is a badge on the glyph's corner there.
  const shown = (el: Element) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0.5 && r.height > 0.5 && cs.visibility !== "hidden" && !el.closest(".sr-only, .k-rail-card, .k-rail-grip") && !(el.matches(".k-act-mark, .k-act-n") && !rail.hasAttribute("data-open")); };
  // What of an element is painted: its box inside every clipping ancestor up to the rail.
  const painted = (el: Element) => {
    const r = el.getBoundingClientRect();
    const box = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    for (let a = el.parentElement; a && a !== rail.parentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      const ar = a.getBoundingClientRect();
      if (s.overflowX !== "visible") { box.left = Math.max(box.left, ar.left); box.right = Math.min(box.right, ar.right); }
      if (s.overflowY !== "visible") { box.top = Math.max(box.top, ar.top); box.bottom = Math.min(box.bottom, ar.bottom); }
    }
    return box;
  };
  for (const el of [rail, ...rail.querySelectorAll<HTMLElement>("*")].filter(shown)) {
    const cs = getComputedStyle(el);
    const over = el.scrollWidth - el.clientWidth;
    if (over > 1 && cs.overflowX !== "visible" && cs.textOverflow !== "ellipsis") issues.push(`cut without an ellipsis: ${name(el)}${where(el)} holds ${over}px more than it shows`);
    const p = painted(el);
    if (p.right - p.left > 0.5 && (p.right > R.right + 0.75 || p.left < R.left - 0.75)) issues.push(`leaves the bar: ${name(el)}${where(el)} by ${Math.max(p.right - R.right, R.left - p.left).toFixed(1)}px`);
  }
  // Words on more than one line (a sentence that says the list is empty may wrap).
  const walker = document.createTreeWalker(rail, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement!;
    if (!n.textContent?.trim() || !shown(el) || el.closest(".k-empty")) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0.5).map((r) => Math.round(r.top)));
    if (tops.size > 1) issues.push(`wraps onto ${tops.size} lines: ${name(el)}${where(el)} "${n.textContent.trim().slice(0, 30)}"`);
  }
  // Parts over each other, inside each row and each bar.
  const groups = [...rail.querySelectorAll<HTMLElement>('.k-row, .k-rail-brand, .k-rail-foot, .k-rail-acts .k-act, .k-find, .k-group-head, .k-machine-sep, .k-session-children > button, .k-child-session, [data-testid="tag-filter"], .k-tick, .k-marks-head, .k-more, [role="tablist"]')].filter(shown);
  for (const g of groups) {
    const atoms = [...g.querySelectorAll<HTMLElement>("*")].filter((el) => shown(el) && (el.tagName.toLowerCase() === "svg" ? !el.parentElement!.closest("svg") : !el.closest("svg") && (el.classList.contains("k-mark") || [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent!.trim()))));
    const boxes = atoms.map((el) => ({ el, b: painted(el) })).filter((x) => x.b.right - x.b.left > 0.5 && x.b.bottom - x.b.top > 0.5);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, b = boxes[j]!;
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const ox = Math.min(a.b.right, b.b.right) - Math.max(a.b.left, b.b.left), oy = Math.min(a.b.bottom, b.b.bottom) - Math.max(a.b.top, b.b.top);
      if (ox > 1 && oy > 1) issues.push(`${name(a.el)} lies ${ox.toFixed(1)}px over ${name(b.el)}${where(a.el)} in ${name(g)}`);
    }
  }
  // Rows of a kind are equally high, and a title keeps at least four rem of a row.
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const heights: Record<string, Set<number>> = {};
  for (const r of [...rail.querySelectorAll<HTMLElement>(".k-row")].filter(shown)) {
    (heights[r.querySelector(".k-row-sub") ? "two-line" : "one-line"] ??= new Set()).add(Math.round(r.getBoundingClientRect().height));
    const t = r.querySelector<HTMLElement>(".k-row-title")!;
    const p = painted(t);
    if (t.scrollWidth > t.clientWidth + 1 && p.right - p.left < 4 * rem) issues.push(`a title cut to ${Math.round(p.right - p.left)}px${where(t)}`);
  }
  for (const [k, set] of Object.entries(heights)) if (set.size > 1) issues.push(`${k} rows of uneven height: ${[...set].join(", ")}px`);
  return { width: R.width, rem, open: rail.hasAttribute("data-open"), issues: [...new Set(issues)] };
}

test("the session list fits at every width its edge can be dragged to", async ({ page, request }) => {
  test.skip(!((await (await request.get("/api/models")).json()).models as { id: string }[]).some((m) => m.id === STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  await page.setViewportSize({ width: 1920, height: 1040 });
  const tag = Date.now().toString(36);
  const root = `${process.env.HOME}/.cache/keel-work/bun/e2e-ws/squeeze-${tag}`;
  const dirs = [`${root}/a-long-folder-name-for-the-billing-service-migration`, `${root}/alpha/api`, `${root}/beta/api`];
  for (const d of dirs) mkdirSync(d, { recursive: true });
  const gate = `${root}/go`;
  const made: string[] = [];
  const mk = async (title: string, workspace: string, mode = "full-auto") => {
    const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title, workspace } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode } });
    made.push(session.id);
    return session.id as string;
  };
  const send = (id: string, text: string) => request.post(`/api/sessions/${id}/messages`, { data: { text } });
  try {
    const need = await mk("Rewrite the uploader so a cut connection resumes from the last chunk it sent", dirs[0]!, "ask");
    await send(need, script([{ name: "Bash", input: { command: "rsync -av --delete ./build/ deploy@staging:/srv/app/releases/current/ && systemctl restart app" } }]));
    const work = await mk("Parent that waits on the two agents it started for the review", dirs[0]!);
    const helper = (n: number) => `Helper ${n}\n${script([{ name: "Bash", input: { command: `until [ -f ${gate} ]; do sleep 0.2; done; echo released` } }])}`;
    await send(work, script([{ name: "spawn_agent", input: { message: helper(1), isolation: "none" } }, { name: "spawn_agent", input: { message: helper(2), isolation: "none" } }]));
    const fail = await mk("Bill the account for the month and email the receipt to finance", dirs[1]!);
    await send(fail, "script:billing");
    const wait = await mk("Check the deploy in a quarter of an hour and report back", dirs[1]!);
    await send(wait, script([{ name: "wait_for", input: { kind: "timer", seconds: 900, note: "check the deploy and the error rate on the canary" } }]));
    const pinned = await mk("Pinned: the release checklist for the next version", dirs[2]!);
    await request.patch(`/api/sessions/${pinned}`, { data: { pinned: true, tags: ["release-blocker", "infra"] } });
    const tagged = await mk("Tagged session with a long title and a tag beside it", dirs[2]!);
    await request.patch(`/api/sessions/${tagged}`, { data: { tags: ["customer-escalation"] } });
    for (let i = 0; i < 8; i++) await mk(`Idle session number ${i} about a thing that was done a while ago`, dirs[0]!);
    for (const word of ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"]) await request.post("/api/errors", { data: { message: `squeeze ${tag}: the ${word} request timed out`, context: {} } });
    const state = async (id: string) => ((await (await request.get("/api/state")).json()).states ?? {})[id]?.watch as string | undefined;
    await expect.poll(() => state(need), { timeout: 30_000 }).toBe("need");
    await expect.poll(() => state(fail), { timeout: 30_000 }).toBe("fail");
    await expect.poll(() => state(wait), { timeout: 30_000 }).toBe("wait");
    await expect.poll(async () => ((await (await request.get(`/api/sessions/${work}/agents`)).json()).agents as { status: string }[]).filter((a) => a.status === "running").length, { timeout: 30_000 }).toBe(2);

    // A first message that did not go waits in the New box: the New session button says so.
    await page.addInitScript(() => localStorage.setItem("keel.sends.new", JSON.stringify([{ id: "squeeze-1", text: "A first message that did not go", images: [], queue: false, state: "refused", error: "The daemon refused it." }])));
    const side = page.getByTestId("sidebar");
    const row = (id: string) => page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`);
    const grip = page.getByTestId("list-grip");
    const check = async (what: string) => {
      const a = await page.evaluate(audit);
      expect.soft(a.issues, `${what}, the list ${Math.round(a.width)}px wide (${(a.width / a.rem).toFixed(2)}rem)`).toEqual([]);
      return a;
    };

    for (const [scale, lines] of [[1, "one"], [1.5, "one"], [0.9, "one"], [1, "two"], [1.5, "two"]] as const) {
      // The session on screen has no request waiting (a request's card takes the keyboard from an empty message box).
      await page.goto(`/s/${wait}`);
      await page.evaluate(([s, l]) => { localStorage.setItem("keel.textScale", JSON.stringify(s)); localStorage.removeItem("keel.listW"); localStorage.setItem("keel.listArrange", JSON.stringify({ group: "folder", sort: "created", hideDone: false, lines: l, v: 2 })); }, [scale, lines] as const);
      await page.reload();
      await expect(page.getByTestId("session-list")).toHaveAttribute("data-lines", lines);
      await expect(side).toHaveAttribute("data-open", "true");
      await expect(row(need).getByTestId("row-state")).toHaveText("Needs you");
      await expect(row(work).getByTestId("row-state")).toHaveText(lines === "one" ? "Working" : "Working · 2 agents");
      await expect(row(fail).getByTestId("row-class")).toBeVisible();
      await expect(row(wait).getByTestId("row-time")).toContainText("in ");
      await expect(page.getByTestId("new-unsent-mark")).toHaveText("not sent");
      await expect(page.getByTestId("errors-button")).toContainText(/\d/);
      const first = await check(`text size ${scale}, ${lines} line a row, the default width`);
      expect(first.width / first.rem).toBeCloseTo(18.75, 1);
      if (scale === 1) await shoot(page, lines === "one" ? "rail-squeeze-01-default" : "rail-squeeze-04-two-lines");

      // The page has settled once its message box has the keyboard: it takes it by itself as the
      // page loads, and never from a control focused after that (lib/self-focus.ts).
      await expect(page.getByTestId("composer")).toBeFocused();
      // The edge, a step at a time with the keys the separator takes, down to the narrowest (14.5rem).
      await grip.focus();
      let last = first.width;
      const width = () => side.evaluate((el) => el.getBoundingClientRect().width);
      for (let i = 0; last > 14.5 * first.rem + 1; i++) {
        expect(i, "the edge is at its narrowest within a dozen steps").toBeLessThan(12);
        await page.keyboard.press("ArrowLeft");
        const was = last;
        // A step that does nothing fails here, with where the keyboard is.
        if (!(await expect.poll(width, { timeout: 2000 }).toBeLessThan(was).then(() => true, () => false))) {
          const on = await page.evaluate(() => { const a = document.activeElement; return a && a !== document.body ? `${a.tagName.toLowerCase()}[${a.getAttribute("data-testid") ?? a.getAttribute("aria-label") ?? ""}]` : "nothing"; });
          throw new Error(`Step ${i + 1} to the left did nothing at text size ${scale}: the list is still ${Math.round(was)}px wide and the keyboard is on ${on}, not on the separator.`);
        }
        last = (await check(`text size ${scale}, ${lines} line a row, step ${i + 1} to the left`)).width;
      }
      expect(last / first.rem, "the narrowest the edge goes").toBeCloseTo(14.5, 1);
      // Every state is still on its row: the mark, the title, the time. With two lines a row the
      // state word and the reason are too: the reason is cut, not dropped.
      await expect(row(need).locator(".k-mark")).toBeVisible();
      await expect(row(wait).getByTestId("row-time")).toBeVisible();
      if (lines === "two") {
        for (const part of [row(need).getByTestId("row-state"), row(need).getByTestId("row-why"), row(fail).getByTestId("row-class")]) await expect(part).toBeVisible();
        expect(await row(need).getByTestId("row-why").evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(3 * first.rem);
      }
      await expect(page.getByTestId("rail-toggle")).toBeInViewport({ ratio: 1 });
      await expect(page.getByTestId("theme-toggle")).toBeInViewport({ ratio: 1 });
      // The foot is one row: Settings as its glyph, the counts whole, the theme at the right edge.
      const tops = await page.evaluate(() => ["settings-button", "errors-button", "inbox-button", "loops-button", "theme-toggle"].map((t) => Math.round(document.querySelector(`[data-testid="${t}"]`)!.getBoundingClientRect().top + document.querySelector(`[data-testid="${t}"]`)!.getBoundingClientRect().height / 2)));
      expect(Math.max(...tops) - Math.min(...tops), "the foot's buttons share a row").toBeLessThanOrEqual(1);
      // The row under the pointer shows its actions in the time's place: still inside the bar.
      await row(need).hover();
      await check(`text size ${scale}, ${lines} line a row, the narrowest, a row under the pointer`);
      await page.mouse.move(960, 500);
      if (scale !== 0.9 && lines === "one") await shoot(page, `rail-squeeze-0${scale === 1 ? 2 : 3}-narrowest${scale === 1 ? "" : "-large-text"}`);

      // Dragged with the pointer to the middle of its range: the same holds.
      const b = (await grip.boundingBox())!;
      await page.mouse.move(b.x + b.width / 2, 520);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2 + 2 * first.rem, 520, { steps: 4 });
      await page.mouse.up();
      const mid = await check(`text size ${scale}, ${lines} line a row, dragged two rem wider`);
      expect(mid.width / mid.rem).toBeCloseTo(16.5, 1);
    }

    // Folded by choice: the marks alone, nothing outside the column.
    await page.keyboard.press("Control+b");
    await expect(side).not.toHaveAttribute("data-open", "true");
    await check("folded to its marks");
    await page.keyboard.press("Control+b");
    await expect(side).toHaveAttribute("data-open", "true");
  } finally {
    writeFileSync(gate, "");
    await page.evaluate(() => { localStorage.removeItem("keel.textScale"); localStorage.removeItem("keel.listW"); localStorage.removeItem("keel.listArrange"); }).catch(() => {});
    for (const id of made) { await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }).catch(() => {}); await request.delete(`/api/sessions/${id}`).catch(() => {}); }
    // The failures this spec posted for the count are its own: put the list back.
    const mine = ((await (await request.get("/api/errors")).json()).errors as { id: string; message: string }[]).filter((e) => e.message.startsWith(`squeeze ${tag}`));
    for (const e of mine) await request.patch(`/api/errors/${e.id}`, { data: { resolved: true } }).catch(() => {});
  }
});
