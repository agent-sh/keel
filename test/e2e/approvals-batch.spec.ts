import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Locator, type Page } from "./isolate.ts";
import { shoot } from "./shots.ts";

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

// Presses whatever is at a point at the instant the page has `rows` requests, as a click
// already on its way does: in the page, in the same task that sees the row drawn, so no
// machine is too slow for it. Says what it pressed: the control and its request.
const pressAtArrival = (page: Page, rows: number, x: number, y: number) => page.evaluate(([rows, x, y]) => new Promise<[string, string]>((done) => {
  const go = () => {
    if (document.querySelectorAll('[data-testid="approval"]').length !== rows) return false;
    const el = document.elementFromPoint(x!, y!) as HTMLElement | null;
    const hit: [string, string] = [el?.closest("[data-testid]")?.getAttribute("data-testid") ?? "", el?.closest<HTMLElement>('[data-testid="approval"]')?.dataset.approvalId ?? ""];
    // The press of a pointer: down, then the click.
    el?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    done(hit);
    return true;
  };
  if (go()) return;
  const mo = new MutationObserver(() => { if (go()) mo.disconnect(); });
  mo.observe(document.body, { childList: true, subtree: true });
}), [rows, x, y] as const);

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
    expect(await frames(page)).toEqual([true, false, false, false, false]);
    await expect(hint).toHaveText("Up and Down choose, Enter allows the framed one once");
    // Down moves to the next request, and the frame with it.
    await page.keyboard.press("ArrowDown");
    await expect(card.nth(1).getByTestId("allow-once")).toBeFocused();
    expect(await frames(page)).toEqual([false, true, false, false, false]);
    await page.keyboard.press("ArrowUp");
    await downTo("two", 0);
    await expect(row("two.txt").getByTestId("allow-once")).toBeFocused();
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
    await expect.poll(() => ["three.txt", "four.txt"].every((f) => existsSync(join(ws, f)))).toBe(true);
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
    await shoot(page, "approvals-batch-390x844-eight");
    const sent = batchPosts(page);
    await all.click();
    await expect(card).toHaveCount(8 - n);
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
    // Two cut ones are left: no action for them, each has its own Allow.
    await expect(all).toHaveCount(0);
    await row("script.txt").getByTestId("allow-once").click();
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

// A card that has just been drawn takes no keyboard and its Allow does not act: an Enter
// typed into the message box as the card appears allows nothing. Words typed after the
// card took the keyboard go to the message box, and so does their Enter.
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
    const pressed = page.evaluate(() => new Promise<string>((done) => {
      const mo = new MutationObserver(() => {
        const b = document.querySelector<HTMLElement>('[data-testid="allow-once"]');
        if (!b) return;
        mo.disconnect();
        b.click();
        done(`${b.getAttribute("aria-disabled")} ${(document.activeElement as HTMLElement).dataset.testid}`);
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }));
    held["solo.txt"]!();
    // It was marked disabled when it was pressed, and the keyboard was still in the message box.
    expect(await pressed).toBe("true composer");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    expect((await cards()).map((c) => c.state)).toEqual(["pending"]);
    expect(existsSync(join(ws, "solo.txt"))).toBe(false);

    // Stood for a second, the card takes the keyboard from the empty box. Words typed now are the box's.
    await expect(once).toBeFocused();
    await expect(once).not.toHaveAttribute("aria-disabled");
    await page.keyboard.type("ok");
    await expect(box).toBeFocused();
    await expect(box).toHaveValue("ok");
    await page.waitForTimeout(300);
    expect((await cards()).map((c) => c.state)).toEqual(["pending"]);
    expect(existsSync(join(ws, "solo.txt"))).toBe(false);
    await box.fill("");
    // Enter on the Allow that has stood: allowed.
    await once.focus();
    await page.keyboard.press("Enter");
    await expect(card).toHaveCount(0);
    await expect.poll(() => existsSync(join(ws, "solo.txt"))).toBe(true);
  } finally { await request.delete(`/api/sessions/${id}`); }
});

// A list that grows moves its rows. A click where the pointer already was lands on another
// row's Allow: on the new request, or on an older one that slid there. Neither is allowed.
test("a click where a row has just arrived or moved allows nothing", async ({ page, request }) => {
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
    // Nothing is answered: every request the daemon holds still waits (the page has not been shown them all yet).
    const answered = async () => (await cards()).filter((c) => c.state !== "pending").map((c) => c.summary);
    const under = (x: number, y: number) => page.evaluate(([px, py]) => {
      const el = document.elementFromPoint(px!, py!);
      return [el?.closest("[data-testid]")?.getAttribute("data-testid") ?? "", el?.closest<HTMLElement>('[data-testid="approval"]')?.dataset.approvalId ?? ""];
    }, [x, y]);
    const centre = async (l: Locator) => { const b = (await l.boundingBox())!; return [b.x + b.width / 2, b.y + b.height / 2] as const; };

    // The pointer rests on the last row's Allow once; a third request arrives and the list grows.
    await expect(card.last()).toHaveAttribute("data-live", "true");
    const lastId = (await card.last().getAttribute("data-approval-id"))!;
    const [x, y] = await centre(card.last().getByTestId("allow-once"));
    await page.mouse.move(x, y);
    expect(await under(x, y)).toEqual(["allow-once", lastId]);
    const third = pressAtArrival(page, 3, x, y);
    held["late.txt"]!();
    const [what, whose] = await third;
    // An Allow once was pressed, and not the one the pointer was on.
    expect(what).toBe("allow-once");
    expect(whose).not.toBe(lastId);
    await page.waitForTimeout(500);
    expect(await answered()).toEqual([]);
    await expect(card).toHaveCount(3);

    // The pointer on the first row's Allow once; a fourth arrives: an older row slides under it.
    await expect(card.first()).toHaveAttribute("data-live", "true");
    const firstId = (await card.first().getAttribute("data-approval-id"))!;
    const [x2, y2] = await centre(card.first().getByTestId("allow-once"));
    await page.mouse.move(x2, y2);
    const fourth = pressAtArrival(page, 4, x2, y2);
    held["more.txt"]!();
    const [what2, whose2] = await fourth;
    expect(what2).toBe("allow-once");
    expect(whose2).not.toBe(firstId);
    await page.waitForTimeout(500);
    expect(await answered()).toEqual([]);
    await expect(card).toHaveCount(4);
    expect(["one.txt", "two.txt", "late.txt", "more.txt"].some((f) => existsSync(join(ws, f)))).toBe(false);

    // Once the row under the pointer has stood for a second, the same click allows it, and only it.
    await expect(card.and(page.locator(`[data-approval-id="${whose2}"]`))).toHaveAttribute("data-live", "true");
    await page.mouse.click(x2, y2);
    await expect(card).toHaveCount(3);
    expect((await cards()).filter((c) => c.state === "allowed").map((c) => c.id)).toEqual([whose2]);
  } finally { await request.delete(`/api/sessions/${id}`); }
});
