import { expect, test } from "./isolate.ts";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

const STAND_IN = "scripted:stand-in";
const calls = (list: { name: string; input: unknown }[]) => `script:calls ${JSON.stringify(list)}`;
const bash = (command: string) => ({ name: "Bash", input: { command } });

// Feature: permissions across an agent tree. The owner moves the root to a tighter mode while its agent asks:
// the agent is held to it at once and its open card is judged again; a looser mode later reaches the agent too,
// as it took its mode from the root.
test("a parent's permission change reaches its agents and their open cards", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "needs the scripted provider: the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `tree-perm-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, workspace: ws, title: "Tree permissions" } })).json();
  const id = session.id as string;
  const perm = async (sid: string) => (await (await request.get(`/api/sessions/${sid}/permissions`)).json()).perm;
  try {
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
    const agent = `Asker\n${calls([bash("touch asked.txt")])}`;
    await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([{ name: "spawn_agent", input: { message: agent, isolation: "none" } }]) } });
    await page.goto(`/s/${id}`);
    const theirs = page.locator(`[data-station="${id}"]`).getByTestId("child-approvals").getByTestId("approval");
    await expect(theirs).toHaveCount(1, { timeout: 30_000 });
    const child = ((await (await request.get(`/api/sessions/${id}/agents`)).json()).agents as { session_id: string }[])[0]!;
    expect((await perm(child.session_id)).mode).toBe("ask");
    await shoot(page, "agent-permissions-01-asking");

    // Read only on the root: the agent's card is settled as read only settles it, and nothing was written.
    await page.getByTestId("permission-menu").click();
    await page.getByTestId("mode-read-only").click();
    await expect(page.getByTestId("permission-mode")).toHaveText("Read only");
    await page.keyboard.press("Escape");
    await expect(theirs).toHaveCount(0, { timeout: 30_000 });
    expect((await perm(child.session_id)).mode).toBe("read-only");
    expect(existsSync(join(ws, "asked.txt"))).toBe(false);
    await shoot(page, "agent-permissions-02-capped");

    // A looser mode reaches it too: it took its mode from the root.
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "auto-edits" } });
    expect((await perm(child.session_id)).mode).toBe("auto-edits");
  } finally {
    await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } });
    await request.delete(`/api/sessions/${id}`);
  }
});
