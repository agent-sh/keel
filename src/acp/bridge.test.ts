import { expect, test } from "bun:test";
import { AcpBridge, permissionRequest, promptOf } from "./bridge.ts";
import { cardForm } from "../safety/card.ts";

test("an editor's permission request carries the card's reason", () => {
  const card = { session_id: "s", call_id: "c", tool: "Bash", summary: "git push --force", input: { command: "git push --force" }, risk: "high", why: "the command rewrites or deletes history on a remote", suggest: [] };
  const r = permissionRequest(card, "Bash");
  expect(r.toolCall.content).toEqual([{ type: "content", content: { type: "text", text: "High risk: the command rewrites or deletes history on a remote." } }]);
  expect(r.options.map((o: any) => o.optionId)).toEqual(["once", "deny"]);
  const low = permissionRequest({ ...card, risk: "low", why: undefined, notice: "Reviewer unavailable: no reviewer is set up. The owner answers this one.", suggest: [{ kind: "shell", pattern: "git push *" }] }, "Bash");
  expect(low.toolCall.content[0].content.text).toContain("Reviewer unavailable");
  expect(low.options.map((o: any) => o.optionId)).toEqual(["once", "always", "deny"]);
});

test("an editor's request for a card that is read first carries the whole text in its content", () => {
  const command = Array.from({ length: 41 }, (_, i) => `echo step ${i + 1}`).join("\n") + "\necho ``` \u202e";
  const a = { id: "a1", session_id: "s", call_id: "c", tool: "Bash", kind: "shell", state: "pending", summary: command, input: { command }, risk: "low", suggest: [] } as any;
  const held = permissionRequest(a, "Bash", cardForm(a));
  // A line for the title: the editor shows a title as one line.
  expect(held.toolCall.title).toBe("Bash: echo step 1 ... (42 lines: the whole request is below)");
  const [notes, text] = held.toolCall.content.map((c: any) => c.content.text);
  expect(notes).toContain("characters that do not show as written");
  // All of it, each hidden character written out, in a fence the text cannot close.
  expect(text.startsWith("````\necho step 1\n")).toBe(true);
  expect(text.endsWith("echo ``` <U+202E>\n````")).toBe(true);
  expect(text.split("\n").length).toBe(44);
  // A request one line shows whole is the line it was.
  const short = { ...a, summary: "npm test", input: { command: "npm test" } };
  expect(permissionRequest(short, "Bash", cardForm(short)).toolCall).toMatchObject({ title: "npm test" });
  expect(permissionRequest(short, "Bash", cardForm(short)).toolCall.content).toBeUndefined();
});

// A daemon stand-in: sessions, their events, a model listing, and the frame stream.
// A prompt is stored at the next seq unless `post` answers for the daemon.
function fixture(sessions: any[], events: Record<string, any[]>) {
  let on: (f: any) => void = () => {};
  let n = 0;
  const out: any[] = [];
  const calls: string[] = [];
  const d = {
    models: [{ id: "p:alpha", name: "Alpha", provider: "p" }],
    post: undefined as undefined | ((method: string, path: string) => any),
    get: async (path: string) => {
      calls.push(`GET ${path}`);
      if (path === "/api/models") return { models: d.models, default: "p:alpha" };
      if (path === "/api/sessions") return { sessions };
      if (path.endsWith("/permissions")) return { perm: { mode: "ask" } };
      const s = sessions.find((x) => path === `/api/sessions/${x.id}`);
      return { session: s, events: events[s.id] ?? [], running: false };
    },
    sent: [] as { method: string; path: string; body: any }[],
    send: async (method: string, path: string, body?: any) => {
      calls.push(`${method} ${path}`);
      d.sent.push({ method, path, body });
      const r = await d.post?.(method, path);
      return r ?? (path.endsWith("/messages") ? { event: { id: `u${++n}`, seq: n } } : {});
    },
    frames: async (f: (x: any) => void) => ((on = f), () => {}),
  };
  const bridge = new AcpBridge(d, (m) => out.push(m));
  const updates = (id: string) => out.filter((m) => m.method === "session/update" && m.params.sessionId === id).map((m) => m.params.update);
  return { d, bridge, out, calls, updates, frame: (f: any) => on(f.t === "event" && f.event.seq === undefined ? { ...f, event: { ...f.event, seq: ++n } } : f) };
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
  // A cursor belongs to the list it was given for: not to another folder's, not to the unfiltered one.
  for (const other of [{ cwd: "/B" }, {}]) {
    const r = await call(f.bridge, f.out, "session/list", { ...other, cursor: one.nextCursor });
    expect(r.error).toEqual({ code: -32602, message: "invalid cursor: it was given for a list with another cwd" });
  }
  const all = (await call(f.bridge, f.out, "session/list", {})).result;
  expect((await call(f.bridge, f.out, "session/list", { cwd: "/A", cursor: all.nextCursor })).error.code).toBe(-32602);
  expect((await call(f.bridge, f.out, "session/list", { cursor: all.nextCursor })).result.sessions.map((x: any) => x.sessionId)).toEqual(["a200", "b0", "b1"]);
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

test("a card's request carries the whole text when the form cannot be read, and an answer the daemon holds is said", async () => {
  const s = { id: "s", workspace: "/w", model: "p:alpha", head: null, updated: 1 };
  const f = fixture([s], {});
  void call(f.bridge, f.out, "session/prompt", { sessionId: "s", prompt: [{ type: "text", text: "go" }] });
  await Bun.sleep(0);
  const command = Array.from({ length: 12 }, (_, i) => `echo row ${i + 1}`).join("\n");
  const card = (id: string) => ({ id, session_id: "s", call_id: `c-${id}`, tool: "Bash", kind: "shell", state: "pending", summary: command, input: { command }, risk: "low", suggest: [] });
  const asked = async (id: string) => {
    f.frame({ t: "feature", name: "approval", data: card(id) });
    await Bun.sleep(5);
    return f.out.findLast((m) => m.method === "session/request_permission")!;
  };
  // The fixture's daemon has no such route: the form is made from the card the stream carried.
  const first = await asked("a1");
  expect(f.calls).toContain("GET /api/sessions/s/approvals/a1");
  expect(first.params.toolCall.title).toBe("Bash: echo row 1 ... (12 lines: the whole request is below)");
  expect(first.params.toolCall.content.at(-1).content.text).toContain("echo row 12");
  await f.bridge.handle({ jsonrpc: "2.0", id: first.id, result: { outcome: { outcome: "selected", optionId: "once" } } });
  await Bun.sleep(5);
  expect(f.d.sent.at(-1)).toEqual({ method: "POST", path: "/api/sessions/s/approvals/a1", body: { choice: "once", reason: undefined, via: "acp", seen: "whole" } });

  // The daemon holds the answer (409 with `hold`): the editor is told, and the call is not shown as running.
  f.d.post = (_m, path) => { if (path.endsWith("/approvals/a2")) throw Object.assign(new Error("Open the request to read it first: it is 12 lines long."), { held: true }); };
  const second = await asked("a2");
  const before = f.updates("s").length;
  await f.bridge.handle({ jsonrpc: "2.0", id: second.id, result: { outcome: { outcome: "selected", optionId: "once" } } });
  await Bun.sleep(5);
  const after = f.updates("s").slice(before);
  expect(after.filter((u: any) => u.sessionUpdate === "tool_call_update").map((u: any) => u.status)).toEqual(["in_progress", "pending"]);
  expect(after.find((u: any) => u.sessionUpdate === "agent_message_chunk").content.text).toBe("Keel did not take that answer: Open the request to read it first: it is 12 lines long. The request still waits: answer it in the workbench.\n\n");
});

test("overlapping prompts each end once, at the end of the turn that took them", async () => {
  const f = fixture([{ id: "s", workspace: "/w", model: "p:alpha", head: null, updated: 1 }], {});
  const stored: ((r: any) => void)[] = [];
  f.d.post = (_m, path) => (path.endsWith("/messages") ? new Promise((r) => stored.push(r)) : undefined);
  const prompt = (id: number, text: string) => f.bridge.handle({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text }] } });
  const answers = (id: number) => f.out.filter((m) => m.id === id).map((m) => m.result?.stopReason ?? m.error?.message);
  const event = (seq: number, kind: string, data: any) => f.frame({ t: "event", event: { session_id: "s", seq, kind, data } });
  const one = prompt(1, "first");
  await Bun.sleep(0);
  event(5, "turn_end", { reason: "max_tokens" }); // an earlier turn ends while the first prompt is on its way
  stored[0]!({ event: { id: "u1", seq: 10 } });
  await Bun.sleep(0);
  expect(answers(1)).toEqual([]);
  const two = prompt(2, "second"); // while the first runs: the daemon queues it
  await Bun.sleep(0);
  stored[1]!({ queued: { id: "q1" }, steer: true });
  await Bun.sleep(0);
  event(12, "turn_end", { reason: "end_turn" });
  await one;
  expect(answers(1)).toEqual(["end_turn"]);
  expect(answers(2)).toEqual([]);
  event(13, "user", { text: "second", origin: "queued", queue_id: "q1" });
  event(16, "turn_end", { reason: "max_steps" });
  await two;
  expect(answers(2)).toEqual(["max_turn_requests"]);
  expect(answers(1)).toEqual(["end_turn"]);
  // A steer the running turn took in ends with that turn, and so does the prompt that started it.
  const three = prompt(3, "third");
  await Bun.sleep(0);
  stored[2]!({ event: { id: "u3", seq: 20 } });
  const four = prompt(4, "fourth");
  await Bun.sleep(0);
  event(22, "user", { text: "fourth", origin: "steer", queue_id: "q2" }); // stored before the daemon's answer arrives
  event(24, "error", { message: "fixture provider unavailable" });
  event(25, "turn_end", { reason: "error" });
  await three;
  expect(answers(3)).toEqual(["fixture provider unavailable"]);
  expect(answers(4)).toEqual([]);
  stored[3]!({ queued: { id: "q2" }, steer: true });
  await four;
  expect(answers(4)).toEqual(["fixture provider unavailable"]);
});

test("a queued prompt the editor cancels or the workbench removes ends as cancelled", async () => {
  const f = fixture([{ id: "s", workspace: "/w", model: "p:alpha", head: null, updated: 1 }], {});
  let queued = 0;
  f.d.post = (method, path) => {
    if (path.endsWith("/messages")) return { queued: { id: `q${++queued}` }, steer: true }; // a turn of the workbench is running
    if (method === "PATCH") throw Object.assign(new Error("no such queued prompt (it may have been sent)"), { code: -32002 });
  };
  const prompt = (id: number) => f.bridge.handle({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "go" }] } });
  const answers = (id: number) => f.out.filter((m) => m.id === id).map((m) => m.result?.stopReason ?? m.error?.message);
  const one = prompt(1);
  await Bun.sleep(0);
  f.frame({ t: "event", event: { session_id: "s", kind: "turn_end", data: { reason: "end_turn" } } }); // the workbench's turn, not ours
  await Bun.sleep(0);
  expect(answers(1)).toEqual([]);
  await f.bridge.handle({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s" } });
  await one;
  expect(answers(1)).toEqual(["cancelled"]);
  expect(f.calls.filter((c) => !c.startsWith("GET ")).slice(-2)).toEqual(["DELETE /api/sessions/s/queue/q1", "POST /api/sessions/s/interrupt"]);
  const two = prompt(2);
  await Bun.sleep(0);
  f.frame({ t: "queue", session_id: "s", queue: [{ id: "q2" }], held: false });
  await Bun.sleep(0);
  expect(answers(2)).toEqual([]);
  f.frame({ t: "queue", session_id: "s", queue: [], held: false }); // removed in the workbench
  await two;
  expect(answers(2)).toEqual(["cancelled"]);
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

test("a session whose model is no longer listed keeps it, marked, until the owner picks a listed one", async () => {
  const s = { id: "s", workspace: "/w", model: "p:gone", head: null, updated: 1 };
  const f = fixture([s], {});
  f.d.post = (method) => { if (method === "PATCH") s.model = "p:alpha"; };
  const values = (m: any) => m.options.flatMap((g: any) => g.options.map((o: any) => o.value));
  for (const method of ["session/load", "session/resume"]) {
    const m = (await call(f.bridge, f.out, method, { sessionId: "s" })).result.configOptions.find((o: any) => o.id === "model");
    expect(m.currentValue).toBe("p:gone");
    expect(values(m)).toEqual(["p:gone", "p:alpha"]);
    expect(m.options[0]).toEqual({ group: "unavailable", name: "Not available", options: [{ value: "p:gone", name: "p:gone (not available)", description: "No provider lists this model now. Pick a listed model to go on." }] });
  }
  expect(f.calls.some((c) => c.startsWith("PATCH"))).toBe(false); // nothing switched by itself
  const picked = (await call(f.bridge, f.out, "session/set_config_option", { sessionId: "s", configId: "model", value: "p:alpha" })).result.configOptions.find((o: any) => o.id === "model");
  expect(f.calls).toContain("PATCH /api/sessions/s");
  expect(picked.currentValue).toBe("p:alpha");
  expect(values(picked)).toEqual(["p:alpha"]);
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

test("the editor's MCP servers go to the daemon with the session, the whole list each time, and one it cannot take is said by name", async () => {
  const s = { id: "s", workspace: "/w", model: "p:alpha", head: null, updated: 1 };
  const f = fixture([s], {});
  f.d.post = (_method, path) => (path === "/api/sessions" ? { session: s } : path.endsWith("/mcp") ? { set: [{ name: "fs", label: "fs" }, { name: "old", error: "not spoken" }] } : undefined);
  const init = await call(f.bridge, f.out, "initialize", {});
  expect(init.result.agentCapabilities.mcpCapabilities).toEqual({ http: true, sse: false });
  await call(f.bridge, f.out, "session/new", { cwd: "/w", mcpServers: [
    { name: "fs", command: "srv", args: ["-x"], env: [{ name: "A", value: "1" }] },
    { type: "http", name: "api", url: "https://example.test/mcp", headers: [{ name: "Authorization", value: "Bearer t" }] },
    { type: "sse", name: "old", url: "https://example.test/sse", headers: [] },
  ] });
  const puts = () => f.d.sent.filter((x) => x.method === "PUT" && x.path === "/api/sessions/s/mcp").map((x) => x.body.servers);
  expect(puts()).toEqual([[
    { name: "fs", command: "srv", args: ["-x"], env: { A: "1" } },
    { name: "api", url: "https://example.test/mcp", headers: { Authorization: "Bearer t" } },
    { name: "old", url: "https://example.test/sse", headers: {}, transport: "sse" },
  ]]);
  await Bun.sleep(0);
  expect(JSON.stringify(f.updates("s"))).toContain("old: not spoken");
  // One that fails to connect later is said too, for a session this editor passed servers to and no other.
  f.frame({ t: "feature", name: "mcp-session", session_id: "s", data: { name: "fs", what: "failed", error: "the server exited (code 1)" } });
  f.frame({ t: "feature", name: "mcp-session", session_id: "s", data: { name: "fs", what: "started" } });
  f.frame({ t: "feature", name: "mcp-session", session_id: "another", data: { name: "x", what: "failed", error: "y" } });
  expect(f.updates("s").filter((u: any) => /could not connect/.test(u.content?.text ?? "")).map((u: any) => u.content.text)).toEqual(["Keel could not connect the MCP server fs the editor passed: the server exited (code 1).\n\n"]);
  // A session opened again brings its list again (none: the earlier ones go); a new one with none asks nothing.
  await call(f.bridge, f.out, "session/resume", { sessionId: "s", cwd: "/w", mcpServers: [] });
  expect(puts().at(-1)).toEqual([]);
  const before = puts().length;
  await call(f.bridge, f.out, "session/new", { cwd: "/w", mcpServers: [] });
  expect(puts().length).toBe(before);
});

test("the editor's servers are held by a socket of its own, and at its end the daemon is told before any socket closes", async () => {
  const log: string[] = [];
  const s = { id: "s", workspace: "/w", model: "p:alpha", head: null, updated: 1 };
  const d = {
    get: async (path: string) => (path === "/api/models" ? { models: [{ id: "p:alpha", name: "Alpha", provider: "p" }], default: "p:alpha" } : path.endsWith("/permissions") ? { perm: { mode: "ask" } } : { session: s, events: [], running: false }),
    send: async (method: string, path: string, body?: any) => {
      if (path.endsWith("/mcp")) { await Bun.sleep(5); log.push(`${method} mcp ${body.servers.length} ${body.holder === held ? "held" : "not held"}`); return { set: [] }; }
      return path === "/api/sessions" ? { session: s } : {};
    },
    frames: async () => { log.push("frames open"); return () => void log.push("frames closed"); },
    hold: async (holder: string) => { held = holder; log.push("hold open"); return () => void log.push("hold closed"); },
  };
  let held = "";
  const out: any[] = [];
  const bridge = new AcpBridge(d, (m) => out.push(m));
  // A session with no servers opens no hold; the first list does, once, before it is sent.
  await call(bridge, out, "session/new", { cwd: "/w", mcpServers: [] });
  expect(log).toEqual(["frames open"]);
  const one = [{ name: "fs", command: "srv", args: [], env: [] }];
  await call(bridge, out, "session/new", { cwd: "/w", mcpServers: one });
  await call(bridge, out, "session/load", { sessionId: "s", cwd: "/w", mcpServers: one });
  expect(log.slice(1)).toEqual(["hold open", "PUT mcp 1 held", "PUT mcp 1 held"]);
  expect(held).toMatch(/^acp-[0-9a-f-]{36}$/);
  await bridge.close();
  // The empty list names no holder: it holds nothing.
  expect(log.slice(4)).toEqual(["PUT mcp 0 not held", "hold closed", "frames closed"]);
});
