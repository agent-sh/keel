// Pure logic the e2e cannot see: the wire bytes of a branch, and the tree.
import { afterAll, expect, test } from "bun:test";
import { leafOf, lineage, versions } from "../core/tree.ts";
import type { Message, StoredEvent } from "../core/types.ts";
import { cutOf, followUpMark, noDearer, RESTART_CUT, stalledContinuations, toMessages, toolLimits, unanswered, withPending } from "./turn.ts";
import { checkpointAt, keptMessages } from "./compact.ts";
import { allHooks } from "./hooks.ts";

// Turn hooks are process-wide: the files after this one run without the ones its tests register.
const hooksAtStart = allHooks().length;
afterAll(() => { allHooks().length = hooksAtStart; });

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
    const id = store.createSession({ title: "Fixture", model: "x:y", workspace: dir }).id;
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

// The owner's layout: two user files import one shared file, and a third file is a generated copy of it
// with a header and a section of its own. The shared text rides once; the copy keeps its own section.
test("instruction files: a section another file already carries is left out where it stands", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { instructionFiles } = await import("./turn.ts");
  const root = mkdtempSync(join(process.env.TMPDIR ?? `${process.env.HOME}/.cache/tmp`, "inst-"));
  try {
    const rules = Array.from({ length: 40 }, (_, i) => `- shared rule ${i}: a sentence of the shared rules.`).join("\n");
    const shared = `# Shared rules\n\n${rules}\n\n## Testing\n\n- TEST-RULE: a test proves what failed before.\n`;
    writeFileSync(join(root, "shared.md"), shared);
    mkdirSync(join(root, "a/b"), { recursive: true });
    writeFileSync(join(root, "a/CLAUDE.md"), "@../shared.md\n\n## Claude only\n\n- CLAUDE-ONLY\n");
    writeFileSync(join(root, "a/AGENTS.md"), `<!-- Generated from shared.md. -->\n${shared}\n## Codex only\n\n- CODEX-ONLY\n`);
    writeFileSync(join(root, "a/b/AGENTS.md"), "INNER\n");
    const text = instructionFiles(join(root, "a/b"));
    expect(text.match(/shared rule 7:/g)?.length).toBe(1);
    expect(text.match(/TEST-RULE/g)?.length).toBe(1);
    for (const own of ["CLAUDE-ONLY", "CODEX-ONLY", "INNER", "## Codex only"]) expect(text).toContain(own);
    expect(text).toContain(`(Left out here: 2 sections under "# Shared rules", "## Testing" the same as in ${join(root, "shared.md")}, above.)`);
    // A heading goes with its section: the copy's "## Testing" went with its rule.
    expect(text.match(/^## Testing$/gm)?.length).toBe(1);
    expect(text.match(/^# Shared rules$/gm)?.length).toBe(1);
  } finally {
    rmSync(join(root, ""), { recursive: true, force: true });
  }
});

// The whole chain is bounded by a quarter of the window: the files past it are named, not loaded.
test("instruction files: the chain's bound names the files past it", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { instructionFiles, chainLimit } = await import("./turn.ts");
  expect(chainLimit(200_000)).toBe(200_000);
  expect(chainLimit(32_000)).toBe(32_000);
  const root = mkdtempSync(join(process.env.TMPDIR ?? `${process.env.HOME}/.cache/tmp`, "inst-"));
  try {
    const big = (tag: string) => Array.from({ length: 300 }, (_, i) => `- ${tag} ${i}: a line of rules of this folder.`).join("\n") + "\n";
    mkdirSync(join(root, "a/b/c"), { recursive: true });
    writeFileSync(join(root, "a/AGENTS.md"), big("OUTER"));
    writeFileSync(join(root, "a/b/AGENTS.md"), big("MIDDLE"));
    writeFileSync(join(root, "a/b/c/AGENTS.md"), big("INNER"));
    // A 32K window: 8,000 characters a file (instructionLimit), 32,000 for the chain.
    const text = instructionFiles(join(root, "a/b/c"), 32_000);
    expect(text).toContain("OUTER 0:");
    expect(text.length).toBeLessThan(32_000 + 2_000);
    const all = instructionFiles(join(root, "a/b/c"), 8_000);
    expect(all).toContain(`# ${join(root, "a/b/c/AGENTS.md")}\n\n(Not loaded: the instruction files above fill the room`);
  } finally {
    rmSync(join(root, ""), { recursive: true, force: true });
  }
});

test("instruction files: a rule past a file's cut is not carried", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { instructionFiles } = await import("./turn.ts");
  const root = mkdtempSync(join(process.env.TMPDIR ?? `${process.env.HOME}/.cache/tmp`, "inst-"));
  try {
    mkdirSync(join(root, "a/b"), { recursive: true });
    const Z = "## Secrets\n\n- Never print a token, a key or a password into any output, and never commit one; a leaked one is rotated before other work goes on.";
    let big = "# Outer\n\n";
    for (let i = 0; i < 400; i++) big += `- outer rule ${i}: lorem ipsum dolor sit amet consectetur adipiscing elit.\n\n`;
    writeFileSync(join(root, "a/AGENTS.md"), big + Z + "\n");
    writeFileSync(join(root, "a/b/AGENTS.md"), "# Inner\n\n- inner rule.\n\n" + Z + "\n");
    // A 32K window cuts the outer file at 8,000 characters, before its Secrets: the inner file's copy is
    // the one the model reads.
    const cut = instructionFiles(join(root, "a/b"), 32_000);
    expect(cut).toContain("(Cut here:");
    expect(cut.match(/Never print a token/g)?.length).toBe(1);
  } finally {
    rmSync(join(root, ""), { recursive: true, force: true });
  }
});

// A call the restart cut gets what its approval card recorded: the owner's
// denial and reason, "did not run" for a card nothing answered, and "may have
// partly run" only for an allowed call or one with no card. Also state from
// before results were stored per call: a denial whose result was never stored.
test("a restart cut: questions and open cards wait, approval outcomes are kept, only a call that may have run warns", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Gate } = await import("../safety/gate.ts");
  const { registerHooks } = await import("./hooks.ts");
  const { Engine, RESTART_CUT } = await import("./turn.ts");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "recover-"));
  const store = new Store(dir);
  const bus = new Bus();
  const s = store.createSession({ title: "Fixture", model: "x:y", workspace: dir });
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
  // The call with an open card and the questions have no result: the continued turn asks on the same cards again.
  expect(cut).toHaveLength(5);
  expect(gate.callOutcome(s.id, "p1")).toBe("waiting");
  expect(Object.fromEntries(cut.map((r: any) => [r.tool_use_id, r.content]))).toEqual({
    w1: RESTART_CUT, a1: RESTART_CUT,
    d1: "The owner denied this call: leave d1 alone",
    d2: "The owner denied this call. Do not retry it; take another way or ask.",
    d3: "Refused by the rule: no touching here.",
  });
  expect(gate.rules()).toEqual([]);
});

// A prompt that arrives before a cut turn was continued (the owner's, a kept
// send going out again) does not take the continuation's place: the model is
// told of the cut first. While a card waits and the model has not read the
// last such message, a restart adds no other one.
test("a prompt after a cut turn follows the restart message; a waiting card gets it once", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Engine, RESTART_CUT } = await import("./turn.ts");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "cut-prompt-"));
  const store = new Store(dir);
  const engine = new Engine(store, new Bus(), { resolve: async () => { throw new Error("no model here"); } } as any, { capture: (_s: string, e: unknown) => ({ message: String(e) }) } as any, join(dir, "spill"));
  const users = (id: string) => store.events(id).filter((e) => e.kind === "user").map((e) => [e.data.origin ?? "owner", String(e.data.text).slice(0, 40)]);
  const cut = (calls: object[], results: object[] = []) => {
    const s = store.createSession({ title: "Fixture", model: "x:y", workspace: dir });
    store.append(s.id, "user", { text: "go" });
    store.append(s.id, "turn_start", {});
    store.append(s.id, "assistant", { blocks: calls, stop: "tool_use" });
    if (results.length) store.append(s.id, "tool_result", { results });
    store.append(s.id, "turn_end", { reason: "restart" });
    return s.id;
  };
  // A cut command: the owner's words come after the restart message.
  const a = cut([{ type: "tool_use", id: "w1", name: "Bash", input: {} }], [{ type: "tool_result", tool_use_id: "w1", is_error: true, content: RESTART_CUT }]);
  engine.send(a, "typed before the continuation");
  expect(users(a)).toEqual([["owner", "go"], ["restart", "[harness] The daemon restarted during yo"], ["owner", "typed before the continuation"]]);
  await engine.interrupt(a, "owner");
  // A waiting question whose continuation was cut again before the model was asked: no second restart message.
  const b = cut([{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: {} }]);
  store.append(b, "user", { text: "[harness] The daemon restarted during your previous turn.", origin: "restart" });
  store.append(b, "turn_start", {});
  store.append(b, "turn_end", { reason: "restart" });
  await engine.recover([], async () => {});
  expect(users(b).map((u) => u[0])).toEqual(["owner", "restart"]);
  // The same branch once the model replied after that message: the next cut is said again.
  const c = cut([{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: {} }]);
  store.append(c, "user", { text: "[harness] The daemon restarted during your previous turn.", origin: "restart" });
  store.append(c, "turn_start", {});
  store.append(c, "tool_result", { results: [{ type: "tool_result", tool_use_id: "q1", content: "answered" }] });
  store.append(c, "assistant", { blocks: [{ type: "tool_use", id: "q2", name: "AskUserQuestion", input: {} }], stop: "tool_use" });
  store.append(c, "turn_end", { reason: "restart" });
  await engine.recover([], async () => {});
  expect(users(c).map((u) => u[0])).toEqual(["owner", "restart", "restart"]);
  // Continue pressed before the continuation: the restart message, not "the previous turn was stopped".
  const d = cut([{ type: "tool_use", id: "w1", name: "Bash", input: {} }], [{ type: "tool_result", tool_use_id: "w1", is_error: true, content: RESTART_CUT }]);
  engine.resume(d);
  expect(users(d).map((u) => u[0])).toEqual(["owner", "restart"]);
  await engine.interrupt(d, "owner");
  // The count of continues after a provider's wait is read through a restart that cut the continued turn.
  const e = store.createSession({ title: "Fixture", model: "x:y", workspace: dir }).id;
  store.append(e, "user", { text: "go" });
  store.append(e, "turn_start", {});
  store.append(e, "turn_end", { reason: "error" });
  store.append(e, "error", { message: "429" });
  store.append(e, "user", { text: "[harness] The wait the provider asked for is over.", origin: "harness", continued: 2 });
  store.append(e, "turn_start", {});
  store.append(e, "turn_end", { reason: "restart" });
  store.append(e, "user", { text: "[harness] The daemon restarted during your previous turn.", origin: "restart" });
  store.append(e, "turn_start", {});
  expect((engine as any).continuedInARow(e)).toBe(2);
  store.append(e, "assistant", { blocks: [{ type: "text", text: "a step" }] });
  expect((engine as any).continuedInARow(e)).toBe(0);
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
  const s = store.createSession({ title: "Fixture", model: "p:m", workspace: dir });
  store.updateSession(s.id, { settings: { compact_at: 2_000 } });
  store.append(s.id, "user", { text: "read the big file" });
  store.append(s.id, "assistant", { blocks: [{ type: "text", text: "x".repeat(8_000) }], model: "p:m", stop: "end_turn", usage: { input: 10, output: 2_000, cache_read: 0, cache_write: 9_000, cache_write_1h: 9_000 } });
  // The last cached reply was 55 minutes ago: the hour is nearly over, the summary is due.
  store.db.run("UPDATE events SET ts = ? WHERE session_id = ?", [Date.now() - 55 * 60_000, s.id]);
  (store as any).forget(s.id); // (changed in the table behind the store: read again from there)
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
    const old = store.createSession({ title: "Fixture", model: "p:m", workspace: dir });
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
    const s = store.createSession({ title: "Fixture", model: "p:m", workspace: dir });
    store.updateSession(s.id, { settings: { compact_at: 2_000 } });
    const first = store.append(s.id, "user", { text: "read the big file" });
    store.append(s.id, "assistant", { blocks: [{ type: "text", text: "x".repeat(8_000) }], model: "p:m", stop: "end_turn", usage: { input: 10, output: 2_000, cache_read: 0, cache_write: 9_000, cache_write_1h: 9_000 } });
    store.db.run("UPDATE events SET ts = ? WHERE session_id = ?", [Date.now() - 55 * 60_000, s.id]);
    (store as any).forget(s.id); // (changed in the table behind the store: read again from there)
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
  // (A count its context could be: one that the bytes before it cannot be is not taken for a measure of them.)
  const usage = { input: 700, output: 1, cache_read: 0, cache_write: 0 };
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
    const s = store.createSession({ title: "Fixture", model: "p:m", workspace: dir });
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

// A summary written ahead that comes back empty or refused, or fails, is
// tried again on the same context only after 2, 4, 8, ... steps: each try reads
// the whole context. The window rule's preparation at 70% and compaction by
// price share it (Engine.prepare).
test("a summary prepared ahead that fails is tried again after a growing number of steps, not at every step", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Engine } = await import("./turn.ts");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "backoff-"));
  const store = new Store(dir);
  const info = { id: "p:m", provider: "p", model: "m", name: "M", family: "other", context: 100_000, output: 1_000, efforts: [], billing: "per_token" };
  const usage = { input: 6_100, output: 1, cache_read: 0, cache_write: 0 };
  const STEPS = 16;
  const run = async (summary: (req: any) => any) => {
    const asked: string[] = [];
    let steps = 0;
    const provider = {
      id: "p", wire: "anthropic_messages", available: () => true, list: async () => [],
      stream: async (req: any) => {
        asked.push(req.purpose);
        if (req.purpose === "summary") return summary(req);
        // Each step a tool call (one that fails at once), until the last.
        if (++steps < STEPS) return { blocks: [{ type: "tool_use", id: `t${steps}`, name: "Read", input: {} }], usage, stop: "tool_use", model: "m" };
        return { blocks: [{ type: "text", text: "done" }], usage, stop: "end_turn", model: "m" };
      },
    };
    const providers = { resolve: async () => ({ provider, info }), models: async () => [info], current: () => [info] };
    const engine = new Engine(store, new Bus(), providers as any, { capture: (_s: string, e: unknown) => ({ message: String((e as Error).message) }) } as any, join(dir, "spill"));
    const s = store.createSession({ title: "Fixture", model: "p:m", workspace: dir });
    // The window's line at 7,000 tokens: a context of about 6,100 is past the 70% where a summary is prepared ahead, and under the line.
    store.updateSession(s.id, { settings: { compact_at: 7_000 } });
    store.append(s.id, "user", { text: "go" });
    store.append(s.id, "assistant", { blocks: [{ type: "text", text: "x".repeat(20_000) }], model: "p:m", stop: "end_turn", usage });
    engine.send(s.id, "next");
    await engine.idle(s.id);
    expect(store.events(s.id).findLast((e) => e.kind === "turn_end")?.data.reason).toBe("end_turn");
    expect(asked.filter((p) => p === "turn")).toHaveLength(STEPS);
    return asked.filter((p) => p === "summary").length;
  };
  // An answer with no summary in it (a tool call instead), a refusal, a failed request: over 16 steps,
  // tries at about the 1st, 3rd, 7th and 15th, never one at every step.
  for (const summary of [
    () => ({ blocks: [{ type: "tool_use", id: "s", name: "Read", input: {} }], usage, stop: "tool_use", model: "m" }),
    () => ({ blocks: [{ type: "text", text: "I can't help with that." }], usage, stop: "refusal", model: "m" }),
    () => { throw Object.assign(new Error("fixture: the summary request failed"), { status: 400 }); },
  ]) {
    const n = await run(summary);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(5);
  }
});

// Compaction by price reads an agent's kind from the agents table, which the
// automation makes: a store without it prices the agent as of no kind, and its
// turn goes on.
test("an agent priced for compaction in a store with no agents table still takes its step", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Engine } = await import("./turn.ts");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "noagents-"));
  const store = new Store(dir);
  const info = { id: "p:m", provider: "p", model: "m", name: "M", family: "other", context: 1_000_000, output: 1_000, efforts: [], billing: "per_token", price: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } };
  const usage = { input: 60_000, output: 1, cache_read: 0, cache_write: 0 };
  const provider = {
    id: "p", wire: "anthropic_messages", available: () => true, list: async () => [],
    stream: async () => ({ blocks: [{ type: "text", text: "ok" }], usage, stop: "end_turn", model: "m" }),
  };
  const providers = { resolve: async () => ({ provider, info }), models: async () => [info], current: () => [info] };
  const engine = new Engine(store, new Bus(), providers as any, { capture: (_s: string, e: unknown) => ({ message: String((e as Error).message) }) } as any, join(dir, "spill"));
  // An agent (a parent of its own) whose tree compacts by price.
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
  const root = store.createSession({ title: "Root", model: "p:m", workspace: dir, settings: { compact_by_price: true } });
  const s = store.createSession({ title: "Agent", model: "p:m", workspace: dir });
  store.db.run("UPDATE sessions SET parent_id = ? WHERE id = ?", [root.id, s.id]);
  expect(store.session(s.id)?.parent_id).toBe(root.id);
  store.append(s.id, "user", { text: "go" });
  store.append(s.id, "assistant", { blocks: [{ type: "text", text: "x".repeat(250_000) }], model: "p:m", stop: "end_turn", usage });
  engine.send(s.id, "next");
  await engine.idle(s.id);
  expect(store.events(s.id).findLast((e) => e.kind === "turn_end")?.data.reason).toBe("end_turn");
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
  const s = store.createSession({ title: "Fixture", model: "p:m", workspace: dir });
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
  const s = store.createSession({ title: "Fixture", model: "fixture:m", workspace: dir });
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
    await engine.interrupt(s.id, "owner");
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
  const s = store.createSession({ title: "Fixture", model: "x:y", workspace: dir });
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

// A call that names no offered tool by its own name: one that differs by case or is the same job's name
// in another harness runs as the offered tool and its result says so once; any other is told the nearest
// names. The call the model wrote is not touched.
test("a call named by case or by another harness's name runs as the offered tool, once said", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Engine } = await import("./turn.ts");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "resolve-"));
  const store = new Store(dir);
  const s = store.createSession({ title: "Fixture", model: "x:y", workspace: dir });
  const engine = new Engine(store, new Bus(), {} as any, { capture: (_s: string, e: unknown) => ({ message: String(e) }) } as any, join(dir, "spill"));
  const ran: unknown[] = [];
  const tools = [{ name: "Bash", description: "", input_schema: { type: "object", required: ["command"] }, readOnly: true, run: async (input: any) => (ran.push(input), { content: "out" }) }] as any;
  const ctx = { sessionId: s.id, cwd: dir, signal: new AbortController().signal, spillDir: dir, seen: new Map() };
  try {
    const call = (id: string, name: string, input: any) => (engine as any).runTool(s, tools, { type: "tool_use", id, name, input }, ctx);
    const a = await call("a", "bash", { command: "ls" });
    expect(a.is_error).toBeUndefined();
    expect(a.content).toBe("out\n\n(There is no tool named bash; ran as Bash, the name of the tool here. Call it Bash.)");
    // The result carries the name it ran as: the stored call keeps the one the model wrote.
    expect(a.resolved_as).toBe("Bash");
    expect(ran).toEqual([{ command: "ls" }]);
    expect((await call("c", "Bash", { command: "ls" })).resolved_as).toBeUndefined();
    const b = await call("b", "exec_command", { cmd: "ls" });
    expect([b.is_error, b.content]).toEqual([true, "No tool named exec_command. The nearest tools offered: Bash."]);
    expect(b.resolved_as).toBeUndefined();
    expect(ran.length).toBe(2);
  } finally {
    store.db.close();
  }
});

// A call whose input is not the tool's is answered from the tool's schema before any gate, hook or run: the
// line names what is wrong and the right field, the tool never runs, and the call is a failed one in the tools table.
test("a call with a missing or unknown field is answered from the schema and does not run", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Engine } = await import("./turn.ts");
  const { allHooks, registerHooks } = await import("./hooks.ts");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "invalid-"));
  const store = new Store(dir);
  const s = store.createSession({ title: "Fixture", model: "x:y", workspace: dir });
  const engine = new Engine(store, new Bus(), {} as any, { capture: (_s: string, e: unknown) => ({ message: String(e) }) } as any, join(dir, "spill"));
  const ran: unknown[] = [];
  const gated: string[] = [];
  const seenByGate: unknown[] = [];
  const measured: string[] = [];
  const tools = [{
    name: "Write", description: "", readOnly: false, inputAlias: { file_path: ["path"], content: ["file_text"] },
    input_schema: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"], additionalProperties: false },
    run: async (input: any) => (ran.push(input), { content: "written" }),
  }] as any;
  const mine = {
    beforeTool: (_s: any, call: any) => { if (call.ctx.sessionId === s.id) { gated.push(call.tool.name); seenByGate.push(call.input); } return undefined; },
    toolRan: (session: any, call: any, _r: any, m: any) => { if (session.id === s.id) measured.push(`${call.tool.name}:${m.outcome}`); },
  } as any;
  // The owner's hook that fills a field in (it runs before the check: the call it leaves is the one judged).
  const fills = { prepareTool: (session: any, call: any) => (session.id === s.id && call.input.fill ? { input: { file_path: call.input.file_path, content: "filled" } } : undefined) } as any;
  registerHooks(mine);
  registerHooks(fills);
  const ctx = { sessionId: s.id, cwd: dir, signal: new AbortController().signal, spillDir: dir, seen: new Map() };
  try {
    const call = (id: string, input: any) => (engine as any).runTool(s, tools, { type: "tool_use", id, name: "Write", input }, ctx);
    const a = await call("a", { file_path: "/a", contents: "x" });
    expect(a.is_error).toBe(true);
    expect(a.content).toContain("the required field `content` is missing; `contents` is not a field of Write (did you mean `content`?)");
    expect(a.content).toContain("Its fields: file_path (required), content (required).");
    expect(ran).toEqual([]);
    expect(gated).toEqual([]);
    expect(measured).toEqual(["Write:error"]);
    // The name a tool reads in a field's place is the field: the call runs.
    const b = await call("b", { path: "/a", content: "x" });
    expect([b.is_error, b.content]).toEqual([undefined, "written"]);
    // (The gates read the field's own name, so the call is moved to it before any of them sees it.)
    expect(ran).toEqual([{ file_path: "/a", content: "x" }]);
    expect(gated).toEqual(["Write"]);
    expect(seenByGate).toEqual([{ file_path: "/a", content: "x" }]);
    // The same for the content: a gate judges what the call writes, whatever name the model gave it.
    seenByGate.length = ran.length = 0;
    const t = await call("t", { file_path: "/a", file_text: "plugins" });
    expect(t.is_error).toBeUndefined();
    expect(seenByGate).toEqual([{ file_path: "/a", content: "plugins" }]);
    expect(ran).toEqual([{ file_path: "/a", content: "plugins" }]);
    ran.length = 0;
    // A hook that makes the call right rescues it.
    const c = await call("c", { file_path: "/b", fill: true });
    expect(c.is_error).toBeUndefined();
    expect(c.content).toContain("written");
    expect(ran[0]).toEqual({ file_path: "/b", content: "filled" });
  } finally {
    allHooks().splice(allHooks().indexOf(fills), 1);
    allHooks().splice(allHooks().indexOf(mine), 1);
    store.db.close();
  }
});

// A Write sent with the text editor tool's name for the content (file_text) writes that text: the call the tool runs
// is the normalised one, through the engine's own call path and the real tools.
test("a Write sent with file_text, or write_file with it, writes the text to disk", async () => {
  const { mkdtempSync, readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Engine } = await import("./turn.ts");
  const { claudeTools } = await import("../tools/claude.ts");
  const { geminiTools } = await import("../tools/gemini.ts");
  const state = mkdtempSync(join(process.env.TMPDIR ?? ".", "write-alias-state-"));
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "write-alias-"));
  const store = new Store(state);
  const s = store.createSession({ title: "Fixture", model: "x:y", workspace: dir });
  const engine = new Engine(store, new Bus(), {} as any, { capture: (_s: string, e: unknown) => ({ message: String(e) }) } as any, join(state, "spill"));
  const ctx = { sessionId: s.id, cwd: dir, signal: new AbortController().signal, spillDir: dir, seen: new Map() };
  try {
    const call = (tools: any[], name: string, id: string, input: any) => (engine as any).runTool(s, tools, { type: "tool_use", id, name, input }, ctx);
    const a = await call(claudeTools, "Write", "a", { file_path: join(dir, "a.txt"), file_text: "from file_text\n" });
    expect(a.is_error).toBeUndefined();
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("from file_text\n");
    const g = await call(geminiTools, "write_file", "g", { file_path: join(dir, "g.txt"), file_text: "from file_text in write_file\n" });
    expect(g.is_error).toBeUndefined();
    expect(readFileSync(join(dir, "g.txt"), "utf8")).toBe("from file_text in write_file\n");
    // No content under any name is still refused, and nothing is written.
    const none = await call(claudeTools, "Write", "n", { file_path: join(dir, "n.txt") });
    expect(none.is_error).toBe(true);
    expect(existsSync(join(dir, "n.txt"))).toBe(false);
  } finally {
    store.db.close();
  }
});

// What a gate adds to a call's process environment (an agent's guard settings) ends with the call, also when the
// call starts no process: a tool that ran no command, one that threw, a later gate's refusal. It is the session's:
// another session's call of the same id neither gets it nor loses its own.
test("a settled tool call leaves no environment of its own behind", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Engine } = await import("./turn.ts");
  const { registerHooks } = await import("./hooks.ts");
  const { hasCallEnv, setCallEnv } = await import("../tools/jobs.ts");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "callenv-"));
  const store = new Store(dir);
  const s = store.createSession({ title: "Fixture", model: "x:y", workspace: dir });
  const engine = new Engine(store, new Bus(), {} as any, { capture: (_s: string, e: unknown) => ({ message: String(e) }) } as any, join(dir, "spill"));
  registerHooks({ beforeTool: (x, c) => void setCallEnv(x.id, c.id, { GIT_CONFIG_COUNT: "2" }) });
  registerHooks({ beforeTool: (_s, c) => (c.tool.name === "refused" ? { deny: "no" } : undefined) });
  const tool = (name: string, run: () => Promise<any>) => ({ name, description: "", input_schema: { type: "object" }, readOnly: true, run }) as any;
  const tools = [tool("ok", async () => ({ content: "fine" })), tool("boom", async () => { throw new Error("broke"); }), tool("refused", async () => ({ content: "never" }))];
  const ctx = { sessionId: s.id, cwd: dir, signal: new AbortController().signal, spillDir: dir, seen: new Map() };
  // Another session's call of the same id (ids are the provider's): its environment is its own and stays.
  const other = store.createSession({ title: "Other", model: "x:y", workspace: dir });
  try {
    for (const name of ["ok", "boom", "refused"]) {
      setCallEnv(other.id, `env-${name}`, { GIT_CONFIG_COUNT: "4" });
      await (engine as any).runTool(s, tools, { type: "tool_use", id: `env-${name}`, name, input: {} }, ctx);
      expect([name, hasCallEnv(s.id, `env-${name}`), hasCallEnv(other.id, `env-${name}`)]).toEqual([name, false, true]);
    }
  } finally {
    allHooks().length -= 2;
    store.db.close();
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
  const s = store.createSession({ title: "Fixture", model: "fixture:m", workspace: dir });
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

test("a turn cut again while its card was open is recorded as waiting on the owner, at the step that asked", () => {
  let n = 0;
  const e = (kind: string, data: any = {}) => ({ id: `c${++n}`, ts: n, kind, data }) as unknown as StoredEvent;
  // A question the model asked at its second step; the daemon went down twice with the card open.
  const line = [
    e("user", { text: "go" }), e("turn_start"),
    e("assistant", { blocks: [{ type: "tool_use", id: "r1", name: "Read", input: {} }] }),
    e("tool_result", { results: [{ type: "tool_result", tool_use_id: "r1", content: "read" }] }),
    e("assistant", { blocks: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: {} }] }),
    e("turn_end", { reason: "restart", ms: 5000 }),
    e("user", { text: "[harness] restarted", origin: "restart" }), e("turn_start"),
    e("turn_end", { reason: "restart", ms: 3000 }),
  ];
  const first = cutOf("s", line, line[5]!);
  expect([first.step, first.tools, first.waiting]).toEqual([2, [], 1]);
  // The second cut: the same card, the same step. It was "step 1, waiting for the model".
  const second = cutOf("s", line, line.at(-1)!);
  expect([second.step, second.tools, second.waiting, second.ran_ms, second.turn_event]).toEqual([2, [], 1, 3000, line[7]!.id]);
  // A call a restart cut in the first run was told then: the continued run that the model was answering in names no tool.
  const ran = [
    e("user", { text: "go" }), e("turn_start"),
    e("assistant", { blocks: [{ type: "tool_use", id: "b1", name: "Bash", input: {} }] }),
    e("tool_result", { results: [{ type: "tool_result", tool_use_id: "b1", content: RESTART_CUT, is_error: true }] }),
    e("turn_end", { reason: "restart", ms: 1 }),
    e("user", { origin: "restart" }), e("turn_start"), e("turn_end", { reason: "restart", ms: 1 }),
  ];
  expect(cutOf("s", ran, ran[4]!)).toMatchObject({ step: 1, tools: ["Bash"], waiting: 0 });
  expect(cutOf("s", ran, ran.at(-1)!)).toMatchObject({ step: 2, tools: [], waiting: 0 });
  // The owner's own prompt after a cut starts another turn: its steps are its own.
  const moved = [...line.slice(0, 6), e("user", { text: "never mind" }), e("turn_start"), e("turn_end", { reason: "restart", ms: 1 })];
  expect(cutOf("s", moved, moved.at(-1)!)).toMatchObject({ step: 1, waiting: 0 });
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

// The calls a turn's start owes are looked for in the context the branch
// shows, not in the whole branch. The answer is the one the whole branch
// gives: over generated sessions with edited prompts, forks, summaries
// (prepared ahead and not), cut calls and steps of several calls.
test("the calls without a result are the same read from the checkpoint as from the whole branch", () => {
  // As it was: every result of the branch, then the calls after the checkpoint.
  const whole = (line: readonly StoredEvent[]) => {
    const done = new Set(line.flatMap((e) => (e.kind === "tool_result" ? e.data.results.map((r: any) => r.tool_use_id) : [])));
    return line.slice(checkpointAt(line).keepFrom).flatMap((e) => (e.kind === "assistant" ? e.data.blocks : [])).filter((b: any) => b.type === "tool_use" && !done.has(b.id));
  };
  let rnd = 7;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let owed = 0, lines = 0, compacted = 0;
  for (let session = 0; session < 60; session++) {
    const all: StoredEvent[] = [];
    let n = 0;
    const add = (parent: string | null, kind: StoredEvent["kind"], data: any) => { const e = ev(`g${session}-${++n}`, parent, kind, data); all.push(e); return e.id; };
    const leaves: string[] = [];
    let head: string | null = null;
    for (let turn = 0; turn < 12 + Math.floor(rand() * 30); turn++) {
      // An edited prompt or a fork: the turn starts from an earlier event of the session.
      if (all.length > 4 && rand() < 0.15) { if (head) leaves.push(head); head = all[Math.floor(rand() * all.length)]!.id; }
      head = add(head, "user", { text: `prompt ${turn}` });
      head = add(head, "turn_start", {});
      for (let step = 0; step < 1 + Math.floor(rand() * 4); step++) {
        const ids = Array.from({ length: 1 + Math.floor(rand() * 3) }, (_, i) => `t${session}-${n}-${i}`);
        head = add(head, "assistant", { blocks: [{ type: "text", text: "on it" }, ...ids.map((id) => ({ type: "tool_use", id, name: rand() < 0.3 ? "AskUserQuestion" : "Bash", input: {} }))], stop: "tool_use" });
        // Each result is stored by itself; some calls get none (a card a restart cut).
        for (const id of ids) if (rand() < 0.8) head = add(head, "tool_result", { results: [{ type: "tool_result", tool_use_id: id, content: "ok" }] });
        // A summary lands between steps too; one prepared ahead covers up to an earlier event of the branch.
        if (rand() < 0.12) {
          const line = lineage(all, head);
          const covered = rand() < 0.5 ? line[Math.max(0, line.length - 1 - Math.floor(rand() * 8))]!.id : undefined;
          head = add(head, "compaction", { mode: "summary", summary: "so far", ...(covered ? { covered } : {}) });
        }
      }
      // A call answered late, after the turn's end and the next prompt.
      if (rand() < 0.5) head = add(head, "turn_end", { reason: rand() < 0.3 ? "restart" : "end_turn" });
    }
    for (const leaf of [...leaves, head!]) {
      const line = lineage(all, leaf);
      const got = unanswered(line);
      expect(got).toEqual(whole(line));
      owed += got.length; lines++;
      if (checkpointAt(line).at >= 0) compacted++;
    }
  }
  // The generated branches do hold what is compared: calls without results, before and after summaries.
  expect(owed).toBeGreaterThan(100);
  expect(compacted).toBeGreaterThan(lines / 3);
});

// A turn another agent runs stores a reply at each tool call. The text it streamed is joined for a
// moment before it is a frame: what the join still holds goes out before the event that stores it,
// never after (a page drops its draft at that event, and would show the stored text again).
test("an external turn's streamed text is all sent before the event that stores it", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { allHooks } = await import("./hooks.ts");
  const { Engine } = await import("./turn.ts");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "external-order-"));
  const store = new Store(dir);
  const bus = new Bus();
  const s = store.createSession({ title: "Fixture", model: "fixture:m", workspace: dir });
  const engine = new Engine(store, bus, {} as any, { capture: (_s: string, e: unknown) => { throw e; } } as any, dir);
  const seen: string[] = [];
  bus.on((f) => {
    if (f.t === "delta" && f.session_id === s.id) seen.push(`delta ${f.text}`);
    else if (f.t === "event" && f.event.session_id === s.id && (f.event.kind === "assistant" || f.event.kind === "turn_end")) seen.push(f.event.kind);
  });
  const hooksBefore = allHooks().length;
  allHooks().push({ external: (session) => session.id === s.id ? async ({ append, delta }) => {
    // A message in pieces, then a tool call: the reply is stored at once, while pieces of it still wait to be sent.
    for (const text of ["I will ", "read the ", "file."]) delta("text", 1, text);
    append("assistant", { blocks: [{ type: "text", text: "I will read the file." }], model: "fixture:m", stop: "tool_use" });
    await Bun.sleep(60); // the tool runs
    for (const text of ["Now ", "the next ", "message."]) delta("text", 1, text);
    append("assistant", { blocks: [{ type: "text", text: "Now the next message." }], model: "fixture:m", stop: "end_turn" });
    return { reason: "end_turn" };
  } : undefined });
  try {
    engine.send(s.id, "start");
    for (let i = 0; i < 300 && !seen.includes("turn_end"); i++) await Bun.sleep(10);
    const text = (from: number, to: number) => seen.slice(from, to).filter((x) => x.startsWith("delta ")).map((x) => x.slice(6)).join("");
    const first = seen.indexOf("assistant"), second = seen.indexOf("assistant", first + 1), end = seen.indexOf("turn_end");
    expect([first > 0, second > first, end > second]).toEqual([true, true, true]);
    expect(text(0, first)).toBe("I will read the file.");
    expect(text(first, second)).toBe("Now the next message.");
    expect(text(second, seen.length)).toBe("");
  } finally {
    allHooks().length = hooksBefore;
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// A follow-up to a finished agent (Engine.followUp, src/engine/follow-up.ts):
// an agent's session with a checkpoint that carried a statement and a story,
// a task after it, and engines on one store with a provider of a given wire.
async function followUpBench() {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Engine } = await import("./turn.ts");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "follow-up-"));
  const store = new Store(dir);
  const asked: any[] = [];
  const price = { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 };
  const info = { id: "p:m", provider: "p", model: "m", name: "M", family: "other", context: 200_000, output: 1_000, efforts: [], billing: "per_token", price };
  const usage = { input: 700, output: 1, cache_read: 0, cache_write: 0 };
  let n = 0;
  const make = (wire: string) => {
    const provider = {
      id: "p", wire, available: () => true, list: async () => [],
      stream: async (req: any) => {
        asked.push(req);
        return { blocks: [{ type: "text", text: req.purpose === "summary" ? "SUMMARY-NOW" : "ok" }], usage, stop: "end_turn", model: "m" };
      },
    };
    const providers = { resolve: async () => ({ provider, info }), models: async () => [info], current: () => [info] };
    return new Engine(store, new Bus(), providers as any, { capture: (_s: string, e: unknown) => ({ message: String((e as Error).message) }) } as any, join(dir, `spill-${++n}`));
  };
  const agentSession = () => {
    const parent = store.createSession({ model: "p:m", workspace: dir });
    const s = store.createSession({ model: "p:m", workspace: dir });
    // (An agent's session: the automation adds the column in the daemon.)
    if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
    store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(parent.id, s.id);
    (store as any).forget(s.id);
    const reply = (c: string) => store.append(s.id, "assistant", { blocks: [{ type: "text", text: c.repeat(40_000) }], model: "p:m", stop: "end_turn", usage: { input: 10, output: 10, cache_read: 0, cache_write: 12_000 } });
    store.append(s.id, "user", { text: "Do the big task", kind: "task" });
    reply("x");
    store.append(s.id, "compaction", {
      mode: "summary", auto: true, owner_messages: [],
      summary: "## Statements\nThe conversation's own words, carried through every compaction until lifted:\n- work: \"never push to main\"\n\n## Story\nSTORY-OLD: chose design Z over Y because of W.",
      statements: [{ kind: "standing", by: "work", text: "never push to main" }],
    });
    store.append(s.id, "user", { text: "Message from the session that started you:\ngo on" });
    reply("y");
    store.append(s.id, "turn_end", { reason: "end_turn" });
    return s.id;
  };
  const o = { title: "Big task", report: "REPORT-AFTER: done, see branch", tasks: 1, since: 0, message: "fix the review findings", ended: "completed" as const };
  return { store, asked, make, agentSession, o };
}

// The capsule keeps what the checkpoint before it carried: its statements, as
// the model reads them, and its story verbatim.
test("a follow-up's capsule keeps the statements and the story of the checkpoint before it", async () => {
  const { summaryMessage } = await import("./compact.ts");
  const { store, make, agentSession, o } = await followUpBench();
  const c = agentSession();
  const plan = await make("anthropic_messages").followUp(c, { ...o, force: "capsule" });
  expect(plan).toMatchObject({ way: "capsule", forced: true });
  const cp = store.events(c).findLast((e) => e.kind === "compaction")!;
  expect(cp.data).toMatchObject({ capsule: true, trigger: "follow_up" });
  const read = JSON.stringify(summaryMessage(cp.data).content);
  expect(read).toContain("REPORT-AFTER");
  expect(read).toContain("never push to main");
  expect(read).toContain("STORY-OLD: chose design Z");
  expect(cp.data.statements).toEqual([expect.objectContaining({ text: "never push to main" })]);
});

// A wire that does not say how long it keeps a cache is not taken for lapsed
// while it may still hold it; and the owner's choice to go on whole makes no capsule.
test("a follow-up on a wire that does not time its cache prices it as perhaps warm", async () => {
  const { store, make, agentSession, o } = await followUpBench();
  const m = agentSession();
  const chat = make("chat_completions");
  const plan = await chat.followUp(m, o);
  expect(plan!.why).not.toContain("cache lapsed");
  expect(plan).toMatchObject({ warm: false, maybe: true });
  // (The way that one took depends on the prompt and tools this machine gives: a session of its own for the owner's choice.)
  const f = agentSession();
  const forced = await make("chat_completions").followUp(f, { ...o, force: "carry" });
  expect(forced).toMatchObject({ way: "carry", forced: true, mark: "carry" });
  expect(store.events(f).filter((e) => e.kind === "compaction")).toHaveLength(1);
  // The long lifetime is priced only where the next request asks for it: an agent's request soon after its last asks for the short one.
  const anthropic = make("anthropic_messages");
  const st = await (anthropic as any).step(store.session(f), "p:m");
  expect((anthropic as any).asksLong(f, st)).toBe(false);
  store.mergeSettings(f, { cache_long: true });
  expect((anthropic as any).asksLong(f, st)).toBe(true);
  expect((anthropic as any).asksLong(f, await (chat as any).step(store.session(f), "p:m"))).toBe(false);
});

// Where the follow-up starts, when the first step must act on it, is read
// from the message that opens the turn: a later engine on the same store
// reads it, and no other turn does.
test("a follow-up's summary at the first step is read from its message, by a later engine too", async () => {
  const { store, asked, make, agentSession, o } = await followUpBench();
  const s = agentSession();
  expect(await make("anthropic_messages").followUp(s, { ...o, force: "summary" })).toMatchObject({ way: "summary" });
  const next = make("anthropic_messages");
  next.message(s, "Message from the session that started you:\nfix the review findings", { kind: "steer", follow_up: "summary" });
  await next.idle(s);
  expect(asked.filter((r) => r.purpose === "summary")).toHaveLength(1);
  expect(store.events(s).findLast((e) => e.kind === "compaction")!.data).toMatchObject({ trigger: "follow_up" });
});

test("a follow-up decision whose message never came leaves the next turn alone", async () => {
  const { asked, make, agentSession, o } = await followUpBench();
  const h = agentSession();
  const engine = make("anthropic_messages");
  await engine.followUp(h, { ...o, force: "summary" });
  engine.send(h, "an unrelated prompt");
  await engine.idle(h);
  expect(asked.filter((r) => r.purpose === "summary")).toHaveLength(0);
  expect(asked.filter((r) => r.purpose === "turn")).toHaveLength(1);
});

// A request that retried (or waited out an outage) was answered by its last attempt: that attempt
// read or wrote the cache, so a tool step's cache plan counts the cache's life from it, not from
// the first attempt (after an eight-minute outage every plan began as "lapsed" and said so).
test("a tool step's cache plan starts from the attempt that answered", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Engine } = await import("./turn.ts");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "answered-"));
  const store = new Store(dir);
  const s = store.createSession({ title: "Fixture", model: "p:m", workspace: dir });
  const info = { id: "p:m", provider: "p", model: "m", name: "M", family: "other", context: 100_000, output: 1_000, efforts: [], billing: "per_token" };
  const tried: number[] = [];
  const provider = {
    id: "p", wire: "anthropic_messages", available: () => true, list: async () => [],
    stream: async (req: any) => {
      if (req.purpose !== "turn") return { blocks: [{ type: "text", text: "t" }], usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 }, stop: "end_turn", model: "m" };
      tried.push(Date.now());
      if (tried.length === 1) throw Object.assign(new Error("HTTP 500: try again"), { status: 500, headers: new Headers({ "retry-after-ms": "300" }) });
      if (tried.length === 2) return { blocks: [{ type: "tool_use", id: "c1", name: "no_such_tool", input: {} }], usage: { input: 1, output: 1, cache_read: 0, cache_write: 5_000 }, stop: "tool_use", model: "m" };
      return { blocks: [{ type: "text", text: "done" }], usage: { input: 1, output: 1, cache_read: 5_000, cache_write: 0 }, stop: "end_turn", model: "m" };
    },
  };
  const providers = { resolve: async () => ({ provider, info }), models: async () => [info], current: () => [info] };
  const engine = new Engine(store, new Bus(), providers as any, { capture: (_s: string, e: unknown) => ({ message: String(e) }), recovered: () => {} } as any, join(dir, "spill"));
  const sent: number[] = [];
  (engine as any).cachePlans.tool = (...a: any[]) => { sent.push(a[5]); return () => {}; };
  engine.send(s.id, "go");
  await engine.idle(s.id);
  expect(tried.length).toBe(3);
  expect(sent).toHaveLength(1);
  // Sent after the first attempt failed, at most when the second one reached the provider.
  expect(sent[0]!).toBeGreaterThan(tried[0]!);
  expect(sent[0]!).toBeLessThanOrEqual(tried[1]!);
});

test("a model is no dearer than another only when every rate the other states is known and not higher", () => {
  const base = { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 };
  expect(noDearer(base, base)).toBe(true);
  expect(noDearer({ ...base, input: 1, output: 5 }, base)).toBe(true);
  expect(noDearer({ ...base, output: 20 }, base)).toBe(false);
  expect(noDearer({ input: 3, output: 15 }, base)).toBe(false); // its cache rates unknown
  expect(noDearer(undefined, base)).toBe(false);
  expect(noDearer(base, undefined)).toBe(false);
  // A context tier dearer than any of the session's.
  expect(noDearer({ ...base, tiers: [{ above: 200_000, input: 6, output: 22.5 }] }, base)).toBe(false);
});

// A file past the limit is cut with a line that says so and where the rest is, for the model to
// read it; the limit grows with the model's window (Claude Code: 40,000 characters on 200K, 150,000 on 1M).
test("instruction files: a long one is cut with a note to Read the rest, the cut scaled to the window", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { instructionFiles, instructionLimit } = await import("./turn.ts");
  const { block } = await import("./nested.ts");
  const root = mkdtempSync(join(process.env.TMPDIR ?? `${process.env.HOME}/.cache/tmp`, "inst-cut-"));
  try {
    const long = Array.from({ length: 1_000 }, (_, i) => `Rule ${i}: ${"x".repeat(45)}`).join("\n");
    expect(long.length).toBeGreaterThan(50_000);
    const file = join(root, "AGENTS.md");
    writeFileSync(file, long);
    // (Only this file's part: the machine's own instruction files come before it.)
    const all = instructionFiles(root);
    const text = all.slice(all.indexOf(`# ${file}`));
    expect(text).toContain("Cut here: this is");
    expect(text).toContain(`Read ${file} from line `);
    expect(text).not.toContain("Rule 999:");
    // The cut is at a line's end, and the line it names is the first one left out.
    const line = Number(/from line (\d+)/.exec(text)![1]);
    expect(text).toContain(`Rule ${line - 2}: ${"x".repeat(45)}\n`);
    expect(text).not.toContain(`Rule ${line - 1}:`);
    // A 1M window carries the whole of this file; 200K, an unknown window and a small one less.
    expect(instructionLimit(200_000)).toBe(40_000);
    expect(instructionLimit()).toBe(40_000);
    expect(instructionLimit(1_000_000)).toBe(150_000);
    expect(instructionLimit(400_000)).toBeGreaterThan(40_000);
    expect(instructionLimit(32_000)).toBeLessThan(40_000);
    expect(instructionFiles(root, 1_000_000)).toContain("Rule 999:");
    // A nested file says the same.
    const nested = block(file)!;
    expect(nested).toContain(`Read ${file} from line `);
    expect(block(file, 1_000_000)).toContain("Rule 999:");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The line the note names is the one on disk, in the file the cut falls in, when imports came in.
test("instruction files: a cut inside or after an imported file names the line on disk", async () => {
  const { mkdtempSync, writeFileSync, rmSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { instructionFiles } = await import("./turn.ts");
  const root = mkdtempSync(join(process.env.TMPDIR ?? `${process.env.HOME}/.cache/tmp`, "inst-cut-imp-"));
  try {
    const file = join(root, "AGENTS.md");
    const big = join(root, "big.md");
    // Cut inside the imported file.
    writeFileSync(big, Array.from({ length: 1_500 }, (_, i) => `Imported rule ${i}: ${"y".repeat(30)}`).join("\n"));
    writeFileSync(file, "head line\n@big.md\n" + Array.from({ length: 100 }, (_, i) => `Own rule ${i}`).join("\n") + "\n");
    const part = (t: string) => t.slice(t.indexOf(`# ${file}`));
    let text = part(instructionFiles(root));
    let m = /Read (\S+) from line (\d+)/.exec(text)!;
    expect(m[1]).toBe(big);
    const n = Number(m[2]);
    expect(readFileSync(big, "utf8").split("\n")[n - 1]).toStartWith(`Imported rule ${n - 1}:`);
    expect(text).not.toContain(`Imported rule ${n - 1}:`);
    expect(text).toContain(`the rest of ${file} after the line that imports it`);
    // Cut after it, in the file's own lines: the line of AGENTS.md, past the one @ line.
    writeFileSync(big, Array.from({ length: 10 }, (_, i) => `Imported rule ${i}`).join("\n"));
    writeFileSync(file, "head line\n@big.md\n" + Array.from({ length: 2_000 }, (_, i) => `Own rule ${i}: ${"z".repeat(30)}`).join("\n") + "\n");
    text = part(instructionFiles(root));
    m = /Read (\S+) from line (\d+)/.exec(text)!;
    expect(m[1]).toBe(file);
    const k = Number(m[2]);
    expect(readFileSync(file, "utf8").split("\n")[k - 1]).toStartWith(`Own rule ${k - 3}:`);
    expect(text).not.toContain(`Own rule ${k - 3}:`);
    expect(text).toContain(`Own rule ${k - 4}:`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a restart between a stored follow-up and its first step keeps the follow-up's mark", () => {
  const prompt = ev("fu1", null, "user", { text: "Go on with the second part.", origin: "owner", follow_up: "carry" });
  const start = ev("fu2", "fu1", "turn_start", {});
  const cut = ev("fu2b", "fu2", "turn_end", { reason: "restart" });
  const restart = ev("fu3", "fu2b", "user", { text: "[harness] The daemon restarted.", origin: "restart" });
  expect(followUpMark([prompt, start])).toEqual({ way: "carry", focus: "Go on with the second part." });
  expect(followUpMark([prompt, start, cut, restart, ev("fu3b", "fu3", "turn_start", {})])).toEqual({ way: "carry", focus: "Go on with the second part." });
  expect(followUpMark([prompt, start, ev("fu4", "fu3", "assistant", { blocks: [] })])).toBeUndefined();
});

test("a tool step's time limit is read from the call's timeout or timeout_ms", () => {
  const use = (input: unknown) => ({ type: "tool_use" as const, id: "u", name: "Bash", input });
  expect(toolLimits([use({ timeout: 5000 }), use({ timeout_ms: 7000 }), use({ timeout: 0 }), use({ command: "ls" })])).toEqual([5000, 7000]);
  expect(toolLimits([use({ timeout: 5000, timeout_ms: 9000 })])).toEqual([5000]);
});
