// A history a wire takes as it is stored is sent as it is stored: the repairs
// of the projection (src/providers/project.ts) change no byte of it. Checked
// against the projection as it was before it repaired anything: one session
// on the real engine and store (four stand-in providers that run the real wire
// codecs over scripted events) is sent to every wire at every point of its
// history, and each request body is compared with a golden hash captured from
// that earlier projection (identity.golden.json names the commit).
//
// The session covers a prompt with an image, thinking, a parallel batch with
// an image read, a steer and an agent's report that join after a tool result,
// a stop while a tool runs, ToolSearch loading a deferred tool, a compaction,
// a crash and the start after it, and a move through the four families and
// back. Its Gemini server sends call ids the way the reader made them for a
// server that sends none: the same call in two steps has one id. No wire
// refuses that, so no body of this session differs from the golden.
//
// The golden covers the conversation a body carries. The tool list and the
// system prompt are left out of the hash: they are the caller's, not the
// projection's, and change with every edited tool description.
//
// To capture again (after a change to what the engine writes, never to hide a
// difference): on the commit to compare with,
//   KEEL_IDENTITY_GOLDEN=write bun test src/providers/wires/identity.test.ts
import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Nothing here reads the owner's configuration or reaches an integration.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "keel-identity-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
Object.assign(process.env, {
  KEEL_CONFIG_DIR: join(ROOT, "config"), KEEL_STATE_DIR: join(ROOT, "state-unused"), KEEL_DESKTOP_NOTIFY: "off",
  KEEL_IMPORT_HOME: join(ROOT, "import/home"), KEEL_IMPORT_CLAUDE_DIR: join(ROOT, "import/claude"), KEEL_IMPORT_CODEX_DIR: join(ROOT, "import/codex"),
  KEEL_IMPORT_AGY_DIR: join(ROOT, "import/agy"), KEEL_IMPORT_KEEL_DB: join(ROOT, "import/keel.db"), KEEL_IMPORT_HERMES_DIR: join(ROOT, "import/hermes"),
  KEEL_MCP_REGISTRY: `file://${ROOT}/registry.json`, KEEL_PHONE_SOCKET: join(ROOT, "phone/phone.sock"), TACIT_BIN: "/bin/false",
});
const { Bus } = await import("../../core/bus.ts");
const { Store } = await import("../../core/store.ts");
const { Engine, toMessages } = await import("../../engine/turn.ts");
const { resolveAttachments, setAttachmentsRoot } = await import("../../engine/attachments.ts");
const { ctxFor, runEvents } = await import("../drive.ts");
const { anthropicWire } = await import("./anthropic.ts");
const { chatWire } = await import("./chat.ts");
const { geminiWire } = await import("./gemini.ts");
const { responsesWire } = await import("./responses.ts");

const GOLDEN = join(import.meta.dir, "identity.golden.json");
const WRITE = process.env.KEEL_IDENTITY_GOLDEN === "write";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// ---- the stand-in providers: scripted replies as each wire's own events ----

type B = { t: "thinking"; text: string } | { t: "text"; text: string } | { t: "tool"; name: string; input: any };
type Reply = { blocks: B[]; hold?: Promise<void> };
const text = (t: string): B => ({ t: "text", text: t });
const think = (t: string): B => ({ t: "thinking", text: t });
const tool = (name: string, input: any): B => ({ t: "tool", name, input });

let n = 0;
const ev = (o: any) => ({ data: JSON.stringify(o) });
function events(wire: string, r: Reply): { data: string }[] {
  const stop = r.blocks.some((b) => b.t === "tool") ? "tool_use" : "end_turn";
  if (wire === "anthropic_messages") {
    const out = [ev({ type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1 } } })];
    r.blocks.forEach((b, i) => {
      if (b.t === "thinking") {
        out.push(ev({ type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "" } }));
        out.push(ev({ type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: b.text } }));
        out.push(ev({ type: "content_block_delta", index: i, delta: { type: "signature_delta", signature: `sig-${++n}` } }));
      } else if (b.t === "text") {
        out.push(ev({ type: "content_block_start", index: i, content_block: { type: "text", text: "" } }));
        out.push(ev({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text } }));
      } else {
        out.push(ev({ type: "content_block_start", index: i, content_block: { type: "tool_use", id: `toolu_${String(++n).padStart(6, "0")}`, name: b.name, input: {} } }));
        out.push(ev({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } }));
      }
    });
    return [...out, ev({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 20 } }), ev({ type: "message_stop" })];
  }
  if (wire === "openai_responses") {
    return [...r.blocks.map((b, i) => ev({
      type: "response.output_item.done", output_index: i,
      item: b.t === "thinking" ? { type: "reasoning", id: `rs_${++n}`, summary: [{ type: "summary_text", text: b.text }], encrypted_content: `enc-${n}` }
        : b.t === "text" ? { type: "message", content: [{ type: "output_text", text: b.text }] }
        : { type: "function_call", call_id: `call_${String(++n).padStart(6, "0")}`, name: b.name, arguments: JSON.stringify(b.input) },
    })), ev({ type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 20 } } })];
  }
  if (wire === "gemini_generate_content") {
    // The id the reader gave a call of a server that sends none, until ids
    // became one per reply: the call's place in its reply and a hash of it.
    // Stored histories hold these, the same one for the same call in two steps.
    let k = 0;
    const parts = r.blocks.map((b) => b.t === "thinking" ? { thought: true, text: b.text, thoughtSignature: `gsig-${++n}` } : b.t === "text" ? { text: b.text }
      : { functionCall: { id: `call_${k++}_${Bun.hash(JSON.stringify({ name: b.name, args: b.input })).toString(36)}`, name: b.name, args: b.input } });
    return [ev({ candidates: [{ content: { parts }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } })];
  }
  const delta: any = {};
  for (const b of r.blocks) {
    if (b.t === "thinking") delta.reasoning_content = (delta.reasoning_content ?? "") + b.text;
    else if (b.t === "text") delta.content = (delta.content ?? "") + b.text;
    else (delta.tool_calls ??= []).push({ index: delta.tool_calls.length, id: `chatcall_${String(++n).padStart(6, "0")}`, function: { name: b.name, arguments: JSON.stringify(b.input) } });
  }
  return [ev({ choices: [{ delta }] }), ev({ choices: [{ delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { data: "[DONE]" }];
}

type Capture = { provider: string; purpose: string; req: any };
const captures: Capture[] = [];
const scripts: Reply[] = [];
const problems: string[] = [];
const untilStopped = (req: any) => new Promise<void>((_, reject) => {
  const stop = () => reject(Object.assign(new Error("interrupted"), { name: "AbortError" }));
  if (req.signal?.aborted) stop(); else req.signal?.addEventListener("abort", stop, { once: true });
});
const spec = (t: any) => ({ name: t.name, description: t.description, input_schema: t.input_schema, ...(t.freeform ? { freeform: t.freeform } : {}), ...(t.defer ? { defer: true } : {}), ...(t.namespace ? { namespace: t.namespace } : {}), ...(t.search ? { search: true } : {}) });

function fake(id: string, wire: string, family: string, codec: any, legacy = false) {
  const model = `${family}-x`;
  const info = { id: `${id}:${model}`, provider: id, model, name: `Fake ${family}`, family, context: 1_000_000, output: 8_000, efforts: [], billing: "unknown", images: true, pdf: true };
  const provider = {
    id, wire, family, available: () => true, list: async () => [],
    stream: async (req: any, onDelta: any) => {
      captures.push({ provider: id, purpose: req.purpose ?? "turn", req: { model: req.model, system: req.system, systemSplit: req.systemSplit, cache: req.cache, cacheLife: req.cacheLife, effort: req.effort, maxTokens: req.maxTokens, sessionKey: req.sessionKey, purpose: req.purpose, messages: JSON.parse(JSON.stringify(req.messages)), tools: req.tools.map(spec) } });
      let r: Reply;
      if (req.purpose === "summary") r = { blocks: [text("Goal: check request bytes. State: several tool rounds ran; next, answer the newest prompt.")] };
      else {
        const next = scripts.shift();
        if (!next) problems.push(`no scripted reply for request ${captures.length} (${id})`);
        r = next ?? { blocks: [text("unscripted")] };
      }
      if (r.hold) await Promise.race([r.hold, untilStopped(req)]);
      return runEvents(codec, req, ctxFor(id, req, [], legacy), onDelta, async function* () { for (const e of events(wire, r)) yield e; });
    },
  };
  return { provider, info };
}
const models = [
  fake("fake-anthropic", "anthropic_messages", "claude", anthropicWire, true),
  fake("fake-codex", "openai_responses", "gpt", responsesWire("codex")),
  fake("fake-gemini", "gemini_generate_content", "gemini", geminiWire({ sentinel: true, thinking: true })),
  fake("fake-chat", "chat_completions", "other", chatWire({ replayReasoning: true })),
];
const [CLAUDE, GPT, GEMINI, CHAT] = models.map((m) => m.info.id) as [string, string, string, string];
const providers = {
  resolve: async (model: string) => models.find((x) => x.info.id === model) ?? (() => { throw new Error(`no model ${model}`); })(),
  models: async () => models.map((m) => m.info), current: () => models.map((m) => m.info),
};
const errors = { capture: (source: string, e: unknown) => { problems.push(`[${source}] ${(e as Error)?.message ?? e}`); return { id: "captured", message: String((e as Error)?.message ?? e) }; } };

// ---- the session ----

async function session() {
  const state1 = join(ROOT, "state1"), state2 = join(ROOT, "state2"), ws = join(ROOT, "ws");
  mkdirSync(state1, { recursive: true });
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "shot.png"), Buffer.from(PNG, "base64"));
  writeFileSync(join(ws, "notes.txt"), "line one\nline two\n");
  const boot = (dir: string) => {
    const store = new Store(dir);
    setAttachmentsRoot(dir);
    const engine = new Engine(store, new Bus(), providers as any, errors as any, join(dir, "spill"));
    (engine as any).systemOf = async () => ({ text: "A stand-in system prompt.", split: 0 });
    return { store, engine };
  };
  let { store, engine } = boot(state1);
  const id = store.createSession({ model: CLAUDE, workspace: ws }).id;
  const turn = async (prompt: string, opts: any, ...replies: Reply[]) => { scripts.push(...replies); engine.send(id, prompt, opts); await engine.idle(id); };
  const waitFile = (f: string) => `while [ ! -f ${f} ]; do sleep 0.05; done; echo went`;
  const line = () => engine.lineage(id) as any[];
  const until = async (cond: () => boolean, what: string) => { for (let i = 0; i < 1200 && !cond(); i++) await Bun.sleep(25); if (!cond()) problems.push(`timed out waiting for ${what}`); };

  // An image with the prompt, thinking, one call, then a parallel batch with an image read.
  await turn("look at this picture", { images: [{ type: "image", media_type: "image/png", data: PNG }] },
    { blocks: [think("I should look around."), text("Looking."), tool("Bash", { command: "echo one" })] },
    { blocks: [tool("Bash", { command: "echo two" }), tool("Bash", { command: "echo three" }), tool("Read", { file_path: join(ws, "shot.png") })] },
    { blocks: [text("Done with the first part.")] });

  // A steer and an agent's report join the turn after the tool result.
  scripts.push({ blocks: [think("A long job."), tool("Bash", { command: waitFile("go-steer") })] }, { blocks: [text("Took the steer and the report.")] });
  engine.send(id, "run the long job", {});
  await until(() => line().at(-1)?.kind === "assistant" && line().at(-1).data.blocks.some((b: any) => b.type === "tool_use"), "the long job's call");
  engine.send(id, "steer: also check the logs", { mode: "steer" });
  engine.send(id, "[harness] A subagent you started has reported.\n<report>all good</report>", { mode: "steer", meta: { kind: "subagent", agent_id: "a1", report_id: "r1", status: "done" } });
  writeFileSync(join(ws, "go-steer"), "");
  await engine.idle(id);

  // Stopped by the owner while one tool of a batch still runs.
  scripts.push({ blocks: [text("Starting a slow one."), tool("Bash", { command: "sleep 30" }), tool("Bash", { command: "echo beside" })] });
  engine.send(id, "run something slow", {});
  await until(() => line().at(-1)?.kind === "tool_result", "the quick call beside the slow one");
  await engine.interrupt(id, "owner");
  await engine.idle(id);

  // A deferred tool loaded by the tool search, then used.
  await turn("load a deferred tool", {}, { blocks: [tool("ToolSearch", { query: "select:WebFetch,Glob" })] }, { blocks: [tool("Glob", { pattern: "*.txt" })] }, { blocks: [text("Loaded and used.")] });

  // A compaction checkpoint, then work after it.
  await engine.compactNow(id);
  await turn("after the compaction", {}, { blocks: [think("Fresh start."), tool("Bash", { command: "echo five" })] }, { blocks: [text("Five.")] });

  // A crash: the state as it was while a tool ran, and the start after it.
  scripts.push({ blocks: [think("Before the crash."), tool("Bash", { command: waitFile("go-crash") }), tool("Bash", { command: "echo fast" })] }, { blocks: [text("the old daemon's own ending, never stored in the copy")] });
  engine.send(id, "work across a crash", {});
  await until(() => line().at(-1)?.kind === "tool_result", "the quick call before the crash");
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  cpSync(state1, state2, { recursive: true });
  writeFileSync(join(ws, "go-crash"), "");
  await engine.idle(id);
  scripts.length = 0;
  ({ store, engine } = boot(state2));
  scripts.push({ blocks: [text("Continued after the crash.")] });
  await engine.recover(store.bootWorking, async () => {});
  await until(() => line().at(-1)?.kind === "turn_end" && line().some((e) => e.kind === "assistant" && JSON.stringify(e.data.blocks).includes("Continued after the crash.")), "the turn continued after the crash");
  await engine.idle(id);

  // A GPT model on the Responses wire: its request holds the search result Claude wrote.
  store.updateSession(id, { model: GPT });
  await turn("now you are another model", {}, { blocks: [think("Reasoning summary."), text("Looking it up."), tool("lookup_weather", { city: "Oslo" })] }, { blocks: [text("No such tool here.")] });

  // Gemini, whose server sends no call ids: the same call in three steps.
  store.updateSession(id, { model: GEMINI });
  const seven = tool("run_shell_command", { command: "echo seven" });
  await turn("and another family", {}, { blocks: [think("Gemini thought."), seven] }, { blocks: [seven] }, { blocks: [seven, tool("run_shell_command", { command: "echo eight" })] }, { blocks: [text("Seven, three times.")] });

  // A Chat Completions model, then Claude again.
  store.updateSession(id, { model: CHAT });
  await turn("a chat completions model", {}, { blocks: [think("Chat reasoning."), text("Calling."), tool("Bash", { command: "echo nine" })] }, { blocks: [text("Nine.")] });
  store.updateSession(id, { model: CLAUDE });
  await turn("back to the first model", { images: [{ type: "image", media_type: "image/png", data: PNG }] }, { blocks: [think("Home again."), tool("Bash", { command: "echo ten" })] }, { blocks: [text("Ten.")] });

  return { id, events: line(), left: scripts.length };
}

// The results of one step are stored as each call settles, in any order: put
// each run of them in the order of their calls, so a prefix of the branch is
// the same in every run.
function inCallOrder(line: any[]): any[] {
  const out: any[] = [];
  let order: string[] = [];
  for (let i = 0; i < line.length; i++) {
    const e = line[i];
    if (e.kind === "assistant") order = e.data.blocks.filter((b: any) => b.type === "tool_use").map((b: any) => b.id);
    if (e.kind !== "tool_result") { out.push(e); continue; }
    let j = i;
    while (j + 1 < line.length && line[j + 1].kind === "tool_result") j++;
    const at = (x: any) => { const k = order.indexOf(x.data.results[0]?.tool_use_id); return k < 0 ? order.length : k; };
    out.push(...line.slice(i, j + 1).sort((a, b) => at(a) - at(b)));
    i = j;
  }
  return out;
}

// ---- every wire's body, as a hash of the conversation it carries ----

const WIRES: Record<string, { codec: any; origin: string; provider: string; legacy?: boolean }> = {
  anthropic: { codec: anthropicWire, origin: CLAUDE, provider: "fake-anthropic", legacy: true },
  "responses-codex": { codec: responsesWire("codex"), origin: GPT, provider: "fake-codex" },
  "responses-openai": { codec: responsesWire("openai"), origin: GPT, provider: "fake-codex" },
  "responses-xai": { codec: responsesWire("xai"), origin: "fake-xai:grok-x", provider: "fake-codex" },
  chat: { codec: chatWire({ replayReasoning: true }), origin: CHAT, provider: "fake-chat" },
  "chat-plain": { codec: chatWire({}), origin: CHAT, provider: "fake-chat" },
  gemini: { codec: geminiWire({ sentinel: true, thinking: true }), origin: GEMINI, provider: "fake-gemini" },
  "gemini-plain": { codec: geminiWire({}), origin: GEMINI, provider: "fake-gemini" },
};
type Rules = Record<string, unknown> | undefined;
function bodyOf(wire: string, req: any, rules: Rules): any {
  const w = WIRES[wire]!;
  const before = JSON.stringify(req.messages);
  const body = w.codec.body({ ...req, signal: new AbortController().signal }, { origin: w.origin, sessionKey: req.sessionKey ?? "", efforts: [], legacyIsMine: w.legacy, rules });
  if (JSON.stringify(req.messages) !== before) throw new Error(`the ${wire} wire changed the messages it was given`);
  return body;
}
const hashOf = (body: any, session: string): string => {
  const { tools: _tools, system: _system, instructions: _instructions, systemInstruction: _si, ...rest } = body;
  return Bun.hash(JSON.stringify(rest).replaceAll(ROOT, "<root>").replaceAll(session, "<session>")).toString(36);
};

test("each wire's request for a history it takes as stored is the bytes it was before the repairs", async () => {
  const run = await session();
  expect(problems).toEqual([]);
  expect(run.left).toBe(0);
  const line = inCallOrder(run.events);
  setAttachmentsRoot(join(ROOT, "state2"));
  const toolsOf = (p: string) => captures.findLast((c) => c.provider === p && c.purpose === "turn")!.req.tools;
  // What is sent: every request the engine made, to every wire, then the
  // request at every point of the branch (a side question, a summary or a
  // turn can start at any of them; a point inside a batch has stand-in results).
  const requests: { key: string; req: any }[] = captures.map((c, i) => ({ key: `request ${i} (${c.provider}, ${c.purpose})`, req: c.req }));
  for (let k = 1; k <= line.length; k++) {
    const messages = resolveAttachments(toMessages(line.slice(0, k)), { pdf: true, name: "m" } as any);
    if (messages.length) requests.push({ key: `event ${k} (${line[k - 1].kind})`, req: { model: "m", system: "sys", sessionKey: run.id, messages } });
  }
  const made: Record<string, string[]> = {};
  const bodies = (rules: Rules) => Object.keys(WIRES).flatMap((wire) => requests.map(({ key, req }) => ({ wire, key, body: bodyOf(wire, req.tools ? req : { ...req, tools: toolsOf(WIRES[wire]!.provider) }, rules) })));

  if (WRITE) {
    for (const b of bodies(undefined)) (made[b.wire] ??= []).push(hashOf(b.body, run.id));
    const commit = (await Bun.$`git rev-parse HEAD`.text()).trim();
    // One line per wire.
    const head = JSON.stringify({ commit, requests: requests.length, events: line.length, kinds: line.map((e) => e.kind[0]).join("") }).slice(0, -1);
    writeFileSync(process.env.KEEL_IDENTITY_OUT ?? GOLDEN, `${head},"wires":{\n${Object.entries(made).map(([w, h]) => `${JSON.stringify(w)}:${JSON.stringify(h)}`).join(",\n")}\n}}\n`);
    return;
  }

  const golden = await Bun.file(GOLDEN).json();
  // The same session as when the golden was captured.
  expect({ requests: requests.length, events: line.length, kinds: line.map((e) => e.kind[0]).join("") }).toEqual({ requests: golden.requests, events: golden.events, kinds: golden.kinds });
  // It holds what it is here for: one call id on calls of several steps.
  const ids = line.flatMap((e) => (e.kind === "assistant" ? e.data.blocks : [])).flatMap((b: any) => (b.type === "tool_use" ? [b.id] : []));
  expect(ids.length - new Set(ids).size).toBeGreaterThanOrEqual(2);

  const { anthropicProblems, chatProblems, geminiProblems, responsesProblems } = await import("./valid.ts");
  const check: Record<string, (b: any) => string[]> = {
    anthropic: anthropicProblems, "responses-codex": (b) => responsesProblems(b, "codex"), "responses-openai": (b) => responsesProblems(b, "openai"), "responses-xai": (b) => responsesProblems(b, "xai"),
    chat: chatProblems, "chat-plain": chatProblems, gemini: geminiProblems, "gemini-plain": geminiProblems,
  };
  const text = (body: any) => { const { tools: _t, system: _s, instructions: _i, systemInstruction: _g, ...rest } = body; return JSON.stringify(rest); };
  const stored = bodies({});
  const failed: string[] = [];
  bodies(undefined).forEach((b, i) => {
    const want = golden.wires[b.wire][i % requests.length];
    // With nothing repaired the projection is the earlier one, byte for byte.
    if (hashOf(stored[i]!.body, run.id) !== want) failed.push(`${b.wire}, ${b.key}: the body with nothing repaired is not the golden's (what the engine writes changed, or the projection did): ${text(stored[i]!.body).slice(0, 200)}`);
    // With the wire's repairs it is still that body: this session holds nothing a wire refuses.
    else if (hashOf(b.body, run.id) !== want) {
      const was = text(stored[i]!.body), now = text(b.body);
      let at = 0;
      while (at < was.length && was[at] === now[at]) at++;
      failed.push(`${b.wire}, ${b.key}: a repair changed a body the wire takes as stored, at byte ${at}:\n  stored: ${was.slice(Math.max(0, at - 80), at + 120)}\n  sent:   ${now.slice(Math.max(0, at - 80), at + 120)}`);
    }
    const bad = check[b.wire]!(b.body);
    if (bad.length) failed.push(`${b.wire}, ${b.key}: the wire refuses it: ${bad[0]}`);
  });
  if (failed.length) throw new Error(`${failed.length} of ${stored.length} bodies differ. The first:\n${failed.slice(0, 4).join("\n")}`);
  console.log(`identity: ${stored.length} bodies on ${Object.keys(WIRES).length} wires, all as before the repairs`);
}, 120_000);
