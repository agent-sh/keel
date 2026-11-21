// Pure logic the e2e cannot see: the wire bytes of a branch, and the tree.
import { expect, test } from "bun:test";
import { leafOf, lineage, versions } from "../core/tree.ts";
import type { Message, StoredEvent } from "../core/types.ts";
import { RESTART_CUT, stalledContinuations, toMessages, withPending } from "./turn.ts";
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

// The engine reads the branch a session shows many times a step. The store
// keeps that branch: a warm read copies nothing and touches no other branch,
// and what it gives is, event for event and byte for byte in the projected
// messages, what a walk of the whole tree gives, through every way a branch
// changes.
test("the kept branch projects the same bytes as a walk of the tree, and a warm read rebuilds nothing", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { spyOn } = await import("bun:test");
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Engine } = await import("./turn.ts");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "lineage-"));
  const store = new Store(dir);
  const engine = new Engine(store, new Bus(), {} as any, { capture: (_s: string, e: unknown) => ({ message: String(e) }) } as any, join(dir, "spill"));
  try {
    const id = store.createSession({ model: "x:y", workspace: dir }).id;
    // One long branch, and at every tenth prompt a sibling branch of its own (an edited prompt and its reply).
    const sides: string[] = [];
    for (let n = 0; n < 120; n++) {
      const before = store.session(id)!.head;
      const u = store.append(id, "user", { text: `prompt ${n}` });
      store.append(id, "assistant", { blocks: [{ type: "text", text: `reply ${n}` }, { type: "tool_use", id: `t${n}`, name: "Bash", input: { command: `echo ${n}` } }], stop: "tool_use" });
      store.append(id, "tool_result", { results: [{ type: "tool_result", tool_use_id: `t${n}`, content: `out ${n}` }] });
      if (n % 10 === 0) {
        const main = store.session(id)!.head!;
        const edited = store.append(id, "user", { text: `prompt ${n}, edited` }, before);
        sides.push(store.append(id, "assistant", { blocks: [{ type: "text", text: `side reply ${n}` }], stop: "end_turn" }, edited.id).id);
        store.updateSession(id, { head: main });
        expect(u.parent).toBe(before);
      }
    }
    const walked = () => lineage(store.events(id), store.session(id)!.head);
    const same = () => {
      const kept = engine.lineage(id), tree = walked();
      expect(kept.map((e) => e.id)).toEqual(tree.map((e) => e.id));
      expect(JSON.stringify(toMessages(kept))).toBe(JSON.stringify(toMessages(tree)));
      return kept;
    };
    const warm = same();
    expect(warm).toHaveLength(360);
    // Warm: the same array, and the session's events (all branches) are not read at all.
    const all = spyOn(store, "events");
    for (let n = 0; n < 50; n++) expect(engine.lineage(id)).toBe(warm);
    toMessages(engine.lineage(id));
    // An append at the head: the branch grows by that event, the events before it are the same objects.
    const added = store.append(id, "user", { text: "one more" });
    const grown = engine.lineage(id);
    expect(grown).toHaveLength(361);
    expect(grown.at(-1)!.id).toBe(added.id);
    expect(grown.every((e, i) => i === 360 || e === warm[i])).toBe(true);
    expect(warm).toHaveLength(360); // a reader that held the branch as it was still has it
    // Another branch is shown, and the first one again: walked by position, no copy of the session.
    store.updateSession(id, { head: sides[3]! });
    expect(engine.lineage(id).at(-1)!.id).toBe(sides[3]!);
    store.updateSession(id, { head: added.id });
    expect(engine.lineage(id).map((e) => e.id)).toEqual(grown.map((e) => e.id));
    expect(all).toHaveBeenCalledTimes(0);
    all.mockRestore();
    same();
    // A sibling branch, an edited prompt, a summary with events kept after it, a clear, its undo.
    for (const head of sides) { store.updateSession(id, { head }); same(); }
    store.updateSession(id, { head: added.id });
    store.append(id, "user", { text: "one more, edited" }, added.parent);
    same();
    store.append(id, "assistant", { blocks: [{ type: "text", text: "after the edit" }], stop: "end_turn" });
    store.append(id, "compaction", { mode: "summary", summary: "what happened", owner_messages: ["prompt 119"], covered: grown[350]!.id });
    same();
    store.append(id, "user", { text: "after the summary" });
    same();
    const cleared = engine.clear(id);
    expect(toMessages(same())).toEqual([]);
    store.append(id, "user", { text: "fresh" });
    same();
    store.updateSession(id, { head: cleared.data.undo_head });
    expect(JSON.stringify(toMessages(same()))).toContain("after the summary");
    // A write that is undone leaves the kept branch as the table has it.
    expect(() => store.atomic(id, () => { store.append(id, "user", { text: "never stored" }); throw new Error("undone"); })).toThrow("undone");
    expect(JSON.stringify(toMessages(same()))).not.toContain("never stored");
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
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
  store.updateSession(s.id, { phase: "working" }); // the turn was running when the daemon went down
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
  // The last cached reply was 55 minutes ago: the hour is nearly over, the summary is due.
  store.db.run("UPDATE events SET ts = ? WHERE session_id = ?", [Date.now() - 55 * 60_000, s.id]);
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
  await engine.resumeIdle(); // six minutes before the cache lifetime ends have passed: the timer is due at once
  await summarized;
  await Bun.sleep(10);
  const row = store.db.query<{ data: string }, []>("SELECT data FROM prepared_summaries").get();
  expect(JSON.parse(row!.data).trigger).toBe("idle");
  // The owner comes back two hours later: the cache has expired.
  const { setSystemTime } = await import("bun:test");
  setSystemTime(new Date(Date.now() + 2 * 60 * 60_000));
  try {
    engine.send(s.id, "and now?");
    await engine.idle(s.id);
    const turn = asked.findLast((r) => r.purpose === "turn");
    expect(JSON.stringify(turn.messages[0])).toContain("SUMMARY-OF-IT");
    expect(JSON.stringify(turn.messages)).not.toContain("x".repeat(8_000));
    expect(JSON.stringify(turn.messages.at(-1))).toContain("and now?");
    expect(store.events(s.id).find((e) => e.kind === "compaction")?.data.trigger).toBe("idle");
    // A context whose cache expired long ago is not summarized while idle: that request would read all of it at the full price.
    const old = store.createSession({ model: "p:m", workspace: dir });
    store.updateSession(old.id, { settings: { compact_at: 2_000 } });
    store.append(old.id, "user", { text: "read the big file" });
    store.append(old.id, "assistant", { blocks: [{ type: "text", text: "x".repeat(8_000) }], model: "p:m", stop: "end_turn", usage: { input: 10, output: 2_000, cache_read: 0, cache_write: 9_000, cache_write_1h: 9_000 } });
    setSystemTime(new Date(Date.now() + 2 * 60 * 60_000));
    const summaries = asked.filter((r) => r.purpose === "summary").length;
    (engine as any).scheduleIdle(old.id, await (engine as any).step(store.session(old.id), "p:m"));
    await Bun.sleep(20);
    expect(asked.filter((r) => r.purpose === "summary")).toHaveLength(summaries);
    expect((engine as any).idleTimers.has(old.id)).toBe(false);
  } finally {
    setSystemTime();
  }
});

// The summary prepared while idle is speculative work with a lifecycle: while
// its request is held, a session that shows another branch, is archived or
// whose daemon drains makes it obsolete, so the request is stopped and no row
// is stored. One whose covered events are still the branch shown is stored
// and applied when the owner returns.
test("an idle preparation made obsolete while it is written is stopped and stores nothing; a valid one is reused", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Engine } = await import("./turn.ts");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "idle-life-"));
  const store = new Store(dir);
  const bus = new Bus();
  const { setSystemTime } = await import("bun:test");
  const info = { id: "p:m", provider: "p", model: "m", name: "M", family: "other", context: 100_000, output: 1_000, efforts: [], billing: "per_token" };
  // Each summary request waits until the test lets it go, and honors its stop.
  const held: { session: string; signal: AbortSignal; go: () => void }[] = [];
  let arrived = Promise.withResolvers<void>();
  const provider = {
    id: "p", wire: "anthropic_messages", available: () => true, list: async () => [],
    stream: async (req: any) => {
      if (req.purpose === "summary") {
        const wait = Promise.withResolvers<void>();
        held.push({ session: req.sessionKey, signal: req.signal, go: wait.resolve });
        req.signal.addEventListener("abort", () => wait.resolve(), { once: true });
        arrived.resolve();
        await wait.promise;
        if (req.signal.aborted) throw Object.assign(new Error("stopped"), { name: "AbortError" });
      }
      return { blocks: [{ type: "text", text: req.purpose === "summary" ? "SUMMARY-OF-IT" : "ok" }], usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 }, stop: "end_turn", model: "m" };
    },
  };
  const providers = { resolve: async () => ({ provider, info }), models: async () => [info], current: () => [info] };
  const failures: unknown[] = [];
  const engine = new Engine(store, bus, providers as any, { capture: (_s: string, e: unknown) => (failures.push(e), { message: String(e) }) } as any, join(dir, "spill"));
  // A long idle context whose cache lifetime is nearly over: its idle timer is due at once.
  const idleSession = async () => {
    const s = store.createSession({ model: "p:m", workspace: dir });
    store.updateSession(s.id, { settings: { compact_at: 2_000 } });
    const first = store.append(s.id, "user", { text: "read the big file" });
    store.append(s.id, "assistant", { blocks: [{ type: "text", text: "x".repeat(8_000) }], model: "p:m", stop: "end_turn", usage: { input: 10, output: 2_000, cache_read: 0, cache_write: 9_000, cache_write_1h: 9_000 } });
    store.db.run("UPDATE events SET ts = ? WHERE session_id = ?", [Date.now() - 55 * 60_000, s.id]);
    arrived = Promise.withResolvers<void>();
    (engine as any).scheduleIdle(s.id, await (engine as any).step(store.session(s.id), "p:m"));
    await arrived.promise;
    return { id: s.id, first: first.id, request: held.findLast((h) => h.session === s.id)! };
  };
  const settled = async () => { for (let n = 0; n < 400 && (engine as any).preparing.size; n++) await Bun.sleep(5); };
  const rows = (id: string) => store.db.query<{ covered: string }, [string]>("SELECT covered FROM prepared_summaries WHERE session_id = ?").all(id);

  // Another branch is shown (as the head route does it: the session changes and says so).
  const a = await idleSession();
  bus.emit({ t: "session", session: store.updateSession(a.id, { head: a.first }) });
  expect(a.request.signal.aborted).toBe(true);
  await settled();
  expect(rows(a.id)).toEqual([]);

  // A head moved with nothing said: the work runs to its end and is discarded there.
  const b = await idleSession();
  store.updateSession(b.id, { head: b.first });
  expect(b.request.signal.aborted).toBe(false);
  b.request.go();
  await settled();
  expect(rows(b.id)).toEqual([]);

  // Archived while it is written.
  const c = await idleSession();
  bus.emit({ t: "session", session: store.updateSession(c.id, { archived: true }) });
  expect(c.request.signal.aborted).toBe(true);
  await settled();
  expect(rows(c.id)).toEqual([]);

  // Still the branch shown (a job's notice landed meanwhile): stored, and the
  // turn that comes back after the cache expired goes on it.
  const d = await idleSession();
  store.append(d.id, "note", { text: "a job ended", model: true });
  bus.emit({ t: "session", session: store.session(d.id)! });
  expect(d.request.signal.aborted).toBe(false);
  d.request.go();
  await settled();
  expect(rows(d.id)).toHaveLength(1);
  setSystemTime(new Date(Date.now() + 2 * 60 * 60_000)); // the owner is away for two hours
  try {
    engine.send(d.id, "and now?");
    await engine.idle(d.id);
    expect(store.events(d.id).find((e) => e.kind === "compaction")?.data).toMatchObject({ trigger: "idle", summary: "SUMMARY-OF-IT" });
    expect(rows(d.id)).toEqual([]);

    // The daemon drains: the held work is stopped. A drain that is called off
    // starts the idle preparation it stopped again.
    const e = await idleSession();
    await engine.settle(0);
    expect(e.request.signal.aborted).toBe(true);
    await settled();
    expect(rows(e.id)).toEqual([]);
    arrived = Promise.withResolvers<void>();
    engine.undrain();
    await arrived.promise;
    const again = held.findLast((h) => h.session === e.id)!;
    expect(again).not.toBe(e.request);
    again.go();
    await settled();
    expect(rows(e.id)).toHaveLength(1);
    expect(failures).toEqual([]);
  } finally {
    setSystemTime();
  }
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

test("a queue request cannot start a stopped session with an empty queue", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { allHooks } = await import("./hooks.ts");
  const { Engine } = await import("./turn.ts");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "queue-stop-"));
  const store = new Store(dir);
  const s = store.createSession({ model: "fixture:m", workspace: dir });
  const engine = new Engine(store, new Bus(), {} as any, { capture: (_s: string, e: unknown) => { throw e; } } as any, dir);
  let running = Promise.withResolvers<void>();
  let pause = true;
  allHooks().push({ external: (session) => session.id === s.id ? async ({ signal }) => {
    if (pause) {
      running.resolve();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
    return { reason: "end_turn" };
  } : undefined });
  try {
    for (const resume of ["queue", "owner"] as const) {
      running = Promise.withResolvers<void>();
      pause = true;
      engine.send(s.id, "start");
      await running.promise;
      await engine.interrupt(s.id, "owner");
      pause = false;
      const stopped = store.events(s.id).at(-1)!;
      expect(stopped.data).toMatchObject({ reason: "interrupted", stopped_by: "owner" });
      expect(store.queue(s.id)).toEqual([]);

      const r = engine.send(s.id, "automation notification", { mode: "queue", meta: { kind: "fixture" } });
      expect(engine.isRunning(s.id)).toBe(false);
      expect(engine.isHeld(s.id)).toBe(true);
      expect(store.events(s.id, stopped.seq)).toEqual([]);
      expect(store.queue(s.id)).toMatchObject([{ id: r.queued!.id, steer: false, meta: { kind: "fixture" } }]);

      if (resume === "queue") engine.resumeQueue(s.id);
      else engine.send(s.id, "owner follow-up");
      await engine.idle(s.id);
      await engine.idle(s.id);
      const prompts = store.events(s.id, stopped.seq).filter((e) => e.kind === "user");
      if (resume === "owner") expect(prompts.shift()?.data).toEqual({ text: "owner follow-up" });
      expect(prompts.map((e) => e.data)).toEqual([{ text: "automation notification", kind: "fixture", origin: "queued", queue_id: r.queued!.id }]);
      expect(engine.isHeld(s.id)).toBe(false);
    }
  } finally {
    await engine.interrupt(s.id);
    allHooks().pop();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
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

test("a side question's stand-in is written on a copy, and an earlier call with the same id keeps its result", () => {
  // A server that sends no call ids left one id on the same call in two steps.
  const freeze = <T,>(v: T): T => { if (v && typeof v === "object") { Object.freeze(v); Object.values(v).forEach(freeze); } return v; };
  const call = { type: "tool_use" as const, id: "call_0_same", name: "advisor", input: { q: "same" } };
  const line = freeze([
    ev("q1", null, "user", { text: "ask twice" }),
    ev("q2", "q1", "assistant", { blocks: [call] }),
    ev("q3", "q2", "tool_result", { results: [{ type: "tool_result", tool_use_id: "call_0_same", content: "the first answer" }] }),
    ev("q4", "q3", "assistant", { blocks: [call] }),
  ]);
  const stored = JSON.stringify(line);
  const messages = toMessages(line);
  const out = withPending(messages, { id: "call_0_same", text: "(this advisor call: the request follows)" });
  expect(out.map((m) => m.content.filter((b) => b.type === "tool_result").map((b: any) => [b.content, b.is_error]))).toEqual([[], [], [["the first answer", undefined]], [], [["(this advisor call: the request follows)", false]]]);
  expect(JSON.stringify(out.at(-1))).toBe('{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_0_same","content":"(this advisor call: the request follows)","is_error":false}]}');
  expect(JSON.stringify(line)).toBe(stored);
  expect(withPending(messages, { id: "none", text: "x" })).toBe(messages);
});
