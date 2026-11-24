import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Locator, type Page } from "./isolate.ts";
import { calls, colors, create, folder, pending } from "./answering.ts";
import { inHead, leaveHead, shoot } from "./shots.ts";

// Feature: the surfaces that landed after the phone page was last checked fit a phone and are
// reached by a finger: the session menu's rows and what opens from them, the dollar cap, the
// list's rows, Settings > Telemetry and the work board. At 390x844 and 412x915: no sideways
// scroll, nothing past the page's edge, a target at least 2.75rem, no control that waits for a
// hover, and a popup opened from the menu stands over the menu.
const STAND_IN = "scripted:stand-in";
const SIZES = [{ width: 390, height: 844 }, { width: 412, height: 915 }];

async function scripted(request: APIRequestContext) {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  return models.some((m) => m.id === STAND_IN);
}
async function start(request: APIRequestContext, title: string, opts: { mode?: string; cap?: number } = {}) {
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: opts.mode ?? "full-auto", sandbox: "off" } });
  if (opts.cap) await request.put(`/api/sessions/${session.id}/cap`, { data: { usd: opts.cap } });
  return session.id as string;
}
const idle = async (request: APIRequestContext, id: string) => { const d = await (await request.get(`/api/sessions/${id}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; };
const drop = async (request: APIRequestContext, ...ids: string[]) => {
  for (const id of ids) { await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }).catch(() => {}); await request.delete(`/api/sessions/${id}`).catch(() => {}); }
};
// Whether what is at the middle of the box's first line is the box (or part of it), not something over it.
const onTop = (box: Locator) => box.evaluate((el) => {
  const r = el.getBoundingClientRect();
  const at = document.elementFromPoint(r.x + r.width / 2, r.y + Math.min(r.height - 2, 24));
  return !!at && el.contains(at);
});
const noSideScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
// What a finger presses in the box and is under 2.75rem each way.
const small = (box: Locator) => box.evaluate((el) => {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const out: string[] = [];
  for (const c of el.querySelectorAll<HTMLElement>("button, [role=button], a[href], input, select, textarea, summary")) {
    const r = c.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.height < 2.75 * rem - 1 || r.width < 2.75 * rem - 1) out.push(`${c.dataset.testid ?? c.tagName} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  return out;
});
const inside = async (page: Page, box: Locator) => {
  const b = (await box.boundingBox())!, w = page.viewportSize()!;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(w.width);
  expect(b.y + b.height).toBeLessThanOrEqual(w.height);
};

for (const size of SIZES) {
  test.describe(`on a phone, ${size.width}x${size.height}`, () => {
    test.use({ viewport: size, hasTouch: true, isMobile: true });

    test("the background list opens over the session menu", async ({ page, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      const id = await start(request, "Phone background");
      try {
        const task = `Watch CI on main\nscript:calls ${JSON.stringify([{ name: "wait_for", input: { kind: "timer", seconds: 3600, note: "CI on main turns green" } }])}`;
        await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:batch ${JSON.stringify([{ name: "spawn_agent", input: { message: task, isolation: "none" } }])}` } });
        await expect.poll(async () => ((await (await request.get(`/api/sessions/${id}/agents`)).json()).agents as unknown[]).length, { timeout: 60_000 }).toBe(1);
        await expect.poll(() => idle(request, id), { timeout: 60_000 }).toBe(true);
        await page.goto(`/s/${id}`);
        const button = await inHead(page, "background-button");
        await button.tap();
        const popup = page.getByTestId("background-popup");
        await expect(popup.getByTestId("bg-agent")).toHaveCount(1);
        // The menu is open under it: the list is what a finger reaches, whole, inside the page.
        expect(await onTop(popup), "the list is over the menu").toBe(true);
        await inside(page, popup);
        expect(await small(popup), "every control of the list is a finger's target").toEqual([]);
        await shoot(page, `phone-surfaces-01-background-${size.width}`);
        await popup.getByTestId("bg-agent-open").first().tap();
        await expect(page.locator(".k-station[data-helm]")).not.toHaveAttribute("data-station", id);
      } finally {
        await drop(request, id);
      }
    });
    test("Settings > Telemetry names each control whole and in a line of its own", async ({ page }) => {
      // Two controls whose names are alike to the 14th character and long, as the menu's actions are.
      const names = ["header-action-export-to-another-machine", "header-action-voice-dictation-and-reading", "snooze-button"];
      const now = Date.now();
      const report = {
        record: true, since_ms: now - 30 * 864e5, days: 30, presses: 9, first_ms: now - 864e5, rows: 9, row_cap: 50_000, kept_days: 90,
        views: [{ view: "session", presses: 9, controls: names.map((control, i) => ({ control, presses: 5 - i * 2 + 1, last_ms: now - i * 6e4, surfaces: "phone" })) }],
        never: names.map((control) => ({ control, views: "session,project", seen_since_ms: now - 864e5 })),
      };
      await page.route("**/api/presses?*", (route) => route.fulfill({ json: report }));
      await page.goto("/settings/telemetry");
      const panel = page.getByTestId("telemetry-panel");
      await expect(panel.getByTestId("press-never-row")).toHaveCount(3);
      await page.getByTestId("settings-scroll").evaluate((el) => { el.scrollTop = el.scrollHeight; });
      // Every name is there whole: not cut at the column's edge, so two controls are never one name.
      const cut = await panel.locator("li span.font-mono").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth || getComputedStyle(e).textOverflow === "ellipsis").map((e) => e.textContent));
      expect(cut, "names cut off").toEqual([]);
      for (const row of await panel.getByTestId("press-never-row").all()) {
        const name = (await row.locator("span.font-mono").first().boundingBox())!, seen = (await row.getByText(/^seen since/).boundingBox())!;
        expect(name.y + name.height, "the date is under the name").toBeLessThanOrEqual(seen.y + 1);
      }
      await noSideScroll(page);
      await shoot(page, `phone-surfaces-02-telemetry-${size.width}`);
    });
    test("the work board's facts and a reviewer's words are whole on a card", async ({ page, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      const id = await start(request, "Phone board");
      try {
        const head = "b3166396dd37cfd55fb0fd54b7bafd8f0457e17c";
        const review = (verdict: string, extra: Record<string, unknown> = {}) => ({ by: "222222222222", title: "Reviewer of the second lane", how: "verdict", state: "completed", verdict, source: "verdict", line: "LAND: no, it breaks the build of the other lane", tip: head, of: head, current: true, at: Date.now(), ...extra });
        const row = (n: number, extra: Record<string, unknown>) => ({
          id: `${n}`.repeat(12), session_id: `s-${n}`, parent_id: id, depth: 1, title: `Lane ${n}`, type: "general-purpose", model: STAND_IN, state: "completed", created: Date.now(), ended: Date.now(), machine: null,
          branch: `keel/lane-${n}`, repo: "/r", base: "main", head, ahead: 1, behind: 0, worktree: "here",
          checks: { state: "known", passed: ["notes"], failed: [], notRun: [] }, reviews: [], queue: null, live: null, work: null,
          landed: { state: "no", missing: 1 }, review: null, ...extra,
        });
        const rows = [
          row(1, { review: review("approved") }),
          row(2, { parent_id: "s-1", depth: 2, review: review("stale", { of: "1234567890abcdef" }) }),
          // Three cards in, where the card is narrowest.
          row(3, { parent_id: "s-2", depth: 3, review: review("refused", { current: false, was: "approved" }) }),
        ];
        await page.route(`**/api/sessions/${id}/board*`, (route) => route.fulfill({ json: { session_id: id, rows, total: rows.length, repos: [{ repo: "/r", base: "main", base_tip: head, deploys: [] }], at: Date.now(), took_ms: 3 } }));
        await page.goto(`/s/${id}`);
        await page.getByTestId("panel-menu").first().tap();
        await page.getByTestId("panel-pick-board").tap();
        const board = page.getByTestId("work-board");
        await expect(board.getByTestId("board-row")).toHaveCount(3);
        // Each fact says all it knows: "older head" and the commit a stale verdict spoke of are not cut off.
        await expect(board.getByTestId("board-review").filter({ hasText: "refused" })).toContainText("older head");
        const values = board.locator('[data-testid^="board-"] > span:nth-child(2) > span:last-child');
        await expect(values).toHaveCount(12);
        const cut = await values.evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth).map((e) => e.textContent));
        expect(cut, "facts cut off").toEqual([]);
        for (const fact of await board.getByTestId("board-review").all()) expect((await fact.boundingBox())!.x + (await fact.boundingBox())!.width, "a fact stays inside the page").toBeLessThanOrEqual(size.width);
        // The reviewer's name under a card reads from the card's edge like the words under it.
        const name = board.getByTestId("board-reviewer").first().locator("button");
        await expect(name).toBeVisible();
        expect(await name.evaluate((el) => getComputedStyle(el).textAlign)).toMatch(/^(left|start)$/);
        await noSideScroll(page);
        expect(await small(board), "every control of the board is a finger's target").toEqual([]);
        await shoot(page, `phone-surfaces-03-board-${size.width}`);
      } finally {
        await drop(request, id);
      }
    });
    test("Settings > Lessons reads from the page's edge: its note over its controls, a long repository name inside the card", async ({ page, request }) => {
      const now = Date.now();
      const name = "a-repository-whose-folder-has-a-very-long-name-for-a-phone";
      const lesson = {
        id: "l-1", repo: `/work/${name}`, repo_name: name, key: "tool:Bash:x", source: "tool", label: "Bash", words: null, state: "proposed",
        text: "Before you run a command here, check it cannot fail like this: ls: cannot access './missing-input-3.txt'", drafted_by: STAND_IN, why_none: null,
        evidence: { key: "tool:Bash:x", source: "tool", label: "Bash", repo: `/work/${name}`, repo_name: name, failures: 3, sessions: 3, trees: 3, first_ts: now - 6e4, last_ts: now, examples: ["ls: cannot access './missing-input-3.txt': No such file or directory (exit code 2)"], evidence: [], repo_trees: 3, trees_a_day: 72, rate: 1, per_arm: 64, trial_days: 2 },
        created: now, updated: now, accepted: null, ended: null, exp_id: null, outcome: null, given: 0, chars: 0,
      };
      await page.route("**/api/lessons", (route) => route.fulfill({ json: { lessons: [lesson], mine: { ts: now, found: 1, ms: 2 }, metric: "trees that failed with the lesson's class", days: 14 } }));
      await page.goto("/settings/lessons");
      const card = page.getByTestId("lesson-proposal");
      await expect(card).toBeVisible();
      // The note is a column of the page's width, not a strip beside the button.
      const note = page.getByTestId("lessons").locator("p").first();
      expect((await note.boundingBox())!.width).toBeGreaterThan(size.width * 0.7);
      // Nothing of the card stands outside it.
      const out = await card.evaluate((el) => { const c = el.getBoundingClientRect(); return [...el.querySelectorAll<HTMLElement>("*")].filter((e) => !e.closest("pre, code, [data-testid=lesson-evidence]") && e.getBoundingClientRect().width && e.getBoundingClientRect().right > c.right + 0.5).map((e) => e.textContent?.slice(0, 30)); });
      expect(out, "parts of the card past its edge").toEqual([]);
      await noSideScroll(page);
      expect(await small(card), "every control of the card is a finger's target").toEqual([]);
      await shoot(page, `phone-surfaces-04-lessons-${size.width}`);
    });

    // Round 10: the surfaces that landed after round 9.
    test("the tree's approvals and questions are answered by a finger, whole, inside the page", async ({ page, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      const ws = folder("phone-tree-asks");
      const root = await create(request, "Coordinator", ws);
      const ids = [root];
      const bash = (command: string) => ({ name: "Bash", input: { command } });
      const spawn = (message: string) => ({ name: "spawn_agent", input: { message, isolation: "none" } });
      try {
        await request.put(`/api/sessions/${root}/permissions`, { data: { mode: "ask", sandbox: "off" } });
        // A nested agent with a long name asks to run a command; a second asks a question.
        const inner = `Gamma the agent with a very long name that a phone cannot hold on one line\n${calls([bash("touch gamma-with-a-long-file-name-that-goes-on-and-on-past-the-edge.txt"), colors])}`;
        const alpha = `Alpha\n${calls([spawn(inner)])}`;
        const beta = `Beta\n${calls([colors])}`;
        await request.post(`/api/sessions/${root}/messages`, { data: { text: calls([spawn(alpha), spawn(beta)]) } });
        await page.goto(`/s/${root}`);
        const station = page.locator(`[data-station="${root}"]`);
        const asks = station.getByTestId("child-asks");
        await expect(asks).toHaveCount(2, { timeout: 45_000 });
        const kids = ((await (await request.get(`/api/sessions/${root}/agents`)).json()).agents as { session_id: string; title: string }[]);
        for (const k of kids) ids.push(k.session_id);
        const al = kids.find((k) => k.title === "Alpha")!;
        const g = ((await (await request.get(`/api/sessions/${al.session_id}/agents`)).json()).agents as { session_id: string }[])[0]!;
        ids.push(g.session_id);
        const all = station.getByTestId("child-approvals");
        await expect(all).toBeVisible();
        await noSideScroll(page);
        for (const c of await asks.all()) await inside(page, c.getByTestId("child-path"));
        // The agent's name is a line a finger can press, and the name is not cut off without a way to read it.
        for (const path of await asks.getByTestId("child-path").all()) {
          expect(await path.evaluate((el) => el.closest("button")!.getBoundingClientRect().height), "the agent's name is a target").toBeGreaterThanOrEqual(43);
          // (A title shows on hover only: a finger reads the name where it stands.)
          expect(await path.evaluate((el) => el.scrollWidth > el.clientWidth + 1), "the agent's path is cut off").toBe(false);
        }
        expect(await small(all), "every control of the tree's cards is a finger's target").toEqual([]);
        await shoot(page, `phone-surfaces-05-tree-asks-${size.width}`);
        // Answered by touch, in place.
        const card = (id: string) => station.locator(`[data-agent="${id}"]`);
        const bt = kids.find((k) => k.title === "Beta")!.session_id;
        await card(bt).getByTestId("question-option").filter({ hasText: "Teal" }).tap();
        await card(bt).getByTestId("question-submit").tap();
        await expect.poll(() => pending(request, bt), { timeout: 30_000 }).toHaveLength(0);
        await noSideScroll(page);
      } finally {
        await drop(request, ...ids.reverse());
      }
    });

    test("the new-model card on the home and in Settings > Models reads whole and is pressed by a finger", async ({ page }) => {
      const now = Date.now();
      const interval = (estimate: number) => ({ estimate, lo: estimate * 0.9, hi: estimate * 1.1, n: 12, method: "bootstrap" });
      const metrics = { cost_usd: { label: "Cost per turn", unit: "usd" }, turn_ms: { label: "Time per turn", unit: "ms" } };
      const model = (id: string, extra: Record<string, unknown>) => ({
        id: `scripted:${id}`, provider: "a-provider-with-a-long-name", model: id, name: `Scripted ${id}`, context: 1_000_000, output: 64_000, efforts: ["low", "medium", "high", "xhigh"],
        price: { input: 1.25, output: 10 }, billing: "api", first_seen: now - 3_600_000, ...extra,
      });
      const ended = {
        id: "e1", role: "builder", state: "stopped", started_ms: now - 7_200_000, stopped_ms: now - 600_000, stop_reason: "the trial ran its length",
        decision: { verdict: "keep", text: "It cost less per turn and took no longer: keep it as the builder, within what these trees show." },
        sessions: [{ arm: "a", n: 6 }, { arm: "b", n: 6 }], per_arm: 6, arms: ["a", "b"],
        report: {
          arms: [{ arm: "a", clusters: 6, units: 40, metrics: { cost_usd: interval(0.42), turn_ms: interval(5200) } }, { arm: "b", clusters: 6, units: 38, metrics: { cost_usd: interval(0.31), turn_ms: interval(4900) } }],
          effects: [{ metric: "cost_usd", diff: { ...interval(-0.11), significant: true }, better: true }, { metric: "turn_ms", diff: { ...interval(-300), significant: false }, better: null }],
        },
      };
      const body = { roles: ["reader", "small", "builder"], metrics, models: [
        model("a-model-with-a-rather-long-name-for-a-phone-1-pro-max", { trial: ended }),
        model("plain-model", { price: undefined, refused: { builder: "plain-model lists no price, so the dollars an agent on it spends could not be counted" } }),
      ] };
      await page.route("**/api/models/new*", (route) => (route.request().method() === "GET" ? route.fulfill({ json: body }) : route.fallback()));
      await page.goto("/");
      const news = page.getByTestId("new-model-news");
      await expect(news).toBeVisible();
      // The line says all it says: it is not cut at the page's edge.
      await inside(page, news);
      expect(await news.evaluate((el) => [...el.querySelectorAll<HTMLElement>("span")].some((s) => s.scrollWidth > s.clientWidth + 1)), "the home's line is cut off").toBe(false);
      await noSideScroll(page);
      await shoot(page, `phone-surfaces-06-new-model-home-${size.width}`);
      await news.tap();
      const cards = page.getByTestId("new-models");
      await expect(cards.getByTestId("new-model")).toHaveCount(2);
      await noSideScroll(page);
      for (const card of await cards.getByTestId("new-model").all()) {
        await card.scrollIntoViewIfNeeded();
        await inside(page, card.getByTestId("new-model-name").locator("xpath=.."));
        expect(await small(card), "every control of the card is a finger's target").toEqual([]);
        // Nothing the card says is cut off without a way to read it whole.
        const cut = await card.evaluate((el) => [...el.querySelectorAll<HTMLElement>("h3, p, span")].filter((e) => !e.closest('[data-testid="new-model-table"]') && getComputedStyle(e).textOverflow === "ellipsis" && e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent?.slice(0, 40)));
        expect(cut, "words cut off in the card").toEqual([]);
        // A part of it that scrolls sideways is the table, and nothing else.
        const wide = await card.evaluate((el) => { const c = el.getBoundingClientRect(); return [...el.querySelectorAll<HTMLElement>("*")].filter((e) => !e.closest('[data-testid="new-model-table"]') && e.getBoundingClientRect().right > c.right + 0.5).map((e) => e.dataset.testid ?? e.tagName); });
        expect(wide, "parts of the card past its edge").toEqual([]);
      }
      const first = cards.getByTestId("new-model").first();
      await first.scrollIntoViewIfNeeded();
      await shoot(page, `phone-surfaces-07-new-model-card-${size.width}`);
      // The result is a table that scrolls inside the card, which the page does not.
      const table = first.getByTestId("new-model-table");
      await expect(table).toBeVisible();
      await inside(page, table);
      await noSideScroll(page);
    });
  });
}
