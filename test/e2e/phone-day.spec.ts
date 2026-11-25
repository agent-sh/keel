import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the phone day. One walk of what an owner does on a phone, on the scripted provider, at the two
// common phone sizes and at the usual and a large text size: open the page after a night, answer an approval
// and a question, follow a live turn and read while it streams, read an error, dictate a message, switch
// between sessions, turn the phone, lose the connection and come back. At every stop nothing reaches past
// the screen's edge, no words are cut with no mark, and every target is a finger's size.
const MODEL = "scripted:stand-in";
const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;
const bash = (command: string) => calls([{ name: "Bash", input: { command } }]);
const question = calls([{ name: "AskUserQuestion", input: { questions: [{ header: "Scope", question: "Fix only cart.js or the whole module?", options: [{ label: "Only cart.js" }, { label: "Whole module" }], multiSelect: false }] } }]);

// Dictation: a recognizer the spec makes speak.
const SPEECH = () => {
  const w = window as any;
  w.__recs = [];
  class Rec {
    lang = ""; continuous = false; interimResults = false; onresult: any; onend: any; onerror: any; on = false;
    constructor() { w.__recs.push(this); }
    start() { this.on = true; }
    stop() { this.on = false; setTimeout(() => this.onend?.(), 0); }
    abort() { this.on = false; }
    hear(final: string, interim = "") {
      const one = (t: string, isFinal: boolean) => Object.assign([{ transcript: t }], { isFinal });
      this.onresult?.({ results: [...(final ? [one(final, true)] : []), ...(interim ? [one(interim, false)] : [])] });
    }
  }
  w.SpeechRecognition = w.webkitSpeechRecognition = Rec;
};

// The page's sockets, so the spec can cut them as a phone's network does.
const SOCKS = () => {
  const w = window as any;
  w.__socks = [];
  const Native = w.WebSocket;
  w.WebSocket = class extends Native { constructor(...a: any[]) { super(...a); w.__socks.push(this); } };
};

// What is wrong with the screen as it is: reaches past the page, words cut with no mark, targets under a finger.
const AUDIT = (rem: number) => {
  const W = innerWidth, H = innerHeight;
  const out: { kind: string; what: string; detail: string }[] = [];
  const name = (el: Element) => el.getAttribute("data-testid") ?? el.getAttribute("aria-label") ?? (el.className?.toString() || el.tagName).slice(0, 40);
  const live = (el: Element) => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return null; /* a one-pixel box is the screen reader's own text */ const cs = getComputedStyle(el); if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) return null; if (r.bottom <= 0 || r.top >= H || r.right <= 0 || r.left >= W) return null; return r; };
  for (const el of document.querySelectorAll("body *")) {
    if (el.closest("svg") && el.tagName !== "svg") continue;
    if (/(^|\s)(max-md:)?sr-only(\s|$)/.test(el.className?.toString() ?? "")) continue;
    const r = live(el); if (!r) continue;
    const cs = getComputedStyle(el);
    if (r.right > W + 1 && !(el.closest("[data-scroll-x], .overflow-x-auto"))) {
      let scrolls = false; for (let a = el.parentElement; a; a = a.parentElement) if (/auto|scroll|hidden|clip/.test(getComputedStyle(a).overflowX) && a.getBoundingClientRect().right <= W + 1) { scrolls = true; break; }
      if (!scrolls) out.push({ kind: "past-edge", what: name(el), detail: `right ${Math.round(r.right)} of ${W}` });
    }
    const text = el.children.length === 0 && el.textContent?.trim();
    if (text && /hidden|clip/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== "ellipsis" && cs.display !== "inline") out.push({ kind: "clipped-w", what: name(el), detail: `${text.slice(0, 40)} (${el.scrollWidth}>${el.clientWidth})` });
    if (text && /hidden|clip/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 2 && !/-webkit-box/.test(cs.display) && cs.webkitLineClamp === "none") out.push({ kind: "clipped-h", what: name(el), detail: `${text.slice(0, 40)} (${el.scrollHeight}>${el.clientHeight})` });
    if (/^(button|a|input|select|textarea)$/i.test(el.tagName) || el.getAttribute("role") === "button" || el.getAttribute("role") === "menuitem") {
      if ((el as HTMLInputElement).type === "hidden" || el.closest("[inert]")) continue;
      const lab = el.closest("label"); const rr = (/^(checkbox|radio)$/.test((el as HTMLInputElement).type) && lab ? lab : el).getBoundingClientRect();
      // 2.75rem is the page's finger; 2.25 is the floor under which a miss is likely.
      if (Math.min(rr.width, rr.height) < 2.25 * rem - 0.5) out.push({ kind: "small-target", what: name(el), detail: `${Math.round(rr.width)}x${Math.round(rr.height)} (${(Math.min(rr.width, rr.height) / rem).toFixed(2)}rem)` });
    }
  }
  const de = document.documentElement;
  if (de.scrollWidth > W + 1) out.push({ kind: "page-wider", what: "html", detail: `${de.scrollWidth} > ${W}` });
  return out;
};
const audit = async (page: Page, label: string) => {
  const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  const found = await page.evaluate(AUDIT, rem);
  const seen = new Set<string>();
  const list = found.filter((f) => { const k = `${f.kind}|${f.what}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return list;
};


// A stop passes when the audit finds nothing; what it finds is named in the failure.
const clean = async (page: Page, label: string) => {
  const found = await audit(page, label);
  expect(found.map((f) => `${f.kind}: ${f.what} (${f.detail})`), `${label}: what is wrong with the screen`).toEqual([]);
};

const waitingCount = async (request: APIRequestContext, ids: string[]) => {
  let n = 0;
  for (const id of ids) n += ((await (await request.get(`/api/sessions/${id}/approvals`)).json()).approvals ?? []).length + ((await (await request.get(`/api/sessions/${id}/questions`)).json()).pending ?? []).length;
  return n;
};
const ended = (request: APIRequestContext, id: string, n = 1) => expect.poll(async () => (await (await request.get(`/api/sessions/${id}`)).json()).events.filter((e: any) => e.kind === "turn_end" || e.kind === "error").length, { timeout: 60_000 }).toBeGreaterThanOrEqual(n);

const SIZES = [{ width: 390, height: 844 }, { width: 412, height: 915 }];
for (const size of SIZES) {
  for (const scale of [1, 1.5]) {
    test.describe(`the phone day ${size.width}x${size.height} at ${scale * 100}%`, () => {
      test.use({ viewport: size, hasTouch: true, isMobile: true });
      test.setTimeout(240_000);
      test("a night, answers, a live turn, an error, dictation, switches, a turn of the phone, a lost connection", async ({ page, request, context }) => {
        const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
        test.skip(!models.includes(MODEL), "requires the scripted provider");
        const label = `${size.width}x${size.height}@${scale}`;
        await page.addInitScript(SPEECH);
        await page.addInitScript(SOCKS);
        await page.addInitScript((s) => localStorage.setItem("keel.textScale", String(s)), scale);
        const made: string[] = [];
        const pane = page.locator(".k-station[data-helm]");
        const mk = async (title: string, mode = "full-auto") => {
          const { session } = await (await request.post("/api/sessions", { data: { model: MODEL, title } })).json();
          await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode, sandbox: "off" } });
          made.push(session.id);
          return session.id as string;
        };
        try {
          // ---- The night: three finished, one that failed, and three that wait.
          const titles = ["Fix cart total rounding", "Bump the lockfile", "Why is the import slow"];
          for (const t of titles) { const id = await mk(t); await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:say ${t}: done, nothing left.` } }); await ended(request, id); }
          const broke = await mk("Fetch the report");
          await request.post(`/api/sessions/${broke}/messages`, { data: { text: "script:billing" } });
          await ended(request, broke);
          const waits: string[] = [];
          for (const [t, mode, text] of [["Approve the schema touch", "ask", bash("touch schema.txt")], ["Approve the cache clean", "ask", bash("touch clean.txt")], ["Ask which scope", "full-auto", question]] as const) {
            const id = await mk(t, mode); waits.push(id);
            await request.post(`/api/sessions/${id}/messages`, { data: { text } });
            await expect.poll(() => waitingCount(request, [id]), { timeout: 30_000 }).toBe(1);
          }

          // ---- 1. Open the page after a night: what waits is first, and the screen is clean.
          await page.goto("/");
          await expect(page.getByTestId("home-watch")).toBeVisible();
          await expect(page.getByTestId("home-session").first()).toBeVisible();
          await shoot(page, `phone-day-01-home-${label}`);
          await clean(page, `${label} home`);

          // ---- 2. Answer an approval with a finger. A held button takes a press that stays on it, so the tap is
          // at the place it settled: the page is still while it has been drawn, the button no longer asks to wait.
          const allow = page.getByTestId("home-allow").first();
          await allow.scrollIntoViewIfNeeded();
          await expect(allow).toBeInViewport({ ratio: 1 });
          await expect.poll(() => allow.getAttribute("aria-disabled"), { timeout: 10_000 }).not.toBe("true");
          let at = (await allow.boundingBox())!;
          for (let i = 0; i < 20; i++) { await page.waitForTimeout(150); const now = (await allow.boundingBox())!; if (Math.abs(now.y - at.y) < 0.5 && Math.abs(now.x - at.x) < 0.5) break; at = now; }
          expect(Math.min(at.width, at.height), "the button is a finger").toBeGreaterThanOrEqual(2.25 * (await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))) - 0.5);
          await page.touchscreen.tap(at.x + at.width / 2, at.y + at.height / 2);
          await expect.poll(() => waitingCount(request, waits.slice(0, 2)), { timeout: 20_000 }).toBeLessThan(2);
          await shoot(page, `phone-day-02-after-allow-${label}`);

          // ---- 3. A question, answered with two taps.
          await page.goto(`/s/${waits[2]}`);
          await expect(pane.getByTestId("question-option").first()).toBeVisible();
          await clean(page, `${label} question`);
          await shoot(page, `phone-day-03-question-${label}`);
          await pane.getByTestId("question-option").first().tap();
          await pane.getByTestId("question-submit").tap();
          await expect.poll(() => waitingCount(request, [waits[2]!]), { timeout: 20_000 }).toBe(0);

          // ---- 4. A live turn: the page follows it, a finger that scrolls up to read is not taken back.
          const live = await mk("Streaming run");
          await page.goto(`/s/${live}`);
          await expect(pane.getByTestId("composer")).toBeVisible();
          await page.evaluate(() => { (window as any).__shifts = []; new PerformanceObserver((l) => { for (const e of l.getEntries() as any[]) if (!e.hadRecentInput) (window as any).__shifts.push(e.value); }).observe({ type: "layout-shift", buffered: false }); });
          for (const text of ["script:count", "script:render", "script:count"]) await request.post(`/api/sessions/${live}/messages`, { data: { text } });
          const scroller = () => pane.evaluate((el) => { let s: HTMLElement | null = el.querySelector('[data-testid="transcript"]') as HTMLElement | null; while (s && !(s.scrollHeight > s.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement; return s ? { top: Math.round(s.scrollTop), end: s.scrollHeight - s.scrollTop - s.clientHeight < 4 } : null; });
          await expect.poll(async () => (await scroller())?.top ?? 0, { timeout: 30_000 }).toBeGreaterThan(300);
          expect((await scroller())!.end, "the view follows the end of what streams").toBe(true);
          await clean(page, `${label} live`);
          await shoot(page, `phone-day-04-live-${label}`);
          await pane.evaluate((el) => { let s: HTMLElement | null = el.querySelector('[data-testid="transcript"]') as HTMLElement | null; while (s && !(s.scrollHeight > s.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement; if (s) s.scrollTop = Math.max(0, s.scrollTop - 600); });
          const read0 = (await scroller())!.top;
          await page.waitForTimeout(2500);
          expect(Math.abs((await scroller())!.top - read0), "the stream does not take back a view that was scrolled up").toBeLessThan(8);
          await request.post(`/api/sessions/${live}/interrupt`, { data: { by: "owner" } });

          // ---- 5. An error is one tap from the home screen.
          await page.goto("/");
          await page.getByTestId("home-count-fail").tap();
          await expect(pane.getByTestId("station-word")).toHaveText(/Failed/);
          await clean(page, `${label} error`);
          await shoot(page, `phone-day-05-error-${label}`);

          // ---- 6. Dictate a message from the home screen.
          await page.goto("/");
          const start = page.getByTestId("home-start");
          await expect(start).toBeVisible();
          // (While something waits the box rests as a line: a tap brings its tools, the microphone among them.)
          if (!(await start.getByTestId("dictate").isVisible())) await start.locator("textarea").tap();
          await start.getByTestId("dictate").tap();
          await expect(page.getByTestId("speech-band")).toBeVisible();
          await page.evaluate(() => (window as any).__recs.at(-1).hear("", "fix the"));
          await page.evaluate(() => (window as any).__recs.at(-1).hear("fix the flaky retry test script:say Done, retry is bounded."));
          await clean(page, `${label} dictating`);
          await shoot(page, `phone-day-06-dictating-${label}`);
          await page.getByTestId("speech-end").tap();
          await expect(start.locator("textarea")).toHaveValue(/flaky retry test/);
          await start.getByTestId("send").tap();
          await expect(page).toHaveURL(/\/s\//, { timeout: 20_000 });
          made.push(page.url().split("/").pop()!);
          await expect(pane.getByTestId("user-message").last()).toContainText("flaky retry test");
          await expect(pane.getByTestId("turn-end").last()).toBeVisible({ timeout: 20_000 });

          // ---- 7. Switch between two sessions, with the list's button and a row.
          const [a, b] = [made[0]!, made[1]!];
          await page.goto(`/s/${a}`);
          await expect(pane.getByTestId("station-title")).toContainText(titles[0]!);
          for (let i = 0; i < 4; i++) {
            const to = i % 2 ? a : b, want = i % 2 ? titles[0]! : titles[1]!;
            await pane.getByTestId("show-sidebar").tap();
            await page.locator(`[data-testid="session-row"][data-session="${to}"]`).first().tap();
            await expect(pane.getByTestId("station-title")).toContainText(want, { timeout: 10_000 });
          }

          // ---- 8. Turn the phone: the conversation keeps most of the height (phone-land.spec.ts has the whole of it).
          await page.goto(`/s/${a}`);
          await expect(pane.getByTestId("composer")).toBeVisible();
          await page.setViewportSize({ width: size.height, height: size.width });
          await page.waitForTimeout(500);
          await clean(page, `${label} landscape`);
          await shoot(page, `phone-day-08-landscape-${label}`);
          await page.setViewportSize(size);

          // ---- 9. Away: the sockets are cut, a session asks meanwhile, the page is back and knows.
          await page.goto(`/s/${a}`);
          await expect(pane.getByTestId("composer")).toBeVisible();
          await context.setOffline(true);
          await page.evaluate(() => { for (const s of (window as any).__socks) try { s.close(); } catch { /* already closed */ } });
          const late = await mk("Late ask", "ask");
          await request.post(`/api/sessions/${late}/messages`, { data: { text: bash("touch late.txt") } });
          await expect.poll(() => waitingCount(request, [late]), { timeout: 30_000 }).toBe(1);
          await page.waitForTimeout(3000);
          await context.setOffline(false);
          // The page finds its own way back and says what waits: the dock's count, with no reload.
          await expect(page.getByTestId("dock-need")).toBeVisible({ timeout: 60_000 });
          await page.goto("/");
          await expect(page.locator(`[data-testid="home-session"][data-session="${late}"]`)).toBeVisible({ timeout: 20_000 });
          await clean(page, `${label} back`);
          await shoot(page, `phone-day-09-back-${label}`);
        } finally {
          for (const id of made) { await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }).catch(() => {}); await request.delete(`/api/sessions/${id}`).catch(() => {}); }
        }
      });
    });
  }
}
