import { expect, test } from "./isolate.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

// Feature: an ACP agent Keel drives announces children (ACP clientCapabilities.subagents), and each is an agent
// row under its session: its title and task, its state, its messages and tool calls in a transcript of its own,
// its permission request on the session's approval card (judged as the session's own, with the child's id), and
// a Stop on its row that sends session/cancel for that child alone. The stand-in agent announces two children:
// one asks permission for a command, the other works until it is cancelled.
test("acp client subagents", async ({ page, request }) => {
  const standin = join(import.meta.dirname, "fixtures/acp-agent-children.ts");
  await request.delete("/api/acp/agents/children-t").catch(() => {});
  expect((await request.post("/api/acp/agents", { data: { id: "children-t", command: "bun", args: [standin] } })).ok()).toBe(true);
  try {
    const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `acp-children-${Date.now()}`);
    mkdirSync(ws, { recursive: true });
    const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: "acp:children-t" } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
    const agents = async () => ((await (await request.get(`/api/sessions/${session.id}/agents`)).json()).agents as { id: string; title: string; session_id: string; status: string; stopped_by?: string; external?: { cancel: boolean; state?: string } }[]);
    await page.goto(`/s/${session.id}`);
    await page.getByTestId("composer").fill("start the children");
    await page.keyboard.press("Enter");

    // Both children are rows under the session with their titles, the agent's own labels.
    await expect.poll(async () => (await agents()).map((a) => a.title).sort(), { timeout: 30_000 }).toEqual(["Doc checker", "Test investigator"]);
    const lines = page.getByTestId("agent-line");
    await expect(lines).toHaveCount(2);
    await expect(lines.filter({ hasText: "Test investigator" })).toBeVisible();
    await expect(lines.filter({ hasText: "Doc checker" })).toBeVisible();
    // (The step's own card for each is under the step: its line opens it.)
    const cards = page.getByTestId("agent-call");

    // One child asks permission for its command: Keel's approval card, answered there.
    const card = page.getByTestId("approval").first();
    await expect(card.getByTestId("approval-summary")).toContainText("touch investigated.txt", { timeout: 30_000 });
    await expect(page.getByTestId("approval")).toHaveCount(1);
    const test_ = (await agents()).find((a) => a.title === "Test investigator")!;
    const docs = (await agents()).find((a) => a.title === "Doc checker")!;
    expect(test_.external?.state).toBe("requires_action");
    expect(((await (await request.get(`/api/sessions/${test_.session_id}/approvals?all=1`)).json()).approvals as { summary: string }[]).map((a) => a.summary)).toEqual([expect.stringContaining("touch investigated.txt")]);
    await shoot(page, "acp-children-01-ask");
    await card.getByTestId("allow-once").click();
    await expect.poll(async () => (await agents()).find((a) => a.id === test_.id)?.status, { timeout: 30_000 }).toBe("completed");

    // Its transcript is its own: the parent's task as a message from the parent, its thought and reply, its call.
    await lines.filter({ hasText: "Test investigator" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${test_.session_id}`));
    await expect(page.getByText("Find out why the integration tests fail on Windows.")).toBeVisible();
    await expect(page.getByTestId("tool-call").first()).toHaveAttribute("data-state", "ok");
    await expect(page.getByTestId("assistant-text").last()).toContainText("Two tests fail");
    await shoot(page, "acp-children-02-child");
    await page.goto(`/s/${session.id}`);

    // The other works on: its Stop sends session/cancel for it, and the agent's own word ends the row.
    await expect.poll(async () => (await agents()).find((a) => a.id === docs.id)?.status).toBe("running");
    await page.getByTestId("work-step").locator(".k-line[data-step]").click();
    await cards.filter({ hasText: "Doc checker" }).getByTestId("agent-call-stop").click();
    await page.getByRole("button", { name: "Stop agent" }).click();
    await expect.poll(async () => (await agents()).find((a) => a.id === docs.id)?.status, { timeout: 30_000 }).toBe("stopped");
    expect((await agents()).find((a) => a.id === test_.id)?.status).toBe("completed");
    // The session's own turn ends with what the agent said of its children.
    await expect(page.getByTestId("assistant-text").last()).toContainText("Children done: test allowed, docs cancelled.", { timeout: 30_000 });
    await expect(page.getByTestId("agent-call-status")).toHaveCount(2);
    await shoot(page, "acp-children-03-done");
  } finally {
    await request.delete("/api/acp/agents/children-t");
  }
});
