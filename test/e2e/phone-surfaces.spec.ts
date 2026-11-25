import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "./isolate.ts";
import { ask, calls, colors, create, folder, pending, settle } from "./answering.ts";
import { SHOTS, inHead, leaveHead, shoot } from "./shots.ts";

// Feature: the surfaces that landed after the phone page was last checked fit a phone and are
// reached by a finger: the session menu's rows and what opens from them, the dollar cap, the
// list's rows, Settings > Telemetry and the work board. At 390x844 and 412x915: no sideways
// scroll, nothing past the page's edge, a target at least 2.75rem, no control that waits for a
// hover, and a popup opened from the menu stands over the menu.
const STAND_IN = "scripted:stand-in";
// Settings sections whose phone fit is not done yet (the walk below).
const WALK_PENDING = new Set<string>([]);
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
// A session whose dock says everything at once: a changed file in a repository, a plan, a command left running, and an
// agent it waits on. Returns its id (the caller drops it).
async function fullDock(request: APIRequestContext, title: string) {
  const repo = folder(`phone-dock-${Date.now().toString(36)}`);
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, encoding: "utf8" });
  mkdirSync(repo, { recursive: true });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "notes.md"), "one\ntwo\nthree\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  const id = await create(request, title, repo);
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  const todos = ["Read the release notes", "Check the changelog against the tags", "Write the summary"].map((content, i) => ({ content, activeForm: `${content} (now)`, status: ["completed", "in_progress", "pending"][i] }));
  const child = `Hold the lane\n${calls([{ name: "Bash", input: { command: "sleep 120" } }])}`;
  await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([
    { name: "Bash", input: { command: "printf 'four\\nfive\\n' >> notes.md; printf 'x\\n' > new.txt" } },
    { name: "TodoWrite", input: { todos } },
    { name: "Bash", input: { command: "sleep 200", run_in_background: true, description: "the long migration" } },
    { name: "spawn_agent", input: { message: child, isolation: "none" } },
  ]) } });
  await expect.poll(async () => ((await (await request.get(`/api/sessions/${id}/agents`)).json()).agents as unknown[]).length, { timeout: 60_000 }).toBe(1);
  await expect.poll(() => idle(request, id), { timeout: 60_000 }).toBe(true);
  return id;
}
// The page at a text scale, as a phone with that setting holds it.
async function atScale(browser: Browser, size: { width: number; height: number }, scale: number) {
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: size, hasTouch: true, isMobile: true });
  await ctx.addInitScript((s) => localStorage.setItem("keel.textScale", String(s)), scale);
  return { ctx, page: await ctx.newPage() };
}
// Two controls that overlap are a press that may land on either.
const overlaps = (box: Locator, selector: string) => box.evaluate((root, sel) => {
  const els = [...root.querySelectorAll<HTMLElement>(sel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; });
  const name = (e: HTMLElement) => e.dataset.testid ?? `${e.tagName.toLowerCase()} "${(e.textContent ?? "").trim().slice(0, 16)}"`;
  const out: string[] = [];
  for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
    const a = els[i]!.getBoundingClientRect(), b = els[j]!.getBoundingClientRect();
    if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push(`${name(els[i]!)} over ${name(els[j]!)}`);
  }
  return out;
}, selector);
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
// What a finger cannot use in a box on a phone: a page or box that scrolls sideways, a part past the page's edge,
// words cut by an ellipsis (a title is no way to read them on a touch screen), a control under 2.75 rem.
const phoneProblems = (box: Locator) => box.evaluate((root) => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize), out: string[] = [];
    const name = (e: Element) => `${(e as HTMLElement).dataset.testid ?? `${e.tagName.toLowerCase()}.${String((e as HTMLElement).className).trim().split(/\s+/).slice(0, 4).join(".")}`}${(e.textContent ?? "").trim().slice(0, 24) ? ` "${(e.textContent ?? "").trim().slice(0, 24)}"` : ""}`;
    const shown = (e: Element) => { const r = e.getBoundingClientRect(); return !!r.width && !!r.height && getComputedStyle(e).visibility !== "hidden" && !e.closest("[aria-hidden=true], [hidden], details:not([open]) > :not(summary)"); };
    // Inside something that scrolls sideways by itself, a wide part is reached by a finger.
    const scrolls = (e: Element) => { for (let a = e.parentElement; a && a !== root; a = a.parentElement) if (/auto|scroll/.test(getComputedStyle(a).overflowX)) return true; return false; };
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth) out.push(`page scrolls sideways by ${document.documentElement.scrollWidth - document.documentElement.clientWidth}`);
    if ((root as HTMLElement).scrollWidth > (root as HTMLElement).clientWidth + 1) out.push(`section scrolls sideways by ${(root as HTMLElement).scrollWidth - (root as HTMLElement).clientWidth}`);
    for (const e of root.querySelectorAll("*")) {
      if (!shown(e) || scrolls(e)) continue;
      const r = e.getBoundingClientRect();
      if (r.right > innerWidth + 0.5 || r.left < -0.5) out.push(`past the edge: ${name(e)} ${Math.round(r.left)}-${Math.round(r.right)}`);
      const cs = getComputedStyle(e);
      if (cs.textOverflow === "ellipsis" && e.scrollWidth > e.clientWidth + 1) out.push(`cut: ${name(e)}`);
    }
    for (const c of root.querySelectorAll<HTMLElement>("button, [role=button], a[href], input:not([type=hidden]), select, textarea, summary")) {
      if (!shown(c)) continue;
      // A link among words keeps its line; a checkbox or radio is pressed by the label around it.
      if (c.tagName === "A" && getComputedStyle(c).display === "inline") continue;
      const r = (/^(checkbox|radio)$/.test((c as HTMLInputElement).type) ? c.closest("label") ?? c : c).getBoundingClientRect();
      if (r.width <= 1 && r.height <= 1) continue; // (a visually hidden field: its label is the control)
      if (r.height < 2.75 * rem - 1 || r.width < 2.75 * rem - 1) out.push(`small: ${name(c)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return [...new Set(out)];
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
        never: names.map((control) => ({ control, views: "session,project,settings/acp,settings/telemetry,settings/safety,settings/models", seen_since_ms: now - 864e5 })),
      };
      await page.route("**/api/presses?*", (route) => route.fulfill({ json: report }));
      await page.goto("/settings/telemetry");
      const panel = page.getByTestId("telemetry-panel");
      await expect(panel.getByTestId("press-never-row")).toHaveCount(3);
      await page.getByTestId("settings-scroll").evaluate((el) => { el.scrollTop = el.scrollHeight; });
      // Every name is there whole: not cut at the column's edge, so two controls are never one name.
      const cut = await panel.locator("li span.font-mono").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth || getComputedStyle(e).textOverflow === "ellipsis").map((e) => e.textContent));
      expect(cut, "names cut off").toEqual([]);
      // The line under a name (the views it was drawn in) is whole too: a long list of views wraps, it is not cut.
      const subs = await panel.locator(".k-set-sub[data-clip]").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1 || getComputedStyle(e).textOverflow === "ellipsis").map((e) => e.textContent));
      expect(subs, "second lines cut").toEqual([]);
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
        // A phone shows a row an agent; the facts open on a tap.
        for (const t of await board.getByTestId("board-toggle").all()) await t.tap();
        // Each fact says all it knows: "older head" and the commit a stale verdict spoke of are not cut off.
        await expect(board.getByTestId("board-review").filter({ hasText: "refused" })).toContainText("older head");
        const values = board.locator('[data-testid^="board-"] > span:nth-child(2) > span:last-child');
        // Three facts a card: a tile with nothing to say (no live check) is left out (UX-S106).
        await expect(values).toHaveCount(9);
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
    test("Customize > Lessons reads from the page's edge: its note over its controls, a long repository name inside the card", async ({ page, request }) => {
      const now = Date.now();
      const name = "a-repository-whose-folder-has-a-very-long-name-for-a-phone";
      const lesson = {
        id: "l-1", repo: `/work/${name}`, repo_name: name, key: "tool:Bash:x", source: "tool", label: "Bash", words: null, state: "proposed",
        text: "Before you run a command here, check it cannot fail like this: ls: cannot access './missing-input-3.txt'", drafted_by: STAND_IN, why_none: null,
        evidence: { key: "tool:Bash:x", source: "tool", label: "Bash", repo: `/work/${name}`, repo_name: name, failures: 3, sessions: 3, trees: 3, first_ts: now - 6e4, last_ts: now, examples: ["ls: cannot access './missing-input-3.txt': No such file or directory (exit code 2)"], evidence: [], repo_trees: 3, trees_a_day: 72, rate: 1, per_arm: 64, trial_days: 2 },
        created: now, updated: now, accepted: null, ended: null, exp_id: null, outcome: null, given: 0, chars: 0,
      };
      await page.route("**/api/lessons", (route) => route.fulfill({ json: { lessons: [lesson], mine: { ts: now, found: 1, ms: 2 }, metric: "trees that failed with the lesson's class", days: 14 } }));
      await page.goto("/customize/lessons");
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
      // The result is read down the card, never scrolled sideways: each row is a block, and every figure of it
      // (with its own heading) is inside the page.
      const table = first.getByTestId("new-model-table");
      await expect(table).toBeVisible();
      await inside(page, table);
      await noSideScroll(page);
      expect(await table.evaluate((el) => el.scrollWidth - el.clientWidth), "the result table scrolls sideways in its card").toBeLessThanOrEqual(0);
      const past = await table.evaluate((el) => [...el.querySelectorAll<HTMLElement>("td")].filter((e) => e.getBoundingClientRect().right > innerWidth || e.getBoundingClientRect().left < 0).map((e) => e.textContent));
      expect(past, "figures past the page's edge").toEqual([]);
      await expect(table.locator("thead")).toBeHidden();
      const row = table.getByTestId("new-model-row-cost_usd");
      for (const head of ["As before", "With it", "Change"]) await expect(row.getByText(head).first()).toBeVisible();
      await table.scrollIntoViewIfNeeded();
      await shoot(page, `phone-surfaces-07b-new-model-table-${size.width}`);
    });

    test("the start box's branch chip and its list fit the page and are pressed by a finger", async ({ page, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      const root = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `phone-base-${Date.now()}-${size.width}`);
      const repo = join(root, "repo");
      mkdirSync(repo, { recursive: true });
      const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" }).trim();
      git("init", "-q", "-b", "main");
      writeFileSync(join(repo, "notes.md"), "main\n");
      git("add", "-A");
      git("commit", "-qm", "init");
      const long = "feature/a-branch-whose-name-is-much-too-long-for-one-line-on-a-phone-screen";
      for (const name of ["dev", long]) { git("checkout", "-q", "-b", name, "main"); writeFileSync(join(repo, `${name.length}.md`), name); git("add", "-A"); git("commit", "-qm", name); }
      git("checkout", "-q", "main");
      git("update-ref", "refs/remotes/origin/main", "main");
      git("update-ref", "refs/remotes/origin/release-candidate-with-a-long-name", "dev");
      git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
      const other = join(root, "long-checkout");
      git("worktree", "add", "-q", other, long);
      const guest = await (await request.post("/api/sessions", { data: { workspace: other, model: STAND_IN, title: "A session whose title is long enough to push the row past the edge" } })).json();
      try {
        await page.addInitScript((ws) => {
          localStorage.setItem("keel.newWorkspace", JSON.stringify(ws));
          localStorage.setItem("keel.startInWorktree", "0");
        }, repo);
        await page.goto("/");
        await page.getByTestId("start-in-worktree").tap();
        const chip = page.getByTestId("worktree-base");
        await expect(chip).toContainText("from");
        await inside(page, chip);
        await noSideScroll(page);
        expect(await small(chip), "the chip is a finger's target").toEqual([]);
        await shoot(page, `phone-surfaces-08-base-chip-${size.width}`);
        const trigger = page.getByTestId("worktree-base-select");
        await trigger.tap();
        const list = page.getByRole("listbox");
        await expect(list.getByRole("option").first()).toBeVisible();
        // The list stands inside the page, each row a finger's target, no row's words cut off.
        await inside(page, list);
        await noSideScroll(page);
        expect(await small(list), "every row of the list is a finger's target").toEqual([]);
        const cut = await list.getByRole("option").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1 || [...e.querySelectorAll<HTMLElement>("*")].some((c) => c.scrollWidth > c.clientWidth + 1 && getComputedStyle(c).overflow !== "visible")).map((e) => e.textContent?.slice(0, 40)));
        expect(cut, "rows cut off").toEqual([]);
        await shoot(page, `phone-surfaces-09-base-list-${size.width}`);
        await list.locator('[role="option"][data-value="dev"]').tap();
        await expect(trigger).toHaveAttribute("data-value", "dev");
        await inside(page, chip);
      } finally {
        await drop(request, guest.session?.id ?? guest.id);
      }
    });

    test("a selection in a reply offers Quote and Comment inside the page, by touch, and the quote reads whole once sent", async ({ page, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      const id = await start(request, "Phone quote");
      const said = "The cache is warmed before the first request, and the loop starts only after that, so a reader that comes late finds every entry already in place. A second sentence follows to make the paragraph run over several lines on a phone.";
      try {
        await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:say ${said}` } });
        await expect.poll(() => idle(request, id), { timeout: 60_000 }).toBe(true);
        await page.goto(`/s/${id}`);
        const reply = page.getByTestId("assistant-text").first().locator("p").first();
        await expect(reply).toHaveText(said);
        // A selection of the reply's words, the way a long press and its handles leave one.
        const select = (from: number, to: number) => reply.evaluate((el, [a, b]) => {
          const t = el.firstChild as Text;
          const r = document.createRange();
          r.setStart(t, a as number); r.setEnd(t, b as number);
          const s = getSelection()!; s.removeAllRanges(); s.addRange(r);
        }, [from, to]);
        await select(0, said.length);
        const bar = page.getByTestId("selection-bar");
        await expect(bar).toBeVisible();
        await inside(page, bar);
        expect(await small(bar), "Quote and Comment are finger targets").toEqual([]);
        // It is not over the words it is about.
        const words = (await reply.boundingBox())!, b = (await bar.boundingBox())!;
        expect(b.y >= words.y + words.height - 1 || b.y + b.height <= words.y + 1, "the bar stands clear of the words").toBe(true);
        await shoot(page, `phone-surfaces-10-selection-${size.width}`);
        // A selection at the foot of the page, under the composer's reach.
        await page.getByTestId("selection-comment-open").tap();
        const line = page.getByTestId("selection-comment");
        await expect(line).toBeVisible();
        await inside(page, bar);
        await line.fill("Is that the order the code runs in, and what if the reader is early?");
        expect(await small(bar), "the comment box's controls are finger targets").toEqual([]);
        await inside(page, bar);
        await shoot(page, `phone-surfaces-11-selection-comment-${size.width}`);
        await page.getByTestId("selection-send").tap();
        await expect(bar).toHaveCount(0);
        const sent = page.getByTestId("user-message").filter({ hasText: "what if the reader is early" });
        await expect(sent).toBeVisible({ timeout: 30_000 });
        const quote = sent.getByTestId("user-quote");
        await expect(quote).toHaveText(said);
        // The quote is whole where it stands: not cut, inside the page.
        expect(await quote.evaluate((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1), "the quote is cut off").toBe(false);
        await inside(page, quote);
        await noSideScroll(page);
        await shoot(page, `phone-surfaces-12-quote-sent-${size.width}`);
      } finally {
        await drop(request, id);
      }
    });

    test("Settings > Safety > Try a rule change: its form and its replay read whole and are pressed by a finger", async ({ page, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      const NS = `127.0.0.1/phone-trial-${size.width}`;
      const had = ((await (await request.get("/api/settings")).json()).settings.accounts?.namespaces ?? []) as string[];
      test.skip(had.includes(NS), "needs a daemon whose namespaces do not hold the spec's own");
      const work = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `phone-trial-${Date.now()}-${size.width}`);
      mkdirSync(work, { recursive: true });
      const git = (...args: string[]) => execFileSync("git", args, { cwd: work, stdio: "ignore" });
      git("init", "-q", "-b", "main");
      git("-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "--allow-empty", "-m", "x");
      git("remote", "add", "theirs", `http://127.0.0.1:1/phone-trial-${size.width}/lib.git`);
      const { session } = await (await request.post("/api/sessions", { data: { workspace: work, model: STAND_IN, title: "Phone rule trial calls" } })).json();
      const base = `/api/sessions/${session.id}`;
      const turns = async () => { const r = await (await request.get(base)).json(); return r.running ? -1 : r.events.filter((e: any) => e.kind === "turn_end").length; };
      const bash = (command: string) => ({ name: "Bash", input: { command } });
      try {
        await request.put(`${base}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
        await page.goto(`/s/${session.id}`);
        await request.post(`${base}/messages`, { data: { text: calls([bash("git status --short"), bash("echo trial")]) } });
        await expect.poll(turns, { timeout: 30_000 }).toBe(1);
        await request.post(`${base}/messages`, { data: { text: calls([bash("git push theirs main")]) } });
        const approval = page.getByTestId("approval");
        await expect(approval).toHaveCount(1, { timeout: 30_000 });
        await approval.getByTestId("deny").tap();
        await approval.getByTestId("deny-send").tap();
        await expect.poll(turns, { timeout: 30_000 }).toBe(2);

        await page.goto("/settings/safety");
        const trial = page.getByTestId("rule-trial");
        await trial.scrollIntoViewIfNeeded();
        await noSideScroll(page);
        await trial.getByTestId("trial-namespace-input").fill(NS);
        await trial.getByTestId("trial-namespace-add").tap();
        await expect(trial.locator('[data-testid="trial-namespace"][data-state="new"]')).toHaveText(`+ ${NS}`);
        await trial.getByTestId("trial-grant-pattern").fill("make a-target-with-a-name-that-goes-on-for-a-long-time-test");
        await trial.getByTestId("trial-grant-scope").fill("/home/someone/projects/a-folder-with-a-long-name/and/more/below");
        await trial.getByTestId("trial-grant-add").tap();
        await trial.getByTestId("trial-days").tap();
        await page.getByRole("option", { name: "1 day" }).tap();
        await trial.getByTestId("trial-run").tap();
        const result = trial.getByTestId("trial-result");
        await expect(result.getByTestId("trial-summary")).toContainText("1 allowed", { timeout: 60_000 });
        await expect(result.getByTestId("trial-call")).toHaveCount(1);
        await trial.scrollIntoViewIfNeeded();
        await noSideScroll(page);
        // The form: every field and button inside the card's width, a finger's target.
        const past = await trial.evaluate((el) => {
          const c = el.getBoundingClientRect();
          return [...el.querySelectorAll<HTMLElement>("*")].filter((e) => !e.closest("pre, code, details:not([open]), [aria-hidden=true]") && e.getBoundingClientRect().width && (e.getBoundingClientRect().right > c.right + 0.5 || e.getBoundingClientRect().left < c.left - 0.5)).map((e) => `${e.dataset.testid ?? e.tagName} ${Math.round(e.getBoundingClientRect().left)}-${Math.round(e.getBoundingClientRect().right)} of ${Math.round(c.left)}-${Math.round(c.right)}`);
        });
        expect(past, "parts of the card past its edge").toEqual([]);
        expect(await small(trial), "every control of the card is a finger's target").toEqual([]);
        // Nothing the replay says is cut off where a finger cannot read it whole: its tables fit, its rows wrap.
        const cut = await result.evaluate((el) => [...el.querySelectorAll<HTMLElement>("td, th, li, span, p")].filter((e) => (getComputedStyle(e).textOverflow === "ellipsis" || getComputedStyle(e).overflow === "hidden") && e.scrollWidth > e.clientWidth + 1).map((e) => (e.textContent ?? "").slice(0, 40)));
        expect(cut, "words of the replay cut off").toEqual([]);
        const cutForm = await trial.evaluate((el) => [...el.querySelectorAll<HTMLElement>('[data-testid="trial-grants"] *, [data-testid="trial-namespaces"] *')].filter((e) => getComputedStyle(e).textOverflow === "ellipsis" && e.scrollWidth > e.clientWidth + 1).map((e) => (e.textContent ?? "").slice(0, 40)));
        expect(cutForm, "words of the grants cut off").toEqual([]);
        await shoot(page, `phone-surfaces-13-rule-trial-${size.width}`);
        await result.getByTestId("trial-agreement").scrollIntoViewIfNeeded();
        await shoot(page, `phone-surfaces-14-rule-trial-agreement-${size.width}`);
      } finally {
        await request.patch("/api/settings", { data: { accounts: { namespaces: had } } });
        await drop(request, session.id);
      }
    });

    test("the checks-beside notice on an agent's card reads whole inside the page", async ({ page, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      const id = await start(request, "Phone beside");
      try {
        await request.post(`/api/sessions/${id}/messages`, { data: { text: "script:say Done." } });
        await expect.poll(() => idle(request, id), { timeout: 60_000 }).toBe(true);
        // The notice Keel writes for the agent (src/checks/beside-run.ts), with long test names and a long command line, as a real failure has.
        const text = [
          "[harness] Checks beside your work: Keel ran unit (12 test files) by itself on your files as they were at 3f9c2ab.",
          "- unit (`sh unit.sh ./packages/a-package-with-a-long-name/src/a-long-test-file-name.test.ts ./other.test.ts`): 2 of 12 failed: a very long suite name > a nested group of tests > it adds the numbers the way the README says; lib > adds",
          "error: add 1 2 gave -1, not 3 at /home/someone/projects/a-repository-with-a-long-name/packages/a-package-with-a-long-name/src/a-long-test-file-name.test.ts:42:17",
        ].join("\n");
        await page.route(new RegExp(`/api/sessions/${id}(\\?.*)?$`), async (route) => {
          const res = await route.fetch();
          const body = await res.json();
          const last = body.events.at(-1);
          body.events.push({ id: "beside-note-1", session_id: id, seq: last.seq + 1, parent: last.id, kind: "user", data: { text, kind: "checks_beside" }, ts: Date.now() });
          body.session.head = "beside-note-1";
          await route.fulfill({ json: body });
        });
        await page.goto(`/s/${id}`);
        const card = page.getByTestId("beside-notice");
        await expect(card).toBeVisible();
        await card.scrollIntoViewIfNeeded();
        await inside(page, card.locator("xpath=.."));
        await noSideScroll(page);
        expect(await small(card), "every control of the notice is a finger's target").toEqual([]);
        // The failing lines are read where they stand: wrapped, none cut at the edge or scrolled away.
        const pre = card.locator("pre");
        await expect(pre).toContainText("error: add 1 2 gave -1");
        expect(await pre.evaluate((el) => el.scrollWidth > el.clientWidth + 1), "the failure's lines run past the notice").toBe(false);
        await shoot(page, `phone-surfaces-15-beside-${size.width}`);
      } finally {
        await drop(request, id);
      }
    });

    test("every Settings and Customize section pages through on a phone: inside the page, a finger's targets, no words cut off", async ({ page }) => {
      test.setTimeout(240_000);
      // Both pages: each lists its sections in its jump bar, and each section is walked at its own address.
      const at: { path: string; id: string }[] = [];
      for (const [path, least] of [["settings", 20], ["customize", 11]] as const) {
        await page.goto(`/${path}`);
        await page.getByTestId("settings-jump").tap();
        const ids = await page.locator("[data-section]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.section!));
        // (The registered sections: every one is on the kit by now; the count only guards against a walk of none.)
        expect(ids.length, `${path} sections listed`).toBeGreaterThanOrEqual(least);
        at.push(...ids.map((id) => ({ path, id })));
      }
      const ids = at.map((x) => x.id);
      const found: Record<string, string[]> = {};
      for (const { path, id } of at) {
        await page.goto(`/${path}/${id}`);
        await expect(page.getByTestId("settings-title")).toBeVisible();
        // The section has drawn: its group heads or its first rows are there, and it stops changing.
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.waitForTimeout(250);
        const scroll = page.getByTestId("settings-scroll");
        const problems = await phoneProblems(scroll);
        if (problems.length) found[id] = problems;
      }
      writeFileSync(join(SHOTS, `walk-${size.width}.json`), JSON.stringify(found, null, 1));
      // The sections not fitted yet are named in WALK_PENDING and the list only shrinks: one that fits is taken out.
      const fitsNow = [...WALK_PENDING].filter((id) => ids.includes(id) && !found[id]);
      expect(fitsNow, "sections that fit a phone now: take them out of WALK_PENDING").toEqual([]);
      for (const id of WALK_PENDING) delete found[id];
      expect(found, "sections with a part a finger cannot reach whole").toEqual({});
    });
    test("the lane plans panel reads whole and is pressed by a finger", async ({ page, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      test.setTimeout(120_000);
      await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
      const repo = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `phone-lanes-${Date.now()}-${size.width}`, "repo");
      mkdirSync(join(repo, "src"), { recursive: true });
      const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
      git("init", "-q", "-b", "main");
      for (const f of ["src/a-rather-long-module-name-for-a-phone.ts", "src/z.ts"]) writeFileSync(join(repo, f), `export const v = "${f}";\n`);
      git("add", "-A");
      git("commit", "-qm", "init");
      const coord = (await (await request.post("/api/sessions", { data: { model: STAND_IN, workspace: repo, title: "Coordinator" } })).json()).session.id as string;
      const lanes = [
        { title: "Lane alpha reworks the long module and its callers", brief: "Rework src/a-rather-long-module-name-for-a-phone.ts and src/z.ts." },
        { title: "Lane beta fixes the same long module", brief: "Fix src/a-rather-long-module-name-for-a-phone.ts and src/z.ts." },
        { title: "Lane gamma restyles the docs", brief: "Restyle docs/guide.md." },
      ];
      try {
        await request.post(`/api/sessions/${coord}/messages`, { data: { text: calls([{ name: "keel__lane_plan", input: { action: "plan", lanes } }]) } });
        await expect.poll(() => idle(request, coord), { timeout: 60_000 }).toBe(true);
        await expect.poll(async () => ((await (await request.get(`/api/sessions/${coord}/lane-plans`)).json()).plans as unknown[]).length, { timeout: 30_000 }).toBe(1);
        await page.goto(`/s/${coord}`);
        await page.getByTestId("panel-menu").first().tap();
        await page.getByTestId("panel-pick-lanes").tap();
        const panel = page.getByTestId("lane-plan");
        await expect(panel.getByTestId("lane-card")).toHaveCount(3);
        await expect(panel.getByTestId("plan-meeting")).toHaveCount(1);
        await panel.scrollIntoViewIfNeeded();
        await shoot(page, `phone-surfaces-19-lane-plan-${size.width}`);
        expect(await phoneProblems(panel), "the plan has a part a finger cannot use").toEqual([]);
        await noSideScroll(page);
        // The proposal's order and its start buttons are reached.
        for (const t of ["plan-start-order", "plan-drop"]) {
          const b = panel.getByTestId(t);
          await b.scrollIntoViewIfNeeded();
          const r = (await b.boundingBox())!;
          expect(r.x, `${t} is inside the page`).toBeGreaterThanOrEqual(0);
          expect(r.x + r.width, `${t} is inside the page`).toBeLessThanOrEqual(size.width);
        }
        await shoot(page, `phone-surfaces-20-lane-plan-start-${size.width}`);
      } finally {
        await drop(request, coord);
      }
    });
    test("an open question leaves one menu button in the title row, with the work board, Stop and Archive in it", async ({ page, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      const ws = folder(`phone-asks-${size.width}`);
      const id = await create(request, "Ship the checkout refactor", ws);
      try {
        const question = { name: "AskUserQuestion", input: { questions: [{ header: "Store", question: "Which store should I use?", options: [{ label: "SQLite" }, { label: "Valkey" }], multiSelect: false }] } };
        await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([question]) } });
        await expect.poll(async () => (await (await request.get(`/api/sessions/${id}/questions`)).json()).pending.length, { timeout: 30_000 }).toBe(1);
        await page.goto(`/s/${id}`);
        const station = page.locator(`section.k-station[data-station="${id}"]`);
        await expect(station).toHaveAttribute("data-question", "");
        await expect(station.locator('.k-question[data-state="open"]')).toBeVisible();
        // The menu button is in view, a finger's size, and in the title's own row, inside the page.
        const menu = station.getByTestId("session-menu");
        await expect(menu).toBeVisible();
        const [m, t] = [(await menu.boundingBox())!, (await station.getByTestId("station-title").boundingBox())!];
        const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
        expect(m.width, "a finger's width").toBeGreaterThanOrEqual(2.75 * rem - 1);
        expect(m.x + m.width, "inside the page").toBeLessThanOrEqual(size.width);
        expect(m.y < t.y + t.height && m.y + m.height > t.y, "in the title's row").toBe(true);
        expect(t.x + t.width, "the title does not run under it").toBeLessThanOrEqual(m.x + 1);
        await shoot(page, `phone-surfaces-21-question-menu-${size.width}`);
        // What the tools row held is a tap away: the work board, Stop, and Archive.
        await menu.tap();
        const more = page.getByTestId("header-more");
        await expect(more.getByTestId("menu-stop")).toBeVisible();
        await shoot(page, `phone-surfaces-22-question-menu-open-${size.width}`);
        // The panels the Panels button holds are in the menu as a group of their own: the five at hand, the work board among them.
        const panelRows = more.locator('[data-testid^="menu-panel-"]');
        await expect(more.getByTestId("menu-panels")).toBeVisible();
        await expect(panelRows).toHaveCount(5);
        await expect(more.getByTestId("menu-panel-board")).toBeVisible();
        // The list stays inside the screen and scrolls: its last action is reached by a swipe, not cut off.
        const box = (await more.boundingBox())!;
        expect(box.y, "the menu starts inside the page").toBeGreaterThanOrEqual(0);
        expect(box.y + box.height, "the menu ends inside the page").toBeLessThanOrEqual(size.height);
        expect(await more.evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");
        await more.getByTestId("menu-delete").scrollIntoViewIfNeeded();
        await expect(more.getByTestId("menu-delete")).toBeInViewport({ ratio: 1 });
        await more.getByTestId("menu-archive").scrollIntoViewIfNeeded();
        await expect(more.getByTestId("menu-archive")).toBeVisible();
        await more.getByTestId("menu-panel-board").scrollIntoViewIfNeeded();
        await more.getByTestId("menu-panel-board").tap();
        await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "board");
      } finally {
        await drop(request, id);
      }
    });
    test("the tree review reads as one column on a phone: areas, one area's diff, and its decisions by a finger", async ({ page, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      test.setTimeout(180_000);
      await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
      const repo = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `phone-tree-${Date.now()}-${size.width}`, "repo");
      mkdirSync(join(repo, "src/board"), { recursive: true });
      mkdirSync(join(repo, "src/landing"), { recursive: true });
      mkdirSync(join(repo, ".keel"));
      const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
      git("init", "-q", "-b", "main");
      writeFileSync(join(repo, "src/board/rules.ts"), Array.from({ length: 10 }, (_, i) => `export const rule${i + 1} = ${i + 1};`).join("\n") + "\n");
      writeFileSync(join(repo, "src/landing/queue.ts"), Array.from({ length: 6 }, (_, i) => `export const step${i + 1} = ${i + 1};`).join("\n") + "\n");
      writeFileSync(join(repo, "README.md"), "# demo\n");
      writeFileSync(join(repo, ".keel/checks.json"), JSON.stringify({ checks: { files: "test -f src/board/rules.ts" }, land: { checks: ["files"] } }));
      git("add", "-A");
      git("commit", "-qm", "init");
      const commit = (msg: string) => `git add -A && git -c user.name=k -c user.email=k@k commit -qm '${msg}'`;
      const coord = (await (await request.post("/api/sessions", { data: { model: STAND_IN, workspace: repo, title: "Coordinator" } })).json()).session.id as string;
      const lane = (title: string, command: string) => ({ name: "spawn_agent", input: { message: `${title}\n${calls([{ name: "Bash", input: { command } }])}` } });
      try {
        await request.post(`/api/sessions/${coord}/messages`, { data: { text: `script:batch ${JSON.stringify([
          lane("Lane alpha", `sed -i 's/rule3 = 3/rule3 = 30/' src/board/rules.ts && mkdir -p ui/src/components && printf 'export const BoardCard = () => null;\\n' > ui/src/components/BoardCard.tsx && ${commit("Lane alpha")}`),
          lane("Lane beta", `sed -i 's/rule3 = 3/rule3 = 300/; s/rule4 = 4/rule4 = 400/' src/board/rules.ts && ${commit("Lane beta")}`),
          lane("Lane gamma", `sed -i 's/step2 = 2/step2 = 20/' src/landing/queue.ts && printf 'Landing steps.\\n' >> README.md && ${commit("Lane gamma")}`),
        ])}` } });
        const agentsOf = async () => (await (await request.get(`/api/sessions/${coord}/agents`)).json()).agents as any[];
        await expect.poll(async () => (await agentsOf()).filter((a) => a.status === "completed" && a.branch).length, { timeout: 90_000 }).toBe(3);
        await expect.poll(() => idle(request, coord), { timeout: 60_000 }).toBe(true);
        await page.goto(`/s/${coord}`);
        await page.getByTestId("panel-menu").first().tap();
        await page.getByTestId("panel-pick-board").tap();
        await page.getByTestId("board-review-tree").tap();
        const dlg = page.getByTestId("tree-review");
        await expect(dlg.getByTestId("tree-summary")).toContainText("3 branches to land");
        await expect(dlg.getByTestId("tree-area")).toHaveCount(3);
        // The dialog is the page's size and the page does not scroll sideways.
        await inside(page, dlg);
        await noSideScroll(page);
        expect(await small(dlg), "every control of the review is a finger's target").toEqual([]);
        // The areas are read at the page's width, not past it: the list does not leave the diff 0 px wide.
        const widths = await dlg.evaluate((el) => { const w = el.getBoundingClientRect().width; return { w, areas: document.querySelector<HTMLElement>('[data-testid="tree-areas"]')!.getBoundingClientRect().width }; });
        expect(widths.areas, "the area list fits the dialog").toBeLessThanOrEqual(widths.w);
        await shoot(page, `phone-surfaces-16-tree-areas-${size.width}`);
        // An area is opened by a press and its diff and decisions are reached.
        await dlg.locator('[data-testid="tree-area"][data-area="src/board"]').tap();
        const files = dlg.getByTestId("tree-area-files");
        await expect(files.locator('[data-testid="tree-file"][data-path="src/board/rules.ts"]')).toBeVisible();
        await expect(dlg.getByTestId("tree-overlap").first()).toBeVisible();
        await inside(page, dlg);
        await noSideScroll(page);
        const land = dlg.getByTestId("tree-land");
        await land.scrollIntoViewIfNeeded();
        for (const t of ["tree-land", "tree-back", "tree-drop"]) {
          const b = dlg.getByTestId(t);
          await b.scrollIntoViewIfNeeded();
          const r = (await b.boundingBox())!;
          expect(r.x, `${t} is inside the page`).toBeGreaterThanOrEqual(0);
          expect(r.x + r.width, `${t} is inside the page`).toBeLessThanOrEqual(size.width);
        }
        // The main button lands the branches that do not conflict and says so; landing them all is beside it and asks first.
        await expect(land).toContainText("would conflict");
        const all = dlg.getByTestId("tree-land-all");
        await all.scrollIntoViewIfNeeded();
        await inside(page, all);
        await all.tap();
        const sure = page.getByTestId("confirm");
        await expect(sure).toContainText("branches?");
        // (Its buttons are measured once it has opened: it grows into place.)
        await expect.poll(() => small(sure), { message: "the confirmation's buttons are finger targets" }).toEqual([]);
        await inside(page, sure);
        await shoot(page, `phone-surfaces-19-tree-land-all-${size.width}`);
        await sure.getByRole("button", { name: "Cancel" }).tap();
        await expect(sure).toHaveCount(0);
        // Where two branches change the same lines, both sides are reached (side by side, scrolling inside the area, not the page).
        const sides = dlg.getByTestId("tree-overlap-sides").first();
        await sides.scrollIntoViewIfNeeded();
        await noSideScroll(page);
        await shoot(page, `phone-surfaces-17-tree-diff-${size.width}`);
        await dlg.getByTestId("tree-back").tap();
        const form = dlg.getByTestId("tree-back-form");
        await expect(form).toBeVisible();
        await form.scrollIntoViewIfNeeded();
        await inside(page, form);
        expect(await small(form), "the send-back form's controls are finger targets").toEqual([]);
        await shoot(page, `phone-surfaces-18-tree-back-${size.width}`);
        // Back to the areas by a press, and the other area opens as the same page.
        await dlg.getByTestId("tree-areas-back").scrollIntoViewIfNeeded();
        await dlg.getByTestId("tree-areas-back").tap();
        await expect(dlg.getByTestId("tree-area")).toHaveCount(3);
        await dlg.locator('[data-testid="tree-area"][data-area="src/landing"]').tap();
        await expect(dlg.locator('[data-testid="tree-file"][data-path="src/landing/queue.ts"]')).toBeVisible();
        await noSideScroll(page);
        // The same review at 150% text: the areas and the land-all header read whole and are targets, inside the page.
        await page.evaluate(() => localStorage.setItem("keel.textScale", "1.5"));
        await page.reload();
        // (The board is still the open panel after a reload.)
        await expect(page.getByTestId("work-board")).toBeVisible();
        await page.getByTestId("board-review-tree").tap();
        await expect(dlg.getByTestId("tree-area")).toHaveCount(3);
        expect(await phoneProblems(dlg), "the tree review's areas at 150% text").toEqual([]);
        await shoot(page, `phone-surfaces-29-tree-areas-large-${size.width}`);
        await dlg.locator('[data-testid="tree-area"][data-area="src/board"]').tap();
        await expect(dlg.getByTestId("tree-area-files")).toBeVisible();
        await dlg.getByTestId("tree-land-all").scrollIntoViewIfNeeded();
        expect(await phoneProblems(dlg), "the tree review's area at 150% text").toEqual([]);
        await shoot(page, `phone-surfaces-30-tree-area-large-${size.width}`);
      } finally {
        await drop(request, coord);
      }
    });
    test("Settings > Alerts: the sound switch is a pill a finger can press, and the routes leave their first column room to read", async ({ page }) => {
      await page.goto("/settings/alerts");
      const sw = page.getByTestId("alert-sound");
      await expect(sw).toBeVisible();
      const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
      // The switch is a target of 2.75 rem each way, and the track drawn in it is a pill, not a disc.
      const box = (await sw.boundingBox())!;
      expect(Math.min(box.width, box.height), "the switch is a finger's target").toBeGreaterThanOrEqual(2.75 * rem - 1);
      const track = await sw.evaluate((el) => { const b = getComputedStyle(el, "::before"); return { w: parseFloat(b.width), h: parseFloat(b.height) }; });
      expect(track.w, "the track is wider than it is tall").toBeGreaterThan(track.h * 1.5);
      // The first column of the routes is a line's width, not a strip a word wide.
      const label = (await page.getByTestId("alert-groups").locator("tbody td").first().boundingBox())!;
      expect(label.width, "the alert's words have room").toBeGreaterThanOrEqual(8.5 * rem);
      expect(await phoneProblems(page.getByTestId("settings-scroll")), "alerts section").toEqual([]);
      await page.getByTestId("alert-fine-toggle").tap();
      await expect(page.getByTestId("alert-kinds")).toBeVisible();
      expect(await phoneProblems(page.getByTestId("settings-scroll")), "alerts section, each kind").toEqual([]);
      await shoot(page, `phone-surfaces-20-alerts-${size.width}`);
    });
    test("the model picker keeps every control of a row inside the row, and an ACP agent's models are folded to its row", async ({ page, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      const base = ((await (await request.get("/api/models")).json()).models as any[]).find((m) => m.id === STAND_IN);
      const LONG = "opengateway/z-ai/glm-5.4-extended-context-instruct-preview-quantized";
      const acp = (model: string, name: string) => ({ ...base, id: `acp:${model}`, provider: "acp", model, name, billing: "subscription", price: undefined, context: model.length % 3 ? 1_000_000 : 200_000 });
      const agents = [acp("opencode", "OpenCode"), ...Array.from({ length: 12 }, (_, i) => acp(`opencode/${LONG}-${i}`, `OpenCode: ${LONG}-${i}`)), acp("codex", "Codex"), ...["a", "b"].map((x) => acp(`codex/gpt-${x}`, `Codex: gpt-${x}`))];
      await page.route(/\/api\/models(\?.*)?$/, async (route) => { const res = await route.fetch(); const body = await res.json(); await route.fulfill({ response: res, json: { ...body, models: [...body.models, ...agents] } }); });
      const id = await start(request, "Phone picker");
      try {
        await request.post(`/api/sessions/${id}/messages`, { data: { text: "Say hello." } });
        await expect.poll(() => idle(request, id), { timeout: 60_000 }).toBe(true);
        await page.goto(`/s/${id}`);
        const pane = page.getByRole("region", { name: /^Phone picker, / });
        await pane.getByRole("button", { name: "Show the model and tools" }).tap();
        await pane.getByTestId("model-picker").tap();
        const popup = page.getByTestId("model-popup");
        await expect(popup).toBeVisible();
        await expect(popup.getByTestId("model-option").first()).toBeVisible();
        // The agent's models are one row with a count until it is opened.
        const open = popup.locator('[data-group="agent:opencode"]');
        await expect(open.getByTestId("model-option")).toHaveCount(1);
        await expect(open.getByTestId("agent-toggle")).toHaveText(/^1\d models$/);
        // No control of a row stands outside it (a row's columns wrap to the lines under its name).
        const spill = () => popup.getByTestId("model-option").evaluateAll((rows) => rows.flatMap((r) => {
          const b = r.getBoundingClientRect();
          return [...r.querySelectorAll<HTMLElement>("*")].filter((c) => { const x = c.getBoundingClientRect(); return x.width > 0 && (x.right > b.right + 0.5 || x.left < b.left - 0.5); }).map((c) => `${(r as HTMLElement).dataset.model}: ${c.dataset.testid ?? c.tagName}`);
        }));
        expect(await spill(), "parts of a row outside it").toEqual([]);
        await shoot(page, `phone-surfaces-21-picker-${size.width}`);
        await open.getByTestId("agent-toggle").tap();
        await expect.poll(() => open.getByTestId("model-option").count()).toBeGreaterThan(12);
        expect(await spill(), "parts of a row outside it, the agent open").toEqual([]);
        expect(await small(popup.getByTestId("model-option").first()), "a row's own controls are finger targets").toEqual([]);
        await shoot(page, `phone-surfaces-22-picker-agents-${size.width}`);
      } finally {
        await page.unroute(/\/api\/models(\?.*)?$/);
        await drop(request, id);
      }
    });
    test("the new models' folded list is a row of two lines a finger can press, and the list measures what it draws", async ({ page, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      test.setTimeout(120_000);
      const batch = `flood${Math.random().toString(36).slice(2, 6)}`;
      const models = async () => (await (await request.get("/api/models?refresh=1")).json()).models.map((m: any) => m.id) as string[];
      for (const e of (await (await request.get("/api/experiments")).json()).experiments) if (e.state === "running" && e.mode === "live") await request.post(`/api/experiments/${e.id}/stop`);
      const say = async (text: string) => {
        const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: `new models ${batch}`, text } })).json();
        await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.settings.last_end, { timeout: 30_000 }).toBeTruthy();
      };
      try {
        // (A daemon's first listing is its baseline, not news: it is made before the models this test adds.)
        await models();
        await say(`script:list-models ${batch} 300`);
        expect((await models()).filter((m) => m.startsWith(`scripted:${batch}.`))).toHaveLength(300);
        await page.goto("/");
        await expect(page.getByTestId("new-model-news")).toContainText("300 new models", { timeout: 20_000 });
        await page.getByTestId("new-model-news").tap();
        await page.getByTestId("new-models-toggle").tap();
        const group = page.locator('[data-testid="new-models-group"][data-provider="scripted"]');
        await group.getByTestId("new-models-group-toggle").tap();
        const rows = group.getByTestId("new-models-row");
        await expect(rows.first()).toBeVisible();
        const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
        // A row is as tall as the list takes it to be (it spaces the rows it does not draw by that height), and a finger's target.
        const takes = await group.getByTestId("new-models-scroll").evaluate((el) => el.querySelector<HTMLElement>("[data-probe]")!.offsetHeight / 2);
        const row = (await rows.first().boundingBox())!;
        expect(Math.abs(row.height - takes), "the row's height is what the list assumes").toBeLessThan(1);
        expect(row.height, "the row is a finger's target").toBeGreaterThanOrEqual(2.75 * rem - 1);
        // The name is whole on its own line; its window and price are under it.
        expect(await rows.first().locator("span").first().evaluate((e) => e.scrollWidth > e.clientWidth + 1), "the name is cut").toBe(false);
        const [name, win] = await Promise.all([rows.first().locator("span").nth(0).boundingBox(), rows.first().locator("span").nth(1).boundingBox()]);
        expect(win!.y, "the window is under the name").toBeGreaterThanOrEqual(name!.y + name!.height - 1);
        await noSideScroll(page);
        await shoot(page, `phone-surfaces-23-new-models-list-${size.width}`);
      } finally {
        await say(`script:unlist-models ${batch}`);
        await models();
      }
    });
    test("the work board writes a one-line agent's title and its reviews whole, and says a check passed on uncommitted files", async ({ page, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      const id = await start(request, "Phone board lines");
      try {
        const head = "b3166396dd37cfd55fb0fd54b7bafd8f0457e17c";
        const row = (n: number, extra: Record<string, unknown>) => ({
          id: `${n}`.repeat(12), session_id: `s-${n}`, parent_id: id, depth: 1, title: `Lane ${n}`, type: "general-purpose", model: STAND_IN, state: "completed", created: Date.now() - 600_000, ended: Date.now(), machine: null,
          branch: `keel/lane-${n}`, repo: "/r", base: "main", head, ahead: 1, behind: 0, worktree: "here",
          checks: { state: "known", passed: [], failed: [], notRun: ["notes"], uncommitted: { passed: ["notes", "typecheck"], failed: [] } }, reviews: [], queue: null, live: null,
          work: { uncommitted: { files: 3, added: 20, removed: 4 }, branch: { files: 2, added: 5, removed: 1 } }, landed: { state: "no", missing: 1 }, review: null, ...extra,
        });
        const none = { branch: null, head: null, work: null, checks: null, landed: null };
        const rows = [
          row(1, {}),
          row(3, { ...none, title: "Reviewer of the second lane with a very long name that goes on", reviews: ["111111111111", "222222222222"], state: "working", ended: null }),
          row(5, { ...none, title: "Another reader nested deep in the tree of agents", parent_id: "s-3", depth: 3, reviews: ["111111111111"] }),
        ];
        await page.route(`**/api/sessions/${id}/board*`, (route) => route.fulfill({ json: { session_id: id, rows, total: rows.length, repos: [{ repo: "/r", base: "main", base_tip: head, deploys: [] }], at: Date.now(), took_ms: 3 } }));
        await page.goto(`/s/${id}`);
        await page.getByTestId("panel-menu").first().tap();
        await page.getByTestId("panel-pick-board").tap();
        const board = page.getByTestId("work-board");
        await expect(board.getByTestId("board-row")).toHaveCount(3);
        // A phone shows a row an agent; the facts open on a tap.
        for (const t of await board.getByTestId("board-toggle").all()) await t.tap();
        await expect(board.getByTestId("board-checks")).toContainText("passed on uncommitted files");
        expect(await phoneProblems(board), "the board").toEqual([]);
        await shoot(page, `phone-surfaces-24-board-lines-${size.width}`);
      } finally {
        await page.unroute(`**/api/sessions/${id}/board*`);
        await drop(request, id);
      }
    });
    test("an ACP agent's child rows write the child's name and what it asks whole, in the transcript and under the session", async ({ page, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      test.setTimeout(120_000);
      await request.delete("/api/acp/agents/children-p").catch(() => {});
      expect((await request.post("/api/acp/agents", { data: { id: "children-p", command: "bun", args: [join(import.meta.dirname, "fixtures/acp-agent-children.ts")] } })).ok()).toBe(true);
      const ws = folder("phone-acp-children");
      const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: "acp:children-p", title: "Phone ACP children" } })).json();
      try {
        await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
        await page.goto(`/s/${session.id}`);
        const pane = page.getByRole("region", { name: /Phone ACP children/ });
        await pane.getByTestId("composer").fill("start the children");
        await page.keyboard.press("Enter");
        const lines = pane.getByTestId("agent-line");
        await expect(lines).toHaveCount(2, { timeout: 45_000 });
        await expect(pane.getByTestId("approval").first()).toBeVisible({ timeout: 30_000 });
        // Each child's row: its name and what it asks are whole (a line of the row, wrapped), and every control is a target.
        const cut = await lines.evaluateAll((els) => els.flatMap((l) => [...l.querySelectorAll<HTMLElement>('[data-testid="agent-line-name"], [data-testid="agent-line-step"]')].filter((e) => e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1).map((e) => e.textContent)));
        expect(cut, "words of the child rows cut off").toEqual([]);
        await noSideScroll(page);
        await shoot(page, `phone-surfaces-25-acp-children-${size.width}`);
        // The step's own line for each child names it too.
        await pane.getByTestId("work-step").locator(".k-line[data-step]").first().tap();
        const titles = pane.getByTestId("agent-call-title");
        await expect(titles).toHaveCount(2);
        for (const t of await titles.all()) {
          expect(await t.evaluate((e) => e.scrollHeight - e.clientHeight), "the call's words are cut").toBeLessThanOrEqual(1);
          const b = (await t.boundingBox())!;
          expect(b.x + b.width).toBeLessThanOrEqual(size.width);
          expect(b.width, "the name has a line to stand on").toBeGreaterThan(size.width * 0.5);
        }
        await noSideScroll(page);
        await shoot(page, `phone-surfaces-26-acp-children-calls-${size.width}`);
      } finally {
        await drop(request, session.id);
        await request.delete("/api/acp/agents/children-p");
      }
    });
    test("the row that says other sessions wait is one finger-high target, in readable words, that goes to the next", async ({ page, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      await settle(request);
      // A plan card has no header to hold the count as a chip: the count is a row above the cards.
      const a = await create(request, "Phone waits plan", folder("phone-waits-a"));
      const b = await create(request, "Phone waits question", folder("phone-waits-b"));
      try {
        await ask(request, a, "plan");
        await ask(request, b, "question");
        for (const scale of [1, 1.5]) {
          await page.goto(`/s/${a}`);
          await page.evaluate((s) => localStorage.setItem("keel.textScale", String(s)), scale);
          await page.reload();
          const row = page.getByTestId("waiting-elsewhere");
          await expect(row).toBeVisible();
          await expect(row).toContainText(/waits? for you/);
          await row.scrollIntoViewIfNeeded();
          await shoot(page, `phone-surfaces-28-waiting-row-${size.width}-${scale * 100}`);
          const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
          const words = await row.locator("p span").first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
          expect(words, `the words are at least 13px at ${scale * 100}% (0.8125 rem)`).toBeGreaterThanOrEqual(0.8125 * rem - 0.5);
          const next = row.getByTestId("waiting-next");
          const r = (await row.boundingBox())!, n = (await next.boundingBox())!;
          expect(n.height, "the row is a finger's height").toBeGreaterThanOrEqual(2.75 * rem - 1);
          expect(n.width, "the whole row goes to the next, not a word at its end").toBeGreaterThanOrEqual(r.width * 0.9);
          await noSideScroll(page);
          // A press on its words, far from the label, goes to the next.
          await row.tap({ position: { x: 12, y: r.height / 2 } });
          await expect(page).not.toHaveURL(new RegExp(`/s/${a}$`));
        }
      } finally {
        await page.evaluate(() => localStorage.removeItem("keel.textScale")).catch(() => {});
        await drop(request, a, b);
      }
    });
    test("the work board is a row an agent with its state and its one action, and its facts open on a tap", async ({ page, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      await settle(request);
      const id = await start(request, "Phone board rows");
      const q = await create(request, "Phone board asker", folder("phone-board-asker"));
      try {
        await ask(request, q, "question");
        const head = "b3166396dd37cfd55fb0fd54b7bafd8f0457e17c";
        const row = (n: number, extra: Record<string, unknown>) => ({
          id: `${n}`.repeat(12), session_id: `s-${n}`, parent_id: id, depth: 1, title: `Lane ${n}`, type: "general-purpose", model: STAND_IN, state: "completed", created: Date.now() - 600_000, ended: Date.now(), machine: null,
          branch: `keel/lane-${n}`, repo: "/r", base: "main", head, ahead: 1, behind: 0, worktree: "here",
          checks: { state: "known", passed: ["notes"], failed: [], notRun: [] }, reviews: [], queue: null, live: null,
          work: { uncommitted: null, branch: { files: 2, added: 5, removed: 1 } }, landed: { state: "no", missing: 1 }, review: null, ...extra,
        });
        const rows = [
          row(1, {}),
          row(2, { review: { by: "222222222222", title: "Reviewer", how: "verdict", state: "completed", verdict: "refused", source: "verdict", line: "LAND: no", tip: head, of: head, current: true } }),
          row(3, { session_id: q, state: "running", ended: null, landed: { state: "no", missing: 1 } }),
        ];
        await page.route(`**/api/sessions/${id}/board*`, (route) => route.fulfill({ json: { session_id: id, rows, total: rows.length, repos: [{ repo: "/r", base: "main", base_tip: head, deploys: [] }], at: Date.now(), took_ms: 3 } }));
        await page.goto(`/s/${id}`);
        await page.getByTestId("panel-menu").first().tap();
        await page.getByTestId("panel-pick-board").tap();
        const board = page.getByTestId("work-board");
        const cards = board.getByTestId("board-row");
        const agent = (n: number) => board.locator(`[data-agent="${`${n}`.repeat(12)}"]`);
        await expect(cards).toHaveCount(3);
        const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
        await shoot(page, `phone-surfaces-29-board-rows-${size.width}`);
        // Collapsed: a row each, with no checks tile and no branch hash, and exactly one action.
        for (const c of await cards.all()) {
          expect((await c.boundingBox())!.height, "a row, not a card").toBeLessThanOrEqual(5 * rem);
          await expect(c.getByTestId("board-state")).toBeVisible();
          await expect(c.locator('[data-testid="board-answer"], [data-testid="board-land"], [data-testid="board-open"]')).toHaveCount(1);
        }
        await expect(board.getByTestId("board-checks")).toHaveCount(0);
        await expect(board.getByTestId("board-head")).toHaveCount(0);
        await expect(agent(1).getByTestId("board-land")).toBeVisible();
        // A refused review holds the landing: Land is the row's one action, held.
        await expect(agent(2).getByTestId("board-land")).toBeDisabled();
        await expect(agent(3).getByTestId("board-answer")).toBeVisible();
        expect(await phoneProblems(board), "the board's rows").toEqual([]);
        // A tap on a row opens its facts, and a second closes them.
        const first = agent(1);
        await first.getByTestId("board-toggle").tap();
        await expect(first.getByTestId("board-toggle")).toHaveAttribute("aria-expanded", "true");
        await expect(first.getByTestId("board-checks")).toBeVisible();
        await expect(first.getByTestId("board-head")).toBeVisible();
        await noSideScroll(page);
        expect(await phoneProblems(board), "the board with a row open").toEqual([]);
        await shoot(page, `phone-surfaces-30-board-row-open-${size.width}`);
        await first.getByTestId("board-toggle").tap();
        await expect(first.getByTestId("board-checks")).toHaveCount(0);
        // Answer goes to what the agent asks.
        await agent(3).getByTestId("board-answer").tap();
        await expect(page).toHaveURL(new RegExp(`/s/${q}$`));
      } finally {
        await page.unroute(`**/api/sessions/${id}/board*`);
        await drop(request, id, q);
      }
    });
    test("the top bar is one line on a phone, working or at rest: the title cut to the room, the state's dot and its age; its word and reason are the menu's first row, whole", async ({ page, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      const id = await start(request, "Phone head one line with a title long enough to be cut by the room the bar leaves it");
      try {
        await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([{ name: "Bash", input: { command: "sleep 30", description: "Building the whole documentation cache from every source folder in the checkout module" } }]) } });
        await page.goto(`/s/${id}`);
        const station = page.locator(".k-station[data-helm]");
        const why = station.getByTestId("station-why");
        await expect(why).toContainText("Building the whole documentation cache", { timeout: 30_000 });
        // One line: the bar is as tall as one row of its controls, whichever the state, and the title is cut inside its room.
        const bar = async () => station.locator(".k-top").evaluate((el) => Math.round(el.getBoundingClientRect().height));
        const working = await bar();
        const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
        expect(working, "the top bar of a working session is one row").toBeLessThanOrEqual(Math.ceil(3.25 * rem));
        const title = station.getByTestId("station-title");
        expect(await title.evaluate((e) => e.scrollWidth > e.clientWidth + 1), "a long title is cut by an ellipsis").toBe(true);
        const clock = station.getByTestId("station-clock");
        await expect(clock).toBeVisible();
        const dot = station.locator(".k-station-state .k-mark");
        await expect(dot).toBeVisible();
        expect(await station.getByTestId("station-word").evaluate((e) => (e.textContent ?? "").trim().length > 0), "its word is still there for a reader").toBe(true);
        expect(await why.isVisible(), "the reason is not on the bar").toBe(false);
        // The word and the reason, whole, open the menu.
        await station.getByTestId("session-menu").tap();
        const said = page.getByTestId("menu-state");
        await expect(said.getByTestId("menu-state-word")).toHaveText("Working");
        await expect(said.getByTestId("menu-state-why")).toContainText("Building the whole documentation cache");
        const cut = await said.evaluate((e) => [...e.querySelectorAll<HTMLElement>("span")].filter((s) => s.scrollWidth > s.clientWidth + 1).length);
        expect(cut, "the menu's state is not cut").toBe(0);
        await noSideScroll(page);
        await shoot(page, `phone-surfaces-27-head-one-line-${size.width}`);
        await page.keyboard.press("Escape");
        await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } });
        await expect.poll(() => idle(request, id), { timeout: 30_000 }).toBe(true);
        expect(await bar(), "and at rest").toBeLessThanOrEqual(Math.ceil(3.25 * rem));
      } finally {
        await drop(request, id);
      }
    });
    test("the message box's tools are whole while a turn runs at a large text size: none cut to a sliver or over another", async ({ browser, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      const id = await start(request, "Phone running tools");
      try {
        await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([{ name: "Bash", input: { command: "sleep 30" } }]) } });
        for (const scale of [1, 1.3, 1.5]) {
          const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: size, hasTouch: true, isMobile: true });
          await ctx.addInitScript((s) => localStorage.setItem("keel.textScale", String(s)), scale);
          const page = await ctx.newPage();
          try {
            await page.goto(`/s/${id}`);
            const box = page.locator(".k-station[data-helm]").locator(".k-box");
            await expect(box.getByTestId("stop")).toBeVisible({ timeout: 30_000 });
            await expect(box.getByTestId("permission-menu")).toBeVisible();
            // Every tool of the row is a whole target inside the box, and a press at its middle lands on it. The attach
            // button gives its place to the mode while a turn runs, so a tool with no box (display none) is not in the row.
            // The queue button is drawn only when the box can queue.
            const bad = await box.evaluate((el) => {
              const b = el.getBoundingClientRect(), out: string[] = [], rects: { id: string; r: DOMRect }[] = [];
              for (const id of ["permission-menu", "effort-picker", "model-picker", "context-meter", "queue-button", "stop", "send"]) {
                const t = el.querySelector(`[data-testid="${id}"]`);
                if (!t) continue;
                const r = t.getBoundingClientRect();
                const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                if (r.left < b.left - 0.5 || r.right > b.right + 0.5 || r.bottom > b.bottom + 0.5) out.push(`${id} outside the box`);
                if (!hit || !t.contains(hit)) out.push(`${id} is not what a press at its middle reaches`);
                for (const o of rects) if (r.left < o.r.right - 1 && r.right > o.r.left + 1 && r.top < o.r.bottom - 1 && r.bottom > o.r.top + 1) out.push(`${id} over ${o.id}`);
                rects.push({ id, r });
              }
              return out;
            });
            expect(bad, `the tools at ${scale * 100}% text`).toEqual([]);
            await noSideScroll(page);
            await shoot(page, `phone-surfaces-28-running-tools-${size.width}-${scale}`);
          } finally { await ctx.close(); }
        }
        await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } });
      } finally {
        await drop(request, id);
      }
    });
    test("a question the agent asks can be put away with Later by a finger, and the count in the head is pressed back", async ({ page, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      await settle(request);
      const id = await create(request, "Phone later question", folder("phone-later-q"));
      try {
        await ask(request, id, "question");
        await page.goto(`/s/${id}`);
        const card = page.getByTestId("question");
        await expect(card).toBeVisible();
        // The card has no head row on a phone: Later stands in its foot, a target inside the card.
        const later = card.getByTestId("ask-later");
        await expect(later).toBeVisible();
        await expect.poll(async () => { const b = await later.boundingBox(); return !!b && b.x >= 0 && b.x + b.width <= size.width && b.y + b.height <= size.height; }, { message: "Later is inside the page" }).toBe(true);
        await expect.poll(() => small(card), { message: "every control of the question card is a finger's target" }).toEqual([]);
        await shoot(page, `phone-surfaces-27-question-later-${size.width}`);
        await later.tap();
        await expect(card).toHaveCount(0);
        const pill = page.getByTestId("later-pill");
        await expect(pill).toHaveText("1 waiting");
        await expect.poll(async () => { const b = await pill.boundingBox(); return !!b && b.x >= 0 && b.x + b.width <= size.width; }, { message: "the count is inside the page" }).toBe(true);
        await expect.poll(() => small(pill.locator("xpath=..")), { message: "the head's controls are finger targets" }).toEqual([]);
        await pill.tap();
        await expect(card).toBeVisible();
      } finally {
        await drop(request, id);
      }
    });
    test("the dock's plan, command and changes lines are targets that touch no other and read whole, also at a large text size", async ({ browser, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      test.setTimeout(180_000);
      const id = await fullDock(request, "Phone dock");
      try {
        for (const scale of [1, 1.5]) {
          const { ctx, page } = await atScale(browser, size, scale);
          try {
            await page.goto(`/s/${id}`);
            const dock = page.getByTestId("session-dock");
            await expect(dock.getByTestId("dock-job")).toBeVisible({ timeout: 30_000 });
            await expect(dock.getByTestId("dock-changes")).toBeVisible();
            await expect(dock.getByTestId("dock-plan")).toBeVisible();
            await page.waitForTimeout(400);
            // A button of one line reaches only its own line: Stop on the command and Review on the changes never cover each other.
            expect(await overlaps(dock, "button"), `controls over each other at ${scale * 100}% text`).toEqual([]);
            for (const line of ["dock-plan", "dock-job", "dock-changes"]) expect(await phoneProblems(dock.getByTestId(line)), `${line} at ${scale * 100}% text`).toEqual([]);
            await shoot(page, `phone-surfaces-29-dock-${size.width}-${scale}`);
          } finally { await ctx.close(); }
        }
      } finally {
        await drop(request, id);
      }
    });
    test("the dock's agents line says its counts and that it waits whole at a large text size", async ({ browser, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      test.setTimeout(180_000);
      const id = await fullDock(request, "Phone agents line");
      try {
        for (const scale of [1, 1.5]) {
          const { ctx, page } = await atScale(browser, size, scale);
          try {
            await page.goto(`/s/${id}`);
            const line = page.getByTestId("dock-agents");
            await expect(line.getByTestId("dock-agents-waiting")).toBeVisible({ timeout: 30_000 });
            await page.waitForTimeout(400);
            // Each count shows all its words: the line grows a row rather than cut a part or the word that it waits.
            const cut = await line.evaluate((el) => [...el.querySelectorAll<HTMLElement>('[data-testid="dock-agents-part"], [data-testid="dock-agents-waiting"]')].filter((p) => {
              const r = p.getBoundingClientRect();
              for (let a = p.parentElement; a && a !== el.parentElement; a = a.parentElement) {
                const b = a.getBoundingClientRect();
                if (r.right > b.right + 0.5 || r.bottom > b.bottom + 0.5 || r.left < b.left - 0.5) return true;
              }
              return false;
            }).map((p) => p.textContent));
            expect(cut, `counts cut at ${scale * 100}% text`).toEqual([]);
            expect(await phoneProblems(line), `the agents line at ${scale * 100}% text`).toEqual([]);
            await shoot(page, `phone-surfaces-30-agents-line-${size.width}-${scale}`);
          } finally { await ctx.close(); }
        }
      } finally {
        await drop(request, id);
      }
    });
    test("the agents list the dock opens reads whole and keeps each Stop inside its row, also at a large text size", async ({ browser, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      test.setTimeout(180_000);
      const id = await fullDock(request, "Phone agents list");
      try {
        for (const scale of [1, 1.5]) {
          const { ctx, page } = await atScale(browser, size, scale);
          try {
            await page.goto(`/s/${id}`);
            await page.getByTestId("dock-agents").tap();
            const popup = page.getByTestId("background-popup");
            await expect(popup.getByTestId("bg-agent")).toHaveCount(1);
            await page.waitForTimeout(400);
            await expect(popup.getByTestId("bg-agent-stop")).toBeVisible();
            expect(await phoneProblems(popup), `the agents list at ${scale * 100}% text`).toEqual([]);
            expect(await overlaps(popup, "button, [role=button]"), `controls over each other at ${scale * 100}% text`).toEqual([]);
            await shoot(page, `phone-surfaces-31-agents-list-${size.width}-${scale}`);
          } finally { await ctx.close(); }
        }
      } finally {
        await drop(request, id);
      }
    });
    test("the waiting chip in a card's header has its own row on a phone: it covers no word and no control, also at a large text size", async ({ browser, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      test.setTimeout(180_000);
      await settle(request);
      const ids = [await create(request, "Phone chip one", folder("phone-chip-1")), await create(request, "Phone chip two", folder("phone-chip-2")), await create(request, "Phone chip three", folder("phone-chip-3"))];
      try {
        for (const id of ids) await ask(request, id, "approval");
        // (An agent's question has no head row on a phone, so its count stands in a line over it: nothing to wrap.)
        for (const kind of ["approval"] as const) {
          for (const scale of [1, 1.5]) {
            const { ctx, page } = await atScale(browser, size, scale);
            try {
              await page.goto(`/s/${ids[0]}`);
              const here = page.locator(".k-station[data-helm]");
              const chip = here.getByTestId("waiting-elsewhere");
              await expect(chip).toBeVisible({ timeout: 30_000 });
              await page.waitForTimeout(400);
              // The header the chip stands in: each of its parts inside it, and no two over each other.
              const bad = await chip.evaluate((el) => {
                const head = el.closest("[data-waiting-slot]")!.parentElement!, h = head.getBoundingClientRect(), out: string[] = [];
                const parts = [...head.children].map((c) => ({ c: c as HTMLElement, r: c.getBoundingClientRect() })).filter((x) => x.r.width > 1 && x.r.height > 1);
                const name = (e: HTMLElement) => e.dataset.testid ?? e.dataset.waitingSlot ?? `${e.tagName.toLowerCase()} "${(e.textContent ?? "").trim().slice(0, 14)}"`;
                for (const x of parts) if (x.r.right > h.right + 0.5 || x.r.left < h.left - 0.5) out.push(`${name(x.c)} outside the header`);
                for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
                  const a = parts[i]!.r, b = parts[j]!.r;
                  if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push(`${name(parts[i]!.c)} over ${name(parts[j]!.c)}`);
                }
                // A word cut to a sliver: the title's lines are each wider than a few letters.
                for (const x of parts) if (x.c.dataset.testid !== "waiting-elsewhere" && x.c.scrollWidth > x.c.clientWidth + 1 && getComputedStyle(x.c).overflow !== "visible") out.push(`${name(x.c)} cut`);
                return out;
              });
              expect(bad, `the ${kind} card's header at ${scale * 100}% text`).toEqual([]);
              expect(await small(here.getByTestId("composer-asks")), "every control of the card is a finger's target").toEqual([]);
              await shoot(page, `phone-surfaces-32-chip-${kind}-${size.width}-${scale}`);
            } finally { await ctx.close(); }
          }
        }
      } finally {
        await drop(request, ...ids);
      }
    });
    test("a row's dot says its word on a phone, where a tooltip cannot be read: done, a command or agents in the background, news", async ({ browser, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      test.setTimeout(180_000);
      const made: string[] = [];
      const mk = async (title: string, text: string) => { const id = await start(request, title); made.push(id); await request.post(`/api/sessions/${id}/messages`, { data: { text } }); return id; };
      try {
        const hold = calls([{ name: "Bash", input: { command: "sleep 120" } }]);
        const lead = await mk("Phone dots lead", calls([{ name: "spawn_agent", input: { message: `Hold the lane\n${hold}`, isolation: "none" } }]));
        const command = await mk("Phone dots command", calls([{ name: "Bash", input: { command: "sleep 240", run_in_background: true, description: "the long migration" } }]));
        const done = await mk("Phone dots done", "script:say Done.");
        const news = await mk("Phone dots news", "script:say Done, and not read yet.");
        for (const id of [done, news]) await expect.poll(() => idle(request, id), { timeout: 60_000 }).toBe(true);
        await expect.poll(async () => { const st = (await (await request.get("/api/state")).json()).states ?? {}; return [lead, command].map((id) => st[id]?.watch).join(" "); }, { timeout: 60_000 }).toBe("work work");
        await request.post(`/api/sessions/${news}/marks`, { data: { unread: true } });
        await request.post(`/api/sessions/${done}/marks`, { data: { unread: false } });
        for (const scale of [1, 1.5]) {
          const { ctx, page } = await atScale(browser, size, scale);
          try {
            await page.goto(`/s/${done}`);
            await page.getByTestId("show-sidebar").first().tap();
            const row = (id: string) => page.locator(`[data-testid="session-row"][data-session="${id}"]`);
            // The words are in the row's visible part: a press at the middle of the word reaches the row's own text (not clipped away, nor under another part), and it is whole.
            const shown = (r: Locator, word: string) => r.evaluate((el, w) => {
              const e = [...el.querySelectorAll<HTMLElement>("span")].find((x) => x.children.length === 0 && (x.textContent ?? "").includes(w) && !x.classList.contains("sr-only"));
              if (!e) return false;
              const b = e.getBoundingClientRect();
              if (b.width < 1 || e.scrollWidth > e.clientWidth + 1) return false;
              const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
              return !!at && e.contains(at);
            }, word);
            for (const id of made) await expect(row(id)).toBeVisible();
            await page.waitForTimeout(500);
            // What the dot says to a reader is written in its row for a finger: there is no tooltip to wait for.
            for (const id of made) await row(id).scrollIntoViewIfNeeded();
            for (const [id, word] of [[lead, "Waiting on agents"], [command, "Command in background"], [done, "Done"], [news, "Done"]] as const) {
              const mark = row(id).locator(".k-mark");
              await expect(mark).toHaveAttribute("aria-label", word);
              await row(id).scrollIntoViewIfNeeded();
              expect(await shown(row(id), word), `"${word}" shown in the row at ${scale * 100}% text`).toBe(true);
            }
            expect(await shown(row(news), "New"), "the white dot's word").toBe(true);
            expect(await row(done).evaluate((el) => (el as HTMLElement).innerText), "a row read has no news").not.toContain("New");
            await noSideScroll(page);
            await shoot(page, `phone-surfaces-33-dot-words-${size.width}-${scale}`);
          } finally { await ctx.close(); }
        }
        await request.post(`/api/sessions/${command}/interrupt`, { data: { by: "owner" } });
      } finally {
        await drop(request, ...made);
      }
    });
    test("the tab strip's marks say which session is which: the dot and the first word of its title, whole inside a mark a finger can press", async ({ browser, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      const ids = [await start(request, "Billing exporter fix"), await start(request, "Migrate the orders table"), await start(request, "Billing report layout")];
      try {
        for (const id of ids) await request.post(`/api/sessions/${id}/messages`, { data: { text: "script:say hello" } });
        for (const id of ids) await expect.poll(() => idle(request, id), { timeout: 60_000 }).toBe(true);
        for (const scale of [1, 1.5]) {
          const { ctx, page } = await atScale(browser, size, scale);
          try {
            await page.goto(`/s/${ids[1]}`);
            const dock = page.locator(".k-dock");
            await expect(dock.getByTestId("dock-code").first()).toBeVisible({ timeout: 30_000 });
            // Each mark of these sessions names its first word: two of them share one, and the dot beside it still tells them from the rest.
            const words = await dock.getByTestId("dock-code").allInnerTexts();
            for (const w of ["Billing", "Migrate"]) expect(words, `the strip's words at ${scale * 100}% text`).toContain(w);
            // The word is whole (no letters cut by the mark's edge) and the mark is a target.
            const bad = await dock.evaluate((el) => {
              const out: string[] = [];
              for (const c of el.querySelectorAll<HTMLElement>('[data-testid="dock-code"]')) {
                const m = c.closest<HTMLElement>(".k-dock-mark")!, a = c.getBoundingClientRect(), b = m.getBoundingClientRect();
                if (c.scrollWidth > c.clientWidth + 1 || a.left < b.left - 0.5 || a.right > b.right + 0.5) out.push(`${c.textContent} is cut`);
              }
              return out;
            });
            expect(bad, `words cut at ${scale * 100}% text`).toEqual([]);
            expect(await small(dock.locator(".k-dock-list")), "the marks are a finger's targets").toEqual([]);
            await noSideScroll(page);
            await shoot(page, `phone-surfaces-34-tab-words-${size.width}-${scale}`);
          } finally { await ctx.close(); }
        }
      } finally {
        await drop(request, ...ids);
      }
    });
    test("the declined card stacks its model picker, a full-width Retry and the checkbox, also at a large text size", async ({ browser, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      test.setTimeout(120_000);
      const id = await start(request, "Phone declined");
      try {
        await request.post(`/api/sessions/${id}/messages`, { data: { text: "script:refuse" } });
        await expect.poll(() => idle(request, id), { timeout: 60_000 }).toBe(true);
        for (const scale of [1, 1.5]) {
          const { ctx, page } = await atScale(browser, size, scale);
          try {
            await page.goto(`/s/${id}`);
            const card = page.getByTestId("refusal");
            await expect(card).toBeVisible({ timeout: 30_000 });
            await card.scrollIntoViewIfNeeded();
            await page.waitForTimeout(300);
            const rows = await card.evaluate((el) => {
              const pick = el.querySelector<HTMLElement>('[data-testid="model-picker"]')!, retry = [...el.querySelectorAll<HTMLElement>("button")].find((b) => /Retry on it/.test(b.textContent ?? ""))!, label = el.querySelector<HTMLElement>("label")!;
              const c = el.getBoundingClientRect(), r = (e: HTMLElement) => e.getBoundingClientRect();
              return {
                stacked: r(pick).bottom <= r(retry).top + 1 && r(retry).bottom <= r(label).top + 1,
                retryWidth: Math.round(r(retry).width), card: Math.round(c.width), retryCut: retry.scrollWidth > retry.clientWidth + 1,
                labelLines: Math.round(r(label).height / parseFloat(getComputedStyle(label).lineHeight)), labelInside: r(label).right <= c.right + 0.5,
              };
            });
            expect(rows.stacked, `picker, Retry and the checkbox are three rows at ${scale * 100}% text: ${JSON.stringify(rows)}`).toBe(true);
            expect(rows.retryWidth, "Retry is the card's width").toBeGreaterThanOrEqual(rows.card * 0.8);
            expect(rows.retryCut, "Retry's words are whole").toBe(false);
            expect(rows.labelInside, "the checkbox's words are inside the card").toBe(true);
            expect(rows.labelLines, "the checkbox's words take at most two lines").toBeLessThanOrEqual(2);
            expect((await phoneProblems(card)).filter((p) => p.startsWith("small")), "every control of the card is a finger's target").toEqual([]);
            await noSideScroll(page);
            await shoot(page, `phone-surfaces-35-declined-${size.width}-${scale}`);
          } finally { await ctx.close(); }
        }
      } finally {
        await drop(request, id);
      }
    });
    test("the recent-sessions switcher has a phone counterpart in the palette: rows a finger presses, and no key hints where there is no key", async ({ browser, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      const ids = [await start(request, "Switch first"), await start(request, "Switch second"), await start(request, "Switch third")];
      try {
        for (const id of ids) await request.post(`/api/sessions/${id}/messages`, { data: { text: "script:say hello" } });
        for (const id of ids) await expect.poll(() => idle(request, id), { timeout: 60_000 }).toBe(true);
        for (const scale of [1, 1.5]) {
          const { ctx, page } = await atScale(browser, size, scale);
          try {
            for (const id of ids) { await page.goto(`/s/${id}`); await expect(page.getByTestId("session-title").first()).toBeVisible(); }
            // The palette is the phone's way to the switcher (the list's "Search and commands").
            await page.getByTestId("show-sidebar").first().tap();
            await page.getByTestId("open-palette").first().tap();
            await page.getByRole("combobox").first().fill("recent sessions");
            await page.keyboard.press("Enter");
            const sw = page.getByTestId("switcher");
            await expect(sw).toBeVisible();
            await expect(sw.getByTestId("switcher-row")).toHaveCount(3);
            await page.waitForTimeout(300);
            const box = (await sw.boundingBox())!;
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width, "inside the page").toBeLessThanOrEqual(size.width);
            for (const row of await sw.getByTestId("switcher-row").all()) expect((await row.boundingBox())!.height, "a row is a finger's height").toBeGreaterThanOrEqual(2.75 * (await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))) - 1);
            // No key to name: the hints for keys are not on a touch screen.
            expect(await sw.evaluate((el) => [...el.querySelectorAll<HTMLElement>("p")].filter((p) => { const r = p.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (p as HTMLElement).innerText.trim(); }).map((p) => p.innerText)), "the hints for keys (move, open, cancel) shown on a touch screen").toEqual([]);
            await shoot(page, `phone-surfaces-36-switcher-${size.width}-${scale}`);
            await sw.getByTestId("switcher-row").first().tap();
            await expect(sw).toHaveCount(0);
          } finally { await ctx.close(); }
        }
      } finally {
        await drop(request, ...ids);
      }
    });
    test("Customize is a press away in the list's foot at a large text size too, where the foot has no room for its word", async ({ browser }) => {
      for (const scale of [1, 1.5]) {
        const { ctx, page } = await atScale(browser, size, scale);
        try {
          await page.goto("/");
          await page.getByTestId("show-sidebar").first().tap();
          const button = page.getByTestId("customize-button");
          await expect(button, `Customize in the list's foot at ${scale * 100}% text`).toBeVisible();
          const b = (await button.boundingBox())!;
          expect(b.x + b.width, "inside the list").toBeLessThanOrEqual(size.width);
          expect(Math.min(b.width, b.height), "a finger's size").toBeGreaterThanOrEqual(2.75 * (await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))) - 1);
          await shoot(page, `phone-surfaces-37-customize-foot-${size.width}-${scale}`);
          await button.tap();
          await expect(page).toHaveURL(/\/customize/);
        } finally { await ctx.close(); }
      }
    });
  });
}
