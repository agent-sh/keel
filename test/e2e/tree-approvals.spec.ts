import { expect, test, type Page } from "./isolate.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { approvals, calls, colors, create, drop, folder, pending, scripted, SETTLE } from "./answering.ts";
import { shoot } from "./shots.ts";

// Feature: a session's view shows what its whole tree of agents waits on, at any depth, each card named by
// the agent that asks and its place in the tree. The owner of a coordinator answers its agents' approvals
// and questions there, by the same keys and with the same permission as in the agent's own pane
// (lib/asks.ts: no key answers as the keyboard arrives). The inbox opens an agent's approval on the
// session at the top of the tree.
// Every pane on screen: no focus mode (the config's default for the other specs).
test.use({ storageState: { cookies: [], origins: [] } });

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
      await expect(ask(page, root).and(page.locator(`[data-agent="${g.session_id}"]`)).getByTestId("child-path")).toHaveText(/Alpha › Gamma/);
      await expect(ask(page, root).and(page.locator(`[data-agent="${g.session_id}"]`))).toHaveAttribute("data-depth", "2");
      await expect(ask(page, root).and(page.locator(`[data-agent="${a!.session_id}"]`))).toHaveAttribute("data-depth", "1");
      const card = (id: string) => page.locator(`[data-station="${root}"] [data-agent="${id}"]`);
      await expect(card(a!.session_id).getByTestId("approval")).toHaveCount(1);
      await expect(card(g.session_id).getByTestId("approval")).toHaveCount(1);
      await expect(card(b!.session_id).getByTestId("question-submit")).toHaveCount(1);
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
