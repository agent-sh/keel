import { expect, test } from "./isolate.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

// Feature: a chained command that asks names the part that asked. The card underlines that part in the
// text of the command, and the card's form carries where it stands (`at`), which the notification's line
// and the phone's card read. The card is never answered: the command is not run.
test("an approval underlines the part of a chained command that asked", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  const model = models.find((m) => m.id === "scripted:stand-in")?.id;
  test.skip(!model, "requires a scripted scratch daemon");
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `part-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { title: "Chain", model, workspace: ws } })).json();
  const id = session.id as string;
  const command = "echo before && git push --force origin main && echo after";
  const asking = "git push --force origin main";
  try {
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
    await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command } }])}` } });
    await page.goto(`/s/${id}`);
    const card = page.getByTestId("approval");
    await expect(card).toHaveCount(1, { timeout: 30_000 });
    // The whole command is there, and the part that asked is the marked one in it.
    await expect(card.getByTestId("approval-summary")).toContainText(command);
    const part = card.getByTestId("approval-part");
    await expect(part).toHaveText(asking);
    expect(await part.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("underline");
    // The daemon's form of the card says where it stands, and its notification line starts with it.
    const list = (await (await request.get(`/api/sessions/${id}/approvals`)).json()).approvals as { id: string }[];
    const one = await (await request.get(`/api/sessions/${id}/approvals/${list[0]!.id}`)).json();
    expect(one.card.at).toEqual([command.indexOf(asking), command.indexOf(asking) + asking.length]);
    expect(one.card.line).toBe(`Bash: ${asking} (part of a longer command)`);
    expect(one.card.glance).toBe(false);
    await shoot(page, "approval-part-01-chain");
  } finally {
    await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } });
    await request.delete(`/api/sessions/${id}`);
  }
});
