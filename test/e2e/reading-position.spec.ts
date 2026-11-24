import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { rmSync } from "node:fs";
import { calls, create, drop, folder, open, pane, row, scripted, settle } from "./answering.ts";
import { daemon, exited, seeded } from "./own-daemon.ts";
import { shoot } from "./shots.ts";

// Feature: the owner's place in a conversation is theirs. Going to another
// session and back, a visit to an agent, a look over a pane, a reload and a
// daemon restart all bring them back to the line they were at (kept by its
// event, on this device), with the part that holds it read first. And a
// conversation shows where what is new to them starts: a rule above the first
// line that was not on screen while they were present, with since when, a way
// to it while it is out of view, and gone once they have read to the end.
// "Present" is the owner at that pane: it holds the keyboard and they did
// something in the page within the last minute, or their pointer, a wheel or a
// touch was in it within the last half minute. A pane beside the one worked in
// is not read because it is on screen, and the list's mark follows the same rule.
test.use({ storageState: { cookies: [], origins: [] } });

const say = (text: string) => `script:say ${text.replaceAll("\n", "\\n")}`;
const lines = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag} line ${i + 1} of the reply says something of its own.`).join("\n\n");
const ends = async (request: APIRequestContext, id: string) => ((await (await request.get(`/api/sessions/${id}`)).json()).events as { kind: string }[]).filter((e) => e.kind === "turn_end").length;
// A session with `turns` long replies, at rest: its lines are named "T<turn> line <n>".
async function long(request: APIRequestContext, title: string, ws: string, turns = 3) {
  const id = await create(request, title, ws);
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  for (let t = 1; t <= turns; t++) {
    await request.post(`/api/sessions/${id}/messages`, { data: { text: say(lines(`T${t}`, 40)) } });
    await expect.poll(() => ends(request, id), { timeout: 60_000 }).toBe(t);
  }
  return id;
}
// The conversation of a session on the page: its pane's own view, not one under a look.
const FIND = `(id) => [...document.querySelectorAll('[data-station="' + id + '"] .k-reading')].find((x) => !x.closest("[inert]"))`;
// Where the owner is in it: the first line of a reply at or under the view's top, how far under, and whether the end is followed.
type At = { line: string; y: number; top: number; end: boolean; marks: number };
const at = (page: Page, id: string) => page.evaluate(([id, find]) => {
  const sc = (0, eval)(find!)(id) as HTMLElement | undefined;
  if (!sc) return null;
  const v = sc.getBoundingClientRect();
  const first = [...sc.querySelectorAll<HTMLElement>(".prose-keel p, .prose-keel h2, .prose-keel li")].find((p) => !p.closest('[data-testid="user-message"]') && p.getBoundingClientRect().top >= v.top - 1);
  return { line: (first?.textContent ?? "").slice(0, 24), y: first ? Math.round(first.getBoundingClientRect().top - v.top) : -1, top: Math.round(sc.scrollTop), end: sc.scrollHeight - sc.scrollTop - sc.clientHeight < 3, marks: sc.querySelectorAll("[data-new-since]").length } as At;
}, [id, FIND] as const);
// The owner reads at a line: it is put at the top of the view, as a wheel would, and the place is kept.
async function readAt(page: Page, id: string, line: string) {
  // A wheel in its pane first: a place is kept when the owner scrolls, not when the page does.
  const box = (await page.locator(`[data-station="${id}"] .k-reading`).first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // (In steps: a row far from the view stands at an estimated height until it is drawn.)
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, -2);
    await page.evaluate(([id, find, line]) => {
      const sc = (0, eval)(find!)(id) as HTMLElement;
      const el = [...sc.querySelectorAll<HTMLElement>(".prose-keel p, .prose-keel h2")].find((p) => !p.closest('[data-testid="user-message"]') && (p.textContent ?? "").startsWith(line!))!;
      sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 6;
    }, [id, FIND, line] as const);
    await page.waitForTimeout(200);
    const a = await at(page, id);
    if (a?.line.startsWith(line) && Math.abs(a.y - 6) <= 2) break;
  }
  await expect.poll(async () => (await at(page, id))?.line.startsWith(line)).toBe(true);
  await page.waitForTimeout(700);
  return (await at(page, id))!;
}
// The same line at the same height (within a few px), and not the end.
async function same(page: Page, id: string, before: At, what: string) {
  await expect.poll(async () => { const a = await at(page, id); return a ? [a.line, Math.abs(a.y - before.y) <= 4 ? "where it was" : `at ${a.y} px, it was at ${before.y}`, a.end] : null; }, { timeout: 15_000, message: what }).toEqual([before.line, "where it was", false]);
  return (await at(page, id))!;
}

test("the owner comes back to the line they were at: another session, an agent, a reload", async ({ page, request }) => {
  test.setTimeout(240_000);
  await scripted(request);
  await settle(request);
  const ws = folder("reading-place");
  const reader = await long(request, "Reading: the importer's retry policy", ws);
  const other = await long(request, "Other: release notes", ws, 1);
  // The reader's last turn starts an agent, so there is an agent to visit.
  await request.post(`/api/sessions/${reader}/messages`, { data: { text: calls([{ name: "spawn_agent", input: { message: "Count the handlers\nscript:say Three handlers.", isolation: "none" } }]) } });
  // (The agent's report may come back as a turn of its own: the session is at rest when no turn runs.)
  await expect.poll(() => ends(request, reader), { timeout: 60_000 }).toBeGreaterThanOrEqual(4);
  await expect.poll(async () => { await new Promise((r) => setTimeout(r, 1500)); return (await (await request.get(`/api/sessions/${reader}`)).json()).running; }, { timeout: 60_000 }).toBeFalsy();
  const table: string[] = [];
  try {
    await page.setViewportSize({ width: 1920, height: 1040 });
    await open(page, [reader]);
    const before = await readAt(page, reader, "T2 line 7 of");
    expect(before.end).toBe(false);

    // To another session in the same pane, and back.
    await row(page, other).click();
    await expect(pane(page, other)).toBeVisible();
    await row(page, reader).click();
    let after = await same(page, reader, before, "after another session");
    table.push(`another session and back | ${before.top} to ${after.top} | ${after.line}`);

    // A reload.
    await page.reload();
    after = await same(page, reader, before, "after a reload");
    table.push(`a reload | ${before.top} to ${after.top} | ${after.line}`);
    await shoot(page, "reading-position-01-back-after-reload");

    // A visit to the agent's own session, and Escape back. (The agent's line is at the conversation's end: the owner goes there by the palette's way, the row.)
    const kids = ((await (await request.get("/api/sessions?agents=all")).json()).sessions as { id: string; parent_id?: string | null }[]).filter((s) => s.parent_id === reader);
    expect(kids).toHaveLength(1);
    await page.goto(`/s/${kids[0]!.id}`);
    await expect(pane(page, kids[0]!.id)).toBeVisible();
    await pane(page, kids[0]!.id).getByTestId("composer").focus();
    await page.keyboard.press("Escape");
    await expect(pane(page, reader)).toBeVisible();
    after = await same(page, reader, before, "after the agent's session");
    table.push(`an agent's session and Escape | ${before.top} to ${after.top} | ${after.line}`);

    // A reader who follows the end comes back to the end.
    await page.keyboard.press("End");
    await pane(page, reader).locator(".k-reading").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect.poll(async () => (await at(page, reader))?.end).toBe(true);
    await page.waitForTimeout(700);
    await row(page, other).click();
    await expect(pane(page, other)).toBeVisible();
    await row(page, reader).click();
    await expect.poll(async () => (await at(page, reader))?.end, { timeout: 15_000 }).toBe(true);
    console.log(`PLACES one pane\n${table.join("\n")}`);
  } finally {
    await drop(request, reader, other);
  }
});

test("a look over a pane, four panes and a phone keep each conversation's place", async ({ page, request }) => {
  test.setTimeout(300_000);
  await scripted(request);
  await settle(request);
  const ws = folder("reading-place-panes");
  const ids = [await long(request, "Pane one: the parser", ws, 2), await long(request, "Pane two: the store", ws, 2), await long(request, "Pane three: the cache", ws, 2), await long(request, "Pane four: the queue", ws, 2)];
  const [a, b, c, d] = ids as [string, string, string, string];
  const table: string[] = [];
  try {
    // Two panes: a look over the first, and back.
    await page.setViewportSize({ width: 1920, height: 1040 });
    await open(page, [a, b]);
    const inA = await readAt(page, a, "T1 line 12 of");
    await row(page, c).click();
    await expect(page.locator('[data-testid="bridge"] > [data-slot="0"]')).toHaveAttribute("data-station", c);
    await expect(page.locator('[data-testid="bridge"] > [data-slot="0"]')).toHaveAttribute("data-holds", a);
    // The session looked at has a place of its own, kept when the look is left.
    const inC = await readAt(page, c, "T1 line 20 of");
    await page.getByTestId("look-back").click();
    let after = await same(page, a, inA, "the pane's own session after a look");
    table.push(`two panes, a look and back | ${inA.top} to ${after.top} | ${after.line}`);
    await row(page, c).click();
    after = await same(page, c, inC, "the session looked at, looked at again");
    table.push(`two panes, the look again | ${inC.top} to ${after.top} | ${after.line}`);
    await shoot(page, "reading-position-02-look-again");

    // Four panes, each at a line of its own: a reload brings back all four.
    await open(page, [a, b, c, d]);
    // (Each well above its conversation's end: within a few lines of the end a reader is following it.)
    const marks = ["T1 line 30 of", "T2 line 4 of", "T1 line 9 of", "T2 line 10 of"];
    const was: At[] = [];
    for (const [i, id] of ids.entries()) was.push(await readAt(page, id, marks[i]!));
    await page.reload();
    for (const [i, id] of ids.entries()) {
      after = await same(page, id, was[i]!, `pane ${i + 1} of four after a reload`);
      table.push(`four panes, a reload, pane ${i + 1} | ${was[i]!.top} to ${after.top} | ${after.line}`);
    }
    await shoot(page, "reading-position-03-four-panes");

    // A phone: one conversation on screen at a time. To another by the dock, and back; then a reload.
    await page.setViewportSize({ width: 390, height: 844 });
    // (With reduced motion: the dock's press scrolls the pages at once. With motion, the pages that pass
    // on the way are each taken for the one swiped to, and the press ends on another conversation: the
    // pages' own fault, told to their lane, and not what is tested here.)
    await page.emulateMedia({ reducedMotion: "reduce" });
    // (Not by `open`: on a phone the message box does not take the keyboard by itself.)
    await page.goto("/api/daemon");
    await page.evaluate((slots) => { localStorage.setItem("keel.focus", "false"); localStorage.setItem("keel.panes", JSON.stringify({ count: slots.length, slots, sizes: {}, active: 0 })); }, [a, b]);
    await page.goto(`/s/${a}`);
    await expect(pane(page, a)).toBeVisible();
    const onPhone = await readAt(page, a, "T2 line 15 of");
    await page.getByRole("button", { name: /^Pane two: the store/ }).click();
    await expect.poll(async () => page.evaluate(() => location.pathname)).toContain(b);
    await page.getByRole("button", { name: /^Pane one: the parser/ }).click();
    await expect.poll(async () => page.evaluate(() => location.pathname)).toContain(a);
    after = await same(page, a, onPhone, "on a phone after another conversation");
    table.push(`390 px, another conversation and back | ${onPhone.top} to ${after.top} | ${after.line}`);
    await page.reload();
    after = await same(page, a, onPhone, "on a phone after a reload");
    table.push(`390 px, a reload | ${onPhone.top} to ${after.top} | ${after.line}`);
    await shoot(page, "reading-position-04-phone");
    console.log(`PLACES panes and phone\n${table.join("\n")}`);
  } finally {
    await drop(request, ...ids);
  }
});

test("a conversation shows where what is new starts, and the mark goes once it is read", async ({ page, request }) => {
  test.setTimeout(240_000);
  await scripted(request);
  await settle(request);
  const ws = folder("reading-new");
  const reader = await long(request, "Reading: what came since", ws, 2);
  const other = await long(request, "Other: a place to be meanwhile", ws, 1);
  const marked = (id: string) => pane(page, id).locator("[data-new-since]");
  try {
    await page.setViewportSize({ width: 1920, height: 1040 });
    await open(page, [reader]);
    // The owner is at the end and present: everything is read, nothing is marked.
    await expect.poll(async () => (await at(page, reader))?.end).toBe(true);
    await page.waitForTimeout(1600);
    await expect(marked(reader)).toHaveCount(0);

    // They go elsewhere, and a turn runs here meanwhile.
    await row(page, other).click();
    await expect(pane(page, other)).toBeVisible();
    await request.post(`/api/sessions/${reader}/messages`, { data: { text: say(lines("N", 30)) } });
    await expect.poll(() => ends(request, reader), { timeout: 60_000 }).toBe(3);

    // Back: at the end, as they were, with one rule above the first line that is new and since when.
    await row(page, reader).click();
    await expect(marked(reader)).toHaveCount(1, { timeout: 15_000 });
    expect((await at(page, reader))!.end).toBe(true);
    await expect(marked(reader)).toHaveAttribute("data-new-since", /^New since \d\d:\d\d$/);
    await expect(marked(reader)).toHaveAttribute("data-testid", "user-message");
    await expect(marked(reader)).toContainText("N line 1 of");
    // It is above the view: a way to it stands at the top, and takes the owner there.
    const jump = pane(page, reader).getByTestId("new-since-jump");
    await expect(jump).toHaveAttribute("data-where", "above");
    await expect(jump).toHaveText(/^New since \d\d:\d\d$/);
    await shoot(page, "reading-position-05-new-since-above");
    await jump.click();
    await expect(jump).toHaveCount(0);
    expect(await marked(reader).evaluate((el) => { const v = el.closest(".k-reading")!.getBoundingClientRect(), r = el.getBoundingClientRect(); return r.top >= v.top - 4 && r.top < v.bottom; })).toBe(true);
    await shoot(page, "reading-position-06-new-since-rule");
    // It takes no room: the row under it stands where it would without it.
    expect(await marked(reader).evaluate((el) => { const before = el.getBoundingClientRect().top; const text = el.getAttribute("data-new-since")!; el.removeAttribute("data-new-since"); const after = el.getBoundingClientRect().top; el.setAttribute("data-new-since", text); return after - before; })).toBe(0);
    // Still there while the new text is read; gone a few seconds after its end has been seen.
    await page.waitForTimeout(4500);
    await expect(marked(reader)).toHaveCount(1);
    await pane(page, reader).locator(".k-reading").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(marked(reader)).toHaveCount(0, { timeout: 12_000 });

    // A reader who was further up: back at their line, with the mark below and the way down to it.
    const before = await readAt(page, reader, "T1 line 5 of");
    await row(page, other).click();
    await expect(pane(page, other)).toBeVisible();
    await request.post(`/api/sessions/${reader}/messages`, { data: { text: say(lines("M", 6)) } });
    await expect.poll(() => ends(request, reader), { timeout: 60_000 }).toBe(4);
    await row(page, reader).click();
    await same(page, reader, before, "the reader further up, after a turn ran meanwhile");
    await expect(marked(reader)).toHaveCount(1, { timeout: 15_000 });
    await expect(marked(reader)).toContainText("M line 1 of");
    await expect(jump).toHaveAttribute("data-where", "below");
    // Never two marks in one conversation.
    expect((await at(page, reader))!.marks).toBe(1);
  } finally {
    await drop(request, reader, other);
  }
});

test("a place in a part that is not loaded is read first, and a daemon restart keeps it", async ({ page }) => {
  test.setTimeout(240_000);
  const s = seeded("reading-place-long", 3000, "turns", "Long: the place is far up");
  const id = s.ids[0]!;
  let d = await daemon(s.state);
  const port = Number(new URL(d.url).port);
  try {
    await page.setViewportSize({ width: 1920, height: 1040 });
    // Every frame from the page's start: whether the conversation was shown at its end.
    await page.addInitScript(() => {
      const w = window as any;
      w.__ends = 0; w.__shown = 0;
      const tick = () => {
        const sc = document.querySelector<HTMLElement>(".k-reading"), c = sc?.querySelector<HTMLElement>('[data-testid="transcript"]');
        if (sc && c && c.style.visibility !== "hidden" && c.querySelector("[data-event-id]") && sc.scrollHeight > sc.clientHeight * 2) { w.__shown++; if (sc.scrollHeight - sc.scrollTop - sc.clientHeight < 4) w.__ends++; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.goto(`${d.url}/s/${id}`);
    await expect(page.getByTestId("user-message").last()).toBeVisible({ timeout: 30_000 });
    const sc = page.locator(".k-reading").first();
    const box = (await sc.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // A place inside the part the page opens with, above the rows it draws first (the last of that
    // part are drawn at once, the rest a moment later): its row is there when it is looked for.
    for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -2000); await page.waitForTimeout(150); }
    await page.waitForTimeout(1500);
    const near = (await at(page, id))!;
    expect([near.end, near.line.length > 3]).toEqual([false, true]);
    const partsBefore = await sc.evaluate((el) => el.querySelectorAll("[data-event-id]").length);
    await page.reload();
    const nearAfter = await same(page, id, near, "after a reload, a place above the rows drawn first");
    console.log(`PLACES above the rows drawn first\na reload | ${near.top} to ${nearAfter.top} | ${nearAfter.line} | rows with an event then ${partsBefore}`);
    await page.evaluate(() => { (window as any).__shown = 0; (window as any).__ends = 0; });
    // The owner reads far up, in parts the page reads as they go.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, -3000); await page.waitForTimeout(120); }
    await page.waitForTimeout(1200);
    const before = (await at(page, id))!;
    const firstEvent = await sc.evaluate((el) => el.querySelector<HTMLElement>("[data-event-id]")!.dataset.eventId!);
    expect([before.end, before.line.length > 3]).toEqual([false, true]);

    // A reload: the page reads the end first, as always; the place is in an earlier part. It is read
    // before the conversation is shown: no frame shows the end.
    await page.reload();
    const after = await same(page, id, before, "after a reload, the place in an earlier part");
    await expect.poll(() => page.evaluate(() => (window as any).__shown as number)).toBeGreaterThan(30);
    const seen = await page.evaluate(() => ({ shown: (window as any).__shown as number, ends: (window as any).__ends as number }));
    expect(seen.ends).toBe(0);
    console.log(`PLACES earlier part\na reload | ${before.top} to ${after.top} | ${after.line} | frames shown ${seen.shown}, at the end ${seen.ends} | first event on the page then ${firstEvent.slice(0, 8)}`);
    await shoot(page, "reading-position-07-earlier-part");

    // A daemon restart under the open page, then a reload of it: the same line both times.
    d.proc.kill();
    await exited(d.proc);
    d = await daemon(s.state, port);
    await expect.poll(async () => (await fetch(`${d.url}/api/daemon`).then((r) => r.ok, () => false)), { timeout: 30_000 }).toBe(true);
    await page.waitForTimeout(2500);
    await same(page, id, before, "after a daemon restart");
    await page.reload();
    await same(page, id, before, "after a daemon restart and a reload");
  } finally {
    d.proc.kill();
    await exited(d.proc);
    rmSync(s.state, { recursive: true, force: true });
  }
});

// The places a first version lost or moved by itself.
test("the place holds at a turn's end line, inside a prompt's row, and over a part that is slow to come", async ({ page, request }) => {
  test.setTimeout(300_000);
  await scripted(request);
  await settle(request);
  const ws = folder("reading-place-hard");
  const reader = await long(request, "Reading: where places were lost", ws);
  const other = await long(request, "Other: a place to be meanwhile", ws, 1);
  const table: string[] = [];
  // What stands at the view's top, by a selector: its text and how far it is from the top.
  const topOf = (sel: string, nth: number) => page.evaluate(([id, find, sel, nth]) => {
    const sc = (0, eval)(find!)(id) as HTMLElement;
    const el = sc.querySelectorAll<HTMLElement>(sel as string)[nth as number]!;
    return { y: Math.round((el.getBoundingClientRect().top - sc.getBoundingClientRect().top) * 10) / 10, top: Math.round(sc.scrollTop) };
  }, [reader, FIND, sel, nth] as const);
  // The owner wheels until that element is `y` px under the view's top.
  const wheelTo = async (sel: string, nth: number, y: number) => {
    const box = (await page.locator(`[data-station="${reader}"] .k-reading`).first().boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 8; i++) {
      const at = await topOf(sel, nth);
      if (Math.abs(at.y - y) < 1) break;
      await page.mouse.wheel(0, at.y - y);
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(800);
    return topOf(sel, nth);
  };
  const awayAndBack = async () => {
    await row(page, other).click();
    await expect(pane(page, other)).toBeVisible();
    await row(page, reader).click();
    await expect(pane(page, reader)).toBeVisible();
    await page.waitForTimeout(700);
  };
  try {
    await page.setViewportSize({ width: 1920, height: 1040 });
    await open(page, [reader]);

    // A turn's end line a few px under the top: it shows no event, and the place is the row under it.
    const foot = await wheelTo(".k-turn-foot", 1, 6);
    for (let i = 1; i <= 3; i++) {
      await awayAndBack();
      const after = await topOf(".k-turn-foot", 1);
      table.push(`a turn's end line at the top, return ${i} | ${foot.top} to ${after.top} | y ${foot.y} to ${after.y}`);
      expect(Math.abs(after.y - foot.y), `a turn's end line at the top, return ${i}`).toBeLessThanOrEqual(1);
    }

    // Inside a prompt's row (its top above the view): it does not creep, over switches and reloads.
    const prompt = await wheelTo('[data-testid="user-message"]', 1, -30);
    for (let i = 1; i <= 6; i++) {
      if (i <= 3) await awayAndBack();
      else { await page.reload(); await expect(pane(page, reader)).toBeVisible(); await page.waitForTimeout(900); }
      const after = await topOf('[data-testid="user-message"]', 1);
      table.push(`inside a prompt's row, ${i <= 3 ? "switch" : "reload"} ${i} | ${prompt.top} to ${after.top} | y ${prompt.y} to ${after.y}`);
      expect(Math.abs(after.y - prompt.y), `inside a prompt's row, trip ${i}`).toBeLessThanOrEqual(1);
    }
    console.log(`PLACES hard\n${table.join("\n")}`);
  } finally {
    await drop(request, reader, other);
  }
});

test("a part that is slow to come says so, and the place is still there the next time", async ({ page }) => {
  test.setTimeout(240_000);
  const s = seeded("reading-place-slow", 3000, "turns", "Long: the part is slow");
  const id = s.ids[0]!;
  const d = await daemon(s.state);
  try {
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`${d.url}/s/${id}`);
    await expect(page.getByTestId("user-message").last()).toBeVisible({ timeout: 30_000 });
    const sc = page.locator(".k-reading").first();
    const box = (await sc.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, -3000); await page.waitForTimeout(120); }
    await page.waitForTimeout(2200);
    const before = (await at(page, id))!;
    expect(before.end).toBe(false);
    const stored = () => page.evaluate((id) => JSON.parse(localStorage.getItem("keel.places") ?? "{}")[id], id);
    const kept = await stored();
    expect(kept.end).toBe(false);

    // The part around the place takes five seconds: the wait says what it is, then the end is shown.
    let slow = true;
    await page.route(new RegExp(`/api/sessions/${id}/page\\?`), async (route) => { if (slow) await new Promise((r) => setTimeout(r, 5000)); await route.continue().catch(() => {}); });
    await page.reload();
    await expect(page.getByTestId("finding-place")).toHaveText("Finding your place", { timeout: 15_000 });
    await expect(page.getByTestId("finding-place")).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(async () => (await at(page, id))?.end, { timeout: 15_000 }).toBe(true);
    // The place was not written over by what the page showed instead.
    await page.waitForTimeout(2200);
    expect([(await stored()).ev, (await stored()).off]).toEqual([kept.ev, kept.off]);
    // The next time, at full speed, the owner is back at it.
    slow = false;
    await page.reload();
    await same(page, id, before, "after the slow part, at full speed");
    expect([(await stored()).ev, (await stored()).off]).toEqual([kept.ev, kept.off]);
  } finally {
    d.proc.kill();
    await exited(d.proc);
    rmSync(s.state, { recursive: true, force: true });
  }
});

test("the rule waits until it was read, says when its row came, and a pane beside the one worked in is not read", async ({ page, request }) => {
  test.setTimeout(300_000);
  await scripted(request);
  await settle(request);
  const ws = folder("reading-rule");
  const reader = await long(request, "Reading: the rule waits", ws, 2);
  const beside = await long(request, "Beside: lines nobody is at", ws, 1);
  const marked = (id: string) => pane(page, id).locator("[data-new-since]");
  const jump = (id: string) => pane(page, id).getByTestId("new-since-jump");
  // The row's news (its title's weight): the row while it is marked unread.
  const dot = (id: string) => row(page, id).and(page.locator("[data-unread]"));
  const mark = (id: string) => page.evaluate((id) => JSON.parse(localStorage.getItem("keel.places") ?? "{}")[id]?.read as string | undefined, id);
  const hhmm = (ts: number) => page.evaluate((ts) => new Date(ts).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }), ts);
  const events = async (id: string) => (await (await request.get(`/api/sessions/${id}`)).json()).events as { id: string; kind: string; ts: number; data: any }[];
  // The owner is at a pane: the pointer moves in it.
  const present = async (id: string) => { const b = (await pane(page, id).locator(".k-reading").first().boundingBox())!; await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.move(b.x + b.width / 2 + 3, b.y + b.height / 2 + 3); };
  const latest = async (id: string) => { const b = pane(page, id).getByTestId("jump-latest"); if (await b.isVisible()) { await b.click(); await page.waitForTimeout(900); } };
  const blur = (on: boolean) => page.evaluate((on) => { if (on) { document.hasFocus = () => false; dispatchEvent(new Event("blur")); } else { delete (document as any).hasFocus; dispatchEvent(new Event("focus")); } }, on);
  try {
    await page.setViewportSize({ width: 1920, height: 1040 });
    await open(page, [reader]);
    await expect.poll(async () => (await at(page, reader))?.end).toBe(true);
    await expect.poll(() => mark(reader), { timeout: 10_000 }).toBeTruthy();
    const read0 = await mark(reader);
    expect(read0).toBeTruthy();

    // The owner looks away (the page loses focus); a long reply comes. Back: the rule stands above the
    // view with the time its first row came, though the read mark was written long before.
    await page.evaluate((id) => { const all = JSON.parse(localStorage.getItem("keel.places")!); all[id].readAt -= 3_600_000; localStorage.setItem("keel.places", JSON.stringify(all)); }, reader);
    await page.reload();
    await expect.poll(async () => (await at(page, reader))?.end, { timeout: 15_000 }).toBe(true);
    await blur(true);
    await request.post(`/api/sessions/${reader}/messages`, { data: { text: say(lines("N", 60)) } });
    await expect.poll(() => ends(request, reader), { timeout: 60_000 }).toBe(3);
    await blur(false);
    await expect(marked(reader)).toHaveCount(1, { timeout: 15_000 });
    const first = (await events(reader)).filter((e) => e.kind === "user").at(-1)!;
    await expect(marked(reader)).toHaveAttribute("data-new-since", `New since ${await hhmm(first.ts)}`);
    await expect(jump(reader)).toHaveAttribute("data-where", "above");
    // A screen reader is told of it as a separator, before the new row.
    expect(await marked(reader).evaluate((el) => { const sep = el.previousElementSibling?.querySelector('[role="separator"]'); return sep?.getAttribute("aria-label") ?? null; })).toBe(`New since ${await hhmm(first.ts)}`);

    // Its line was never on screen: it is still there after ten seconds at the end, a blur and a focus,
    // another session and back, and a reload. The read mark has not passed it.
    await present(reader);
    await page.waitForTimeout(6000);
    await blur(true); await blur(false);
    await page.waitForTimeout(600);
    await expect(marked(reader)).toHaveCount(1);
    await row(page, beside).click();
    await expect(pane(page, beside)).toBeVisible();
    await row(page, reader).click();
    await expect(marked(reader)).toHaveCount(1, { timeout: 15_000 });
    await page.reload();
    await expect(marked(reader)).toHaveCount(1, { timeout: 15_000 });
    await expect(marked(reader)).toHaveAttribute("data-new-since", `New since ${await hhmm(first.ts)}`);
    await present(reader);
    await page.waitForTimeout(1800);
    expect(await mark(reader)).toBe(read0);

    // The way to it puts the rule at the view's top with nothing cut above it, at any text size.
    for (const scale of [1.5, 1]) {
      await latest(reader);
      await page.evaluate((scale) => localStorage.setItem("keel.textScale", JSON.stringify(scale)), scale);
      await page.reload();
      await expect(jump(reader)).toHaveAttribute("data-where", "above", { timeout: 15_000 });
      await jump(reader).click();
      await expect(jump(reader)).toHaveCount(0);
      const y = await marked(reader).evaluate((el) => { const rem = parseFloat(getComputedStyle(document.documentElement).fontSize); return (el.getBoundingClientRect().top - el.closest(".k-reading")!.getBoundingClientRect().top) / rem; });
      expect(y, `the rule's row under the top at text size ${scale}, in rem`).toBeGreaterThan(0.9);
      expect(y, `the rule's row under the top at text size ${scale}, in rem`).toBeLessThan(1.2);
      if (scale === 1.5) await shoot(page, "reading-position-08-jump-at-text-size-1.5");
    }
    // The place after the jump is the owner's: another session and back returns to it.
    await page.waitForTimeout(800);
    const jumped = (await at(page, reader))!;
    await row(page, beside).click();
    await expect(pane(page, beside)).toBeVisible();
    await row(page, reader).click();
    await same(page, reader, jumped, "after the way to the rule, another session and back");
    await expect(marked(reader)).toHaveCount(1);
    // Read to the end: it goes, and the mark is written at the end.
    await pane(page, reader).locator(".k-reading").hover();
    await page.mouse.wheel(0, 100_000);
    await expect(marked(reader)).toHaveCount(0, { timeout: 12_000 });
    const lastId = (await events(reader)).at(-1)!.id;
    await expect.poll(() => mark(reader), { timeout: 10_000 }).toBe(lastId);

    // Present but scrolled up: a reply comes below the view. The rule waits there, with the way down to it.
    await readAt(page, reader, "T1 line 5 of");
    await request.post(`/api/sessions/${reader}/messages`, { data: { text: say(lines("M", 60)) } });
    await expect.poll(() => ends(request, reader), { timeout: 60_000 }).toBe(4);
    await page.mouse.wheel(0, -2);
    await expect(marked(reader)).toHaveCount(1, { timeout: 15_000 });
    await expect(marked(reader)).toContainText("M line 1 of");
    await expect(jump(reader)).toHaveAttribute("data-where", "below");
    // Said to be read by the owner: it goes at once.
    await latest(reader);
    await expect(jump(reader)).toHaveAttribute("data-where", "above", { timeout: 15_000 });
    await pane(page, reader).getByTestId("new-since-read").click();
    await expect(marked(reader)).toHaveCount(0);

    // Two panes: the owner types in the first. Lines that come in the second are not read because
    // they are on screen: its row in the list is marked, and its conversation shows where they start.
    await open(page, [reader, beside]);
    await expect.poll(async () => (await at(page, beside))?.end).toBe(true);
    await present(beside);
    await expect(dot(beside)).toHaveCount(0, { timeout: 15_000 });
    await page.waitForTimeout(800);
    await expect(marked(beside)).toHaveCount(0);
    const box = pane(page, reader).getByTestId("composer");
    await box.click();
    await box.pressSequentially("a note of my own");
    // (Over half a minute since the pointer or a wheel was in the second pane.)
    await page.evaluate(() => { const real = Date.now.bind(Date); Date.now = () => real() + 40_000; });
    await box.pressSequentially(" and more");
    await page.waitForTimeout(400);
    await request.post(`/api/sessions/${beside}/messages`, { data: { text: say(lines("B", 60)) } });
    await expect.poll(() => ends(request, beside), { timeout: 60_000 }).toBe(2);
    await box.pressSequentially(".");
    await expect(marked(beside)).toHaveCount(1, { timeout: 15_000 });
    await expect(dot(beside)).toBeVisible({ timeout: 15_000 });
    await expect(marked(reader)).toHaveCount(0);
    await shoot(page, "reading-position-09-pane-beside-not-read");
    // The owner goes to it: its row is read, and the rule stays until its line and the end were seen.
    await present(beside);
    await expect(dot(beside)).toHaveCount(0, { timeout: 15_000 });
    await expect(marked(beside)).toHaveCount(1);
  } finally {
    await drop(request, reader, beside);
  }
});
