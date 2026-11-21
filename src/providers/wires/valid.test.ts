// A request built from any stored history is valid for the wire it goes to.
// A provider that refuses a request as malformed refuses every later one of
// the session too (the block that made it malformed stays in the history), so
// the projection repairs what a wire refuses. Proved three ways: the provider
// refusals seen in the field, each from a constructed history; random
// histories (calls, results, images, attachments, checkpoints, cuts, family
// switches) against each wire's structural rules (valid.ts); and that a
// history needing no repair is projected exactly as before, the same bytes
// every time.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, StoredEvent } from "../../core/types.ts";
import type { ProviderRequest, ToolSpec } from "../types.ts";

// Nothing here reads the owner's configuration.
process.env.KEEL_CONFIG_DIR = mkdtempSync(join(tmpdir(), "keel-valid-"));
const { toMessages } = await import("../../engine/turn.ts");
const { resolveAttachments } = await import("../../engine/attachments.ts");
const { toolsFor } = await import("../../tools/registry.ts");
const { referenced } = await import("../../tools/defer.ts");
const { LOOSE_RESULT, NO_RESULT, onRepair, portableId, portableName, project, recordRepairs } = await import("../project.ts");
const { anthropicBody, toWire } = await import("./anthropic.ts");
const { chatBody } = await import("./chat.ts");
const { geminiBody, geminiWire } = await import("./gemini.ts");
const { RESERVED_NAMESPACES, responsesBody } = await import("./responses.ts");
const { anthropicProblems, chatProblems, geminiProblems, responsesProblems } = await import("./valid.ts");

const base = { model: "m", system: "s", signal: new AbortController().signal } as ProviderRequest;
const ctx = (origin = "p:m", sessionKey = "k") => ({ origin, sessionKey, efforts: [] as string[] });
const spec = (name: string, more: Partial<ToolSpec> = {}): ToolSpec => ({ name, description: name, input_schema: { type: "object" }, ...more });

const b64 = (...bytes: number[]) => Buffer.from([...bytes, ...new Array(24).fill(0)]).toString("base64");
const PNG = b64(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = b64(0xff, 0xd8, 0xff, 0xe0);
const GIF = b64(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
const WEBP = b64(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50);
const text = (t: string) => ({ type: "text" as const, text: t });
const call = (id: string, name = "Read", input: unknown = { path: "/a" }) => ({ type: "tool_use" as const, id, name, input });
const result = (id: string, content: any = "ok") => ({ type: "tool_result" as const, tool_use_id: id, content });

// The four wires, each with a body and its rules.
type Target = { name: string; body: (messages: Message[], tools: ToolSpec[], session?: string) => any; problems: (body: any) => string[] };
const targets: Target[] = [
  { name: "anthropic", body: (messages, tools, s) => anthropicBody({ ...base, messages, tools }, { ...ctx("bedrock:claude", s), legacyIsMine: true }), problems: anthropicProblems },
  { name: "responses", body: (messages, tools, s) => responsesBody({ ...base, messages, tools }, ctx("chatgpt:gpt", s), "codex"), problems: (b) => responsesProblems(b, "codex") },
  { name: "responses-xai", body: (messages, tools, s) => responsesBody({ ...base, messages, tools }, ctx("xai:grok", s), "xai"), problems: (b) => responsesProblems(b, "xai") },
  { name: "chat", body: (messages, tools, s) => chatBody({ ...base, messages, tools }, ctx("or:other", s), { replayReasoning: true }), problems: chatProblems },
  { name: "gemini", body: (messages, tools, s) => geminiBody({ ...base, messages, tools }, ctx("gemini:g", s), { sentinel: true }), problems: geminiProblems },
];
const valid = (messages: Message[], tools: ToolSpec[] = [spec("Read")]) =>
  Object.fromEntries(targets.map((t) => [t.name, t.problems(t.body(messages, tools))]));
const none = Object.fromEntries(targets.map((t) => [t.name, [] as string[]]));

// ---- the refusals seen in the field, each from a constructed history ----

test("an image is labelled by its bytes on every wire, in a prompt and in a tool result", () => {
  // "The image was specified using the image/jpeg media type, but the image
  // appears to be a image/png image": a tool took the type from the file's
  // extension, an MCP server or a browser from wherever it liked.
  const messages: Message[] = [
    { role: "user", content: [{ type: "image", media_type: "image/jpeg", data: PNG }, text("look")] },
    { role: "assistant", content: [call("c1")] },
    { role: "user", content: [result("c1", [{ type: "image", media_type: "image/png", data: JPEG }, { type: "image", media_type: "image/png", data: WEBP }, { type: "image", media_type: "image/gif", data: GIF }])] },
  ];
  const stored = JSON.stringify(messages);
  expect(valid(messages)).toEqual(none);
  const a = anthropicBody({ ...base, messages, tools: [] }, ctx());
  expect(a.messages[0].content[0].source.media_type).toBe("image/png");
  expect(a.messages[2].content[0].content.map((c: any) => c.source.media_type)).toEqual(["image/jpeg", "image/webp", "image/gif"]);
  expect(responsesBody({ ...base, messages, tools: [] }, ctx(), "openai").input[0].content[0].image_url.startsWith("data:image/png;")).toBe(true);
  expect(geminiBody({ ...base, messages, tools: [] }, ctx()).contents[0].parts[0].inlineData.mimeType).toBe("image/png");
  // Bytes that are no known format keep their label; the stored history is untouched.
  const odd = { type: "image" as const, media_type: "image/png", data: b64(1, 2, 3, 4) };
  expect(project([{ role: "user", content: [odd] }], { origin: "p:m" })[0]!.content[0]).toBe(odd);
  expect(JSON.stringify(messages)).toBe(stored);
});

test("a result with no call before it is sent as text, a call with no result gets one", () => {
  // Anthropic: "unexpected `tool_use_id` found in `tool_result` blocks ... Each
  // `tool_result` block must have a corresponding `tool_use` block in the
  // previous message". Responses: "No tool call found for function call
  // output with call_id ...". A request whose messages a hook rebuilt, or an
  // imported history: a result stored after a later reply, one whose call a
  // summary replaced, a second result for one call, a call cut before its result.
  const messages: Message[] = [
    { role: "user", content: [text("go"), result("gone", "output of a summarized call")] },
    { role: "assistant", content: [call("a"), call("b")] },
    { role: "user", content: [text("a steer"), result("a", "first"), result("a", "again"), result("late", [text("late output"), { type: "image", media_type: "image/png", data: PNG }]), result("empty", "")] },
    { role: "assistant", content: [text("done"), call("cut")] },
  ];
  const stored = JSON.stringify(messages);
  expect(valid(messages)).toEqual(none);
  const p = project(messages, { origin: "p:m" });
  expect(p).toEqual([
    { role: "user", content: [text("go"), text(`${LOOSE_RESULT}\noutput of a summarized call`)] },
    { role: "assistant", content: [call("a"), call("b")] },
    { role: "user", content: [
      result("a", "first"), { ...result("b", NO_RESULT), is_error: true },
      text("a steer"), text(`${LOOSE_RESULT}\nagain`), text(`${LOOSE_RESULT}\nlate output`), { type: "image", media_type: "image/png", data: PNG },
    ] },
    { role: "assistant", content: [text("done"), call("cut")] },
    { role: "user", content: [{ ...result("cut", NO_RESULT), is_error: true }] },
  ]);
  expect(JSON.stringify(messages)).toBe(stored);
  // A user message that held only an empty loose result is gone, and the replies around it are one.
  expect(project([{ role: "user", content: [text("q")] }, { role: "assistant", content: [text("one")] }, { role: "user", content: [result("x", "")] }, { role: "assistant", content: [text("two")] }], { origin: "p:m" }))
    .toEqual([{ role: "user", content: [text("q")] }, { role: "assistant", content: [text("one"), text("two")] }]);
});

test("a tool grouped under a namespace the Responses backend keeps for itself goes as its own function", () => {
  // "Invalid Value: 'tools'. Function 'web.websearch' is not allowed in reserved namespace 'web'."
  for (const ns of RESERVED_NAMESPACES) {
    const tools = [spec("exec_command"), spec("tool_search", { search: true }), spec(`${ns}__find`, { defer: true, namespace: ns })];
    const messages: Message[] = [
      { role: "user", content: [text("go")] },
      { role: "assistant", content: [call("s1", "tool_search", { query: "find" })] },
      { role: "user", content: [result("s1", [{ type: "tool_reference", tool_name: `${ns}__find` }])] },
      { role: "assistant", content: [call("c1", `${ns}__find`, {})] },
      { role: "user", content: [result("c1")] },
    ];
    const b = responsesBody({ ...base, messages, tools }, ctx(), "codex");
    expect(responsesProblems(b, "codex")).toEqual([]);
    expect(b.input[2].tools).toEqual([{ type: "function", name: `${ns}__find`, description: `${ns}__find`, strict: false, defer_loading: true, parameters: { type: "object" } }]);
    expect(b.input[3]).toEqual({ type: "function_call", call_id: "c1", name: `${ns}__find`, arguments: "{}" });
  }
  expect([...RESERVED_NAMESPACES]).toContain("web");
});

test("a session that changed family: another wire's call ids, tool names and inputs", async () => {
  // A Gemini server that sends no call ids: the same call in two steps is two calls.
  const reply = (args: any) => {
    const p = geminiWire().parser(base, ctx("gemini:g"), () => {});
    p.event({ data: JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "read_file", args } }] }, finishReason: "STOP" }] }) } as any);
    return p.result().blocks.find((b) => b.type === "tool_use") as any;
  };
  const first = reply({ path: "/a" });
  await Bun.sleep(2);
  expect(reply({ path: "/a" }).id).not.toBe(first.id);
  const messages: Message[] = [
    { role: "user", content: [text("go")] },
    // The same id twice (stored before ids were per reply), a name with a dot, a made-up name, no name, a long one.
    { role: "assistant", content: [call("call_0_x", "read_file"), call("call_0_x", "functions.Read"), call("n1", ""), call("n2", "9" + "x".repeat(90))] },
    { role: "user", content: [result("call_0_x", "one"), result("call_0_x", "two"), result("n1"), result("n2")] },
    { role: "assistant", content: [call("call_0_x", "multi_tool_use.parallel", "not an object"), call("arr", "Read", [1, 2]), call("nil", "Read", null)] },
    { role: "user", content: [result("call_0_x", "three"), result("arr"), result("nil")] },
  ];
  expect(valid(messages)).toEqual(none);
  const p = project(messages, { origin: "p:m" });
  const calls = p.flatMap((m) => (m.role === "assistant" ? m.content : [])) as any[];
  const results = p.flatMap((m) => (m.role === "user" ? m.content : [])).filter((b) => b.type === "tool_result") as any[];
  expect(new Set(calls.map((c) => c.id)).size).toBe(7);
  expect(results.map((r) => r.tool_use_id)).toEqual(calls.map((c) => c.id));
  expect(results.slice(0, 2).map((r) => r.content)).toEqual(["one", "two"]);
  expect(calls.map((c) => c.name)).toEqual(["read_file", portableName("functions.Read"), portableName(""), portableName("9" + "x".repeat(90)), portableName("multi_tool_use.parallel"), "Read", "Read"]);
  for (const c of calls) expect(c.name).toMatch(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);
  expect(calls.slice(4).map((c) => c.input)).toEqual([{ input: "not an object" }, { input: [1, 2] }, {}]);
  expect(portableName("functions.Read")).not.toBe(portableName("functions_Read"));
});

test("a repair is told once per session and kind, with no content", () => {
  const seen: any[] = [];
  const off = onRepair("test", (r) => seen.push(r));
  const messages: Message[] = [
    { role: "user", content: [text("secret words"), result("gone", "secret output"), { type: "image", media_type: "image/jpeg", data: PNG }] },
    { role: "assistant", content: [call("c1", "bad.name")] },
  ];
  for (const s of ["told-1", "told-1", "told-2"]) for (const t of targets) t.body(messages, [spec("Read")], s);
  off();
  targets[0]!.body(messages, [spec("Read")], "told-3");
  expect(seen.map((r) => `${r.session} ${r.kind}`).sort()).toEqual(["told-1", "told-2"].flatMap((s) => ["call_without_result", "image_type", "result_without_call", "tool_name"].map((k) => `${s} ${k}`)).sort());
  expect(seen.find((r) => r.kind === "tool_name")).toEqual({ kind: "tool_name", session: "told-1", message: 1, call: "c1" });
  expect(JSON.stringify(seen)).not.toMatch(/secret|iVBOR/);
});

test("the daemon records a repair once per session and kind, as a warning that names the session", async () => {
  const { Store } = await import("../../core/store.ts");
  const { Bus } = await import("../../core/bus.ts");
  const { ErrorTracker } = await import("../../core/errors.ts");
  const dir = mkdtempSync(join(tmpdir(), "keel-valid-store-"));
  const store = new Store(dir);
  const quiet = console.error;
  console.error = () => {};
  const off = recordRepairs(new ErrorTracker(store, new Bus()));
  try {
    const one = store.createSession({ model: "m", workspace: "/" }), two = store.createSession({ model: "m", workspace: "/" });
    const messages: Message[] = [{ role: "user", content: [text("secret words"), result("gone", "secret output")] }];
    for (const s of [one.id, one.id, two.id]) for (const t of targets) t.body(messages, [spec("Read")], s);
    const rows = store.errors(50);
    expect(rows.length).toBe(1); // one row per kind
    expect(rows[0]!.count).toBe(2); // counted once per session
    expect(rows[0]!.source).toBe("provider");
    expect(rows[0]!.message).toStartWith("warning: a request was repaired before it was sent: a tool result whose call is not in the assistant message before it");
    expect(rows[0]!.session_id).toBe(two.id);
    expect(rows[0]!.context).toEqual({ level: "warning", session: two.id, repair: "result_without_call", message_index: 0, call: "gone" });
    expect(JSON.stringify(rows)).not.toContain("secret");
  } finally {
    off();
    console.error = quiet;
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- random histories ----

const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// The tool profile each family's model is given, and the origin its blocks carry.
const FAMILIES = ["claude", "gpt", "gemini", "other"] as const;
type Fam = (typeof FAMILIES)[number];
const ORIGIN: Record<Fam, string> = { claude: "bedrock:claude", gpt: "chatgpt:gpt", gemini: "gemini:g", other: "or:other" };
const profile = (f: Fam, native = false): ToolSpec[] => toolsFor(f, native).map((t: any) => ({ name: t.name, description: t.description, input_schema: t.input_schema, freeform: t.freeform, defer: t.defer, namespace: t.namespace, search: t.search }));
const PROFILES = Object.fromEntries(FAMILIES.map((f) => [f, profile(f)])) as Record<Fam, ToolSpec[]>;
const FOREIGN = ["functions.Read", "multi_tool_use.parallel", "", "9lives", "x".repeat(80), "mcp__srv__do.it", "web search", "é"];

// One branch of stored events. `faults`: also what no healthy turn writes (a
// cut call, a late or doubled result, one with no call, ids two calls share,
// made-up tool names, inputs that are no object, mislabeled images, empty
// text, a checkpoint that keeps a result without its call).
function branch(seed: number, faults: boolean): StoredEvent[] {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const maybe = (p: number) => r() < p;
  const bad = (p: number) => faults && maybe(p);
  const events: StoredEvent[] = [];
  const add = (kind: StoredEvent["kind"], data: any) => {
    const e = { id: `e${events.length}`, session_id: "s", seq: events.length + 1, parent: events.at(-1)?.id ?? null, kind, data, ts: 0 } as StoredEvent;
    events.push(e);
    return e;
  };
  const image = () => {
    const [type, data] = pick([["image/png", PNG], ["image/jpeg", JPEG], ["image/gif", GIF], ["image/webp", WEBP]] as const);
    return { type: "image", media_type: bad(0.4) ? pick(["image/jpeg", "image/png", "image/webp"]) : type, data };
  };
  let n = 0;
  const late: any[] = [];
  const id = (f: Fam) => {
    n++;
    if (bad(0.08)) return pick(["call_0_same", "dup", `call.${n % 3}`]);
    return f === "claude" ? `toolu_${n}` : f === "gpt" ? `call_${n}` : f === "gemini" ? `fc_${n}` : pick([`call-${n}`, `chatcmpl-tool-${n}`, ...(faults ? [`call|${n}`, `${n}`, `id.${n}`, `long${"z".repeat(70)}${n}`] : [])]);
  };
  const content = () => {
    const k = r();
    if (k < 0.5) return bad(0.1) ? "" : `out ${n}`;
    if (k < 0.65) return [image()];
    if (k < 0.75) return [{ type: "tool_reference", tool_name: pick(PROFILES.claude).name }];
    if (k < 0.8) return bad(0.5) ? [] : [text("x")];
    return [text(bad(0.3) ? "" : `out ${n}`), ...(maybe(0.3) ? [image()] : [])];
  };
  const turns = 1 + Math.floor(r() * 5);
  let fam: Fam = pick(FAMILIES);
  for (let t = 0; t < turns; t++) {
    if (maybe(0.3)) fam = pick(FAMILIES); // the owner picked another model
    const media = [...(maybe(0.25) ? [image()] : []), ...(maybe(0.15) ? [{ type: "attachment", id: "0".repeat(64), name: "notes.txt", media_type: "text/plain", size: 3 }] : [])];
    add("user", { text: bad(0.05) && media.length ? "" : `prompt ${t}`, ...(media.length ? { images: media } : {}) });
    add("turn_start", {});
    for (let step = 0, steps = Math.floor(r() * 4); step <= steps; step++) {
      const blocks: any[] = [];
      if (maybe(0.4)) blocks.push(fam === "claude" ? { type: "thinking", thinking: "t", signature: maybe(0.9) ? "SIG" : undefined, origin: maybe(0.8) ? ORIGIN.claude : undefined }
        : fam === "gpt" ? { type: "thinking", thinking: "t", opaque: { type: "reasoning", summary: [], encrypted_content: "ENC" }, origin: ORIGIN.gpt }
        : fam === "gemini" ? { type: "thinking", thinking: "t", opaque: [{ thought: true, text: "t" }], origin: ORIGIN.gemini }
        : { type: "thinking", thinking: "t", origin: ORIGIN.other });
      if (maybe(0.6)) blocks.push(text(bad(0.1) ? "" : `reply ${t}.${step}`));
      const last = step === steps;
      const calls: any[] = [];
      if (!last || maybe(0.2)) for (let c = 0, cs = 1 + Math.floor(r() * 3); c < cs; c++) {
        const name = bad(0.12) ? pick(FOREIGN) : pick(PROFILES[fam]).name;
        const input = bad(0.1) ? pick(["raw text", [1], 7, null, true]) : fam === "gpt" && maybe(0.2) ? { input: "*** Begin Patch" } : { a: n };
        calls.push({ type: "tool_use", id: id(fam), name, input, ...(fam !== "claude" ? { origin: ORIGIN[fam] } : {}) });
      }
      blocks.push(...calls);
      if (!blocks.length) blocks.push(text("ok"));
      const refused = maybe(0.03) && !calls.length;
      add("assistant", { blocks, model: ORIGIN[fam], stop: refused ? "refusal" : calls.length ? "tool_use" : "end_turn" });
      // Each result is stored as its call settles, in any order, a steer or a note between them.
      const order = [...calls].sort(() => r() - 0.5);
      for (const c of order) {
        if (bad(0.12)) { if (maybe(0.5)) late.push(c); continue; } // cut before its result; some come late
        add("tool_result", { results: [{ type: "tool_result", tool_use_id: c.id, content: content(), ...(maybe(0.1) ? { is_error: true } : {}) }] });
        if (bad(0.06)) add("tool_result", { results: [{ type: "tool_result", tool_use_id: c.id, content: "again" }] });
        if (maybe(0.08)) add("user", { text: "a steer", origin: "steer" });
        if (maybe(0.08)) add("note", { model: true, text: bad(0.1) ? "" : "a job ended" });
      }
      if (bad(0.05)) add("tool_result", { results: [{ type: "tool_result", tool_use_id: `unknown_${n}`, content: content() }] });
      if (late.length && bad(0.3)) add("tool_result", { results: [{ type: "tool_result", tool_use_id: late.shift().id, content: "late" }] });
      if (calls.length && last) break; // the turn was stopped after its calls
    }
    add("turn_end", { reason: "end_turn" });
    if (maybe(0.15)) {
      // A checkpoint: a summary of everything, one prepared ahead that covers
      // up to an earlier event, or a clear.
      const clean = events.filter((e, i) => e.kind === "turn_end" && i < events.length - 1);
      const covered = faults && maybe(0.5) ? pick(events) : maybe(0.4) && clean.length ? pick(clean) : undefined;
      add("compaction", maybe(0.15) ? { mode: "clear" } : { mode: "summary", summary: "what happened", ...(maybe(0.5) ? { owner_messages: ["prompt 0"] } : {}), ...(covered ? { covered: covered.id } : {}) });
    }
  }
  return events;
}

// The request's messages the way the engine makes them, and the way a hook or
// an import that maps events one to one would (no pairing of its own).
const engineMessages = (events: StoredEvent[]) => resolveAttachments(toMessages(events), { pdf: true, name: "m" });
function plainMessages(events: StoredEvent[]): Message[] {
  const out: Message[] = [];
  for (const e of events) {
    if (e.kind === "user") out.push({ role: "user", content: [...(e.data.images ?? []), text(e.data.text ?? "")] });
    else if (e.kind === "assistant") out.push({ role: "assistant", content: e.data.blocks });
    else if (e.kind === "tool_result") out.push({ role: "user", content: e.data.results });
    else if (e.kind === "note" && e.data.model) out.push({ role: "user", content: [text(e.data.text)] });
    else if (e.kind === "compaction") out.length = 0;
  }
  return resolveAttachments(out, { pdf: true, name: "m" });
}

// The tools a request to `f` declares: its profile, plus (as the engine does,
// withCatalog) a stand-in for each tool a result references.
const declared = (f: Fam, messages: Message[], native = false): ToolSpec[] => {
  const tools = native ? profile(f, true) : PROFILES[f];
  const have = new Set(tools.map((t) => t.name));
  return native ? [...tools, ...[...referenced(messages)].filter((x) => !have.has(x)).map((x) => spec(x, { defer: true }))] : tools;
};
const requests = (messages: Message[], session?: string): { name: string; body: any; problems: string[] }[] => {
  const of = (name: string, f: Fam, native = false) => {
    const t = targets.find((x) => x.name === name)!;
    const body = t.body(messages, declared(f, messages, native), session);
    return { name: `${name}${native ? " (deferred tools)" : ""}`, body, problems: t.problems(body) };
  };
  return [of("anthropic", "claude"), of("anthropic", "claude", true), of("responses", "gpt"), of("responses", "gpt", true), of("responses-xai", "gpt"), of("chat", "other"), of("gemini", "gemini")];
};

const SEEDS = 150;

test("every wire's request from a random history passes the wire's rules", () => {
  const failed: string[] = [];
  let repaired = 0;
  const off = onRepair("test", () => void repaired++);
  for (let seed = 1; seed <= SEEDS; seed++) {
    const events = branch(seed, true);
    const stored = JSON.stringify(events);
    for (const [how, messages] of [["engine", engineMessages(events)], ["plain", plainMessages(events)]] as const) {
      for (const q of requests(messages, `rand-${seed}-${how}`)) if (q.problems.length) failed.push(`seed ${seed} ${how} ${q.name}: ${q.problems.slice(0, 3).join("; ")}`);
    }
    expect(JSON.stringify(events)).toBe(stored); // the stored history is never rewritten
  }
  off();
  expect(failed.slice(0, 12)).toEqual([]);
  expect(repaired).toBeGreaterThan(SEEDS); // the histories did need repairs
});

// The projection as it was before it repaired anything.
function projectBefore(messages: Message[], o: { origin: string; legacyIsMine?: boolean; toolRefs?: boolean }): Message[] {
  const mine = (origin?: string) => (origin ? origin === o.origin : !!o.legacyIsMine);
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const content: any[] = [];
      for (const b of m.content) {
        if (b.type === "thinking") {
          if (!mine(b.origin)) continue;
          content.push({ type: "thinking", thinking: b.thinking, signature: b.signature, opaque: b.opaque, origin: b.origin, bind: b.bind });
        } else if (b.type === "redacted_thinking") {
          if (o.legacyIsMine) content.push(b);
        } else if (b.type === "text") {
          if (!b.text && !(mine(b.origin) && b.signature)) continue;
          content.push(mine(b.origin) && b.signature ? { type: "text", text: b.text, signature: b.signature } : { type: "text", text: b.text });
        } else if (b.type === "tool_use") {
          const t: any = { type: "tool_use", id: portableId(b.id), name: b.name, input: b.input ?? {} };
          if (mine(b.origin) && b.signature) t.signature = b.signature;
          content.push(t);
        }
      }
      if (content.length) out.push({ role: "assistant", content });
    } else {
      const content: any[] = m.content.map((b) => {
        if (b.type !== "tool_result") return b;
        const c = typeof b.content === "string" || o.toolRefs || !b.content.some((x) => x.type === "tool_reference")
          ? b.content
          : b.content.map((x) => (x.type === "tool_reference" ? { type: "text" as const, text: `Tool loaded: ${x.tool_name}` } : x));
        return { ...b, tool_use_id: portableId(b.tool_use_id), content: c };
      });
      if (content.length) out.push({ role: "user", content });
    }
  }
  const merged: Message[] = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) (last.content as any[]).push(...m.content);
    else merged.push(m);
  }
  return merged;
}

test("a history that needs no repair is projected as it was before, with nothing told", () => {
  let repaired = 0;
  const off = onRepair("test", () => void repaired++);
  let results = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const messages = engineMessages(branch(seed, false));
    results += messages.flatMap((m) => m.content as any[]).filter((b) => b.type === "tool_result").length;
    for (const f of FAMILIES) for (const toolRefs of [false, true]) {
      const o = { origin: ORIGIN[f], legacyIsMine: f === "claude", toolRefs };
      expect(JSON.stringify(project(messages, { ...o, sessionKey: `clean-${seed}` }))).toBe(JSON.stringify(projectBefore(messages, o)));
    }
    for (const q of requests(messages, `clean-${seed}`)) expect([seed, q.name, q.problems]).toEqual([seed, q.name, []]);
  }
  off();
  expect(repaired).toBe(0);
  expect(results).toBeGreaterThan(SEEDS);
});

test("the same history gives the same bytes, and a longer one keeps the bytes of its start", () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const events = branch(seed, true);
    for (const messages of [engineMessages(events), plainMessages(events)]) {
      const once = requests(messages).map((q) => JSON.stringify(q.body));
      expect(requests(messages).map((q) => JSON.stringify(q.body))).toEqual(once);
    }
    // One more turn after it: every message but the last (which the next
    // prompt may join) is sent as it was, so the provider's cached prefix holds.
    const more = branch(seed + 10_000, true).filter((e) => e.kind !== "compaction").map((e, i) => ({ ...e, id: `m${i}`, parent: i ? `m${i - 1}` : events.at(-1)!.id }));
    const wire = (evs: StoredEvent[]) => toWire(engineMessages(evs), { origin: ORIGIN.claude, legacyIsMine: true }, null);
    const short = wire(events), long = wire([...events, ...more]);
    expect(JSON.stringify(long.slice(0, Math.max(0, short.length - 1)))).toBe(JSON.stringify(short.slice(0, -1)));
  }
});
