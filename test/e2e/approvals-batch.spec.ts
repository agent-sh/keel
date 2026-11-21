import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Locator, type Page } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: several requests waiting at once. They are a list of rows; the one
// that has the keyboard is the framed one and the others step back; each is
// still answered alone (Enter, or Esc and a reason); and one action allows
// every request of a tool that the list shows, and nothing else.

type Card = { id: string; summary: string; tool: string; state: string; choice?: string; reason?: string };
const bash = (n: string) => ({ name: "Bash", input: { command: `echo ${n} > ${n}.txt` } });

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

test("several requests are answered one by one from the keys, or all of a tool at once", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const { id, ws, cards } = await start(request, "Five at once", [bash("one"), bash("two"), { name: "Write", input: { file_path: "note.md", content: "a note\n" } }, bash("three"), bash("four")]);
  try {
    await page.goto(`/s/${id}`);
    const pane = page.getByTestId("station").and(page.locator(`[data-station="${id}"]`));
    const card = pane.getByTestId("approval");
    const row = (text: string) => card.filter({ hasText: text });
    const all = pane.getByTestId("allow-all");
    await expect(card).toHaveCount(5);
    // Requests made in the same instant have no order of their own: the rows are read as they are shown.
    const order = () => card.evaluateAll((els) => els.map((el) => el.textContent!.match(/(one|two|three|four|note)\.(txt|md)/)![1]!));
    const downTo = async (name: string, from: number) => { for (let i = from; i < (await order()).indexOf(name); i++) await page.keyboard.press("ArrowDown"); };
    const only = async (...names: string[]) => (await order()).map((n) => names.includes(n));
    await expect(pane.getByTestId("approvals-count")).toHaveText("5 requests wait");
    // One action, for the tool that has several: it says how many it answers and what they are.
    await expect(all).toHaveCount(1);
    await expect(all).toBeEnabled();
    await expect(all).toHaveText("Allow all 4 Bash commands");
    await expect(all).toHaveAttribute("aria-description", `Allows once, in this order: ${(await order()).filter((n) => n !== "note").map((n) => `echo ${n} > ${n}.txt`).join("; ")}`);

    // The oldest request has the keyboard: it is the framed one, the others are not.
    await expect(card.first().getByTestId("allow-once")).toBeFocused();
    expect(await frames(page)).toEqual([true, false, false, false, false]);
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
    await page.keyboard.press("Enter");
    await expect(card).toHaveCount(4);
    await expect(row("two.txt")).toHaveCount(0);
    await expect(pane.getByTestId("approvals")).toBeFocused();
    await expect.poll(() => existsSync(join(ws, "two.txt"))).toBe(true);
    await expect(all).toHaveText("Allow all 3 Bash commands");

    // Esc on a request denies it with a reason, as a lone card does.
    await downTo("one", -1);
    await expect(row("one.txt").getByTestId("allow-once")).toBeFocused();
    await page.keyboard.press("Escape");
    const why = row("one.txt").getByTestId("deny-reason");
    await expect(why).toBeFocused();
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
    await expect(all).toHaveText("Allow all 2 Bash commands");
    expect(await frames(page)).toEqual(await only("three", "four"));
    await expect(row("note.md")).not.toHaveAttribute("data-hot");
    await shoot(page, "approvals-batch-1920-all");
    const listed = await card.and(page.locator("[data-hot]")).evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.approvalId));
    const sent: string[] = [];
    page.on("request", (r) => { if (r.method() === "POST" && /\/approvals\/[^/]+$/.test(r.url())) sent.push(r.url().split("/").pop()!); });
    await page.keyboard.press("Enter");
    // Exactly the listed ones were answered, in the order they were listed.
    await expect(card).toHaveCount(1);
    expect(sent).toEqual(listed);
    await expect.poll(() => ["three.txt", "four.txt"].every((f) => existsSync(join(ws, f)))).toBe(true);
    // The file change still waits, a lone card again with its own hint; the focus is on the list.
    await expect(row("note.md")).toBeVisible();
    await expect(row("note.md")).not.toHaveAttribute("data-dense");
    await expect(pane.getByTestId("approvals-bar")).toHaveCount(0);
    await expect(pane.getByTestId("approvals")).toBeFocused();
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
    const pane = page.getByTestId("station").and(page.locator(`[data-station="${id}"]`));
    const own = pane.getByTestId("approvals").first();
    const theirs = pane.getByTestId("child-approvals").getByTestId("approvals");
    await expect(own.getByTestId("approval")).toHaveCount(3);
    await expect(theirs.getByTestId("approval")).toHaveCount(2, { timeout: 30_000 });
    // Every request of the list is the same tool: the heading names it, the rows carry the commands.
    await expect(own.getByTestId("approvals-count")).toHaveText("3 Bash commands wait");
    await expect(own.getByTestId("allow-all")).toBeEnabled();
    await expect(own.getByTestId("allow-all")).toHaveText("Allow all 3 Bash commands");
    await expect(theirs.getByTestId("allow-all")).toHaveText("Allow all 2 Bash commands");
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
    await expect(theirs.locator('[data-testid="approval"][data-hot]')).toHaveCount(0);
    expect(await Promise.all((await theirs.getByTestId("approval").all()).map(framed))).toEqual([false, false]);
    await shoot(page, "approvals-batch-1920-pointed");
    const child = (await (await request.get("/api/approvals")).json()).approvals.find((a: { session_id: string }) => a.session_id !== id).session_id as string;
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
// the page after that, while those answers are still on their way, is not among them.
test("a request that arrives after the click is not answered by it", async ({ page, request }) => {
  const { id, ws, cards, send } = await start(request, "A late third", [bash("one"), bash("two"), bash("three")], { later: true });
  try {
    // The third request's frame is kept from the page until it is let through.
    const late: { let?: () => void } = {};
    await page.routeWebSocket(/\/ws$/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((m) => {
        const f = typeof m === "string" && m.includes("three.txt") ? JSON.parse(m) : null;
        if (f?.name === "approval" && f.data?.state === "pending") late.let = () => socket.send(m);
        else socket.send(m);
      });
    });
    await page.goto(`/s/${id}`);
    const pane = page.getByTestId("station").and(page.locator(`[data-station="${id}"]`));
    await expect(pane.getByTestId("composer")).toBeFocused();
    await send();
    const card = pane.getByTestId("approval");
    const all = pane.getByTestId("allow-all");
    await expect(card).toHaveCount(2);
    await expect(all).toBeEnabled();
    await expect(all).toHaveText("Allow all 2 Bash commands");
    await expect.poll(() => !!late.let).toBe(true);
    const listed = await card.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.approvalId));

    // The first answer is held on its way: the third request arrives meanwhile.
    const sent: string[] = [];
    let go!: () => void;
    const held = new Promise<void>((r) => { go = r; });
    await page.route(/\/approvals\/[^/]+$/, async (r) => {
      if (r.request().method() !== "POST") return r.continue();
      sent.push(r.request().url().split("/").pop()!);
      await held;
      await r.continue();
    });
    await all.click();
    await expect.poll(() => sent.length).toBe(1);
    late.let!();
    await expect(card).toHaveCount(3);
    await expect(card.filter({ hasText: "three.txt" }).getByTestId("allow-once")).toBeEnabled();
    go();

    // The two that were listed ran. The third waits with its own answers, and nothing of it ran.
    await expect(card).toHaveCount(1);
    expect(sent).toEqual(listed);
    await expect.poll(() => ["one.txt", "two.txt"].every((f) => existsSync(join(ws, f)))).toBe(true);
    const third = (await cards()).find((c) => c.summary.includes("three"))!;
    expect(third.state).toBe("pending");
    expect(sent).not.toContain(third.id);
    expect(existsSync(join(ws, "three.txt"))).toBe(false);
    await card.getByTestId("allow-once").click();
    await expect(pane.getByTestId("turn-end")).toHaveCount(1, { timeout: 30_000 });
    expect(existsSync(join(ws, "three.txt"))).toBe(true);
  } finally { await request.delete(`/api/sessions/${id}`); }
});
