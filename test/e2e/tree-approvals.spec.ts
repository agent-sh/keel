import { expect, test, type Page } from "./isolate.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { approvals, calls, colors, create, drop, folder, pending, scripted, SETTLE } from "./answering.ts";
import { shoot, WORKBENCH } from "./shots.ts";

// Feature: a session's view shows what its whole tree of agents waits on, at any depth, each card named by
// the agent that asks and its place in the tree. The owner of a coordinator answers its agents' approvals
// and questions there, by the same keys and with the same permission as in the agent's own pane
// (lib/asks.ts: no key answers as the keyboard arrives). The inbox opens an agent's approval on the
// session at the top of the tree.
// Every pane on screen: no focus mode (the config's default for the other specs).
test.use({ storageState: WORKBENCH });

const bash = (command: string) => ({ name: "Bash", input: { command } });
const spawn = (message: string) => ({ name: "spawn_agent", input: { message, isolation: "none" } });
type Agent = { session_id: string; title: string; parent_id: string };
const agentsOf = async (request: Parameters<typeof approvals>[0], id: string) => (await (await request.get(`/api/sessions/${id}/agents`)).json()).agents as Agent[];

const ask = (page: Page, id: string) => page.locator(`[data-station="${id}"]`).getByTestId("child-asks");

for (const size of [{ width: 1920, height: 1040 }, { width: 390, height: 844 }]) {
  test(`the coordinator's view answers its whole tree at ${size.width}x${size.height}`, async ({ page, request }) => {
    await scripted(request);
    await page.setViewportSize(size);
    const ws = folder("tree-asks");
    const root = await create(request, "Coordinator", ws);
    const ids = [root];
    try {
      await request.put(`/api/sessions/${root}/permissions`, { data: { mode: "ask", sandbox: "off" } });
      // Alpha asks to run a command and starts Gamma, which asks to run one and then asks a question; Beta asks a question.
      const gamma = `Gamma\n${calls([bash("touch gamma.txt"), colors])}`;
      const alpha = `Alpha\n${calls([spawn(gamma), bash("touch alpha.txt")])}`;
      const beta = `Beta\n${calls([colors])}`;
      await request.post(`/api/sessions/${root}/messages`, { data: { text: calls([spawn(alpha), spawn(beta)]) } });
      await page.goto(`/s/${root}`);
      const station = page.locator(`[data-station="${root}"]`);
      await expect(station.getByTestId("child-asks")).toHaveCount(3, { timeout: 45_000 });
      const kids = await agentsOf(request, root);
      const [a, b] = ["Alpha", "Beta"].map((t) => kids.find((k) => k.title === t)!);
      const g = (await agentsOf(request, a!.session_id)).find((k) => k.title === "Gamma")!;
      ids.push(a!.session_id, b!.session_id, g.session_id);
      // Each is named by its path from this session: the grandchild under its parent.
      await expect(ask(page, root).and(page.locator(`[data-agent="${g.session_id}"]`)).getByTestId("child-path")).toHaveText(/^Agent Alpha › Gamma$/);
      // (the same prefix at every depth)
      await expect(ask(page, root).and(page.locator(`[data-agent="${a!.session_id}"]`)).getByTestId("child-path")).toHaveText(/^Agent Alpha$/);
      // The line speaks as a dock line does: small, muted, one dot of colour. The name is told by its ink, not by its weight.
      const line = ask(page, root).and(page.locator(`[data-agent="${a!.session_id}"]`)).locator("> button");
      const name = line.getByTestId("child-name");
      await expect(name).toHaveText("Alpha");
      expect(await name.evaluate((el) => { const c = getComputedStyle(el), p = getComputedStyle(el.parentElement!); return [c.fontWeight, c.color !== p.color, parseFloat(c.fontSize) < parseFloat(getComputedStyle(document.body).fontSize)]; })).toEqual(["400", true, true]);
      await expect(line.locator(".k-mark")).toHaveCount(1);
      await expect(ask(page, root).and(page.locator(`[data-agent="${g.session_id}"]`))).toHaveAttribute("data-depth", "2");
      await expect(ask(page, root).and(page.locator(`[data-agent="${a!.session_id}"]`))).toHaveAttribute("data-depth", "1");
      const card = (id: string) => page.locator(`[data-station="${root}"] [data-agent="${id}"]`);
      await expect(card(a!.session_id).getByTestId("approval")).toHaveCount(1);
      await expect(card(g.session_id).getByTestId("approval")).toHaveCount(1);
      // An agent's request is a row under its line, not a card of its own height, and only the one Enter answers carries the state's edge.
      for (const id of [a!.session_id, g.session_id]) await expect(card(id).getByTestId("approval")).toHaveAttribute("data-dense", "true");
      // The keyboard on one agent's list: its request alone carries the state's edge, the others and the question step back.
      if (size.width > 767) {
        await card(a!.session_id).getByTestId("approvals").focus();
        const edge = (id: string, sel: string) => card(id).locator(sel).first().evaluate((el) => getComputedStyle(el).boxShadow);
        expect(await edge(a!.session_id, '[data-testid="approval"]')).not.toBe("none");
        expect(await edge(g.session_id, '[data-testid="approval"]')).toBe("none");
        expect(await edge(b!.session_id, ".k-question")).toBe("none");
        // The keyboard nowhere in the requests: still one edge, the first agent's.
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        const edges = await ask(page, root).evaluateAll((els) => els.map((el) => getComputedStyle(el.querySelector('[data-testid="approval"], .k-question')!).boxShadow !== "none"));
        expect(edges).toEqual([true, false, false]);
      }
      // The second answer is not heavier than the first.
      if (size.width > 767) expect(await card(a!.session_id).getByTestId("allow-always").evaluate((el) => getComputedStyle(el).fontWeight)).toBe("400");
      // The last of them does not stand on the message box.
      const gap = async () => (await page.locator(`[data-station="${root}"]`).getByTestId("composer-box").boundingBox())!.y - await ask(page, root).last().evaluate((el) => el.lastElementChild!.getBoundingClientRect().bottom);
      if (size.width > 767) expect(await gap()).toBeGreaterThanOrEqual(6);
      await expect(card(b!.session_id).getByTestId("question-submit")).toHaveCount(1);
      // The question's header chip shows once at every width (wide: beside the question, narrow: leading its text).
      await expect(card(b!.session_id).locator(".k-q-chip").filter({ visible: true })).toHaveCount(1);
      await shoot(page, `tree-approvals-01-${size.width}`);

      // The grandchild's card by the keyboard. A key right after the keyboard arrives answers nothing.
      const allow = card(g.session_id).getByTestId("allow-once");
      await allow.focus();
      const arrived = Date.now();
      await page.keyboard.press("Enter");
      if (Date.now() - arrived < SETTLE / 2) expect((await approvals(request, g.session_id))[0]).toMatchObject({ state: "pending" });
      await expect(allow).toHaveAttribute("data-ready", "true", { timeout: 5000 });
      await page.keyboard.press("Enter");
      await expect.poll(() => existsSync(join(ws, "gamma.txt")), { timeout: 30_000 }).toBe(true);
      // The grandchild's question comes next, on the same view.
      await expect(card(g.session_id).getByTestId("question-submit")).toHaveCount(1, { timeout: 30_000 });

      // The child's card by the pointer, and the questions of both agents: all answered here, none opened.
      // (The grandchild's question just came in and the region went to the oldest request, which moves this card on a
      // phone: its Allow takes a press once it has stood still. A click that waits for that is scrolled by the retries.)
      await expect(card(a!.session_id).getByTestId("allow-once")).not.toHaveAttribute("aria-disabled", "true", { timeout: 10_000 });
      await card(a!.session_id).getByTestId("allow-once").click();
      await expect.poll(() => existsSync(join(ws, "alpha.txt")), { timeout: 30_000 }).toBe(true);
      await shoot(page, `tree-approvals-02-${size.width}`);
      for (const [id, pick] of [[b!.session_id, "Teal"], [g.session_id, "Amber"]] as const) {
        await card(id).getByTestId("question-option").filter({ hasText: pick }).click();
        await card(id).getByTestId("question-submit").click();
        await expect.poll(() => pending(request, id), { timeout: 30_000 }).toHaveLength(0);
      }
      await expect(station.getByTestId("child-asks")).toHaveCount(0, { timeout: 30_000 });
      expect(new URL(page.url()).pathname).toBe(`/s/${root}`);
    } finally {
      await drop(request, ...ids.reverse());
    }
  });
}

// An agent whose questions the page cannot read (a failed read, an older peer): one more read, and then a way to the agent.
async function askedByAgent(request: Parameters<typeof approvals>[0], root: string) {
  await request.put(`/api/sessions/${root}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await request.post(`/api/sessions/${root}/messages`, { data: { text: calls([spawn(`Beta\n${calls([colors])}`)]) } });
  await expect.poll(async () => (await agentsOf(request, root)).length, { timeout: 45_000 }).toBe(1);
  const beta = (await agentsOf(request, root))[0]!.session_id;
  await expect.poll(async () => (await pending(request, beta)).length, { timeout: 30_000 }).toBe(1);
  return beta;
}

test("an agent's question is read once more when the first read fails", async ({ page, request }) => {
  await scripted(request);
  const root = await create(request, "Retry root", folder("tree-retry"));
  const ids = [root];
  try {
    const beta = await askedByAgent(request, root);
    ids.push(beta);
    let reads = 0;
    await page.route(`**/api/sessions/${beta}/questions`, (route) => (++reads === 1 ? route.fulfill({ status: 500, contentType: "application/json", body: "{\"error\":\"try again\"}" }) : route.fallback()));
    await page.goto(`/s/${root}`);
    await expect(ask(page, root).getByTestId("question-submit")).toHaveCount(1, { timeout: 30_000 });
    expect(reads).toBe(2);
    await expect(page.getByTestId("question-unreadable")).toHaveCount(0);
  } finally {
    await drop(request, ...ids.reverse());
  }
});

for (const size of [{ width: 1920, height: 1040 }, { width: 390, height: 844 }]) {
  test(`a question that cannot be read says to open the agent at ${size.width}x${size.height}`, async ({ page, request }) => {
    await scripted(request);
    await page.setViewportSize(size);
    const root = await create(request, "Unreadable root", folder("tree-unreadable"));
    const ids = [root];
    try {
      const beta = await askedByAgent(request, root);
      ids.push(beta);
      let reads = 0;
      await page.route(`**/api/sessions/${beta}/questions`, (route) => { reads++; return route.fulfill({ status: 404, contentType: "application/json", body: "{\"error\":\"not found\"}" }); });
      await page.goto(`/s/${root}`);
      const note = ask(page, root).getByTestId("question-unreadable");
      await expect(note).toContainText("open the agent to answer", { timeout: 30_000 });
      expect(reads).toBe(2);
      await expect(ask(page, root).getByTestId("question-submit")).toHaveCount(0);
      await shoot(page, `tree-approvals-04-${size.width}`);
      await note.getByRole("button").click();
      await expect(page).toHaveURL(new RegExp(`/s/${beta}$`));
    } finally {
      await drop(request, ...ids.reverse());
    }
  });
}

test("the inbox opens an agent's approval on the session at the top of its tree", async ({ page, request }) => {
  await scripted(request);
  const ws = folder("tree-inbox");
  const root = await create(request, "Tree top", ws);
  const other = await create(request, "Somewhere else", ws);
  const ids = [root, other];
  try {
    await request.put(`/api/sessions/${root}/permissions`, { data: { mode: "ask", sandbox: "off" } });
    const inner = `Inner\n${calls([bash("touch inner.txt")])}`;
    await request.post(`/api/sessions/${root}/messages`, { data: { text: calls([spawn(`Outer\n${calls([spawn(inner)])}`)]) } });
    await expect.poll(async () => { const o = (await agentsOf(request, root))[0]; return o ? (await agentsOf(request, o.session_id)).length : 0; }, { timeout: 45_000 }).toBe(1);
    const outer = (await agentsOf(request, root))[0]!;
    const inn = (await agentsOf(request, outer.session_id))[0]!;
    ids.push(outer.session_id, inn.session_id);
    await expect.poll(async () => (await approvals(request, inn.session_id)).length, { timeout: 30_000 }).toBe(1);
    await page.goto(`/s/${other}`);
    await page.getByTestId("inbox-button").click();
    const row = page.getByTestId("inbox-item").filter({ has: page.getByTestId("inbox-word").getByText("Approval", { exact: true }) }).first();
    await row.getByTestId("inbox-open").first().click();
    await expect(page).toHaveURL(new RegExp(`/s/${root}$`));
    await expect(page.locator(`[data-station="${root}"] [data-agent="${inn.session_id}"]`).getByTestId("approval")).toHaveCount(1);
    await shoot(page, "tree-approvals-03-inbox");
  } finally {
    await drop(request, ...ids.reverse());
  }
});
