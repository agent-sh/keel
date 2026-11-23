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

// Feature: a grant "for this session" made on an agent's card covers its whole tree. The owner answers the agent's
// card on the root's page with a grant for the session; the root's own command of that form then runs unasked.
test("a grant for this session on an agent's card covers the root", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "needs the scripted provider: the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `tree-grant-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, workspace: ws, title: "Tree grant" } })).json();
  const id = session.id as string;
  try {
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
    const agent = `Toucher\n${calls([bash("touch alpha.txt")])}`;
    await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([{ name: "spawn_agent", input: { message: agent, isolation: "none" } }]) } });
    await page.goto(`/s/${id}`);
    const theirs = page.locator(`[data-station="${id}"]`).getByTestId("child-approvals").getByTestId("approval");
    await expect(theirs).toHaveCount(1, { timeout: 30_000 });
    await theirs.getByTestId("allow-always").click();
    await expect(page.getByTestId("grant-pattern")).toHaveValue("touch *");
    await shoot(page, "agent-permissions-03-grant");
    // (The button says what the grant covers: the session and its agents.)
    await page.getByTestId("grant-session").getByText("This session and its agents").click();
    await expect(theirs).toHaveCount(0);
    await expect.poll(() => existsSync(join(ws, "alpha.txt")), { timeout: 30_000 }).toBe(true);
    // The root's own touch runs without a card: a card would hold it, and the file would never be made.
    await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([bash("touch beta.txt")]) } });
    await expect.poll(() => existsSync(join(ws, "beta.txt")), { timeout: 30_000 }).toBe(true);
    const cards = (await (await request.get(`/api/sessions/${id}/approvals?all`)).json()).approvals as { session_id: string }[];
    expect(cards.filter((a) => a.session_id === id)).toEqual([]);
  } finally {
    await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } });
    // The grant made here goes (a later spec's card must not find it), and so would it with its session.
    const tree = new Set([id, ...((await (await request.get(`/api/sessions/${id}/agents`)).json()).agents as { session_id: string }[]).map((a) => a.session_id)]);
    for (const r of (await (await request.get("/api/permissions/grants")).json()).grants as { id: string; session_id?: string }[])
      if (r.session_id && tree.has(r.session_id)) await request.delete(`/api/permissions/grants/${r.id}`);
    await request.delete(`/api/sessions/${id}`);
  }
});
