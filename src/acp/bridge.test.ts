import { expect, test } from "bun:test";
import { AcpBridge, permissionRequest, promptOf } from "./bridge.ts";

test("an editor's permission request carries the card's reason", () => {
  const card = { session_id: "s", call_id: "c", tool: "Bash", summary: "git push --force", input: { command: "git push --force" }, risk: "high", why: "the command rewrites or deletes history on a remote", suggest: [] };
  const r = permissionRequest(card, "Bash");
  expect(r.toolCall.content).toEqual([{ type: "content", content: { type: "text", text: "High risk: the command rewrites or deletes history on a remote." } }]);
  expect(r.options.map((o: any) => o.optionId)).toEqual(["once", "deny"]);
  const low = permissionRequest({ ...card, risk: "low", why: undefined, notice: "Reviewer unavailable: no reviewer is set up. The owner answers this one.", suggest: [{ kind: "shell", pattern: "git push *" }] }, "Bash");
  expect(low.toolCall.content[0].content.text).toContain("Reviewer unavailable");
  expect(low.options.map((o: any) => o.optionId)).toEqual(["once", "always", "deny"]);
});

// A daemon stand-in: sessions, their events, a model listing, and the frame stream.
function fixture(sessions: any[], events: Record<string, any[]>) {
  let on: (f: any) => void = () => {};
  const out: any[] = [];
  const calls: string[] = [];
  const d = {
    models: [{ id: "p:alpha", name: "Alpha", provider: "p" }],
    get: async (path: string) => {
      calls.push(`GET ${path}`);
      if (path === "/api/models") return { models: d.models, default: "p:alpha" };
      if (path === "/api/sessions") return { sessions };
      if (path.endsWith("/permissions")) return { perm: { mode: "ask" } };
      const s = sessions.find((x) => path === `/api/sessions/${x.id}`);
      return { session: s, events: events[s.id] ?? [], running: false };
    },
    send: async (method: string, path: string) => (calls.push(`${method} ${path}`), {}),
    frames: async (f: (x: any) => void) => ((on = f), () => {}),
  };
  const bridge = new AcpBridge(d, (m) => out.push(m));
  const updates = (id: string) => out.filter((m) => m.method === "session/update" && m.params.sessionId === id).map((m) => m.params.update);
  return { d, bridge, out, calls, updates, frame: (f: any) => on(f) };
}
let seq = 0;
const ev = (kind: string, data: any, parent: string | null, id = `e${++seq}`) => ({ id, session_id: "s", seq, parent, kind, data, ts: seq });
const call = async (b: AcpBridge, out: any[], method: string, params: any) => {
  const id = Math.random();
  await b.handle({ jsonrpc: "2.0", id, method, params });
  return out.find((m) => m.id === id);
};

test("loading a session replays the branch shown, each input as whose it is", async () => {
  const q = ev("user", { text: "Q", images: [{ type: "image", media_type: "image/png", data: "iVBO" }] }, null, "q");
  const left = ev("assistant", { blocks: [{ type: "text", text: "Left" }] }, "q", "left");
  const right = ev("assistant", { blocks: [{ type: "text", text: "Right" }, { type: "tool_use", id: "c1", name: "Read", input: { file_path: "/a" } }, { type: "tool_use", id: "c2", name: "Read", input: { file_path: "/b" } }, { type: "tool_use", id: "c3", name: "Read", input: { file_path: "/c" } }] }, "q", "right");
  const res = ev("tool_result", { results: [{ tool_use_id: "c1", content: [{ type: "text", text: "one" }, { type: "image", media_type: "image/png", data: "AAAA" }, { type: "text", text: "two" }] }, { tool_use_id: "c2", content: [{ type: "image", media_type: "image/png", data: "BBBB" }], is_error: true }] }, "right", "res");
  const rep = ev("user", { text: '<subagent_result agent_id="k1" title="Review" status="done">status ok</subagent_result>', kind: "subagent" }, "res", "rep");
  const cmp = ev("compaction", { mode: "summary", summary: "Kept: the plan." }, "rep", "cmp");
  const s = { id: "s", workspace: "/w", model: "p:alpha", head: "cmp", updated: 1 };
  for (const compaction of [true, false]) {
    const f = fixture([s], { s: [q, left, right, res, rep, cmp] });
    await call(f.bridge, f.out, "initialize", { protocolVersion: 1, clientCapabilities: compaction ? { session: { compaction: {} } } : {} });
    await call(f.bridge, f.out, "session/load", { sessionId: "s", cwd: "/w", mcpServers: [] });
    const u = f.updates("s");
    const said = u.filter((x: any) => x.sessionUpdate === "user_message_chunk").map((x: any) => x.content);
    expect(said).toEqual([{ type: "image", mimeType: "image/png", data: "iVBO" }, { type: "text", text: "Q" }]);
    const agent = u.filter((x: any) => x.sessionUpdate === "agent_message_chunk").map((x: any) => x.content.text);
    expect(agent.some((t: string) => t.includes("Left"))).toBe(false);
    expect(agent[0]).toBe("Right");
    expect(agent[1]).toStartWith("[Report from a child agent]");
    const calls = u.filter((x: any) => x.sessionUpdate === "tool_call").map((x: any) => x.status);
    expect(calls).toEqual(["completed", "failed", "failed"]); // c3 has no result: never shown as done
    const c1 = u.find((x: any) => x.sessionUpdate === "tool_call_update" && x.toolCallId === "c1");
    expect(c1.content.map((c: any) => c.content.type)).toEqual(["text", "image", "text"]);
    expect(u.find((x: any) => x.sessionUpdate === "tool_call_update" && x.toolCallId === "c2").content[0].content.type).toBe("image");
    const structured = u.filter((x: any) => x.sessionUpdate === "compaction_update");
    if (compaction) expect(structured).toEqual([{ sessionUpdate: "compaction_update", compactionId: "cmp", status: "completed", summary: [{ type: "text", text: "Kept: the plan." }] }]);
    else expect(structured).toEqual([]);
    // The load answer comes after the last replayed update.
    expect(f.out.at(-1).result.configOptions).toBeDefined();
  }
});

test("session/list pages with a cursor and refuses a bad one", async () => {
  const rows = [...Array(201).keys()].map((i) => ({ id: `a${i}`, workspace: "/A", updated: 1 })).concat([{ id: "b0", workspace: "/B", updated: 1 }, { id: "b1", workspace: "/B", updated: 1 }]);
  const f = fixture(rows, {});
  const one = (await call(f.bridge, f.out, "session/list", { cwd: "/A" })).result;
  expect(one.sessions.length).toBe(200);
  const two = (await call(f.bridge, f.out, "session/list", { cwd: "/A", cursor: one.nextCursor })).result;
  expect(two.sessions.map((x: any) => x.sessionId)).toEqual(["a200"]);
  expect(two.nextCursor).toBeUndefined();
  expect((await call(f.bridge, f.out, "session/list", { cwd: "/B" })).result.sessions.length).toBe(2);
  expect((await call(f.bridge, f.out, "session/list", { cursor: "nope" })).error.code).toBe(-32602);
});

test("a prompt's live reply: missed text sent, the turn's end said as it was", async () => {
  const s = { id: "s", workspace: "/w", model: "p:alpha", head: null, updated: 1 };
  const f = fixture([s], {});
  const turn = async (frames: any[]) => {
    const p = call(f.bridge, f.out, "session/prompt", { sessionId: "s", prompt: [{ type: "text", text: "go" }] });
    await Bun.sleep(0);
    const before = f.updates("s").length;
    for (const x of frames) f.frame(x);
    const answer = await p;
    return { answer, text: f.updates("s").slice(before).filter((u: any) => u.sessionUpdate === "agent_message_chunk").map((u: any) => u.content.text).join("") };
  };
  const reply = { t: "event", event: { session_id: "s", kind: "assistant", data: { blocks: [{ type: "text", text: "Build finished. " }, { type: "text", text: "Tests failed." }] } } };
  const end = (reason: string) => ({ t: "event", event: { session_id: "s", kind: "turn_end", data: { reason } } });
  const delta = (text: string) => ({ t: "delta", session_id: "s", index: 0, kind: "text", text });
  for (const deltas of [[], [delta("Build finished. ")], [delta("Build finished. "), delta("Tests failed.")]]) {
    const r = await turn([...deltas, reply, end("end_turn")]);
    expect(r.text).toBe("Build finished. Tests failed.");
    expect(r.answer.result.stopReason).toBe("end_turn");
  }
  expect((await turn([end("max_steps")])).answer.result.stopReason).toBe("max_turn_requests");
  expect((await turn([end("interrupted")])).answer.result.stopReason).toBe("cancelled");
  const failed = await turn([{ t: "event", event: { session_id: "s", kind: "error", data: { message: "fixture provider unavailable" } } }, end("error")]);
  expect(failed.text).toContain("fixture provider unavailable");
  expect(failed.answer.error.message).toBe("fixture provider unavailable");
});

test("loading again reads the model listing again", async () => {
  const s = { id: "s", workspace: "/w", model: "p:alpha", head: null, updated: 1 };
  const f = fixture([s], {});
  const models = async () => (await call(f.bridge, f.out, "session/load", { sessionId: "s" })).result.configOptions.find((o: any) => o.id === "model");
  expect((await models()).options[0].options.map((o: any) => o.value)).toEqual(["p:alpha"]);
  f.d.models = [{ id: "p:beta", name: "Beta", provider: "p" }];
  s.model = "p:beta";
  const m = await models();
  expect(m.currentValue).toBe("p:beta");
  expect(m.options[0].options.map((o: any) => o.value)).toEqual(["p:beta"]);
});

test("an embedded file reaches the prompt or the prompt is refused", async () => {
  const blob = { type: "resource", resource: { uri: "memory://draft/spec", mimeType: "application/pdf", blob: Buffer.from("%PDF").toString("base64") } };
  await expect(promptOf([{ type: "text", text: "inspect spec" }, blob])).rejects.toThrow("cannot be attached");
  const up = await promptOf([{ type: "text", text: "inspect spec" }, blob], async (name, type, bytes) => ({ type: "attachment", id: "x", name, media_type: type, size: bytes.byteLength }));
  expect(up.images).toEqual([{ type: "attachment", id: "x", name: "spec", media_type: "application/pdf", size: 4 }]);
  const img = await promptOf([{ type: "resource", resource: { uri: "memory://i", mimeType: "image/png", blob: "iVBO" } }, { type: "image", mimeType: "image/png", data: "iVBO" }]);
  expect(img.images).toEqual([{ type: "image", media_type: "image/png", data: "iVBO" }, { type: "image", media_type: "image/png", data: "iVBO" }]);
  const text = await promptOf([{ type: "resource", resource: { uri: "file:///a.txt", text: "hi" } }, { type: "resource_link", uri: "file:///b.txt", name: "b" }]);
  expect(text.text).toBe('<file path="/a.txt">\nhi\n</file>\n\n@/b.txt');
});
