import { expect, test } from "./isolate.ts";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Editor } from "./acp-editor.ts";
import { shoot } from "./shots.ts";

const STAND_IN = "scripted:stand-in";
const calls = (list: { name: string; input: unknown }[]) => `script:calls ${JSON.stringify(list)}`;
const touch = (file: string) => ({ name: "Bash", input: { command: `touch ${file}` } });

// Feature: an editor that takes child sessions (ACP clientCapabilities.subagents) sees the agents of a
// session it holds as children of it: each announced on its parent with its task and its cancel, its
// task as a message from the parent and its calls under its own id, its card asked as its own (one
// answer, in the editor or the workbench), and a cancel of it is the owner's Stop of that agent alone.
// An editor that did not say it takes them sees none of it.
test("acp subagents", async ({ page, request, baseURL }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "needs the scripted provider: the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `acp-subagents-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const ed = new Editor(baseURL!);
  await ed.call("initialize", { protocolVersion: 1, clientCapabilities: { subagents: {} } });
  const id = (await ed.call("session/new", { cwd: ws, mcpServers: [] })).sessionId as string;
  try {
    await ed.call("session/set_config_option", { sessionId: id, configId: "model", value: STAND_IN });
    await ed.call("session/set_mode", { sessionId: id, modeId: "ask" });
    // The parent's own requests are answered at once; its agents' stay open until the spec answers them.
    ed.onRequest = (m) => (m.params.sessionId === id ? { outcome: { outcome: "selected", optionId: "once" } } : undefined);
    const agents = async () => ((await (await request.get(`/api/sessions/${id}/agents`)).json()).agents as { id: string; session_id: string; status: string; stopped_by?: string }[]);
    const r = ed.call("session/prompt", { sessionId: id, prompt: [{ type: "text", text: calls([
      { name: "spawn_agent", input: { message: `Touch the first file\n${calls([touch("first.txt")])}`, isolation: "none" } },
      { name: "spawn_agent", input: { message: `Touch the second file\n${calls([touch("second.txt")])}`, isolation: "none" } },
    ]) }] });
    await expect.poll(async () => (await agents()).length, { timeout: 30_000 }).toBe(2);
    const [a, b] = await agents();
    expect((await r).stopReason).toBe("end_turn");

    // Both are children of the session, each announced with its task line and a cancel while it works.
    const told = (child: string) => ed.updates.filter((u) => u.sessionId === id && u.update.sessionUpdate === "subagent_update" && u.update.sessionId === child).map((u) => u.update);
    for (const [child, task] of [[a!.session_id, "Touch the first file"], [b!.session_id, "Touch the second file"]] as const) {
      await expect.poll(() => told(child).length, { timeout: 30_000 }).toBeGreaterThan(0);
      expect(told(child)[0]).toMatchObject({ description: task, capabilities: { cancel: {} }, state: { state: "running" } });
      // Its first update follows its announcement; its task is a message from the parent.
      const at = ed.updates.findIndex((u) => u.sessionId === child);
      expect(at).toBeGreaterThan(ed.updates.findIndex((u) => u.update.sessionId === child));
      expect(ed.updates[at].update).toMatchObject({ sessionUpdate: "session_message", senderSessionId: id, recipientSessionId: child });
    }

    // The first one's card is asked under its own id and answered there: it runs and ends.
    const asks = (child: string) => ed.requests.filter((m) => m.params.sessionId === child);
    await expect.poll(() => asks(a!.session_id).length, { timeout: 30_000 }).toBe(1);
    expect(asks(a!.session_id)[0].method).toBe("session/request_permission");
    expect(asks(a!.session_id)[0].params.toolCall.title).toContain("touch first.txt");
    ed.answer(asks(a!.session_id)[0].id, { outcome: { outcome: "selected", optionId: "once" } });
    await expect.poll(() => existsSync(join(ws, "first.txt")), { timeout: 30_000 }).toBe(true);
    expect(ed.kinds(a!.session_id)).toEqual(expect.arrayContaining(["tool_call", "tool_call_update", "agent_message_chunk"]));
    await expect.poll(() => told(a!.session_id).at(-1)?.state, { timeout: 30_000 }).toEqual({ state: "idle", stopReason: "end_turn" });
    expect(told(a!.session_id).at(-1)!.capabilities).toEqual({});

    // The second one waits on its card, and shows it; the editor cancels it instead.
    await expect.poll(() => asks(b!.session_id).length, { timeout: 30_000 }).toBe(1);
    const held = asks(b!.session_id)[0];
    await expect.poll(() => told(b!.session_id).at(-1)?.state).toEqual({ state: "requires_action" });
    // A child is watched, not driven: a prompt to it is refused.
    await expect(ed.call("session/prompt", { sessionId: b!.session_id, prompt: [{ type: "text", text: "go" }] })).rejects.toMatchObject({ code: -32602 });
    // Another editor that loads the session now: the waiting agent is announced as needing action and
    // the card it put up before is asked there too (one answer counts, from either).
    const late = new Editor(baseURL!);
    late.onRequest = () => undefined; // its requests stay open
    await late.call("initialize", { protocolVersion: 1, clientCapabilities: { subagents: {} } });
    await late.call("session/load", { sessionId: id, cwd: ws, mcpServers: [] });
    const lateTold = (child: string) => late.updates.filter((u) => u.sessionId === id && u.update.sessionUpdate === "subagent_update" && u.update.sessionId === child).map((u) => u.update);
    await expect.poll(() => lateTold(b!.session_id).at(-1)?.state, { timeout: 30_000 }).toEqual({ state: "requires_action" });
    await expect.poll(() => late.requests.filter((m) => m.params.sessionId === b!.session_id).length, { timeout: 30_000 }).toBe(1);
    const lateAsk = late.requests.find((m) => m.params.sessionId === b!.session_id)!;
    expect(lateAsk.params.toolCall.title).toContain("touch second.txt");
    expect(lateTold(a!.session_id).at(-1)?.state).toEqual({ state: "idle", stopReason: "end_turn" });
    ed.notify("session/cancel", { sessionId: b!.session_id });
    await expect.poll(() => late.notices.some((m) => m.method === "$/cancel_request" && m.params.requestId === lateAsk.id), { timeout: 30_000 }).toBe(true);
    late.answer(lateAsk.id, { outcome: { outcome: "cancelled" } });
    late.close();
    await expect.poll(() => told(b!.session_id).at(-1)?.state, { timeout: 30_000 }).toEqual({ state: "idle", stopReason: "cancelled" });
    // Stopped as the owner's Stop of that agent; its card is withdrawn from the editor, and nothing ran.
    expect((await agents()).find((x) => x.id === b!.id)).toMatchObject({ status: "stopped", stopped_by: "owner" });
    await expect.poll(() => ed.notices.some((m) => m.method === "$/cancel_request" && m.params.requestId === held.id)).toBe(true);
    ed.answer(held.id, { outcome: { outcome: "cancelled" } });
    expect(existsSync(join(ws, "second.txt"))).toBe(false);
    // The first one was not touched by it.
    expect((await agents()).find((x) => x.id === a!.id)!.status).toBe("completed");

    await page.goto(`/s/${id}`);
    await expect(page.getByTestId("assistant-text").first()).toBeVisible();
    await shoot(page, "acp-subagents-01-parent");

    // An editor that did not say it takes child sessions sees none of them.
    const plain = new Editor(baseURL!);
    await plain.call("initialize", { protocolVersion: 1, clientCapabilities: {} });
    await plain.call("session/load", { sessionId: id, cwd: ws, mcpServers: [] });
    await expect.poll(() => plain.kinds(id)).toContain("available_commands_update");
    expect(plain.updates.some((u) => u.update.sessionUpdate === "subagent_update" || u.sessionId !== id)).toBe(false);
    plain.close();
  } finally {
    ed.close();
    await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } });
    await request.delete(`/api/sessions/${id}`);
  }
});
