import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { answersOf, ask, create, folder } from "./answering.ts";
import { shoot, setPanes } from "./shots.ts";

// Feature: the home screen is the watch over every session. Its headline is
// the state of the sessions in the state words; the sessions that need the
// owner are listed with what kind of thing waits, what it is, and one action;
// the box to start a new one is on screen with them, on a desk and on a phone.
// An approval is given from a row only for a command the row shows whole, by
// a press the owner meant.

const MODEL = "scripted:stand-in";
const scripted = async (request: APIRequestContext) => (await (await request.get("/api/models")).json()).models.some((m: any) => m.id === MODEL);
const make = async (request: APIRequestContext, title: string, text?: string) => (await (await request.post("/api/sessions", { data: { model: MODEL, title, ...(text ? { text } : {}) } })).json()).session;
// A session that asks before each of these calls: one a turn, or all in one reply.
async function asking(request: APIRequestContext, title: string, calls: { name: string; input: unknown }[], how: "calls" | "batch" = "calls") {
  const s = await make(request, title);
  await request.put(`/api/sessions/${s.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await request.post(`/api/sessions/${s.id}/messages`, { data: { text: `script:${how} ${JSON.stringify(calls)}` } });
  return s;
}
const bash = (command: string) => ({ name: "Bash", input: { command } });
const pending = async (request: APIRequestContext, id: string) => (await (await request.get(`/api/sessions/${id}/approvals`)).json()).approvals.filter((a: any) => a.state === "pending") as { id: string; summary: string }[];
const row = (page: Page, id: string) => page.locator(`[data-testid="home-session"][data-session="${id}"]`);
const ended = async (request: APIRequestContext, id: string) => (await (await request.get(`/api/sessions/${id}`)).json()).events.some((e: any) => e.kind === "turn_end" || e.kind === "error");
async function drop(request: APIRequestContext, ids: string[]) {
  for (const id of ids) { await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }).catch(() => {}); await request.delete(`/api/sessions/${id}`).catch(() => {}); }
  for (const e of (await (await request.get("/api/errors?resolved=0")).json()).errors) if (String(e.message).includes("credit balance")) await request.patch(`/api/errors/${e.id}`, { data: { resolved: true } });
  await request.post("/api/alerts/read", { data: {} });
}

test("home: the sessions' state, what needs you, and a place to start", async ({ page, request, browser, baseURL }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const done = await make(request, "Home: write up the parser move", "One line.");
  const failed = await make(request, "Home: summarize the incident", "script:billing");
  for (const s of [done, failed]) await expect.poll(() => ended(request, s.id), { timeout: 60_000 }).toBe(true);
  const asks = await asking(request, "Home: clean the build output", [bash("rm -rf dist build")]);
  const gate = join(mkdtempSync(join(tmpdir(), "keel-home-")), "go");
  const works = await make(request, "Home: reindex the docs", `script:hold ${gate}`);
  try {
    // The page shows one line a session without reading its transcript.
    const fetched: string[] = [];
    // (A list row of a session at work asks once whether a message waits in its queue: that request names no events.)
    page.on("request", (r) => { const u = new URL(r.url()); const m = /\/api\/sessions\/([0-9a-f-]{20,})$/.exec(u.pathname); if (m && r.method() === "GET" && u.searchParams.get("events") !== "0") fetched.push(m[1]!); });
    // Errors the page raises (an observer told of a size it changed itself is one), kept for the resize below.
    await page.addInitScript(() => { (window as any).__errs = []; addEventListener("error", (e: ErrorEvent) => (window as any).__errs.push(String(e.message))); });
    await page.goto("/");
    const watch = page.getByTestId("home-watch");
    await expect(watch.getByTestId("home-count-need")).toContainText(/\d+ needs? you/, { timeout: 30_000 });
    await expect(watch.getByTestId("home-count-work")).toContainText(/\d+ working/);
    await expect(watch.getByTestId("home-count-fail")).toContainText(/\d+ failed/);
    // The headline has no caption of help under it: the start box is its own part of the page.
    await expect(page.getByText("Paste screenshots")).toHaveCount(0);
    await expect(page.getByTestId("home-start")).toContainText("Start a session");
    // No blank band over the counts: the headline starts under the top row, at a laptop and at a desk.
    for (const [width, height] of [[1366, 768], [1920, 1040]] as const) {
      await page.setViewportSize({ width, height });
      await expect.poll(async () => (await watch.boundingBox())!.y / (await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))), { message: `the headline's top at ${width}` }).toBeLessThanOrEqual(6.5);
    }
    // The count is said once on the page: the list under the headline is not headed by its word again
    // (a screen reader still has the heading to move by).
    const drawn = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("h2, h3, [data-testid^='home-count']")]
      .filter((el) => !el.closest('[data-testid="sidebar"]') && /needs? you/i.test(el.textContent ?? "") && el.getBoundingClientRect().width > 2 && el.getBoundingClientRect().height > 2).map((el) => el.textContent!.trim()));
    expect(await drawn()).toEqual([expect.stringMatching(/^\d+ needs? you$/)]);
    await expect(page.getByTestId("home-attention").getByRole("heading", { name: "Needs you" })).toHaveCount(1);

    // A row says what kind of thing waits, once, and what it is: not the state again.
    const asking_ = row(page, asks.id);
    await expect(asking_).toHaveAttribute("data-watch", "need");
    await expect(asking_.getByTestId("home-kind")).toHaveText("Command");
    await expect(asking_).not.toContainText(/needs you/i);
    // The command it may allow is whole, wrapped, in the code face.
    const cmd = asking_.getByTestId("home-command");
    await expect(cmd).toHaveText("rm -rf dist build");
    expect(await cmd.evaluate((el) => { const c = getComputedStyle(el); return `${c.whiteSpace} ${c.textOverflow} ${/mono/i.test(c.fontFamily)}`; })).toBe("pre-wrap clip true");
    await expect(page.getByTestId("home-attention").getByTestId("home-session").first()).toHaveAttribute("data-watch", "need");
    // A failure has its row, its word and its action.
    await expect(row(page, failed.id)).toHaveAttribute("data-watch", "fail");
    // A failure says its class, in the daemon's word for it.
    await expect(row(page, failed.id).getByTestId("home-kind")).toHaveText("Failed: billing");
    await expect(row(page, failed.id)).toContainText("credit balance");
    await expect(row(page, failed.id).getByTestId("home-see")).toHaveText("Open");
    // A row is one line in the wide list, as the work board's is: the title, why, and the action at its end.
    const line = await row(page, failed.id).evaluate((el) => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      const mid = (sel: string) => { const r = el.querySelector(sel)!.getBoundingClientRect(); return r.top + r.height / 2; };
      return { height: el.getBoundingClientRect().height / rem, title: mid(".k-home-row-title"), kind: mid('[data-testid="home-kind"]'), act: mid('[data-testid="home-see"]') };
    });
    expect(line.height).toBeLessThan(3.5);
    expect(Math.abs(line.title - line.kind)).toBeLessThan(8);
    expect(Math.abs(line.title - line.act)).toBeLessThan(8);
    // One action leads the screen.
    await expect(page.locator(".k-home-act-lead")).toHaveCount(1);
    // A finished session is not there; a working one is listed under what needs the owner, with its step.
    await expect(row(page, done.id)).toHaveCount(0);
    await expect(page.getByTestId("home-working").locator(`[data-session="${works.id}"]`)).toHaveAttribute("data-watch", "work");
    // A row's kind is in the row's ink, whatever its state: its dot alone says the state's colour.
    for (const s of [asks, failed]) {
      const [title, kind] = await row(page, s.id).evaluate((el) => [".k-home-row-title", '[data-testid="home-kind"]'].map((q) => getComputedStyle(el.querySelector(q)!).color));
      expect(kind, `the kind on "${s.title}"`).toBe(title);
    }
    // Under the Working head a row says its step, not Working again.
    await expect(page.getByTestId("home-working").locator(`[data-session="${works.id}"]`).getByTestId("home-kind")).toHaveCount(0);
    expect(fetched.filter((id) => [done.id, failed.id, asks.id, works.id].includes(id))).toEqual([]);

    // The place to start is on screen with them, and does not move when the lists change.
    const boxY = async () => Math.round((await page.getByTestId("new-composer").boundingBox())!.y);
    const y0 = await boxY();
    await expect(page.getByTestId("new-composer")).toBeInViewport({ ratio: 1 });
    await expect(asking_).toBeInViewport({ ratio: 1 });
    // At a desk the list beside the page names every session: the page does not say them again.
    await expect(page.getByTestId("recent-session")).toHaveCount(0);
    await expect(page.getByTestId("sidebar").getByText("Home: write up the parser move")).toBeVisible();
    await shoot(page, "home-01-watch");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("new-composer")).toBeInViewport({ ratio: 1 });
    await expect(watch).toBeInViewport({ ratio: 1 });
    // A phone has no rail: the working ones are listed. The dock's count would say the headline twice.
    await expect(page.getByTestId("home-working").locator(`[data-session="${works.id}"]`)).toHaveAttribute("data-watch", "work");
    await expect(page.locator(".k-dock-need")).toHaveCount(0);
    // The asking session's card is on a page behind the home screen: it does not take the keyboard from here.
    await page.waitForTimeout(1300);
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? "")).not.toMatch(/allow/);
    // A phone has no list beside the page: Recent tells the other sessions apart (state, folder, age).
    const recent = page.locator(`[data-testid="recent-session"][data-session="${done.id}"]`);
    await expect(recent).toHaveAttribute("data-watch", "done");
    await expect(recent.getByTestId("recent-folder")).not.toBeEmpty();
    await shoot(page, "home-02-phone");
    await page.setViewportSize({ width: 1920, height: 1040 });
    // Crossing to a phone's width and back with a request waiting raised no error.
    expect(await page.evaluate(() => (window as any).__errs)).toEqual([]);

    // The answer in place: once the list has stood still, the command is allowed from its row, and the page stays.
    await expect(asking_.getByTestId("home-allow")).toBeEnabled();
    await asking_.getByTestId("home-allow").click();
    await expect(asking_).toHaveCount(0, { timeout: 30_000 });
    await expect(page).toHaveURL(/\/$/);
    expect(Math.abs((await boxY()) - y0)).toBeLessThanOrEqual(1);

    // A failure counts until its session was opened here: marking every alert read does not hide it.
    const failedBefore = Number((await watch.getByTestId("home-count-fail").innerText()).match(/\d+/)![0]);
    await request.post("/api/alerts/read", { data: {} });
    await page.reload();
    await expect(watch.getByTestId("home-count-fail")).toContainText(`${failedBefore} failed`);
    await expect(row(page, failed.id)).toBeVisible();
    // Another device (a fresh browser) counts it too, until any device has shown it.
    const other = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
    const phone = await other.newPage();
    await phone.goto("/");
    await expect(row(phone, failed.id)).toBeVisible();
    // Opened and left, it is a failed session among the recent ones.
    await row(page, failed.id).getByTestId("home-see").click();
    await expect(page).toHaveURL(new RegExp(`/s/${failed.id}`));
    await expect(page.getByTestId("turn-error").first()).toBeVisible();
    await page.goto("/");
    await expect(page.getByTestId("home-watch")).toBeVisible();
    await expect(row(page, failed.id)).toHaveCount(0);
    // The daemon keeps what was looked at: the other device stops counting it too, with no reload.
    await expect(row(phone, failed.id)).toHaveCount(0);
    await other.close();
    if (failedBefore > 1) await expect(watch.getByTestId("home-count-fail")).toContainText(`${failedBefore - 1} failed`);
    else await expect(watch.getByTestId("home-count-fail")).toHaveCount(0);
    // It is a failed session in the list now (the rail at a desk, Recent on a phone), not news.
    await page.setViewportSize({ width: 390, height: 844 });
    const seen = page.locator(`[data-testid="recent-session"][data-session="${failed.id}"]`);
    await expect(seen).toHaveAttribute("data-watch", "fail");
    await expect(seen).toContainText("Failed");
    await shoot(page, "home-03-seen");
    await page.setViewportSize({ width: 1920, height: 1040 });

    // A count opens the first session in that state.
    await watch.getByTestId("home-count-work").click();
    await expect(page).toHaveURL(new RegExp(`/s/${works.id}`));
  } finally {
    writeFileSync(gate, "");
    await drop(request, [done.id, failed.id, asks.id, works.id]);
  }
});

// A command the row cannot show whole is never allowed from the row: a long
// one and a many-line one are read on their card.
test("home: a cut command is reviewed on its card, never allowed from its row", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const tail = "&& python3 scripts/drop_table.py --table invoices_legacy --yes";
  const long = await asking(request, "Home: backfill the invoices", [bash(`python3 scripts/backfill_invoices.py --from 2026-01-01 --to 2026-10-31 --batch-size 500 --tenant acme --tenant globex --tenant initech --resume-from checkpoints/backfill.json --log-level info --dry-run=false ${tail}`)]);
  const multi = await asking(request, "Home: rotate the log files", [bash('for f in logs/*.log; do\n  gzip "$f"\ndone\nmv logs/*.gz /var/archive/ && rm -rf /var/archive/old')]);
  try {
    await page.goto("/");
    for (const s of [long, multi]) {
      const r = row(page, s.id);
      await expect(r.getByTestId("home-kind")).toHaveText("Command");
      await expect(r.getByTestId("home-review")).toHaveText("Review");
      await expect(r.getByTestId("home-allow")).toHaveCount(0);
      await expect(r.getByTestId("home-command")).toHaveCount(0);
    }
    await shoot(page, "home-04-review");
    // Review opens the card, with the whole command on it.
    await row(page, long.id).getByTestId("home-review").click();
    await expect(page).toHaveURL(new RegExp(`/s/${long.id}`));
    await expect(page.getByTestId("approval").first()).toContainText("drop_table.py");
    expect(await pending(request, long.id)).toHaveLength(1);
    expect(await pending(request, multi.id)).toHaveLength(1);

    // By keyboard: Enter on Review, Enter again 400 ms later, then Enter held down. On the way in
    // the keyboard is on the card or its list, not on an answer, and nothing is allowed. The whole
    // command is on the card: once it has stood there for the settle time its answer takes the
    // keyboard, as on any way to the card, and not before.
    await page.goto("/");
    await expect(row(page, long.id).getByTestId("home-review")).toBeEnabled();
    await row(page, long.id).getByTestId("home-review").focus();
    await page.keyboard.press("Enter");
    const arrived = Date.now();
    await expect(page.getByTestId("approval").first()).toContainText("drop_table.py");
    // (On the card itself: it answers nothing there.)
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? "")).toMatch(/^approvals?$/);
    expect(await pending(request, long.id)).toHaveLength(1);
    await expect(page.getByTestId("approval").first().getByTestId("allow-once")).toBeFocused({ timeout: 5000 });
    // (Brought there by the page: Enter acts after the settle time from then, as the card says.)
    await expect(page.getByTestId("approval").first().getByTestId("allow-once")).toHaveAttribute("data-ready", "true", { timeout: 5000 });
    expect(Date.now() - arrived).toBeGreaterThanOrEqual(300);
    expect(await pending(request, long.id)).toHaveLength(1);
    await page.goto("/");
    await expect(row(page, multi.id).getByTestId("home-review")).toBeEnabled();
    await row(page, multi.id).getByTestId("home-review").focus();
    await page.keyboard.down("Enter");
    for (let i = 0; i < 40; i++) { await page.keyboard.down("Enter"); await page.waitForTimeout(50); }
    await page.keyboard.up("Enter");
    await expect(page).toHaveURL(new RegExp(`/s/${multi.id}`));
    expect(await pending(request, multi.id)).toHaveLength(1);
  } finally {
    await drop(request, [long.id, multi.id]);
  }
});

// A press meant for one call never allows another: the next call of the same
// session gets buttons of its own (no focus carried to them, not ready at
// once), and a row that moved under the pointer does not act.
test("home: a press meant for one call never allows the next", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const two = await asking(request, "Home: regenerate the clients", [bash("bun run codegen"), bash("git add -A && git commit -m 'Regenerate clients'")], "batch");
  const ids = [two.id];
  try {
    await expect.poll(async () => (await pending(request, two.id)).length, { timeout: 30_000 }).toBe(2);
    await page.goto("/");
    const r = row(page, two.id);
    await expect(r.getByTestId("home-command")).toHaveText("bun run codegen");
    await expect(r.getByTestId("home-allow")).toBeEnabled();
    await r.getByTestId("home-allow").click();
    // The row now shows the next call. Its Allow is another button: the focus did not come with it, and Enter allows nothing.
    await expect(r.getByTestId("home-command")).toHaveText("git add -A && git commit -m 'Regenerate clients'");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName)).not.toBe("home-allow");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);
    expect((await pending(request, two.id)).map((a) => a.summary)).toEqual(["git add -A && git commit -m 'Regenerate clients'"]);

    // A new asking session takes the top row and moves the others down: a click where the old button was, at once, allows nothing.
    await expect(r.getByTestId("home-allow")).toBeEnabled();
    const at = (await r.getByTestId("home-allow").boundingBox())!;
    // The press lands the moment the list changes (in the page, so no round trip stands between the two):
    // whatever is under that point then, it allows nothing, and an Allow there says why.
    await page.evaluate(([x, y]) => {
      const list = document.querySelector('[data-testid="home-attention"]')!;
      const rows = () => list.querySelectorAll('[data-testid="home-session"]').length;
      const was = rows();
      const seen = new MutationObserver(() => {
        if (rows() === was) return;
        seen.disconnect();
        const hit = document.elementFromPoint(x!, y!)?.closest("button") as HTMLButtonElement | null;
        (window as any).__hit = { testid: hit?.dataset.testid ?? null, session: hit?.closest<HTMLElement>("[data-session]")?.dataset.session ?? null };
        hit?.click();
      });
      seen.observe(list, { childList: true, subtree: true });
    }, [at.x + at.width / 2, at.y + at.height / 2]);
    const above = await asking(request, "Home: clean the build output", [bash("rm -rf dist build")]);
    ids.push(above.id);
    await expect(row(page, above.id)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => (window as any).__hit)).toBeTruthy();
    const hit = await page.evaluate(() => (window as any).__hit);
    if (hit.testid === "home-allow") {
      // A press that did nothing is answered: the button is ringed and its row says why.
      await expect(row(page, hit.session).getByTestId("home-note")).toContainText("Not yet");
      await expect(row(page, hit.session).getByTestId("home-allow")).toHaveAttribute("data-nudge", "true");
    }
    // Every Allow on the screen was held when the list changed, and nothing was allowed.
    await expect(row(page, above.id).getByTestId("home-allow")).toBeDisabled();
    await page.waitForTimeout(1200);
    expect(await pending(request, above.id)).toHaveLength(1);
    expect(await pending(request, two.id)).toHaveLength(1);
    // Stood still, it acts; a card answered elsewhere meanwhile is said on the row, not thrown.
    await expect(row(page, above.id).getByTestId("home-allow")).toBeEnabled();
    const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
    await page.route(`**/api/sessions/${above.id}/approvals/*`, async (route) => {
      // Denied from another device just before this press lands.
      const [a] = await pending(request, above.id);
      if (a) await request.post(`/api/sessions/${above.id}/approvals/${a.id}`, { data: { choice: "deny", reason: "not now" } });
      await route.continue();
    });
    await row(page, above.id).getByTestId("home-allow").click();
    await expect.poll(async () => (await pending(request, above.id)).length).toBe(0);
    expect((await (await request.get("/api/errors")).json()).errors.length).toBe(errorsBefore);
    await page.unroute(`**/api/sessions/${above.id}/approvals/*`);

    // The hold watches where a button stands, not only the rows: the list pushed down by something
    // above it (a banner over the page) holds every button again, and a press then is refused.
    const r2 = row(page, two.id);
    await expect(r2.getByTestId("home-allow")).toBeEnabled();
    await page.evaluate(() => {
      (document.querySelector('[data-testid="home-attention"]') as HTMLElement).style.marginTop = "3rem";
      document.querySelector<HTMLElement>('[data-testid="home-allow"]')!.click();
    });
    await expect(r2.getByTestId("home-note")).toContainText("Not yet");
    await page.waitForTimeout(300);
    expect(await pending(request, two.id)).toHaveLength(1);
    await shoot(page, "home-05-holds");
    // Stood still again, it acts.
    await expect(r2.getByTestId("home-allow")).toBeEnabled();
    await r2.getByTestId("home-allow").click();
    await expect.poll(async () => (await pending(request, two.id)).length).toBe(0);
  } finally {
    await drop(request, ids);
  }
});

// A "New session" pane that stands beside other panes says what needs the owner
// as the start page of one pane does: the headline and the rows, answered from
// there, in the pane's width.
test("home: a new-session pane beside others lists what needs the owner", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const asks = await asking(request, "Home: clean the build output", [bash("rm -rf dist build")]);
  try {
    await page.addInitScript(() => { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("keel.focus", "false"); } });
    await page.goto("/");
    await setPanes(page, 2);
    await page.getByRole("button", { name: "New session" }).first().click();
    const pane = page.locator(".k-station-new");
    await expect(pane.getByTestId("new-composer")).toBeVisible();
    await expect(pane.getByTestId("home-count-need")).toContainText(/\d+ needs? you/);
    const asking_ = pane.locator(`[data-testid="home-session"][data-session="${asks.id}"]`);
    await expect(asking_.getByTestId("home-command")).toHaveText("rm -rf dist build");
    await expect(asking_.getByTestId("home-allow")).toBeVisible();
    // Beside the titled list the recent sessions are not said again.
    await expect(pane.getByTestId("recent-session")).toHaveCount(0);
    expect(await pane.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await shoot(page, "home-06-pane");
    await setPanes(page, 1);
  } finally {
    await drop(request, [asks.id]);
  }
});

// Deny on a row opens the card's own denial, the keyboard in its reason field:
// no key that follows can allow the command.
test("home: Deny lands in the card's reason field, never on Allow", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const dir = mkdtempSync(join(tmpdir(), "keel-home-deny-"));
  const made = (n: string) => existsSync(join(dir, n));
  const a = await asking(request, "Home: deny by mouse, then Enter", [bash(`touch ${join(dir, "a.txt")}`)]);
  const b = await asking(request, "Home: deny by Enter, then Enter", [bash(`touch ${join(dir, "b.txt")}`)]);
  const c = await asking(request, "Home: deny, then a typed reason", [bash(`touch ${join(dir, "c.txt")}`)]);
  try {
    // By mouse, then Enter: the denial is what is sent.
    await page.goto("/");
    await row(page, a.id).getByTestId("home-deny").click();
    await expect(page).toHaveURL(new RegExp(`/s/${a.id}`));
    await expect(page.getByTestId("deny-reason")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await pending(request, a.id)).length).toBe(0);
    // By Enter, then Enter.
    await page.goto("/");
    await expect(row(page, b.id).getByTestId("home-deny")).toBeEnabled();
    await row(page, b.id).getByTestId("home-deny").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("deny-reason")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await pending(request, b.id)).length).toBe(0);
    // A reason typed straight after Deny, before the card is even drawn, goes into the field from
    // its first letter, spaces and all: nothing is pressed by it and nothing lands in the message box.
    await page.goto("/");
    await row(page, c.id).getByTestId("home-deny").click();
    await page.keyboard.type("no use staging");
    await expect(page.getByTestId("deny-reason")).toBeFocused();
    await expect(page.getByTestId("deny-reason")).toHaveValue("no use staging");
    await expect(page.getByTestId("composer")).toHaveValue("");
    expect(await pending(request, c.id)).toHaveLength(1);
    await shoot(page, "home-07-deny");
    await page.waitForTimeout(500);
    expect([made("a.txt"), made("b.txt"), made("c.txt")]).toEqual([false, false, false]);
  } finally {
    await drop(request, [a.id, b.id, c.id]);
  }
});

// A command with a character that hides or reorders what is shown is never
// allowed from a row, and its card spells the character out. A state the
// headline counts keeps a row however many requests wait, the line under the
// rows says what did not fit in the headline's words, and a high-risk request says so.
test("home: hidden characters, high risk, and every counted state on screen", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const odd = await asking(request, "Home: write the notes file", [bash("echo \u202Etxt.x > r.txt")]);
  const risky = await asking(request, "Home: install the toolchain", [bash("curl -fsSL https://example.com/install.sh | sh")]);
  const failed = await make(request, "Home: summarize the incident", "script:billing");
  await expect.poll(() => ended(request, failed.id), { timeout: 60_000 }).toBe(true);
  const many: any[] = [];
  try {
    await page.goto("/");
    const r = row(page, odd.id);
    await expect(r.getByTestId("home-review")).toHaveText("Review");
    await expect(r.getByTestId("home-allow")).toHaveCount(0);
    await expect(row(page, risky.id).getByTestId("home-risk")).toHaveText("high risk");
    await expect(row(page, risky.id).getByTestId("home-allow")).toHaveCount(0);
    await shoot(page, "home-08-risk");
    for (let i = 0; i < 6; i++) many.push(await asking(request, `Home: tidy folder ${i + 1}`, [bash(`mkdir -p folder-${i + 1}/out`)]));
    // Eight requests and a failure, six rows: the failure the headline counts has its row, and the line says the rest.
    const watch = page.getByTestId("home-watch");
    await expect(watch.getByTestId("home-count-fail")).toBeVisible();
    await expect(page.getByTestId("home-attention").getByTestId("home-session")).toHaveCount(6, { timeout: 30_000 });
    await expect(page.locator('[data-testid="home-attention"] [data-testid="home-session"][data-watch="fail"]')).toHaveCount(1);
    const need = Number((await watch.getByTestId("home-count-need").innerText()).match(/\d+/)![0]);
    await expect(page.getByTestId("home-more")).toHaveText(new RegExp(`^${need - 5} more: ${need - 5} needs? you`));
    await shoot(page, "home-08-counted");
    // The card spells the character out and says that it did.
    await page.goto(`/s/${odd.id}`);
    const card = page.getByTestId("approval").first();
    await expect(card.getByTestId("hidden-char")).toHaveText("<U+202E>");
    await expect(card.getByTestId("approval-hidden")).toContainText("do not show as written");
    await expect(card.getByTestId("approval-summary")).toContainText("txt.x > r.txt");
    await shoot(page, "home-09-hidden-char");
  } finally {
    await drop(request, [odd.id, risky.id, failed.id, ...many.map((m) => m.id)]);
  }
});

// A session that waits on a plan, on a secret, or on a request of one of its
// agents needs the owner: the headline counts it and it has a row that says
// which. On a phone a waiting secret does not take the home screen away or
// put the keyboard in its field.
test("home: a waiting plan, secret and agent's request are counted and have a row", async ({ page, request, browser, baseURL }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const mk = async (title: string, calls: { name: string; input: unknown }[], mode: string) => {
    const s = await make(request, title);
    await request.put(`/api/sessions/${s.id}/permissions`, { data: { mode, sandbox: "off" } });
    await request.post(`/api/sessions/${s.id}/messages`, { data: { text: `script:calls ${JSON.stringify(calls)}` } });
    return s;
  };
  const plan = await mk("Home: plan the retry policy", [{ name: "present_plan", input: { title: "Retry policy", plan: "## Retry policy\n\n1. Read the importer.\n2. Change the retry policy.\n3. Run the tests." } }], "plan");
  const secret = await mk("Home: call the staging API", [{ name: "request_secret", input: { name: "SPEC_TOKEN", purpose: "a spec" } }], "full-auto");
  const parent = await mk("Home: check the build with an agent", [{ name: "spawn_agent", input: { message: `Check the build\nscript:calls ${JSON.stringify([bash("touch agent1.txt")])}`, isolation: "none" } }, { name: "wait_agent", input: {} }], "ask");
  try {
    await expect.poll(async () => (await (await request.get(`/api/sessions/${plan.id}/plan`)).json()).open?.length, { timeout: 30_000 }).toBe(1);
    await expect.poll(async () => (await (await request.get(`/api/sessions/${secret.id}/secrets`)).json()).requests?.length, { timeout: 30_000 }).toBe(1);
    await page.goto("/");
    await expect(row(page, plan.id).getByTestId("home-kind")).toHaveText("Plan", { timeout: 30_000 });
    await expect(row(page, plan.id)).toContainText("Retry policy");
    await expect(row(page, plan.id).getByTestId("home-review")).toHaveText("Review");
    await expect(row(page, secret.id).getByTestId("home-kind")).toHaveText("Secret");
    await expect(row(page, secret.id)).toContainText("SPEC_TOKEN");
    for (const s of [plan, secret]) await expect(row(page, s.id)).toHaveAttribute("data-watch", "need");
    const need = Number((await page.getByTestId("home-count-need").innerText()).match(/\d+/)![0]);
    expect(need).toBeGreaterThanOrEqual(2);
    // The headline counts what the tab's title counts: the things that wait.
    await expect(page).toHaveTitle(new RegExp(`^\\(${need}\\) `));
    // An agent's request, where the scripted agent asked one: the parent's row says whose it is and offers Review only.
    const agent = row(page, parent.id);
    if (await agent.getByTestId("home-kind").filter({ hasText: "Agent's command" }).count()) {
      await expect(agent.getByTestId("home-review")).toHaveText("Review");
      await expect(agent.getByTestId("home-allow")).toHaveCount(0);
    }
    await shoot(page, "home-10-plan-secret");

    // A phone: the home screen stays, and the keyboard is not in the secret's field.
    const c = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const phone = await c.newPage();
    await phone.goto("/");
    await expect(phone.getByTestId("home-watch")).toBeVisible();
    await phone.waitForTimeout(1500);
    await expect(phone).toHaveURL(/\/$/);
    expect(await phone.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? "")).not.toBe("secret-value");
    await expect(phone.getByTestId("home-watch")).toBeInViewport();
    await expect(row(phone, secret.id).getByTestId("home-kind")).toHaveText("Secret");
    expect((await (await request.get(`/api/sessions/${secret.id}/secrets`)).json()).requests?.length).toBe(1);
    await c.close();
    // Opened, the secret's field has the keyboard: there the owner means it.
    await row(page, secret.id).getByTestId("home-review").click();
    await expect(page.getByTestId("secret-value")).toBeFocused();
  } finally {
    await drop(request, [plan.id, secret.id, parent.id]);
  }
});

// Every way from the home screen to a session with a request waiting lands on
// the card's list of requests, never on an answer: the row's title, a count
// in the headline, the line under the rows, an agent's request. A command the
// row could not show stays pending whatever key follows.
test("home: every way to a waiting session lands on the list of requests", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  test.setTimeout(240_000);
  const LONG = `${Array.from({ length: 40 }, (_, i) => `echo step ${i + 1}`).join("\n")}\nrm -rf ./release && git push --force origin main`;
  const states = async (id: string) => ((await (await request.get(`/api/sessions/${id}/approvals?all`)).json()).approvals as any[]).map((a) => `${a.state}${a.choice ? `/${a.choice}` : ""}`).join(",") || "none";
  const focus = () => page.evaluate(() => { const el = document.activeElement as HTMLElement | null; return el?.dataset.testid ?? el?.tagName ?? "none"; });
  // Enter 1.2 s after arriving and again at 2.7 s: past the card's own settle time, when a whole card would act.
  const enters = async () => { await page.waitForTimeout(1200); const at = await focus(); await page.keyboard.press("Enter"); await page.waitForTimeout(1500); await page.keyboard.press("Enter"); await page.waitForTimeout(600); return at; };
  const table: string[] = [];
  const ids: string[] = [];
  const one = async (title: string) => { const s = await asking(request, title, [bash(LONG)]); ids.push(s.id); await expect.poll(() => states(s.id), { timeout: 30_000 }).toBe("pending"); return s; };
  try {
    const s = await one("Home: a command of forty-one lines");
    await page.goto("/");
    await expect(row(page, s.id).getByTestId("home-review")).toHaveText("Review");
    await row(page, s.id).getByTestId("home-open").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("approval")).toHaveAttribute("data-must-open", "true");
    let at = await enters();
    expect(at).toBe("approvals");
    expect(await states(s.id)).toBe("pending");
    table.push(`| Row title, Enter | ${at} | Enter at 1.2 s and 2.7 s: ${await states(s.id)} |`);
    await page.goto("/");
    await row(page, s.id).getByTestId("home-open").click();
    at = await enters();
    expect(at).toBe("approvals");
    expect(await states(s.id)).toBe("pending");
    table.push(`| Row title, mouse | ${at} | Enter at 1.2 s and 2.7 s: ${await states(s.id)} |`);
    await page.goto("/");
    await page.getByTestId("home-count-need").click();
    await expect(page).toHaveURL(new RegExp(`/s/${s.id}`));
    at = await enters();
    expect(at).toBe("approvals");
    expect(await states(s.id)).toBe("pending");
    table.push(`| Headline count | ${at} | Enter at 1.2 s and 2.7 s: ${await states(s.id)} |`);
    await drop(request, ids.splice(0));

    // "N more": seven wait, six have a row, and the line under them opens one that has none.
    const many: { id: string }[] = [];
    for (let i = 0; i < 7; i++) many.push(await one(`Home: one of seven, ${i + 1}`));
    await page.goto("/");
    await expect(page.getByTestId("home-more")).toHaveText(/^1 more: 1 needs you/, { timeout: 30_000 });
    await page.getByTestId("home-more").click();
    await expect(page).toHaveURL(/\/s\//);
    at = await enters();
    const after = (await Promise.all(many.map((m) => states(m.id)))).join(" ");
    expect(at).toBe("approvals");
    expect(after).toBe(Array(7).fill("pending").join(" "));
    table.push(`| "N more" | ${at} | Enter at 1.2 s and 2.7 s: all seven pending |`);
    await drop(request, ids.splice(0));

    // An agent's request: the parent's row says whose it is, offers Review only, and opens the parent's page.
    const parent = await asking(request, "Home: parent of an asking agent", [{ name: "spawn_agent", input: { message: `Check the build\nscript:calls ${JSON.stringify([bash(LONG)])}`, isolation: "none" } }, { name: "wait_agent", input: {} }]);
    ids.push(parent.id);
    let kid = "";
    await expect.poll(async () => (kid = (await (await request.get(`/api/sessions/${parent.id}/agents`)).json()).agents?.[0]?.session_id ?? ""), { timeout: 30_000 }).not.toBe("");
    await expect.poll(() => states(kid), { timeout: 30_000 }).toBe("pending");
    await page.goto("/");
    await expect(row(page, parent.id).getByTestId("home-kind")).toHaveText("Agent's command", { timeout: 30_000 });
    await expect(row(page, parent.id).getByTestId("home-allow")).toHaveCount(0);
    await expect(row(page, parent.id).getByTestId("home-review")).toBeEnabled();
    await row(page, parent.id).getByTestId("home-review").click();
    // The request waits in the agent's own session: that is the one the row opens.
    await expect(page).toHaveURL(new RegExp(`/s/${kid}`));
    await expect(page.getByTestId("approval").first()).toBeVisible();
    at = await enters();
    expect(at).toBe("approvals");
    expect(await states(kid)).toBe("pending");
    table.push(`| Agent's request, home row's Review | ${at} | Enter at 1.2 s and 2.7 s: ${await states(kid)} |`);
  } finally {
    await drop(request, ids);
    console.log(`\nPATH-TABLE-HOME\n${table.join("\n")}\nPATH-TABLE-HOME-END`);
  }
});

// A Review on a row that says how many wait goes through all of them, as Alt A does, and the owner is
// on the home screen again when the last is answered: not in the agent's session they answered in.
test("home: Review goes through every request that waits, and ends on the home screen", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  test.setTimeout(180_000);
  const states = async (id: string) => ((await (await request.get(`/api/sessions/${id}/approvals?all`)).json()).approvals as any[]).map((a) => `${a.state}${a.choice ? `/${a.choice}` : ""}`).join(",") || "none";
  const spawn = (name: string, word: string) => ({ name: "spawn_agent", input: { message: `${name}\nscript:calls ${JSON.stringify([bash(`echo ${word} > ${word}.txt`)])}`, isolation: "none" } });
  const parent = await asking(request, "Home: parent of two asking agents", [spawn("Check A", "review_a"), spawn("Check B", "review_b"), { name: "wait_agent", input: {} }], "batch");
  try {
    let kids: string[] = [];
    await expect.poll(async () => (kids = ((await (await request.get(`/api/sessions/${parent.id}/agents`)).json()).agents ?? []).map((a: any) => a.session_id)).length, { timeout: 30_000 }).toBe(2);
    for (const k of kids) await expect.poll(() => states(k), { timeout: 30_000 }).toBe("pending");
    await page.goto("/");
    const review = row(page, parent.id).getByTestId("home-review");
    // The row says how many it goes through, and what key goes to the next.
    await expect(review).toHaveText("Review 2", { timeout: 30_000 });
    await expect(review).toHaveAttribute("title", /all 2 requests in turn.*Alt A/);
    await expect(review).toBeEnabled();
    await shoot(page, "home-11-review-all");
    await review.click();
    const ready = async () => { const allow = page.getByTestId("allow-once"); await expect(allow).toBeFocused(); await expect(allow).toHaveAttribute("data-ready", "true", { timeout: 5000 }); };
    await expect(page).toHaveURL(/\/s\//);
    const first = page.url();
    await ready();
    await page.keyboard.press("Enter");
    // The next agent's request opens by itself, with the keyboard on it.
    await expect.poll(() => page.url()).not.toBe(first);
    await expect(page).toHaveURL(/\/s\//);
    await ready();
    await page.keyboard.press("Enter");
    // Both are answered, and the owner is where they started.
    for (const k of kids) await expect.poll(() => states(k), { timeout: 30_000 }).toBe("allowed/once");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("home-watch")).toBeVisible();
    await shoot(page, "home-12-all-answered");
  } finally {
    await drop(request, [parent.id]);
  }
});

// A row's Answer opens the session that asks as the start of an answering sequence, so the owner is
// back on the home screen once they have answered it, not left in the session they answered in.
test("home: answering what a row opened leads back to the home screen", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const id = await create(request, "Home: back after the answer", folder("home-back"));
  try {
    await ask(request, id, "question");
    await page.goto("/");
    const review = row(page, id).getByTestId("home-review");
    await expect(review).toHaveText("Answer", { timeout: 30_000 });
    await expect(review).toBeEnabled();
    await review.click();
    await expect(page).toHaveURL(new RegExp(`/s/${id}$`));
    const card = page.getByTestId("question");
    await expect(card).toBeFocused();
    await expect(card).toHaveAttribute("data-keys", "ready");
    await page.keyboard.press("1");
    await expect.poll(() => answersOf(request, id)).toBeTruthy();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("home-watch")).toBeVisible();
    await shoot(page, "home-11-back-home");
  } finally {
    await drop(request, [id]);
  }
});

// The headline and the rows read the state the daemon serves: a session that
// waits on a timer is Waiting (it goes on by itself, so it has no row at a
// desk), and a turn the model declined is news under its own word until its
// session was shown.
test("home: waiting and declined sessions, from the served state", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const timer = await make(request, "Home: check the deploy later");
  await request.put(`/api/sessions/${timer.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  await request.post(`/api/sessions/${timer.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "wait_for", input: { kind: "timer", seconds: 900, note: "check the deploy" } }])}` } });
  const declined = await make(request, "Home: a turn the model declines", "script:refuse");
  try {
    for (const s of [timer, declined]) await expect.poll(() => ended(request, s.id), { timeout: 60_000 }).toBe(true);
    await page.goto("/");
    const watch = page.getByTestId("home-watch");
    await expect(watch.getByTestId("home-count-wait")).toContainText(/\d+ waiting/, { timeout: 30_000 });
    await expect(watch.getByTestId("home-count-declined")).toContainText(/\d+ declined/);
    const r = row(page, declined.id);
    await expect(r).toHaveAttribute("data-watch", "declined");
    await expect(r.getByTestId("home-kind")).toHaveText("Declined");
    await expect(r).toContainText("The model declined the turn");
    // What waits on a timer needs nothing: no row among what needs the owner.
    await expect(page.getByTestId("home-attention").locator(`[data-session="${timer.id}"]`)).toHaveCount(0);
    await shoot(page, "home-11-waiting-declined");
    // A phone has no rail: it is listed with the working ones, with what it waits on and when that is due.
    await page.setViewportSize({ width: 390, height: 844 });
    const waits = page.getByTestId("home-working").locator(`[data-session="${timer.id}"]`);
    await expect(waits.getByTestId("home-kind")).toHaveText("Waiting");
    await expect(waits).toContainText("check the deploy");
    // Listed once: Recent leaves out what the list above it holds.
    await expect(page.locator(`[data-testid="recent-session"][data-session="${timer.id}"]`)).toBeHidden();
    await shoot(page, "home-12-waiting-phone");
    await page.setViewportSize({ width: 1920, height: 1040 });
    // Shown, the declined turn is no longer news.
    const before = Number((await watch.getByTestId("home-count-declined").innerText()).match(/\d+/)![0]);
    await expect(r.getByTestId("home-see")).toBeEnabled();
    await r.getByTestId("home-see").click();
    await expect(page).toHaveURL(new RegExp(`/s/${declined.id}`));
    await page.waitForTimeout(500);
    await page.goto("/");
    await expect(page.getByTestId("home-watch")).toBeVisible();
    await expect(row(page, declined.id)).toHaveCount(0);
    if (before > 1) await expect(watch.getByTestId("home-count-declined")).toContainText(`${before - 1} declined`);
    else await expect(watch.getByTestId("home-count-declined")).toHaveCount(0);
  } finally {
    await drop(request, [timer.id, declined.id]);
  }
});

// A short command that is whole on its card needs no second look: reached by
// its row's title, the card's Allow once takes the keyboard after the settle
// time and one Enter answers it. (The card guards itself: a text that is not
// all read keeps the keyboard on the list, as the cases above show.)
test("home: a whole short command reached by its row's title takes Enter after the settle time", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  const s = await asking(request, "Home: make the reports folder", [bash("mkdir -p out/reports")]);
  const state = async () => ((await (await request.get(`/api/sessions/${s.id}/approvals?all`)).json()).approvals as any[]).map((a) => `${a.state}${a.choice ? `/${a.choice}` : ""}`).join(",");
  try {
    await expect.poll(async () => (await pending(request, s.id)).length, { timeout: 30_000 }).toBe(1);
    await page.goto("/");
    const r = row(page, s.id);
    await expect(r).toBeVisible({ timeout: 30_000 });
    await r.getByTestId("home-open").focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/s/${s.id}`));
    const card = page.getByTestId("approval").first();
    // An Enter on the way in answers nothing: the answer has no keyboard before it acts.
    await page.waitForTimeout(400);
    await page.keyboard.press("Enter");
    expect(await state()).toBe("pending");
    await expect(card.getByTestId("allow-once")).toBeFocused({ timeout: 5000 });
    // (Brought there by the page: Enter acts after the settle time from then, as the card says.)
    await expect(card.getByTestId("allow-once")).toHaveAttribute("data-ready", "true", { timeout: 5000 });
    await page.keyboard.press("Enter");
    await expect.poll(state).toBe("allowed/once");
  } finally {
    await drop(request, [s.id]);
  }
});

// Feature: back after a while, the start page says what finished since the owner looked, with how many,
// beside what waits and what failed; a press opens the Inbox, where they are.
test("the start page says what finished since you looked", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  await page.setViewportSize({ width: 1920, height: 1040 });
  const made: string[] = [];
  try {
    await page.goto("/");
    await expect(page.getByTestId("home-watch")).toBeVisible();
    // Two sessions finish while the start page is on screen: neither is looked at.
    for (const t of ["Tidy the release notes", "Check the mirror"]) {
      const s = await make(request, `${t} ${Date.now().toString(36)}`);
      made.push(s.id);
      await request.post(`/api/sessions/${s.id}/messages`, { data: { text: "script:say Done, nothing else to change." } });
    }
    const finished = page.getByTestId("home-count-finished");
    await expect(finished).toBeVisible({ timeout: 20_000 });
    await expect(finished).toHaveText(/^\d+ done since you looked$/);
    const n = Number((await finished.innerText()).split(" ")[0]);
    expect(n).toBeGreaterThanOrEqual(2);
    await shoot(page, "home-finished-since");
    await finished.click();
    await expect(page.getByTestId("inbox-panel")).toBeVisible();
    // A phone: the same line on its start page.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.getByTestId("home-count-finished")).toBeVisible();
    await shoot(page, "home-finished-since-390");
  } finally {
    for (const id of made) await request.delete(`/api/sessions/${id}`);
  }
});

// Feature: the start box starts a session in the background: Alt+Enter, or "Start in background"
// in the menu beside Send. The box empties and keeps the keyboard, the page stays where it is, and a
// toast says "Started <title>" with Open. Plain Enter still opens the session it starts.
test("home: start in the background keeps the box and says what started", async ({ page, request }) => {
  const count = async () => (await (await request.get("/api/sessions")).json()).sessions.length as number;
  const before = await count();
  await page.goto("/");
  const box = page.getByTestId("new-composer").locator("textarea");
  await expect(box).toBeVisible();
  await box.fill("Reply with only the word one.");
  await box.press("Alt+Enter");
  await expect(page.getByTestId("started-toast")).toContainText(/^Started \S/);
  await expect(box).toHaveValue("");
  await expect(box).toBeFocused();
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(count).toBe(before + 1);
  await shoot(page, "start-background-01-toast");

  // The menu beside Send does the same, and the toast is the newest one's.
  await box.fill("Reply with only the word two.");
  await page.getByTestId("send-menu").click();
  await page.getByTestId("start-background").click();
  await expect(box).toHaveValue("");
  await expect(box).toBeFocused();
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(count).toBe(before + 2);
  await expect(page.getByTestId("started-toast")).toHaveCount(1);
  await shoot(page, "start-background-02-menu");

  // Open goes to that session; Enter in the box opens the session it starts, as before.
  await page.getByTestId("started-open").click();
  await expect(page).toHaveURL(/\/s\/[\w-]+/);
  await page.goto("/");
  await box.fill("Reply with only the word three.");
  await box.press("Enter");
  await expect(page).toHaveURL(/\/s\/[\w-]+/);
  await expect(page.getByTestId("started-toast")).toHaveCount(0);

  // A phone: the same toast over the same box.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await box.fill("Reply with only the word four.");
  await box.press("Alt+Enter");
  await expect(page.getByTestId("started-toast")).toBeVisible();
  await expect(box).toHaveValue("");
  await shoot(page, "start-background-03-phone");
});

// Feature (UX-S142): on a phone every count of the headline is whole and in view, at the usual text size and at 150%:
// a count that does not fit beside the others goes to the next line, never past the screen's edge.
for (const scale of [1, 1.5]) {
  test.describe(`home on a phone at ${scale * 100}% text`, () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    test("the headline's counts all fit the screen", async ({ page, request }) => {
      test.skip(!(await scripted(request)), "requires the scripted provider");
      await page.addInitScript((s) => localStorage.setItem("keel.textScale", String(s)), scale);
      const gate = join(mkdtempSync(join(tmpdir(), "keel-home-")), "go");
      const ids: string[] = [];
      try {
        ids.push((await asking(request, "Home phone: clean the output", [bash("rm -rf dist")])).id);
        ids.push((await make(request, "Home phone: reindex the docs", `script:hold ${gate}`)).id);
        for (const text of ["script:billing", "script:refuse"]) {
          const s = await make(request, `Home phone: ${text}`, text);
          ids.push(s.id);
          await expect.poll(() => ended(request, s.id), { timeout: 60_000 }).toBe(true);
        }
        await page.goto("/");
        const watch = page.getByTestId("home-watch");
        for (const w of ["need", "work", "fail", "declined"]) await expect(watch.getByTestId(`home-count-${w}`), `the ${w} count`).toBeVisible({ timeout: 30_000 });
        const seen = await watch.evaluate((h) => ({ over: h.scrollWidth - h.clientWidth, counts: [...h.querySelectorAll<HTMLElement>("[data-testid^='home-count']")].map((c) => { const b = c.getBoundingClientRect(); return { id: c.dataset.testid!, right: b.right, width: b.width, text: c.textContent!.trim() }; }) }));
        expect(seen.over, "the headline does not scroll sideways").toBeLessThanOrEqual(0);
        for (const c of seen.counts) expect(c.right, `${c.id} ("${c.text}") ends inside the screen`).toBeLessThanOrEqual(390);
        // The headline is at most two rows of the page's own size, and the start box's text is above the tab bar at the foot.
        const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
        expect((await watch.boundingBox())!.height / rem, "the headline's height, in rem").toBeLessThanOrEqual(6);
        const box = await page.getByTestId("new-composer").locator("textarea").boundingBox();
        expect(box!.y + box!.height, "the start box's text is above the foot").toBeLessThanOrEqual(844 - 5 * rem);
        await shoot(page, `home-phone-counts-${scale}`);
      } finally {
        writeFileSync(gate, "");
        await drop(request, ids);
      }
    });
  });
}
