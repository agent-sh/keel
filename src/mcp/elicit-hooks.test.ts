// A server's question and the owner's Elicitation and ElicitationResult hooks: a hook that answers skips the card, a
// hook that says nothing leaves it, and an answer a hook changes is the one the server gets.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allHooks, registerHooks, type ElicitAnswer, type ElicitAsk } from "../engine/hooks.ts";
import { answer, askedOf, decline, pendingQuestions } from "../tools/interact.ts";
import { McpManager } from "./manager.ts";

const before = allHooks().length;
afterEach(() => { allHooks().length = before; });

const manager = () => new McpManager({ capture() {} } as any, mkdtempSync(join(tmpdir(), "keel-mcp-")), "/");
const params = { message: "Which one?", requestedSchema: { type: "object", properties: { color: { type: "string", enum: ["red", "blue"] }, count: { type: "integer" } }, required: ["color"] } };
let n = 0;
// One question on its own call: what the server gets back, and whether a card opened for it.
async function ask(m: McpManager, owner?: (callId: string) => void, mode: "form" | "url" = "form") {
  const callId = `c-hook-${++n}`;
  const ctx: any = { sessionId: "s-hook", callId, signal: new AbortController().signal };
  const call: any = { asked: 0, declined: 0, queued: 0, self: 0, roots: 0, notes: new Set(), readOnly: false };
  const unasked = async () => ({ action: "cancel" as const });
  const run = mode === "url"
    ? (m as any).elicitLink("srv", { mode: "url", message: "Sign in", url: "https://example.com/login", elicitationId: "e1" }, ctx, `s-hook:${callId}`, call)
    : (m as any).elicit("srv", params, ctx, `s-hook:${callId}`, call, unasked);
  let opened = false;
  for (let i = 0; i < 40 && !opened; i++) { opened = pendingQuestions("s-hook").includes(callId); if (!opened) await Bun.sleep(5); }
  if (opened) owner?.(callId);
  return { result: await run, opened };
}
const hooks = (h: { elicitation?: (a: ElicitAsk) => ElicitAnswer | void; elicitationResult?: (a: ElicitAsk, r: ElicitAnswer) => ElicitAnswer | void }, seen: { ask?: ElicitAsk; result?: ElicitAnswer } = {}) =>
  registerHooks({
    elicitation: async (_s, a) => { seen.ask = a; return h.elicitation?.(a); },
    elicitationResult: async (_s, a, r) => { seen.result = r; return h.elicitationResult?.(a, r); },
  });

test("a hook that declines a server's request answers it, and no card opens", async () => {
  const seen: { ask?: ElicitAsk } = {};
  hooks({ elicitation: () => ({ action: "decline" }) }, seen);
  const { result, opened } = await ask(manager());
  expect(result).toEqual({ action: "decline" });
  expect(opened).toBe(false);
  expect(seen.ask).toMatchObject({ server: "srv", mode: "form", message: "Which one?", fields: ["color", "count"] });
});

test("a hook that accepts with content that fits the form answers it; one that does not fit leaves the card", async () => {
  hooks({ elicitation: () => ({ action: "accept", content: { color: "blue", count: 2 } }) });
  expect(await ask(manager())).toEqual({ result: { action: "accept", content: { color: "blue", count: 2 } }, opened: false });
  allHooks().length = before;
  hooks({ elicitation: () => ({ action: "accept", content: { color: "green" } }) });
  const r = await ask(manager(), (id) => answer("s-hook", id, { color: { picked: ["red"] } }, false, askedOf("s-hook", id)!.id));
  expect(r).toEqual({ result: { action: "accept", content: { color: "red" } }, opened: true });
});

test("a hook that says nothing leaves the card, and the owner's answer reaches ElicitationResult, which may change it", async () => {
  const seen: { result?: ElicitAnswer } = {};
  hooks({ elicitationResult: (_a, r) => (r.action === "accept" ? { action: "decline" } : undefined) }, seen);
  const owner = (id: string) => {
    // (The question's id is the card's: the page sends it with the answer.)
    answer("s-hook", id, { color: { picked: ["red"] } }, false, askedOf("s-hook", id)!.id);
  };
  const { result, opened } = await ask(manager(), owner);
  expect(opened).toBe(true);
  expect(seen.result).toEqual({ action: "accept", content: { color: "red" } });
  expect(result).toEqual({ action: "decline" });
});

test("a URL request takes a hook's decline and never its accept", async () => {
  hooks({ elicitation: () => ({ action: "decline" }) });
  expect(await ask(manager(), undefined, "url")).toEqual({ result: { action: "decline" }, opened: false });
  allHooks().length = before;
  const seen: { ask?: ElicitAsk } = {};
  hooks({ elicitation: () => ({ action: "accept" }) }, seen);
  const owner = (id: string) => decline("s-hook", id, askedOf("s-hook", id)!.id);
  const r = await ask(manager(), owner, "url");
  expect(r).toEqual({ result: { action: "decline" }, opened: true });
  expect(seen.ask).toMatchObject({ mode: "url", url: "https://example.com/login", id: "e1", fields: [] });
});

test("an ElicitationResult hook only asks less of the owner: it never turns a decline or a cancel into an accept", async () => {
  hooks({ elicitationResult: () => ({ action: "accept", content: { color: "red" } }) });
  expect((await ask(manager(), (id) => decline("s-hook", id, askedOf("s-hook", id)!.id))).result).toEqual({ action: "decline" });
  // It does not change the content of an accept either.
  const seen: { result?: ElicitAnswer } = {};
  allHooks().length = before;
  hooks({ elicitationResult: () => ({ action: "accept", content: { color: "blue" } }) }, seen);
  const r = await ask(manager(), (id) => answer("s-hook", id, { color: { picked: ["red"] } }, false, askedOf("s-hook", id)!.id));
  expect(r.result).toEqual({ action: "accept", content: { color: "red" } });
  // A cancel from a hook over an accept does hold.
  allHooks().length = before;
  hooks({ elicitationResult: () => ({ action: "cancel" }) });
  const c = await ask(manager(), (id) => answer("s-hook", id, { color: { picked: ["red"] } }, false, askedOf("s-hook", id)!.id));
  expect(c.result).toEqual({ action: "cancel" });
});

test("the hooks are told whether the form asks for a secret", async () => {
  const seen: { ask?: ElicitAsk } = {};
  hooks({ elicitation: () => ({ action: "decline" }) }, seen);
  const secret = { message: "Sign in", requestedSchema: { type: "object", properties: { password: { type: "string" } } } };
  const m = manager();
  const callId = `c-hook-${++n}`;
  const ctx: any = { sessionId: "s-hook", callId, signal: new AbortController().signal };
  const call: any = { asked: 0, declined: 0, queued: 0, self: 0, roots: 0, notes: new Set(), readOnly: false };
  await (m as any).elicit("srv", secret, ctx, `s-hook:${callId}`, call, async () => ({ action: "cancel" }));
  expect(seen.ask).toMatchObject({ fields: ["password"], sensitive: true });
});
