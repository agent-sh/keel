process.env.KEEL_CONFIG_DIR ??= `${process.env.TMPDIR ?? "."}/keel-helper-cards-config`;
// The helper's answer on another session's card, through the engine: the call waits on its card, the helper allows
// it once on the owner's standing instruction, the call runs once, and its result and the card keep who answered.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const { Store } = await import("../core/store.ts");
const { Bus } = await import("../core/bus.ts");
const { Engine } = await import("../engine/turn.ts");
const { allHooks, registerHooks } = await import("../engine/hooks.ts");
const { Gate } = await import("../safety/gate.ts");
const { fingerprint, HelperCards, SOURCE } = await import("./cards.ts");
const { TOLD_SCHEMA } = await import("./told.ts");
const { bindHelperTools, useHelper } = await import("./tools.ts");
const { toolsFor } = await import("../tools/registry.ts");

const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "helper-cards-"));
const store = new Store(join(dir, "state")), bus = new Bus();
store.migrate(TOLD_SCHEMA);
const ws = join(dir, "ws");
mkdirSync(ws);
const errors = { capture: (_s: string, e: unknown) => ({ message: String(e) }) } as any;
const engine = new Engine(store, bus, {} as any, errors, join(dir, "spill"));
const gate = new Gate(store, bus, () => false);
const registered = allHooks().length;
registerHooks({ beforeTool: (session, c) => (store.session(session.id) ? gate.beforeTool(session, c) : undefined) });
const mine = allHooks().slice(registered);
afterAll(() => {
  useHelper(undefined);
  for (const x of mine) allHooks().splice(allHooks().indexOf(x), 1);
  rmSync(dir, { recursive: true, force: true });
});

// A stand-in helper: its conversation, on, answering cards.
const helperSession = store.createSession({ model: "fixture:m", workspace: ws, title: "Helper" });
let answering = true;
const helper = {
  state: () => ({ on: true, session_id: helperSession.id, mail_every_min: 0, wake_gap_min: 10, last_wake: 0, mail_baseline: true, answer_cards: answering }),
  session: () => store.session(helperSession.id),
  isHelper: (id: string | null | undefined) => id === helperSession.id,
  isCards: (id: string | null | undefined) => !!id && !!store.session(id)?.settings.helper_cards,
  cardsContext: () => store.createSession({ model: "fixture:m", workspace: ws, title: "Helper: approvals", settings: { helper_cards: true } }),
  closeCards: (id: string) => { store.updateSession(id, { archived: true }); },
  changed: () => {},
  deps: { store, bus, errors },
} as any;
// What the cards send the helper, kept here instead of delivered.
const sent: { session: string; text: string; cards: string[] }[] = [];
const send = (session: string, text: string, meta: Record<string, unknown>, opts: { onSent?: (e: any) => void } = {}) => {
  sent.push({ session, text, cards: meta.cards as string[] });
  opts.onSent?.({ id: `input-${sent.length}` });
  return true;
};
// What goes to the owner, by card and the note before its line.
const raised: { id: string; note?: string }[] = [];
// The context a card was sent to: the only session whose answer is taken for it.
const ctxOf = (card: string) => sent.find((x) => x.cards.includes(card))!.session;
const cards = new HelperCards(helper, () => gate, { send: send as any, raise: ((a: any, _silent: boolean, note?: string) => { raised.push({ id: a.id, note }); return undefined; }) as any });

let runs = 0;
const tool = { name: "Bash", description: "", kind: "shell", readOnly: false, input_schema: { type: "object", properties: { command: {} } },
  run: async (input: any) => { runs++; return { content: `ran: ${input.command}` }; } } as any;
const run = (s: any, command: string, id: string) =>
  (engine as any).runTool(s, [tool], { type: "tool_use", id, name: "Bash", input: { command } }, { sessionId: s.id, cwd: ws, signal: new AbortController().signal, spillDir: dir, seen: new Map() }) as Promise<any>;
const open = async (sid: string) => { for (let i = 0; i < 300 && !gate.approvals({ session: sid, pending: true }).length; i++) await Bun.sleep(10); return gate.approvals({ session: sid, pending: true })[0]!; };

test("an allowed card runs the call once and records the helper on the owner's standing instruction", async () => {
  const s = store.createSession({ model: "fixture:m", workspace: ws, title: "Build" });
  gate.setPerm(s.id, { mode: "ask", sandbox: "off" });
  const result = run(s, "npm install left-pad", "call-1");
  const card = await open(s.id);
  // Sent once: the card is kept by its fingerprint, so the same card put back (a restart) is not sent to the helper again.
  expect(cards.take(card.id)).toBe(true);
  expect(sent.at(-1)!.cards).toEqual([card.id]);
  expect(store.db.query("SELECT fp FROM helper_told WHERE key = ?").get(`card:${card.id}`)).toEqual({ fp: fingerprint(card) });
  expect(cards.open().find((c) => c.a.id === card.id)).toMatchObject({ mine: true });
  answering = false;
  // Switched off, the helper's answer is refused.
  expect(cards.answer(card.id, "allow", "routine install", { session: ctxOf(card.id), call: "h1" })).toMatchObject({ error: expect.stringContaining("off") });
  answering = true;
  // Only the context the card was sent to answers it: not the session, not the helper's own conversation.
  expect(cards.answer(card.id, "allow", "routine install", { session: s.id })).toHaveProperty("error");
  expect(cards.answer(card.id, "allow", "routine install", { session: helperSession.id })).toHaveProperty("error");
  expect(ctxOf(card.id)).not.toBe(helperSession.id);
  expect(cards.answer(card.id, "allow", "routine install", { session: ctxOf(card.id), call: "h1" })).toEqual({ ok: expect.stringContaining("Allowed once") });
  const r = await result;
  expect(r.content).toBe("ran: npm install left-pad");
  expect(runs).toBe(1);
  // The call's line keeps who answered its card; the card keeps who, the instruction and its source, and the reason.
  expect((engine as any).shown.get("call-1")).toMatchObject({ card: { by: "helper", choice: "once", reason: "routine install", helper_session: ctxOf(card.id) } });
  expect(gate.approval(card.id)).toMatchObject({ state: "allowed", choice: "once", by: { client: "helper", helper: { session: ctxOf(card.id), call: "h1", source: SOURCE, reason: "routine install" } } });
  // In the chain of cards too (the audit record): the answered version is a link of its own.
  const sealed = store.db.query<{ data: string }, [string]>("SELECT data FROM seal_cards WHERE session_id = ? ORDER BY ts").all(s.id).map((x) => JSON.parse(x.data));
  expect(sealed.at(-1)).toMatchObject({ id: card.id, state: "allowed", by: { client: "helper" } });
  // Nothing more was granted: the same call asks again.
  const again = run(s, "npm install left-pad", "call-2");
  const second = await open(s.id);
  expect(second.id).not.toBe(card.id);
  expect(cards.take(second.id)).toBe(true);
  expect(cards.answer(second.id, "deny", "", { session: ctxOf(second.id) })).toMatchObject({ error: expect.stringContaining("reason") });
  expect(cards.answer(second.id, "deny", "installed already", { session: ctxOf(second.id) })).toHaveProperty("ok");
  expect((await again).content).toContain("Refused by the Helper (on the owner's standing instruction): installed already");
  expect(runs).toBe(1);
});

test("after the helper denied a session's last three cards in a row, its next one is the owner's", async () => {
  const s = store.createSession({ model: "fixture:m", workspace: ws, title: "Loop" });
  gate.setPerm(s.id, { mode: "ask", sandbox: "off" });
  for (let i = 0; i < 3; i++) {
    const r = run(s, `npm install pkg-${i}`, `deny-${i}`);
    const card = await open(s.id);
    expect(cards.take(card.id)).toBe(true);
    expect(cards.answer(card.id, "deny", "not needed", { session: ctxOf(card.id) })).toHaveProperty("ok");
    await r;
  }
  const r = run(s, "npm install pkg-3", "deny-3");
  const card = await open(s.id);
  expect(cards.take(card.id)).toBe("The Helper denied this session's last 3 requests, so this one is yours.");
  gate.resolve(card.id, s.id, { choice: "deny" });
  await r;
});

test("the helper answers only a card sent to it while it is with it: one never sent, or gone back to the owner, is his", async () => {
  const s = store.createSession({ model: "fixture:m", workspace: ws, title: "Hand back" });
  gate.setPerm(s.id, { mode: "ask", sandbox: "off" });
  // Opened while answering was off: never sent to the helper, so never its.
  answering = false;
  const first = run(s, "npm install never-sent", "back-1");
  const never = await open(s.id);
  expect(cards.take(never.id)).toBe(false);
  answering = true;
  expect(cards.open().find((c) => c.a.id === never.id)).toMatchObject({ mine: false, text: expect.stringContaining("it was not sent to you, or it went back to him") });
  expect(cards.answer(never.id, "allow", "fine", { session: sent[0]!.session })).toMatchObject({ error: expect.stringContaining("not yours to answer") });
  gate.resolve(never.id, s.id, { choice: "deny" });
  await first;
  // Sent, then gone back to the owner (its turn ended, it timed out, it left it): no longer the helper's.
  const second = run(s, "npm install handed-back", "back-2");
  const back = await open(s.id);
  expect(cards.take(back.id)).toBe(true);
  cards.toOwner(back.id, "The Helper did not answer it in time.");
  expect(raised.at(-1)).toEqual({ id: back.id, note: "The Helper did not answer it in time." });
  expect(cards.open().find((c) => c.a.id === back.id)).toMatchObject({ mine: false });
  expect(cards.answer(back.id, "allow", "fine", { session: ctxOf(back.id) })).toMatchObject({ error: expect.stringContaining("went back to the owner") });
  expect(gate.approval(back.id)!.state).toBe("pending");
  gate.resolve(back.id, s.id, { choice: "deny" });
  await second;
});

test("a card is answered in a fresh context of the helper's own: no history, no tool but the answer, closed when its turn ends", async () => {
  cards.install();
  try {
    const s = store.createSession({ model: "fixture:m", workspace: ws, title: "Context" });
    gate.setPerm(s.id, { mode: "ask", sandbox: "off" });
    const call = run(s, "npm install in-context", "ctx-1");
    const card = await open(s.id);
    expect(cards.take(card.id)).toBe(true);
    const ctx = store.session(ctxOf(card.id))!;
    expect(ctx).toMatchObject({ settings: { helper_cards: true }, archived: false });
    expect(store.events(ctx.id)).toEqual([]);
    // Its tools: the cards and its answer, nothing else (no mail, calendar, web, shell, files, other sessions).
    bindHelperTools(helper);
    expect(toolsFor("claude", false, ctx.id).map((t) => t.name).sort()).toEqual(["helper__approval", "helper__approvals"]);
    const main = toolsFor("claude", false, helperSession.id).map((t) => t.name);
    expect(main).toContain("mail__read");
    expect(main).not.toContain("helper__approval");
    // And in code: a call of any other tool there is refused by the gate.
    const bash = { ...tool, name: "Bash" };
    const refused = await gate.beforeTool(ctx, { id: "x", tool: bash, input: { command: "ls" }, ctx: { sessionId: ctx.id, cwd: ws, signal: new AbortController().signal, spillDir: dir, seen: new Map() } } as any);
    expect(refused).toMatchObject({ deny: expect.stringContaining("only answers approval cards") });
    // Its turn ended without an answer: the card goes to the owner and the context is closed.
    bus.emit({ t: "event", event: { id: "e", session_id: ctx.id, seq: 1, ts: Date.now(), kind: "turn_end", data: {} } as any });
    expect(raised.at(-1)).toEqual({ id: card.id, note: "The Helper ended its turn without answering it." });
    expect(store.session(ctx.id)!.archived).toBe(true);
    expect(cards.answer(card.id, "allow", "late", { session: ctx.id })).toHaveProperty("error");
    gate.resolve(card.id, s.id, { choice: "deny" });
    await call;
  } finally { cards.stop(); }
});
