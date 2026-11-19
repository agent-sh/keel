// Pure logic the e2e cannot see: the wire bytes of a branch, and the tree.
import { expect, test } from "bun:test";
import { leafOf, lineage, versions } from "../core/tree.ts";
import type { StoredEvent } from "../core/types.ts";
import { toMessages } from "./turn.ts";
import { ownerMedia, ownerWords } from "./compact.ts";

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
  const media = ownerMedia(line)!;
  expect(media).toEqual([[img], [file]]);
  const cp = ev("m4", "m3", "compaction", { mode: "summary", summary: "s", owner_messages: ownerWords(line), owner_media: media });
  const m = toMessages([...line, cp]);
  expect(m[0]!.content.map((b: any) => b.type)).toEqual(["text", "image", "text", "attachment", "text"]);
  // A later compaction keeps them again, from the first one's record.
  expect(ownerMedia([...line, cp])).toEqual([[img], [file]]);
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

test("a restart expires an unanswered question and warns only for a call that may have run", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Engine, QUESTION_CUT, RESTART_CUT } = await import("./turn.ts");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "recover-"));
  const store = new Store(dir);
  const s = store.createSession({ model: "x:y", workspace: dir });
  store.append(s.id, "user", { text: "go" });
  store.append(s.id, "turn_start", {});
  store.append(s.id, "assistant", { blocks: [
    { type: "tool_use", id: "q1", name: "AskUserQuestion", input: {} },
    { type: "tool_use", id: "q2", name: "request_user_input", input: {} },
    { type: "tool_use", id: "q3", name: "ask_user", input: {} },
    { type: "tool_use", id: "w1", name: "Bash", input: { command: "touch x" } },
  ], stop: "tool_use" });
  const engine = new Engine(store, new Bus(), {} as any, { capture: (_s: string, e: unknown) => ({ message: String(e) }) } as any, join(dir, "spill"));
  await engine.recover([s.id], async () => { throw new Error("no model here"); });
  const cut = store.events(s.id).filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results);
  expect(Object.fromEntries(cut.map((r: any) => [r.tool_use_id, r.content]))).toEqual({ q1: QUESTION_CUT, q2: QUESTION_CUT, q3: QUESTION_CUT, w1: RESTART_CUT });
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
