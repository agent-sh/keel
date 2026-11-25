import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Locator, type Page } from "./isolate.ts";
import { shoot, setPanes } from "./shots.ts";

// Feature: several requests waiting at once. They are a list of rows; the one
// that has the keyboard is the framed one and the others step back; each is
// still answered alone (Enter, or Esc and a reason); and one action allows
// the requests of a tool that the owner can have read, and nothing else: only
// rows whose text is whole on screen and has stood still for a second, never
// one that is cut, high risk, or that arrived under the hand.

type Card = { id: string; summary: string; tool: string; state: string; risk: string; cut?: boolean; choice?: string; reason?: string };
const bash = (n: string) => ({ name: "Bash", input: { command: `echo ${n} > ${n}.txt` } });
const FIXTURE = `${import.meta.dirname}/fixtures/echo-mcp.ts`;

async function start(request: APIRequestContext, title: string, calls: unknown[], opts: { later?: boolean } = {}) {
  const models = (await (await request.get("/api/models")).json()).models as { id: string; provider: string; context: number }[];
  const model = models.filter((m) => m.provider === "scripted").sort((a, b) => b.context - a.context)[0];
  test.skip(!model, "requires a scripted scratch daemon");
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `batch-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { title, model: model!.id, workspace: ws } })).json();
  const id = session.id as string;
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  const send = () => request.post(`/api/sessions/${id}/messages`, { data: { text: `script:batch ${JSON.stringify(calls)}` } });
  if (!opts.later) await send();
  const cards = async (of = id) => (await (await request.get(`/api/sessions/${of}/approvals?all`)).json()).approvals as Card[];
  return { id, ws, cards, send };
}
const paneOf = (page: Page, id: string) => page.getByTestId("station").and(page.locator(`[data-station="${id}"]`));
// What the action says it covers (the button also holds its widest label, unseen, to keep its width).
const label = (all: Locator) => all.getByTestId("allow-all-label");

// Framed: the violet border of a request that has the keyboard or that a pointed "allow all" covers.
const framed = (card: Locator) => card.evaluate((el) => {
  const probe = document.createElement("i");
  probe.style.color = "var(--st-need)";
  el.append(probe);
  const need = getComputedStyle(probe).color;
  probe.remove();
  return getComputedStyle(el).borderTopColor === need;
});
const frames = async (page: Page) => Promise.all((await page.getByTestId("approval").all()).map(framed));

// The ids each "allow all" answer carried to the daemon.
function batchPosts(page: Page) {
  const sent: string[][] = [];
  page.on("request", (r) => { if (r.method() === "POST" && /\/approvals$/.test(new URL(r.url()).pathname)) sent.push(r.postDataJSON().ids); });
  return sent;
}
// Keeps the frame of each new request whose text holds one of the words from the page until it is let through.
async function holdFrames(page: Page, words: string[]) {
  const held: Record<string, () => void> = {};
  await page.routeWebSocket(/\/ws$/, (socket) => {
    const server = socket.connectToServer();
    server.onMessage((m) => {
      const word = typeof m === "string" ? words.find((w) => m.includes(w)) : undefined;
      const f = word ? JSON.parse(m as string) : null;
      if (f?.name === "approval" && f.data?.state === "pending") held[word!] = () => socket.send(m);
      else socket.send(m);
    });
  });
  return held;
}

// Once the page has `rows` requests, presses every Allow once that now lies where another
// row's Allow once was: what a pointer resting there, or a press already on its way, would
// hit. In the page, in the first frame in which a row has changed place (the region takes a
// frame to fit a list that grew or shrank), so no machine is too slow for it. A whole press:
// pointer down, mouse down, click. Says for each one which row was there, which row it hit,
// and whether the mouse down was kept from taking the keyboard. Empty when no row changed
// place within ten frames (a request that landed where it moves nothing).
const pressWhereRowsChanged = (page: Page, rows: number) => page.evaluate((rows) => new Promise<{ from: string; to: string; kept: boolean }[]>((done) => {
  const idOf = (el: Element) => el.closest<HTMLElement>('[data-testid="approval"]')!.dataset.approvalId!;
  const was = [...document.querySelectorAll('[data-testid="allow-once"]')].map((b) => { const r = b.getBoundingClientRect(); return { id: idOf(b), x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const press = () => {
    const out: { from: string; to: string; kept: boolean }[] = [];
    for (const p of was) {
      const b = document.elementFromPoint(p.x, p.y)?.closest('[data-testid="allow-once"]');
      if (!b || idOf(b) === p.id) continue;
      const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      b.dispatchEvent(down);
      b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
      out.push({ from: p.id, to: idOf(b), kept: down.defaultPrevented });
    }
    return out;
  };
  let frames = 0;
  const frame = () => {
    const out = press();
    if (out.length || ++frames > 10) done(out);
    else requestAnimationFrame(frame);
  };
  const changed = () => document.querySelectorAll('[data-testid="approval"]').length === rows;
  if (changed()) return frame();
  const mo = new MutationObserver(() => { if (changed()) { mo.disconnect(); frame(); } });
  mo.observe(document.body, { childList: true, subtree: true });
}), rows);

test("several requests are answered one by one from the keys, or all of a tool at once", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const { id, ws, cards } = await start(request, "Five at once", [bash("one"), bash("two"), { name: "Write", input: { file_path: "note.md", content: "a note\n" } }, bash("three"), bash("four")]);
  try {
    await page.goto(`/s/${id}`);
    const pane = paneOf(page, id);
    const card = pane.getByTestId("approval");
    const row = (text: string) => card.filter({ hasText: text });
    const all = pane.getByTestId("allow-all");
    const hint = pane.getByTestId("approvals-hint");
    await expect(card).toHaveCount(5);
    // Requests made in the same instant have no order of their own: the rows are read as they are shown.
    const order = () => card.evaluateAll((els) => els.map((el) => el.textContent!.match(/(one|two|three|four|note)\.(txt|md)/)![1]!));
    const downTo = async (name: string, from: number) => { for (let i = from; i < (await order()).indexOf(name); i++) await page.keyboard.press("ArrowDown"); };
    const only = async (...names: string[]) => (await order()).map((n) => names.includes(n));
    await expect(pane.getByTestId("approvals-count")).toHaveText("5 requests wait");
    // One action, for the tool that has several: it says how many it answers and what they are.
    await expect(all).toHaveCount(1);
    await expect(all).toBeEnabled();
    await expect(label(all)).toHaveText("Allow all 4 Bash commands");
    await expect(all).toHaveAttribute("aria-description", `Allows once, in this order: ${(await order()).filter((n) => n !== "note").map((n) => `echo ${n} > ${n}.txt`).join("; ")}`);

    // The oldest request has the keyboard: it is the framed one, the others are not.
    await expect(card.first().getByTestId("allow-once")).toBeFocused();
    // (Brought there by the page: Enter acts after the settle time from then, as the card says.)
    await expect(card.first().getByTestId("allow-once")).toHaveAttribute("data-ready", "true", { timeout: 5000 });
    expect(await frames(page)).toEqual([true, false, false, false, false]);
    await expect(hint).toHaveText("Up and Down choose, Enter allows the framed one once");
    // Down moves to the next request, and the frame with it.
    await page.keyboard.press("ArrowDown");
    await expect(card.nth(1).getByTestId("allow-once")).toBeFocused();
    // (Brought there by the page: Enter acts after the settle time from then, as the card says.)
    await expect(card.nth(1).getByTestId("allow-once")).toHaveAttribute("data-ready", "true", { timeout: 5000 });
    expect(await frames(page)).toEqual([false, true, false, false, false]);
    await page.keyboard.press("ArrowUp");
    await downTo("two", 0);
    await expect(row("two.txt").getByTestId("allow-once")).toBeFocused();
    // (Brought there by the page: Enter acts after the settle time from then, as the card says.)
    await expect(row("two.txt").getByTestId("allow-once")).toHaveAttribute("data-ready", "true", { timeout: 5000 });
    expect(await frames(page)).toEqual(await only("two"));
    await shoot(page, "approvals-batch-1920-marked");

    // Enter answers the framed one and no other. The focus goes to the list, not to another request.
    await page.keyboard.down("Enter");
    await expect(card).toHaveCount(4);
    await expect(row("two.txt")).toHaveCount(0);
    await expect(pane.getByTestId("approvals")).toBeFocused();
    await expect.poll(() => existsSync(join(ws, "two.txt"))).toBe(true);
    await expect(label(all)).toHaveText("Allow all 3 Bash commands");
    // The key is still held: its repeat answers nothing, on a request whose Allow can act.
    await downTo("one", -1);
    await expect(row("one.txt").getByTestId("allow-once")).toBeFocused();
    // (Brought there by the page: Enter acts after the settle time from then, as the card says.)
    await expect(row("one.txt").getByTestId("allow-once")).toHaveAttribute("data-ready", "true", { timeout: 5000 });
    await expect(row("one.txt")).toHaveAttribute("data-live", "true");
    await page.keyboard.down("Enter");
    await page.waitForTimeout(400);
    await page.keyboard.up("Enter");
    await expect(card).toHaveCount(4);
    expect((await cards()).filter((c) => c.state === "pending")).toHaveLength(4);

    // Esc on a request denies it with a reason, as a lone card does.
    await page.keyboard.press("Escape");
    const why = row("one.txt").getByTestId("deny-reason");
    await expect(why).toBeFocused();
    await expect(hint).toHaveText(""); // the arrows are the field's while it has the keyboard
    // An input method's Escape drops the word being composed: the reason field stays.
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      await why.evaluate((el, init) => {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true, ...init }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", code: "Escape", bubbles: true }));
      }, init);
    }
    await page.waitForTimeout(200);
    await expect(why).toBeFocused();
    await page.keyboard.type("one.txt is kept as it is");
    await shoot(page, "approvals-batch-1920-deny");
    await page.keyboard.press("Enter");
    await expect(card).toHaveCount(3);
    await expect(pane.getByTestId("approvals")).toBeFocused();

    // Up from the list reaches the one action. While it has the keyboard, the requests it
    // covers are the framed ones: the two commands, not the file change between them.
    await page.keyboard.press("ArrowUp");
    await expect(all).toBeFocused();
    await expect(all).toBeEnabled();
    await expect(label(all)).toHaveText("Allow all 2 Bash commands");
    await expect(hint).toHaveText("Enter allows the framed ones once");
    expect(await frames(page)).toEqual(await only("three", "four"));
    await expect(row("note.md")).not.toHaveAttribute("data-hot");
    await shoot(page, "approvals-batch-1920-all");
    const listed = await card.and(page.locator("[data-hot]")).evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.approvalId));
    const sent = batchPosts(page);
    await page.keyboard.press("Enter");
    // Exactly the listed ones were answered, in the order they were listed, with one request.
    await expect(card).toHaveCount(1);
    expect(sent).toEqual([listed]);
    // (The commands after the file change in the reply run when it has ended: they are answered now, and run below.)
    // The file change still waits, a lone card again; the focus is on the list, so the card
    // does not say that Enter allows it.
    await expect(row("note.md")).toBeVisible();
    await expect(row("note.md")).not.toHaveAttribute("data-dense");
    await expect(pane.getByTestId("approvals-bar")).toHaveCount(0);
    await expect(pane.getByTestId("approvals")).toBeFocused();
    await expect(row("note.md").getByTestId("approval-hint")).toBeHidden();
    expect(existsSync(join(ws, "note.md"))).toBe(false);

    const by = Object.fromEntries((await cards()).map((c) => [c.summary.match(/(one|two|three|four|note)/)![1]!, c]));
    expect(by.one).toMatchObject({ state: "denied", reason: "one.txt is kept as it is" });
    for (const n of ["two", "three", "four"]) expect(by[n]).toMatchObject({ state: "allowed", choice: "once" });
    expect(by.note!.state).toBe("pending");
    expect(existsSync(join(ws, "one.txt"))).toBe(false);

    // The last one by the pointer: the turn goes on.
    await row("note.md").getByTestId("allow-once").click();
    await expect(card).toHaveCount(0);
    await expect(pane.getByTestId("turn-end")).toHaveCount(1, { timeout: 30_000 });
    expect(existsSync(join(ws, "note.md"))).toBe(true);
    await expect.poll(() => ["three.txt", "four.txt"].every((f) => existsSync(join(ws, f)))).toBe(true);
    expect((await (await request.get("/api/errors")).json()).errors.length).toBe(errorsBefore);
  } finally { await request.delete(`/api/sessions/${id}`); }
});

// The pointer, a phone, and an agent's requests on the parent's page: "allow all" answers
// the list it sits over. The agent's requests have a list of their own under its name.
test("allow all covers the requests it lists, not an agent's", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const agent = `Check the build\nscript:batch ${JSON.stringify([bash("c1"), bash("c2")])}`;
  const { id, ws, cards } = await start(request, "Three and an agent", [{ name: "spawn_agent", input: { message: agent, isolation: "none" } }, bash("one"), bash("two"), bash("three")]);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/s/${id}`);
    const pane = paneOf(page, id);
    const own = pane.getByTestId("approvals").first();
    const theirs = pane.getByTestId("child-approvals").getByTestId("approvals");
    await expect(own.getByTestId("approval")).toHaveCount(3);
    await expect(theirs.getByTestId("approval")).toHaveCount(2, { timeout: 30_000 });
    // Every request of the list is the same tool: the heading names it, the rows carry the commands.
    await expect(own.getByTestId("approvals-count")).toHaveText("3 Bash commands wait");
    await expect(own.getByTestId("allow-all")).toBeEnabled();
    await expect(label(own.getByTestId("allow-all"))).toHaveText("Allow all 3 Bash commands");
    // The agent's rows are under the fold on a phone: its action covers none of them.
    await expect(label(theirs.getByTestId("allow-all"))).toHaveText("Allow 0 of 2 Bash commands");
    await expect(theirs.getByTestId("allow-all")).toBeDisabled();
    // On a phone each row keeps its three answers whole, under its command.
    for (const t of ["approval-summary", "allow-once", "allow-always", "deny"]) await expect(own.getByTestId("approval").first().getByTestId(t)).toBeInViewport({ ratio: 1 });
    await shoot(page, "approvals-batch-390x844");

    await page.setViewportSize({ width: 1920, height: 1040 });
    await expect(own.getByTestId("approval").first().getByTestId("allow-once")).toBeFocused();
    // A link that names one request (an alert's, a notification's) opens the page with the
    // keyboard on that request, here an agent's, and it is the framed one: no other is.
    const linked = (await theirs.locator('[data-testid="approval"]', { hasText: "c2.txt" }).getAttribute("data-approval-id"))!;
    await page.goto(`/s/${id}?approval=${linked}`);
    await expect(theirs.locator(`[data-approval-id="${linked}"]`).getByTestId("allow-once")).toBeFocused();
    expect(await Promise.all((await pane.getByTestId("approval").all()).map(framed))).toEqual((await pane.getByTestId("approval").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.approvalId))).map((x) => x === linked));
    await own.getByTestId("approval").first().getByTestId("allow-once").focus();
    // The pointer on the action frames the three requests it answers and no request of the agent.
    await own.getByTestId("allow-all").hover();
    await expect(own.locator('[data-testid="approval"][data-hot]')).toHaveCount(3);
    // The hint is about the pointed action while several rows are framed, not about the row with the keyboard.
    await expect(own.getByTestId("approvals-hint")).toHaveText("A click allows the framed ones once");
    await expect(theirs.locator('[data-testid="approval"][data-hot]')).toHaveCount(0);
    expect(await Promise.all((await theirs.getByTestId("approval").all()).map(framed))).toEqual([false, false]);
    await shoot(page, "approvals-batch-1920-pointed");
    const theirId = await theirs.getByTestId("approval").first().getAttribute("data-approval-id");
    const child = (await (await request.get("/api/approvals")).json()).approvals.find((a: { id: string }) => a.id === theirId).session_id as string;
    await own.getByTestId("allow-all").click();
    await expect.poll(() => ["one.txt", "two.txt", "three.txt"].every((f) => existsSync(join(ws, f)))).toBe(true);
    expect((await cards()).map((c) => [c.state, c.choice])).toEqual([["allowed", "once"], ["allowed", "once"], ["allowed", "once"]]);
    // The agent's two still wait, shown under its name, and nothing of theirs ran.
    await expect(theirs.getByTestId("approval")).toHaveCount(2);
    expect((await cards(child)).map((c) => c.state)).toEqual(["pending", "pending"]);
    expect(existsSync(join(ws, "c1.txt"))).toBe(false);
    // Their own action answers them.
    await theirs.getByTestId("allow-all").click();
    await expect(pane.getByTestId("approval")).toHaveCount(0);
    await expect.poll(() => ["c1.txt", "c2.txt"].every((f) => existsSync(join(ws, f)))).toBe(true);
    expect((await (await request.get("/api/errors")).json()).errors.length).toBe(errorsBefore);
  } finally { await request.delete(`/api/sessions/${id}`); }
});

// The action answers the requests it named when it was pressed, by their ids. One that reaches
// the page after that, while the answer is still on its way, is not among them.
test("a request that arrives after the click is not answered by it", async ({ page, request }) => {
  const { id, ws, cards, send } = await start(request, "A late third", [bash("one"), bash("two"), bash("three")], { later: true });
  try {
    const late = await holdFrames(page, ["three.txt"]);
    await page.goto(`/s/${id}`);
    const pane = paneOf(page, id);
    await expect(pane.getByTestId("composer")).toBeFocused();
    await send();
    const card = pane.getByTestId("approval");
    const all = pane.getByTestId("allow-all");
    await expect(card).toHaveCount(2);
    await expect(all).toBeEnabled();
    await expect(label(all)).toHaveText("Allow all 2 Bash commands");
    await expect.poll(() => !!late["three.txt"]).toBe(true);
    const listed = await card.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.approvalId));

    // The answer is held on its way: the third request arrives meanwhile. The daemon's reply
    // is changed on its way back to say the second card would not take the answer though it
    // still waits (as a card nothing waits on does): the page has to say so.
    const sent: string[][] = [];
    let go!: () => void;
    const held = new Promise<void>((r) => { go = r; });
    await page.route(/\/approvals$/, async (r) => {
      if (r.request().method() !== "POST") return r.continue();
      sent.push(r.request().postDataJSON().ids);
      await held;
      const reply = await r.fetch();
      const body = await reply.json();
      body.results[1] = { id: body.results[1].id, error: "nothing waits on this card", status: 409, state: "pending" };
      await r.fulfill({ response: reply, json: body });
    });
    await all.click();
    await expect.poll(() => sent.length).toBe(1);
    late["three.txt"]!();
    await expect(card).toHaveCount(3);
    await expect(card.filter({ hasText: "three.txt" }).getByTestId("allow-once")).not.toHaveAttribute("disabled");
    go();

    // The two that were listed ran. The third waits with its own answers, and nothing of it ran.
    await expect(card).toHaveCount(1);
    expect(sent).toEqual([listed]);
    await expect(pane.getByTestId("approvals-error")).toHaveText("1 of 2 allowed. One still waits: nothing waits on this card");
    await expect.poll(() => ["one.txt", "two.txt"].every((f) => existsSync(join(ws, f)))).toBe(true);
    const third = (await cards()).find((c) => c.summary.includes("three"))!;
    expect(third.state).toBe("pending");
    expect(existsSync(join(ws, "three.txt"))).toBe(false);
    await card.getByTestId("allow-once").click();
    await expect(pane.getByTestId("turn-end")).toHaveCount(1, { timeout: 30_000 });
    expect(existsSync(join(ws, "three.txt"))).toBe(true);
  } finally { await request.delete(`/api/sessions/${id}`); }
});

// Eight requests on a phone: three or so fit above the message box. The action names and
// answers the ones whose command is whole on screen, never one under the fold.
test("on a phone the action covers the rows in view, not the ones under the fold", async ({ page, request }) => {
  const names = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];
  const { id, ws, cards } = await start(request, "Eight on a phone", names.map(bash));
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/s/${id}`);
    const pane = paneOf(page, id);
    const card = pane.getByTestId("approval");
    const all = pane.getByTestId("allow-all");
    await expect(card).toHaveCount(8);
    await expect(pane.getByTestId("approvals-count")).toHaveText("8 Bash commands wait");
    await expect(all).toBeEnabled();
    // The action stays in reach while the list is scrolled to its end, and back.
    const tray = pane.getByTestId("composer-tray");
    await tray.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(card.last()).toBeInViewport();
    await expect(all).toBeInViewport({ ratio: 1 });
    await tray.evaluate((el) => { el.scrollTop = 0; });
    await expect(all).toBeEnabled();
    // The rows whose command shows whole in the region above the message box.
    const inView = () => card.evaluateAll((els) => {
      const tray = els[0]!.closest('[data-testid="composer-tray"]')!.getBoundingClientRect();
      return els.filter((el) => { const r = el.querySelector('[data-testid="approval-summary"]')!.getBoundingClientRect(); return r.top >= tray.top && r.bottom <= tray.bottom; }).map((el) => (el as HTMLElement).dataset.approvalId!);
    });
    const shown = await inView();
    expect(shown.length).toBeGreaterThan(1);
    expect(shown.length).toBeLessThan(8);
    const said = (await label(all).textContent())!.match(/^Allow (\d+) of 8 Bash commands$/);
    expect(said).not.toBeNull();
    const n = Number(said![1]);
    expect(n).toBeGreaterThan(1);
    expect(n).toBeLessThanOrEqual(shown.length);
    // Where a finger is used nothing points at the action before it is pressed: the rows it covers are framed all the time.
    const framedIds = await card.and(page.locator("[data-hot]")).evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.approvalId!));
    expect(framedIds).toHaveLength(n);
    await shoot(page, "approvals-batch-390x844-eight");
    const sent = batchPosts(page);
    await all.click();
    await expect(card).toHaveCount(8 - n);
    expect(sent[0]).toEqual(framedIds);
    // What was answered is what was said, and every one of them was in view.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(n);
    expect(sent[0]!.every((x) => shown.includes(x))).toBe(true);
    const after = await cards();
    expect(after.filter((c) => c.state === "allowed").map((c) => c.id).sort()).toEqual([...sent[0]!].sort());
    for (const c of after.filter((c) => c.state === "pending")) expect(existsSync(join(ws, `${c.summary.match(/p\d/)![0]}.txt`))).toBe(false);
    // The rest come into view, stand, and the action names the next ones.
    await expect(all).toBeEnabled().catch(async (e) => {
      console.log(await card.evaluateAll((els) => { const tray = els[0]!.closest<HTMLElement>('[data-testid="composer-tray"]')!; const t = tray.getBoundingClientRect(); const b = document.querySelector('[data-testid="allow-all"]')!; return JSON.stringify({ tray: [t.top, t.bottom, tray.scrollTop, tray.scrollHeight, tray.clientHeight, tray.dataset.more], rows: els.map((el) => { const r = el.querySelector('[data-testid="approval-summary"]')!.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.bottom), (el as HTMLElement).dataset.live]; }), active: (document.activeElement as HTMLElement)?.dataset?.testid, label: b.textContent, dis: b.getAttribute("aria-disabled") }); }));
      throw e;
    });
    await expect(label(all)).toHaveText(new RegExp(`^Allow (all ${8 - n}|\\d+ of ${8 - n}) Bash commands$`));
  } finally { await request.delete(`/api/sessions/${id}`); }
});

// A command longer than the box that shows it (a long line, a script whose last line writes
// a file) is not answered with the others: the row says it is cut and opens in place.
test("a command cut by its box is answered on its own, and opens in place", async ({ page, request }) => {
  const long = `echo ${"x".repeat(4100)} > long.txt`;
  const script = [...Array.from({ length: 40 }, (_, i) => `echo line ${i + 1}`), "echo done > script.txt"].join("\n");
  const { id, ws, cards } = await start(request, "Cut commands", [bash("aa"), { name: "Bash", input: { command: long } }, { name: "Bash", input: { command: script } }, bash("bb")]);
  try {
    await page.goto(`/s/${id}`);
    const pane = paneOf(page, id);
    const card = pane.getByTestId("approval");
    const row = (text: string) => card.filter({ hasText: text });
    const all = pane.getByTestId("allow-all");
    await expect(card).toHaveCount(4);
    await expect(all).toBeEnabled();
    await expect(label(all)).toHaveText("Allow 2 of 4 Bash commands");
    const over = (r: Locator) => r.getByTestId("approval-summary").evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    for (const name of ["long.txt", "script.txt"]) {
      const r = row(name);
      await expect(r.getByTestId("approval-cut")).toHaveText("Cut here, so it is answered on its own");
      expect(await over(r)).toBe(true);
    }
    // The line that writes a file is below what the box shows.
    expect(await row("script.txt").getByTestId("approval-summary").evaluate((el) => {
      const range = document.createRange();
      const text = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent!.includes("script.txt"))!;
      range.setStart(text, text.textContent!.indexOf("echo done"));
      range.setEnd(text, text.textContent!.length);
      return range.getBoundingClientRect().top > el.getBoundingClientRect().bottom;
    })).toBe(true);
    await shoot(page, "approvals-batch-1920-cut");

    // Opened in place it is whole; folded again it is cut again.
    for (const name of ["script.txt", "long.txt"]) {
      const r = row(name), open = r.getByTestId("approval-expand");
      await expect(open).toHaveText("Show the whole command");
      await open.click();
      await expect(open).toHaveAttribute("aria-expanded", "true");
      await expect(r.getByTestId("approval-cut")).toHaveCount(0);
      expect(await over(r)).toBe(false);
      if (name === "script.txt") await shoot(page, "approvals-batch-1920-opened");
      await open.click();
      await expect(r.getByTestId("approval-cut")).toBeVisible();
    }

    // The action frames and answers the two short ones only.
    await expect(all).toBeEnabled();
    await expect(label(all)).toHaveText("Allow 2 of 4 Bash commands");
    await all.hover();
    await expect(card.and(page.locator("[data-hot]"))).toHaveCount(2);
    for (const name of ["long.txt", "script.txt"]) await expect(row(name)).not.toHaveAttribute("data-hot");
    const sent = batchPosts(page);
    await all.click();
    await expect(card).toHaveCount(2);
    const now = await cards();
    expect(sent).toEqual([now.filter((c) => /echo (aa|bb) /.test(c.summary)).map((c) => c.id)]);
    await expect.poll(() => ["aa.txt", "bb.txt"].every((f) => existsSync(join(ws, f)))).toBe(true);
    expect(now.filter((c) => c.state === "pending").map((c) => c.summary.slice(-10)).sort()).toEqual(["> long.txt", "script.txt"]);
    expect(["long.txt", "script.txt"].some((f) => existsSync(join(ws, f)))).toBe(false);
    // Two cut ones are left: no action for them. Cut, a card takes no answer: its Allow refuses and
    // says to open the whole command first; opened, it answers.
    await expect(all).toHaveCount(0);
    const cut = row("script.txt");
    await expect(cut.getByTestId("allow-once")).toBeDisabled();
    await cut.getByTestId("allow-once").click({ force: true });
    await expect(cut.getByTestId("approval-open-first")).toHaveText("Open the whole command first.");
    expect(existsSync(join(ws, "script.txt"))).toBe(false);
    // Opened, it is read once every line of it has been in view: the owner scrolls through it.
    await cut.getByTestId("approval-expand").click();
    await expect(cut.getByTestId("approval-left")).toHaveText(/^\d+ lines not seen yet/);
    const tray = (await pane.getByTestId("composer-tray").boundingBox())!;
    await page.mouse.move(tray.x + tray.width / 2, tray.y + tray.height / 2);
    for (const by of [...Array(8).fill(-300), ...Array(40).fill(60)]) { await page.mouse.wheel(0, by); await page.waitForTimeout(35); }
    await expect(cut).not.toHaveAttribute("data-must-open", "true", { timeout: 10_000 });
    await cut.getByTestId("allow-once").scrollIntoViewIfNeeded();
    await expect(cut).toHaveAttribute("data-live", "true", { timeout: 10_000 });
    await cut.getByTestId("allow-once").click();
    await expect.poll(() => existsSync(join(ws, "script.txt"))).toBe(true);
  } finally { await request.delete(`/api/sessions/${id}`); }
});

// What is answered alone is a rule of the daemon too: a list that names a high-risk request,
// or one whose card shows only the start of its input, is refused whole.
test("a high-risk request and one shown in part are left out, by the page and by the daemon", async ({ page, request }) => {
  const server = `batchecho${Date.now().toString(36)}`;
  const text = `${"words ".repeat(120)}END-OF-TEXT`;
  expect((await request.post("/api/mcp/servers", { data: { name: server, command: "bun", args: [FIXTURE] } })).ok()).toBe(true);
  const { id, ws, cards, send } = await start(request, "Left out", [bash("aa"), bash("bb"), { name: "Bash", input: { command: "sudo true" } }, { name: "mcp_call", input: { tool: `${server}__echo`, arguments: { text } } }], { later: true });
  try {
    await expect.poll(async () => ((await (await request.get("/api/mcp/servers")).json()).servers as { name: string; state: string }[]).find((s) => s.name === server)?.state, { timeout: 20_000 }).toBe("ready");
    await send();
    await page.goto(`/s/${id}`);
    const pane = paneOf(page, id);
    const card = pane.getByTestId("approval");
    const all = pane.getByTestId("allow-all");
    await expect(card).toHaveCount(4);
    const risky = card.and(page.locator('[data-risk="high"]'));
    const part = card.filter({ has: page.getByTestId("approval-cut") });
    await expect(risky).toHaveCount(1);
    // "all" is not said when requests of the tool are left out.
    await expect(all).toHaveCount(1);
    await expect(all).toBeEnabled();
    await expect(label(all)).toHaveText("Allow 2 of 3 Bash commands");
    // The daemon cut this card's text: it says so, and shows all it kept when opened.
    await expect(part).toHaveCount(1);
    await expect(part.getByTestId("approval-cut")).toHaveText("Only the start is shown, so it is answered on its own");
    await expect(part.getByTestId("approval-summary")).not.toContainText("END-OF-TEXT");
    // A high-risk card in a list says that Enter allows it only while it has the keyboard.
    await expect(risky.getByTestId("approval-hint")).toBeHidden();
    await risky.getByTestId("allow-once").focus();
    await expect(risky.getByTestId("approval-hint")).toBeVisible();
    await shoot(page, "approvals-batch-1920-left-out");
    await part.getByTestId("approval-expand").click();
    await expect(pane.getByTestId("approval").filter({ hasText: "END-OF-TEXT" })).toHaveCount(1);
    await pane.getByTestId("approval").filter({ hasText: "END-OF-TEXT" }).getByTestId("approval-expand").click();

    // Asked of the daemon directly, as a page with a fault would: refused whole, nothing allowed.
    const open = await cards();
    const pick = (f: (c: Card) => boolean) => open.find(f)!.id;
    const [aa, high, cut] = [pick((c) => c.summary.includes("aa.txt")), pick((c) => c.risk === "high"), pick((c) => !!c.cut)];
    const many = (ids: string[], choice = "once") => request.post(`/api/sessions/${id}/approvals`, { data: { choice, ids } });
    const refusedHigh = await many([aa, high]);
    expect([refusedHigh.status(), (await refusedHigh.json()).alone]).toEqual([400, [high]]);
    const refusedCut = await many([aa, cut]);
    expect([refusedCut.status(), (await refusedCut.json()).alone]).toEqual([400, [cut]]);
    expect((await many([aa], "always")).status()).toBe(400);
    // A list longer than a page can show to be read is not one the owner answered.
    expect((await many([aa, ...Array.from({ length: 100 }, (_, i) => `no-such-${i}`)])).status()).toBe(400);
    expect((await cards()).map((c) => c.state)).toEqual(["pending", "pending", "pending", "pending"]);

    // The action answers the two it names.
    await expect(all).toBeEnabled();
    const sent = batchPosts(page);
    await all.click();
    await expect(card).toHaveCount(2);
    expect(sent).toHaveLength(1);
    await expect.poll(() => ["aa.txt", "bb.txt"].every((f) => existsSync(join(ws, f)))).toBe(true);
    expect((await cards()).filter((c) => c.state === "pending").map((c) => c.id).sort()).toEqual([high, cut].sort());
  } finally {
    await request.delete(`/api/sessions/${id}`);
    await request.delete(`/api/mcp/servers/${server}`);
  }
});

// While the keyboard is on the action, what it covers does not grow: a request that arrives
// then is not answered by the Enter that follows.
test("a request that arrives while the action has the keyboard does not join it", async ({ page, request }) => {
  const { id, ws, cards, send } = await start(request, "Late under the keys", [bash("k1"), bash("k2"), bash("late")], { later: true });
  try {
    const held = await holdFrames(page, ["late.txt"]);
    await page.goto(`/s/${id}`);
    const pane = paneOf(page, id);
    await expect(pane.getByTestId("composer")).toBeFocused();
    await send();
    const card = pane.getByTestId("approval");
    const all = pane.getByTestId("allow-all");
    await expect(card).toHaveCount(2);
    await expect(all).toBeEnabled();
    await all.focus();
    await expect(label(all)).toHaveText("Allow all 2 Bash commands");
    await expect.poll(() => !!held["late.txt"]).toBe(true);
    const listed = await card.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.approvalId));
    // Every label the action shows from here on, with whether it could be pressed.
    await page.evaluate(() => {
      const w = window as unknown as { labels: string[] };
      w.labels = [];
      const read = () => {
        const b = document.querySelector('[data-testid="allow-all"]');
        const s = b ? `${b.querySelector('[data-testid="allow-all-label"]')!.textContent}|${b.getAttribute("aria-disabled") ? "waits" : "acts"}` : "gone";
        if (w.labels.at(-1) !== s) w.labels.push(s);
      };
      new MutationObserver(read).observe(document.querySelector('[data-testid="approvals"]')!, { subtree: true, childList: true, characterData: true, attributes: true });
      read();
    });
    held["late.txt"]!();
    await expect(card).toHaveCount(3);
    // The list moved: the action waits, then covers the two it covered, named as two of three.
    await expect(label(all)).toHaveText("Allow 2 of 3 Bash commands");
    await expect(all).toBeEnabled();
    await page.waitForTimeout(1500);
    const labels = await page.evaluate(() => (window as unknown as { labels: string[] }).labels);
    expect(labels.at(-1)).toBe("Allow 2 of 3 Bash commands|acts");
    expect(labels.filter((l) => /Allow (all 3|3 of 3) /.test(l))).toEqual([]);
    expect(await frames(page)).toEqual((await card.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.approvalId))).map((x) => listed.includes(x)));
    await shoot(page, "approvals-batch-1920-late");
    const sent = batchPosts(page);
    await page.keyboard.press("Enter");
    await expect(card).toHaveCount(1);
    expect(sent).toEqual([listed]);
    const third = (await cards()).find((c) => c.summary.includes("late"))!;
    expect(third.state).toBe("pending");
    expect(existsSync(join(ws, "late.txt"))).toBe(false);
  } finally { await request.delete(`/api/sessions/${id}`); }
});

// A card that has just been drawn brings the keyboard to its list, never to its Allow, and
// its Allow does not act: an Enter on its way to the message box as the card appears allows
// nothing. Words typed after the card took the keyboard go to the message box, and so does
// their Enter.
test("Enter as a request appears allows nothing", async ({ page, request }) => {
  const { id, ws, cards, send } = await start(request, "Enter as it appears", [bash("solo")], { later: true });
  try {
    const held = await holdFrames(page, ["solo.txt"]);
    await page.goto(`/s/${id}`);
    const pane = paneOf(page, id);
    const box = pane.getByTestId("composer");
    await expect(box).toBeFocused();
    await send();
    await expect.poll(() => !!held["solo.txt"]).toBe(true);
    const card = pane.getByTestId("approval");
    const once = card.getByTestId("allow-once");
    // A click that lands on the Allow as it is drawn, and an Enter right behind it.
    // (The watch is in place before the request is let through: set up and released in one
    // breath, the request could be drawn first and the watch would miss it.)
    await page.evaluate(() => {
      (window as unknown as { pressed: Promise<string> }).pressed = new Promise<string>((done) => {
        const mo = new MutationObserver(() => {
          const b = document.querySelector<HTMLElement>('[data-testid="allow-once"]');
          if (!b) return;
          mo.disconnect();
          b.click();
          done(`${b.getAttribute("aria-disabled")} ${(document.activeElement as HTMLElement).dataset.testid}`);
        });
        mo.observe(document.body, { childList: true, subtree: true });
      });
    });
    held["solo.txt"]!();
    const pressed = page.evaluate(() => (window as unknown as { pressed: Promise<string> }).pressed);
    // It was marked disabled when it was pressed, and the keyboard was not on it: in the message
    // box still, or on the list the card is in (which answers nothing).
    expect(["true composer", "true approvals"]).toContain(await pressed);
    // The press is not dropped with no sign: the control is marked, and the reason is said once.
    await expect(once).toHaveAttribute("data-nudge", "true");
    await expect(card.getByTestId("approval-refused").filter({ hasText: "Not yet: it has only just arrived" })).toHaveCount(1);
    // The card does not say that Enter allows it while its Allow waits.
    await expect(card.getByTestId("approval-hint")).toBeHidden();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    expect((await cards()).map((c) => c.state)).toEqual(["pending"]);
    expect(existsSync(join(ws, "solo.txt"))).toBe(false);

    // Stood for a second, the card takes the keyboard from the empty box. Words typed at it now are
    // typed nowhere (a key meant for a card never becomes a message), and the card says so.
    await expect(once).toBeFocused();
    await expect(once).not.toHaveAttribute("aria-disabled");
    await expect(card.getByTestId("approval-hint")).toBeVisible();
    await expect(once).not.toHaveAttribute("data-nudge");
    await page.keyboard.type("ok");
    await expect(page.locator(".k-tip")).toHaveText("Nothing typed: this request has the keyboard");
    await expect(box).toHaveValue("");
    await page.waitForTimeout(300);
    expect((await cards()).map((c) => c.state)).toEqual(["pending"]);
    expect(existsSync(join(ws, "solo.txt"))).toBe(false);
    await box.fill("");
    // Enter on the Allow that has stood, once the keyboard has been on the card for the settle time: allowed.
    await once.focus();
    await page.keyboard.press("Enter");
    await expect(card.getByTestId("approval-refused").filter({ hasText: "Not yet: the keyboard has only just arrived" })).toHaveCount(1);
    expect((await cards()).map((c) => c.state)).toEqual(["pending"]);
    await expect(pane.getByTestId("approvals")).toHaveAttribute("data-keys", "ready");
    await page.keyboard.press("Enter");
    await expect(card).toHaveCount(0);
    await expect.poll(() => existsSync(join(ws, "solo.txt"))).toBe(true);
  } finally { await request.delete(`/api/sessions/${id}`); }
});

// A list that changes moves its rows. A press where the pointer already was lands on another
// row's Allow: a new request's, or an older one's that slid there. Neither is allowed, the
// press shows on the control, and it does not take the keyboard. Requests made in the same
// instant are listed in no order of their own, so where a new one lands is read, not assumed.
test("a press where a row has just arrived or moved allows nothing", async ({ page, request }) => {
  const { id, ws, cards, send } = await start(request, "Under the pointer", [bash("one"), bash("two"), bash("late"), bash("more")], { later: true });
  try {
    const held = await holdFrames(page, ["late.txt", "more.txt"]);
    await page.goto(`/s/${id}`);
    const pane = paneOf(page, id);
    await expect(pane.getByTestId("composer")).toBeFocused();
    await send();
    const card = pane.getByTestId("approval");
    await expect(card).toHaveCount(2);
    await expect.poll(() => Object.keys(held).length).toBe(2);
    const allowed = async () => (await cards()).filter((c) => c.state === "allowed").map((c) => c.summary);
    const stood = async (n: number) => { await expect(card).toHaveCount(n); await expect(card.and(page.locator("[data-live]"))).toHaveCount(n); };

    // A third request arrives, then a fourth: wherever each lands, every Allow that is now where
    // another row's was is pressed at that instant.
    await stood(2);
    const third = pressWhereRowsChanged(page, 3);
    held["late.txt"]!();
    const a = await third;
    await stood(3);
    const fourth = pressWhereRowsChanged(page, 4);
    held["more.txt"]!();
    const b = await fourth;
    await page.waitForTimeout(500);
    expect([...a, ...b].filter((x) => !x.kept)).toEqual([]);
    expect(await allowed()).toEqual([]);

    // The last row is denied from elsewhere: the rows over it slide down, and the row before it
    // is now where its Allow was. That one is always there to press.
    await stood(4);
    const order = await card.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.approvalId!));
    const gone = pressWhereRowsChanged(page, 3);
    expect((await request.post(`/api/sessions/${id}/approvals/${order[3]}`, { data: { choice: "deny", reason: "from elsewhere" } })).ok()).toBe(true);
    const c = await gone;
    expect(c).toContainEqual({ from: order[3], to: order[2], kept: true });
    // The press shows on the control and is said once; it took no keyboard and allowed nothing.
    const slid = card.and(page.locator(`[data-approval-id="${order[2]}"]`));
    await expect(slid.getByTestId("allow-once")).toHaveAttribute("data-nudge", "true");
    await expect(slid.getByTestId("approval-refused").filter({ hasText: "Not yet: it moved a moment ago" })).toHaveCount(1);
    await expect(slid.getByTestId("allow-once")).not.toBeFocused();
    await page.waitForTimeout(500);
    expect(await allowed()).toEqual([]);
    expect(["one.txt", "two.txt", "late.txt", "more.txt"].some((f) => existsSync(join(ws, f)))).toBe(false);

    // Once it has stood for a second, a click on it allows it, and only it.
    await stood(3);
    await expect(slid.getByTestId("allow-once")).not.toHaveAttribute("data-nudge");
    await slid.getByTestId("allow-once").click();
    await expect(card).toHaveCount(2);
    expect((await cards()).filter((c) => c.state === "allowed").map((c) => c.id)).toEqual([order[2]]);
  } finally { await request.delete(`/api/sessions/${id}`); }
});

// What the note says after an answer for several: the daemon's refusal as a refusal, and a
// reply that never came as that, with what still waits read again. Never "none allowed" for
// requests that were allowed.
test("a refused list and a lost reply are told apart", async ({ page, request }) => {
  const { id, ws, cards } = await start(request, "Lost reply", [bash("aa"), bash("bb"), bash("cc"), { name: "Write", input: { file_path: "note.md", content: "a note\n" } }]);
  try {
    let how: "refuse" | "lose" = "refuse";
    await page.route(/\/approvals$/, async (r) => {
      if (r.request().method() !== "POST") return r.continue();
      if (how === "refuse") return r.fulfill({ status: 400, json: { error: "these are answered one at a time", alone: [] } });
      await r.fetch(); // the daemon answers
      await r.abort("failed"); // its reply does not arrive
    });
    await page.goto(`/s/${id}`);
    const pane = paneOf(page, id);
    const card = pane.getByTestId("approval");
    const all = pane.getByTestId("allow-all");
    const note = pane.getByTestId("approvals-error");
    await expect(card).toHaveCount(4);
    await expect(all).toBeEnabled();
    await all.click();
    await expect(note).toHaveText("None allowed: these are answered one at a time");
    expect((await cards()).map((c) => c.state)).toEqual(["pending", "pending", "pending", "pending"]);

    how = "lose";
    await expect(all).toBeEnabled();
    await all.click();
    await expect(note).toContainText("The answer may not have arrived");
    await expect(note).toContainText("What still waits is shown.");
    await expect(note).not.toContainText("None allowed");
    // The three were allowed all the same, and the page shows the one that still waits.
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("note.md");
    await expect.poll(() => ["aa.txt", "bb.txt", "cc.txt"].every((f) => existsSync(join(ws, f)))).toBe(true);
    await shoot(page, "approvals-batch-1920-reply-lost");
  } finally { await request.delete(`/api/sessions/${id}`); }
});

// The owner's own scroll moves the rows too, and it is theirs: a row they scrolled to acts
// as the scroll ends, without the second a row waits when it comes under the hand by itself.
// A list that changes while they scroll is not their move: its rows wait.
test("a row the owner scrolled to acts as the scroll ends, a list that changed meanwhile does not", async ({ page, request }) => {
  const names = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];
  const { id, cards, send } = await start(request, "Own scroll", [...names.map(bash), bash("late")], { later: true });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const held = await holdFrames(page, ["late.txt"]);
    await page.goto(`/s/${id}`);
    const pane = paneOf(page, id);
    await expect(pane.getByTestId("composer")).toBeVisible();
    await send();
    const card = pane.getByTestId("approval");
    const tray = pane.getByTestId("composer-tray");
    await expect(card).toHaveCount(8);
    await expect.poll(() => !!held["late.txt"]).toBe(true);
    await expect(card.first()).toHaveAttribute("data-live", "true");
    await page.waitForTimeout(1100); // every card has been on the page for a second
    // In the page: when the region last scrolled, and when each Allow once could first be pressed after that.
    await page.evaluate(() => {
      const w = window as unknown as { scrolled: number; could: Record<string, number> };
      w.scrolled = 0;
      w.could = {};
      const tray = document.querySelector('[data-testid="composer-tray"]')!;
      tray.addEventListener("scroll", () => { w.scrolled = performance.now(); w.could = {}; }, { passive: true });
      new MutationObserver(() => {
        for (const el of document.querySelectorAll<HTMLElement>('[data-testid="approval"][data-live]')) w.could[el.dataset.approvalId!] ??= performance.now();
      }).observe(tray, { subtree: true, attributes: true, attributeFilter: ["data-live"] });
    });
    const whole = () => card.evaluateAll((els) => {
      const t = els[0]!.closest('[data-testid="composer-tray"]')!.getBoundingClientRect();
      return els.filter((el) => { const r = el.querySelector('[data-testid="allow-once"]')!.getBoundingClientRect(); return r.top >= t.top && r.bottom <= t.bottom; }).map((el) => (el as HTMLElement).dataset.approvalId!);
    });
    const before = await whole();
    // A short row that stands at the region's fold says nothing of lines not seen: it keeps its
    // height as it comes into view, and the list under the owner's scroll does not change.
    await expect(card.getByTestId("approval-left")).toHaveCount(0);
    const box = (await tray.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 320);
    // The scroll has ended when the region has stood for a moment.
    await expect.poll(() => page.evaluate(() => { const w = window as unknown as { scrolled: number }; return w.scrolled > 0 && performance.now() - w.scrolled > 250; })).toBe(true);
    const came = (await whole()).filter((x) => !before.includes(x));
    expect(came.length).toBeGreaterThan(0);
    // A row that came into view by that scroll can be pressed well inside the second it would wait otherwise.
    // (The one taken is a row the page itself shows whole: the region's own bar lies over the edge of
    // what this test measures, and how many rows fit changes with the height of the pane's header.)
    const pressable = () => card.and(page.locator("[data-live]")).evaluateAll((els, ids) => els.map((el) => (el as HTMLElement).dataset.approvalId!).find((x) => ids.includes(x)) ?? null, came);
    await expect.poll(pressable).not.toBeNull();
    const reached = [(await pressable())!];
    const waited = await page.evaluate((x) => { const w = window as unknown as { scrolled: number; could: Record<string, number> }; return w.could[x!]! - w.scrolled; }, reached[0]);
    expect(waited).toBeLessThan(600);
    await card.and(page.locator(`[data-approval-id="${reached[0]}"]`)).getByTestId("allow-once").click();
    await expect(card).toHaveCount(7);
    expect((await cards()).filter((c) => c.state === "allowed").map((c) => c.id)).toEqual([reached[0]]);

    // The owner's wheel turns again, and in the same moment a request arrives: every Allow that
    // is now where another row's was is pressed at that instant. None is allowed.
    await expect(card.and(page.locator("[data-live]")).first()).toBeVisible();
    const changed = pressWhereRowsChanged(page, 8);
    await page.mouse.wheel(0, -40);
    held["late.txt"]!();
    const pressed = await changed;
    await page.waitForTimeout(500);
    expect(pressed.filter((x) => !x.kept)).toEqual([]);
    expect((await cards()).filter((c) => c.state === "allowed").map((c) => c.id)).toEqual([reached[0]]);
  } finally { await request.delete(`/api/sessions/${id}`); }
});

test("a card that was whole reads cut when its pane narrows, and whole again when it widens", async ({ page, request }) => {
  // Eight long lines: whole in one wide pane, wrapped past the card's box in a pane a quarter as wide.
  const line = (i: number) => `echo ${"word ".repeat(12)}${i}`;
  const command = `${Array.from({ length: 7 }, (_, i) => line(i + 1)).join("\n")}\n${line(8)} > out.txt`;
  const { id, cards } = await start(request, "A pane that narrows", [{ name: "Bash", input: { command } }]);
  try {
    await expect.poll(async () => (await cards()).length).toBe(1);
    await page.goto(`/s/${id}`);
    const card = page.getByTestId("approval");
    const once = card.getByTestId("allow-once");
    await expect(card).toBeVisible();
    await expect(card).not.toHaveAttribute("data-must-open", "true");
    await expect(once).toBeFocused();
    await expect(card).toHaveAttribute("data-live", "true");
    // Two panes, chosen in the Arrange menu: the card is still whole, and the keyboard goes back to its Allow once.
    const panes = (n: number) => setPanes(page, n);
    await panes(2);
    await expect(card).not.toHaveAttribute("data-must-open", "true");
    await once.focus();
    // The window narrows while the keyboard is on Allow once, so the pane narrows under it: the card says it is
    // cut, takes no answer, and the keyboard leaves its Allow once.
    await page.setViewportSize({ width: 1366, height: 1040 });
    await expect(card).toHaveAttribute("data-must-open", "true");
    await expect(card.getByTestId("approval-cut")).toBeVisible();
    await expect(page.getByTestId("approvals")).toBeFocused();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    expect((await cards())[0]!.state).toBe("pending");
    // A wide window and one pane again: whole, and it can be answered.
    await page.setViewportSize({ width: 1920, height: 1040 });
    await panes(1);
    await expect(card).not.toHaveAttribute("data-must-open", "true");
    await expect(card.getByTestId("approval-cut")).toHaveCount(0);
    await expect(card).toHaveAttribute("data-live", "true");
    await once.click();
    await expect.poll(async () => (await cards())[0]!.state).toBe("allowed");
  } finally { await request.delete(`/api/sessions/${id}`); }
});

test("a request drawn as the owner leaves its pane records no error", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const made: string[] = [];
  try {
    const quiet = await start(request, "Somewhere else", [], { later: true });
    made.push(quiet.id);
    for (const way of ["home", "another session", "home"]) {
      const { id, send, cards } = await start(request, `Left for ${way}`, [bash(`left${made.length}`)], { later: true });
      made.push(id);
      await page.goto(`/s/${id}`);
      await expect(paneOf(page, id).getByTestId("composer")).toBeFocused();
      await expect(page.getByTestId("sidebar").locator(`[data-session="${quiet.id}"]`).first()).toBeVisible();
      // The owner leaves in the same task in which the card is drawn: the region it was to be placed in is gone two frames later.
      await page.evaluate(([way, quiet]) => {
        const mo = new MutationObserver(() => {
          if (!document.querySelector('[data-testid="composer-asks"] [data-testid="approval"]')) return;
          mo.disconnect();
          if (way === "home") { history.pushState({}, "", "/"); dispatchEvent(new PopStateEvent("popstate")); }
          else document.querySelector<HTMLElement>(`[data-testid="sidebar"] [data-session="${quiet}"]`)!.click();
        });
        mo.observe(document.body, { childList: true, subtree: true });
      }, [way, quiet.id] as const);
      await send();
      await expect.poll(async () => (await cards()).length).toBe(1);
      await expect(page).not.toHaveURL(new RegExp(`/s/${id}$`));
      await page.waitForTimeout(500);
      expect(errors, `left for ${way}`).toEqual([]);
    }
  } finally { for (const id of made) { await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }).catch(() => {}); await request.delete(`/api/sessions/${id}`).catch(() => {}); } }
});

test("a card says which call of the reply it is and names the calls behind it that have no card", async ({ page, request }) => {
  const calls = [
    { name: "Edit", input: { file_path: "a.md", old_string: "x", new_string: "y" } },
    bash("two"),
    bash("three"),
    { name: "Bash", input: { command: "git push origin main --force" } },
  ];
  const { id, ws, cards } = await start(request, "Four in one reply", calls, { later: true });
  writeFileSync(join(ws, "a.md"), "x\n");
  try {
    await page.goto(`/s/${id}`);
    const pane = paneOf(page, id);
    await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:batch ${JSON.stringify(calls)}` } });
    const card = pane.getByTestId("approval");
    await expect(card).toHaveCount(4);
    // Each card says its place in the reply. Every call has a card here, so nothing is named twice.
    await expect(pane.getByTestId("approval-call")).toHaveText(["1 of 4", "2 of 4", "3 of 4", "4 of 4"]);
    await expect(pane.getByTestId("approval-later")).toHaveCount(0);
    // The force push is put away with Later: it has no card now, and the first card names it, marked.
    await card.filter({ hasText: "--force" }).getByTestId("ask-later").click();
    await expect(card).toHaveCount(3);
    await expect(pane.getByTestId("approval-call")).toHaveText(["1 of 4", "2 of 4", "3 of 4"]);
    const later = pane.getByTestId("approval-later");
    await expect(later).toHaveCount(1);
    await expect(card.first().getByTestId("approval-later")).toHaveCount(1);
    await expect(later).toContainText("Allow once is for this call only");
    const row = later.getByTestId("approval-later-call");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Bash");
    await expect(row).toContainText("git push origin main --force");
    await expect(row.getByTestId("approval-later-asks")).toContainText("high risk");
    await shoot(page, "approvals-reply-place");
    await page.setViewportSize({ width: 390, height: 844 });
    await shoot(page, "approvals-reply-place-phone");
    await page.setViewportSize({ width: 1920, height: 1040 });
    // Allow once answers the shown call only: the others, the one put away included, still wait.
    await card.first().getByTestId("allow-once").click();
    await expect(card).toHaveCount(2);
    await expect.poll(async () => (await cards()).map((c) => c.state).sort()).toEqual(["allowed", "pending", "pending", "pending"]);
    await expect(pane.getByTestId("approval-call")).toHaveText(["2 of 4", "3 of 4"]);
    await expect(card.first().getByTestId("approval-later-call")).toContainText("git push origin main --force");
  } finally {
    await request.delete(`/api/sessions/${id}`);
  }
});

// Feature (UX-S153): a request on a phone at a large text size shows Allow and Deny together in the region above the
// message box, not Deny on a second row under it (the owner scrolled to find it).
for (const scale of [1, 1.5]) {
  test.describe(`touch at ${scale * 100}%`, () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test(`on a phone at ${scale * 100}% text, Deny stands beside Allow once in view`, async ({ page, request }) => {
    const { id, cards } = await start(request, `One on a phone at ${scale * 100}%`, [bash("s153")]);
    try {
      await page.addInitScript((s) => localStorage.setItem("keel.textScale", String(s)), scale);
      await page.goto(`/s/${id}`);
      const pane = paneOf(page, id);
      const card = pane.getByTestId("approval");
      await expect(card).toHaveCount(1, { timeout: 30_000 });
      await expect.poll(async () => (await cards()).filter((c) => c.state === "pending").length).toBe(1);
      const allow = card.getByTestId("allow-once"), deny = card.getByTestId("deny");
      await expect(allow).toBeInViewport({ ratio: 1 });
      await expect(deny, "Deny is in view with Allow once, without a scroll").toBeInViewport({ ratio: 1 });
      const [a, d, tray] = await Promise.all([allow.boundingBox(), deny.boundingBox(), pane.getByTestId("composer-tray").boundingBox()]);
      expect(Math.abs(a!.y - d!.y), "Deny is on Allow's row").toBeLessThan(4);
      expect(d!.y + d!.height, "Deny is above the message box").toBeLessThanOrEqual(tray!.y + tray!.height + 1);
      await shoot(page, `approvals-batch-390x844-deny-${scale}`);
    } finally { await request.delete(`/api/sessions/${id}`); }
  });
  });
}
