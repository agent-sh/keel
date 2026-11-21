// Pure logic the e2e cannot see: the wire bytes of a branch, and the tree.
import { expect, test } from "bun:test";
import { leafOf, lineage, versions } from "../core/tree.ts";
import type { Message, StoredEvent } from "../core/types.ts";
import { RESTART_CUT, stalledContinuations, toMessages } from "./turn.ts";
import { keptMessages } from "./compact.ts";

let seq = 0;
const ev = (id: string, parent: string | null, kind: StoredEvent["kind"], data: any): StoredEvent => ({ id, session_id: "s", seq: ++seq, parent, kind, data, ts: 0 });

const events = [
  ev("u1", null, "user", { text: "first" }),
  ev("a1", "u1", "assistant", { blocks: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], stop: "tool_use" }),
  ev("r1", "a1", "tool_result", { results: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] }),
  ev("s1", "r1", "user", { text: "steer", origin: "steer" }),
  ev("a2", "s1", "assistant", { blocks: [{ type: "text", text: "no" }], stop: "refusal" }),
  ev("u2", "u1", "user", { text: "first, edited" }), // a sibling version of u1's follow-up branch point
  ev("u1b", null, "user", { text: "first v2" }),
  ev("c1", "s1", "compaction", { mode: "summary", summary: "did ls", owner_messages: ["first", "steer"] }),
  ev("u3", "c1", "user", { text: "next" }),
];

test("toMessages is a pure function of the branch", () => {
  const line = lineage(events, "s1");
  const a = JSON.stringify(toMessages(line));
  const b = JSON.stringify(toMessages(structuredClone(line)));
  expect(a).toBe(b);
  // the steer lands after the tool results in the same user message
  const m = toMessages(line);
  expect(m.at(-1)!.content.map((c: any) => c.type)).toEqual(["tool_result", "text"]);
});

test("tool replay keeps paired results and omits late, unrelated and duplicate results", () => {
  const call = (id: string) => ({ type: "tool_use" as const, id, name: "Read", input: { id } });
  const result = (tool_use_id: string, content: string) => ({ type: "tool_result" as const, tool_use_id, content });
  const text = (text: string) => ({ type: "text" as const, text });
  const record = (id: string, parent: string, ...results: ReturnType<typeof result>[]) => ev(id, parent, "tool_result", { results });
  const one = result("one", "first output"), two = result("two", "second output");
  const received = result("received", "completed in the same batch");
  const current = result("current", "keep the first reply");
  const late = result("waiting", "the resumed call's late output");
  const unrelated = result("unknown", "no call in this context");
  const image = { type: "image" as const, media_type: "image/png", data: "AAAA" };
  const prefix = [
    ev("p1", null, "user", { text: "start" }),
    ev("p2", "p1", "assistant", { blocks: [call("one"), call("two")] }),
    record("p3", "p2", two), record("p4", "p3", one),
    ev("p5", "p4", "user", { text: "steer", images: [image] }),
  ];
  const prefixMessages: Message[] = [
    { role: "user", content: [text("start")] },
    { role: "assistant", content: [call("one"), call("two")] },
    { role: "user", content: [one, two, image, text("steer")] },
  ];
  const line = [...prefix,
    ev("p6", "p5", "assistant", { blocks: [call("received"), call("waiting")] }),
    record("p7", "p6", received),
    ev("p8", "p7", "assistant", { blocks: [call("current")] }),
    record("p9", "p8", current, late, unrelated, result("current", "discard this duplicate")),
    ev("p10", "p9", "assistant", { blocks: [text("before")] }),
    record("p11", "p10", unrelated),
    ev("p12", "p11", "assistant", { blocks: [text("after")] }),
  ];
  const stored = JSON.stringify(line);
  expect(JSON.stringify(toMessages(prefix))).toBe(JSON.stringify(prefixMessages));
  expect(JSON.stringify(toMessages(line))).toBe(JSON.stringify([...prefixMessages,
    { role: "assistant", content: [call("received"), call("waiting")] },
    { role: "user", content: [{ ...result("waiting", "Interrupted by the user before this tool ran."), is_error: true }, received] },
    { role: "assistant", content: [call("current")] },
    { role: "user", content: [current] },
    { role: "assistant", content: [text("before"), text("after")] },
  ]));
  const clear = ev("clear", "p6", "compaction", { mode: "clear" });
  const next = ev("next", "orphan", "user", { text: "next" });
  expect(toMessages([...line.slice(0, 6), clear, record("orphan", "clear", late), next])).toEqual([
    { role: "user", content: [text("next")] },
  ]);
  expect(JSON.stringify(line)).toBe(stored);
});

test("a declined reply is not replayed; a summary replaces what came before", () => {
  expect(toMessages(lineage(events, "a2")).at(-1)!.role).toBe("user");
  const after = toMessages(lineage(events, "u3"));
  expect(after.length).toBe(1);
  expect((after[0]!.content[0] as any).text).toContain("did ls");
  expect((after[0]!.content.at(-1) as any).text).toBe("next");
});

test("branches: versions share a parent, leafOf finds the newest end", () => {
  expect(versions(events, events[0]!).map((e) => e.id)).toEqual(["u1", "u1b"]);
  expect(leafOf(events, "u1")).toBe("u3");
  expect(lineage(events, "u1b").map((e) => e.id)).toEqual(["u1b"]);
});

test("the owner's images and files stay with their message through a compaction", () => {
  const img = { type: "image" as const, media_type: "image/png", data: "AAAA" };
  const file = { type: "attachment" as const, id: "f".repeat(64), name: "a.pdf", media_type: "application/pdf", size: 10 };
  const line = [
    ev("m1", null, "user", { text: "look at A", images: [img] }),
    ev("m2", "m1", "assistant", { blocks: [{ type: "text", text: "red" }], stop: "end_turn" }),
    ev("m3", "m2", "user", { text: "and this file", images: [file] }),
  ];
  const media = keptMessages(line).owner_media!;
  expect(media).toEqual([[img], [file]]);
  const cp = ev("m4", "m3", "compaction", { mode: "summary", summary: "s", owner_messages: keptMessages(line).owner_messages, owner_media: media });
  const m = toMessages([...line, cp]);
  expect(m[0]!.content.map((b: any) => b.type)).toEqual(["text", "image", "text", "attachment", "text"]);
  // A later compaction keeps them again, from the first one's record.
  expect(keptMessages([...line, cp]).owner_media).toEqual([[img], [file]]);
});

// One instruction source read through two paths (a linked AGENTS.md, a file
// two folders import) is in the prompt once; a file that cannot be read says so.
test("instruction files: each source once, an unreadable one named", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { instructionFiles, instructionPaths } = await import("./turn.ts");
  const root = mkdtempSync(join(process.env.TMPDIR ?? `${process.env.HOME}/.cache/tmp`, "inst-"));
  try {
    writeFileSync(join(root, "shared.md"), "SHARED-RULE\n");
    mkdirSync(join(root, "a/b/c"), { recursive: true });
    writeFileSync(join(root, "a/AGENTS.md"), "OUTER\n@../shared.md\n");
    writeFileSync(join(root, "a/b/AGENTS.md"), "INNER\n@../../shared.md\n");
    symlinkSync("../AGENTS.md", join(root, "a/b/c/AGENTS.md"));
    const text = instructionFiles(join(root, "a/b/c"));
    expect(text.match(/SHARED-RULE/g)?.length).toBe(1);
    expect(text.match(/INNER/g)?.length).toBe(1);
    expect(instructionPaths(join(root, "a/b/c")).filter((p) => p.path.startsWith(root)).length).toBe(2);
    chmodSync(join(root, "a/AGENTS.md"), 0);
    expect(instructionFiles(join(root, "a/b"))).toContain(`# ${join(root, "a/AGENTS.md")}\n\n(This file could not be read`);
  } finally {
    chmodSync(join(root, "a/AGENTS.md"), 0o644);
    rmSync(join(root, ""), { recursive: true, force: true });
  }
});

// A call the restart cut gets what its approval card recorded: the owner's
// denial and reason, "did not run" for a card nothing answered, and "may have
// partly run" only for an allowed call or one with no card. Also state from
// before results were stored per call: a denial whose result was never stored.
test("a restart cut: questions expire, approval outcomes are kept, only a call that may have run warns", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Gate } = await import("../safety/gate.ts");
  const { registerHooks } = await import("./hooks.ts");
  const { Engine, QUESTION_CUT, RESTART_CUT } = await import("./turn.ts");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "recover-"));
  const store = new Store(dir);
  const bus = new Bus();
  const s = store.createSession({ model: "x:y", workspace: dir });
  store.append(s.id, "user", { text: "go" });
  store.append(s.id, "turn_start", {});
  const bash = (id: string) => ({ type: "tool_use", id, name: "Bash", input: { command: `touch ${id}` } });
  store.append(s.id, "assistant", { blocks: [
    { type: "tool_use", id: "q1", name: "AskUserQuestion", input: {} },
    { type: "tool_use", id: "q2", name: "request_user_input", input: {} },
    { type: "tool_use", id: "q3", name: "ask_user", input: {} },
    bash("w1"), bash("d1"), bash("d2"), bash("d3"), bash("p1"), bash("a1"),
  ], stop: "tool_use" });
  // The cards the last daemon left: an owner denial with a reason and one
  // without, a denial by a rule, an open card, an allowed one.
  new Gate(store, bus);
  const card = (call: string, state: string, extra: object = {}) =>
    store.db.query("INSERT INTO approvals (id, session_id, state, data, created) VALUES (?, ?, ?, ?, ?)")
      .run(`c-${call}`, s.id, state, JSON.stringify({ id: `c-${call}`, session_id: s.id, call_id: call, tool: "Bash", kind: "shell", summary: `touch ${call}`, input: {}, risk: "low", suggest: [], state, created: 1, ...extra }), 1);
  card("d1", "denied", { choice: "deny", reason: "leave d1 alone" });
  card("d2", "denied", { choice: "deny" });
  card("d3", "denied", { reason: "Refused by the rule: no touching here." });
  card("p1", "pending");
  card("a1", "allowed", { choice: "once" });
  const gate = new Gate(store, bus); // the new daemon: the open card waits for its call to come back
  registerHooks({ callOutcome: (sid, call) => gate.callOutcome(sid, call) });
  const engine = new Engine(store, bus, {} as any, { capture: (_s: string, e: unknown) => ({ message: String(e) }) } as any, join(dir, "spill"));
  const none = async () => { throw new Error("no model here"); };
  await engine.recover([s.id], none);
  await engine.recover([s.id], none); // a second boot adds nothing
  const cut = store.events(s.id).filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results);
  // The call with an open card has no result: the continued turn asks on that card again.
  expect(cut).toHaveLength(8);
  expect(gate.callOutcome(s.id, "p1")).toBe("waiting");
  expect(Object.fromEntries(cut.map((r: any) => [r.tool_use_id, r.content]))).toEqual({
    q1: QUESTION_CUT, q2: QUESTION_CUT, q3: QUESTION_CUT, w1: RESTART_CUT, a1: RESTART_CUT,
    d1: "The owner denied this call: leave d1 alone",
    d2: "The owner denied this call. Do not retry it; take another way or ask.",
    d3: "Refused by the rule: no touching here.",
  });
  expect(gate.rules()).toEqual([]);
});

// Idle compaction: a context past its idle minimum whose cache is about to
// expire gets a summary while still warm; a turn that starts after the cache
// expired goes on that summary, the owner's new words after it.
test("idle compaction prepares while warm and applies when the cache went cold", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Engine } = await import("./turn.ts");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "idle-"));
  const store = new Store(dir);
  const s = store.createSession({ model: "p:m", workspace: dir });
  store.updateSession(s.id, { settings: { compact_at: 2_000 } });
  store.append(s.id, "user", { text: "read the big file" });
  store.append(s.id, "assistant", { blocks: [{ type: "text", text: "x".repeat(8_000) }], model: "p:m", stop: "end_turn", usage: { input: 10, output: 2_000, cache_read: 0, cache_write: 9_000, cache_write_1h: 9_000 } });
  const twoHours = Date.now() - 2 * 60 * 60_000;
  store.db.run("UPDATE events SET ts = ? WHERE session_id = ?", [twoHours, s.id]);
  const asked: any[] = [];
  let answered!: () => void;
  const summarized = new Promise<void>((r) => (answered = r));
  const info = { id: "p:m", provider: "p", model: "m", name: "M", family: "other", context: 100_000, output: 1_000, efforts: [], billing: "per_token" };
  const provider = {
    id: "p", wire: "anthropic_messages", available: () => true, list: async () => [],
    stream: async (req: any) => {
      asked.push(req);
      if (req.purpose === "summary") setTimeout(answered, 0);
      return { blocks: [{ type: "text", text: req.purpose === "summary" ? "SUMMARY-OF-IT" : "ok" }], usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 }, stop: "end_turn", model: "m" };
    },
  };
  const providers = { resolve: async () => ({ provider, info }), models: async () => [info], current: () => [info] };
  const engine = new Engine(store, new Bus(), providers as any, { capture: (_s: string, e: unknown) => ({ message: String(e) }) } as any, join(dir, "spill"));
  await engine.resumeIdle(); // the cache lifetime ended long ago: the timer is due at once
  await summarized;
  await Bun.sleep(10);
  const row = store.db.query<{ data: string }, []>("SELECT data FROM prepared_summaries").get();
  expect(JSON.parse(row!.data).trigger).toBe("idle");
  // The owner comes back after the summary call's own cache expired too.
  store.db.run("UPDATE prepared_summaries SET data = json_set(data, '$.prepared_ms', ?)", [twoHours]);
  engine.send(s.id, "and now?");
  await engine.idle(s.id);
  const turn = asked.findLast((r) => r.purpose === "turn");
  expect(JSON.stringify(turn.messages[0])).toContain("SUMMARY-OF-IT");
  expect(JSON.stringify(turn.messages)).not.toContain("x".repeat(8_000));
  expect(JSON.stringify(turn.messages.at(-1))).toContain("and now?");
  expect(store.events(s.id).find((e) => e.kind === "compaction")?.data.trigger).toBe("idle");
});

// A threshold compaction is asked only when there is something new to
// summarize, and a summary request answered without one (a tool call instead)
// leaves the turn to go on whole while the context still fits the window.
test("threshold compaction: nothing new is not summarized, an empty summary does not fail the turn", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Engine } = await import("./turn.ts");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "thresh-"));
  const store = new Store(dir);
  const asked: string[] = [];
  const info = { id: "p:m", provider: "p", model: "m", name: "M", family: "other", context: 100_000, output: 1_000, efforts: [], billing: "per_token" };
  const usage = { input: 1, output: 1, cache_read: 0, cache_write: 0 };
  const provider = {
    id: "p", wire: "anthropic_messages", available: () => true, list: async () => [],
    stream: async (req: any) => {
      asked.push(req.purpose);
      if (req.purpose === "summary") return { blocks: [{ type: "tool_use", id: "t", name: "Read", input: {} }], usage, stop: "tool_use", model: "m" };
      return { blocks: [{ type: "text", text: "ok" }], usage, stop: "end_turn", model: "m" };
    },
  };
  const providers = { resolve: async () => ({ provider, info }), models: async () => [info], current: () => [info] };
  const engine = new Engine(store, new Bus(), providers as any, { capture: (_s: string, e: unknown) => ({ message: String((e as Error).message) }) } as any, join(dir, "spill"));
  const big = { blocks: [{ type: "text", text: "x".repeat(20_000) }], model: "p:m", stop: "end_turn", usage: { ...usage, input: 6_000 } };
  const session = (after: (id: string) => void) => {
    const s = store.createSession({ model: "p:m", workspace: dir });
    store.updateSession(s.id, { settings: { compact_at: 2_000 } });
    store.append(s.id, "user", { text: "go" });
    store.append(s.id, "assistant", big);
    after(s.id);
    return s.id;
  };
  // Already summarized, then cut by a restart: only harness words and marks since.
  const a = session((id) => {
    store.append(id, "compaction", { mode: "summary", summary: "y".repeat(20_000), auto: true });
    store.append(id, "turn_start", {});
    store.append(id, "note", { text: "memory" });
    store.append(id, "turn_end", { reason: "restart" });
  });
  engine.send(a, "[harness] continue", { meta: { origin: "restart" } });
  await engine.idle(a);
  expect(asked).toEqual(["turn"]);
  // History to summarize, but the summary request calls a tool.
  asked.length = 0;
  const b = session(() => {});
  engine.send(b, "next");
  await engine.idle(b);
  expect(asked).toEqual(["summary", "turn"]);
  const line = store.events(b);
  expect(line.find((e) => e.kind === "note" && e.data.kind === "compaction_failed")?.data.text).toContain("no summary");
  expect(line.findLast((e) => e.kind === "turn_end")?.data.reason).toBe("end_turn");
});

// Input that is not the owner's, sent while a turn runs, keeps who sent it
// through the queue: a steer and a queued prompt are not the owner's words.
test("a steer or queued prompt from momentum or a hook keeps its origin", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Engine } = await import("./turn.ts");
  const { ownerPrompt } = await import("../core/owner.ts");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "queue-meta-"));
  const store = new Store(dir);
  const s = store.createSession({ model: "p:m", workspace: dir });
  const info = { id: "p:m", provider: "p", model: "m", name: "M", family: "other", context: 100_000, output: 1_000, efforts: [], billing: "per_token" };
  const usage = { input: 1, output: 1, cache_read: 0, cache_write: 0 };
  let calls = 0;
  let engine: any;
  const provider = {
    id: "p", wire: "anthropic_messages", available: () => true, list: async () => [],
    stream: async () => {
      if (++calls === 1) {
        engine.send(s.id, "from momentum", { mode: "steer", meta: { origin: "momentum" } });
        engine.send(s.id, "from a hook", { mode: "queue", meta: { origin: "hook" } });
        return { blocks: [{ type: "tool_use", id: "t1", name: "nope", input: {} }], usage, stop: "tool_use", model: "m" };
      }
      return { blocks: [{ type: "text", text: "ok" }], usage, stop: "end_turn", model: "m" };
    },
  };
  const providers = { resolve: async () => ({ provider, info }), models: async () => [info], current: () => [info] };
  engine = new Engine(store, new Bus(), providers as any, { capture: (_s: string, e: unknown) => ({ message: String(e) }) } as any, join(dir, "spill"));
  engine.send(s.id, "start");
  await engine.idle(s.id);
  await engine.idle(s.id);
  const prompts = store.events(s.id).filter((e) => e.kind === "user").map((e) => [e.data.text, e.data.origin, ownerPrompt(e.data)]);
  expect(prompts).toEqual([["start", undefined, true], ["from momentum", "momentum", false], ["from a hook", "hook", false]]);
});

// A finished tool call takes its abort listener off the turn's shared signal,
// whether it succeeded, failed or a gate refused it.
test("a settled tool call leaves no abort listener on the turn's signal", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Engine } = await import("./turn.ts");
  const { registerHooks } = await import("./hooks.ts");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "listeners-"));
  const store = new Store(dir);
  const s = store.createSession({ model: "x:y", workspace: dir });
  const engine = new Engine(store, new Bus(), {} as any, { capture: (_s: string, e: unknown) => ({ message: String(e) }) } as any, join(dir, "spill"));
  registerHooks({ beforeTool: (_s, c) => (c.tool.name === "refused" ? { deny: "no" } : undefined) });
  const tool = (name: string, run: () => Promise<any>) => ({ name, description: "", input_schema: { type: "object" }, readOnly: true, run }) as any;
  const tools = [tool("ok", async () => ({ content: "fine" })), tool("boom", async () => { throw new Error("broke"); }), tool("refused", async () => ({ content: "never" }))];
  const stop = new AbortController();
  let live = 0;
  const add = stop.signal.addEventListener.bind(stop.signal), remove = stop.signal.removeEventListener.bind(stop.signal);
  stop.signal.addEventListener = ((t: string, f: any, o?: any) => (t === "abort" && live++, add(t, f, o))) as any;
  stop.signal.removeEventListener = ((t: string, f: any, o?: any) => (t === "abort" && live--, remove(t, f, o))) as any;
  const ctx = { sessionId: s.id, cwd: dir, signal: stop.signal, spillDir: dir, seen: new Map() };
  for (const name of ["ok", "boom", "refused"]) {
    await (engine as any).runTool(s, tools, { type: "tool_use", id: name, name, input: {} }, ctx);
    expect(live).toBe(0);
  }
});

test("an Auto approval is checked again after hooks and with the executed input", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Gate } = await import("../safety/gate.ts");
  const { Engine } = await import("./turn.ts");
  const { registerHooks } = await import("./hooks.ts");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "auto-dispatch-"));
  const store = new Store(dir), bus = new Bus();
  const s = store.createSession({ model: "fixture:m", workspace: dir });
  const engine = new Engine(store, bus, {} as any, { capture: (_s: string, e: unknown) => ({ message: String(e) }) } as any, dir);
  const gate = new Gate(store, bus);
  let judgments = 0, runs = 0;
  gate.judge = async () => (judgments++, { allow: true, risk: "low", reason: "fixture", model: "m" });
  registerHooks({ beforeTool: (session, c) => session.id === s.id ? gate.beforeTool(s, c) : undefined });
  registerHooks({
    async beforeTool(session, c) {
      if (session.id !== s.id || c.id !== "policy") return;
      await Promise.resolve();
      gate.setPerm(s.id, { mode: "read-only" });
    },
    execInput: (session, c) => session.id === s.id && c.id === "input" ? { note: "changed" } : undefined,
  });
  const tool = { name: "fixture_note", description: "", input_schema: { type: "object" }, readOnly: false,
    run: async () => (runs++, { content: "ran" }) };
  const ctx = { sessionId: s.id, cwd: dir, signal: new AbortController().signal, spillDir: dir, seen: new Map() };
  for (const id of ["policy", "input", "unchanged"]) {
    gate.setPerm(s.id, { mode: "auto" });
    const r = await (engine as any).runTool(s, [tool], { type: "tool_use", id, name: tool.name, input: { note: "original" } }, ctx);
    if (id === "unchanged") expect(r.content).toBe("ran");
    else expect(r.content).toContain("changed while permission was pending");
  }
  expect(judgments).toBe(3);
  expect(runs).toBe(1);
});

test("continuations cut in a row count only while none finished a step", () => {
  let n = 0;
  const e = (kind: string, data: any = {}) => ({ id: `e${++n}`, kind, data }) as unknown as StoredEvent;
  const cutTurn = (origin?: string, result = RESTART_CUT) => [
    e("user", { text: "go", origin }), e("turn_start"),
    e("assistant", { blocks: [{ type: "tool_use", id: `t${n}`, name: "Bash", input: {} }] }),
    e("tool_result", { results: [{ type: "tool_result", tool_use_id: `t${n}`, content: result, is_error: true }] }),
    e("turn_end", { reason: "restart" }),
  ];
  expect(stalledContinuations(cutTurn())).toBe(0); // the first cut: no continuation yet
  expect(stalledContinuations([...cutTurn(), ...cutTurn("restart"), ...cutTurn("restart")])).toBe(2);
  // A continuation that got a tool result ends the run, though it was cut too.
  const worked = [e("user", { origin: "restart" }), e("turn_start"), e("tool_result", { results: [{ content: "ok" }] }), ...cutTurn().slice(2)];
  expect(stalledContinuations([...cutTurn(), ...cutTurn("restart"), ...worked, ...cutTurn("restart")])).toBe(1);
  expect(stalledContinuations([...cutTurn("restart"), e("user", { text: "more" }), e("turn_start"), e("turn_end", { reason: "end_turn" })])).toBe(0);
});
