import { expect, test } from "bun:test";
import type { StoredEvent } from "../core/types.ts";
import { claudeTools } from "../tools/claude.ts";
import { pendingAsks, pendingQuestions, relay } from "../tools/interact.ts";
import { relayAnswers } from "./relay.ts";

// The owner answers a question of session A in the helper's conversation; the helper relays his words to A's card.
const ev = (id: string, kind: StoredEvent["kind"], data: Record<string, unknown>): StoredEvent => ({ id, session_id: "helper", seq: 0, ts: 0, kind, data } as StoredEvent);
const line = [
  ev("u1", "user", { text: "Tell the build session: use the staging database, not production." }),
  ev("a1", "assistant", { blocks: [{ type: "text", text: "Use production, I think." }] }),
  ev("d1", "user", { text: "[helper digest] Use production.", kind: "helper_digest" }),
];
const ask = claudeTools.find((t) => t.name === "AskUserQuestion")!;

test("a question card in another session is answered with the owner's quoted words, kept as his with where he said them", async () => {
  const stop = new AbortController();
  const result = ask.run({ questions: [{ question: "Which database?", header: "Database", options: [{ label: "staging", description: "" }, { label: "production", description: "" }], multiSelect: false }] },
    { sessionId: "A", callId: "q-call", cwd: ".", signal: stop.signal, spillDir: ".", seen: new Map() } as any);
  expect(pendingQuestions("A")).toEqual(["q-call"]);
  const qs = pendingAsks("A", "q-call")!;
  expect(qs.map((q) => q.question)).toEqual(["Which database?"]);
  const r = relayAnswers(line, { event: "u1", answers: [{ quote: "use the staging database, not production" }] }, qs);
  if ("refused" in r) throw new Error(r.refused);
  expect(r.answers).toEqual({ 0: { picked: [], other: "use the staging database, not production" } });
  expect(relay("A", "q-call", r.answers, { by: "helper", session: "helper", event: "u1", quotes: r.quotes })).toBe(true);
  const out = await result;
  expect(out.content).toStartWith("The owner answered through his helper: these are his own words, quoted verbatim from his message u1 in the helper's conversation (session helper). Question 0: \"use the staging database, not production\".");
  expect(out.content).toContain('"Which database?"="use the staging database, not production"');
  expect(out.shown).toMatchObject({ relayed: { by: "helper", session: "helper", event: "u1", quotes: { 0: "use the staging database, not production" } } });
  expect(pendingQuestions("A")).toEqual([]);
  // Words that are an option pick it.
  expect(relayAnswers([ev("u2", "user", { text: "staging" })], { event: "u2", answers: [{ quote: "staging" }] }, qs)).toMatchObject({ answers: { 0: { picked: ["staging"] } } });
});

test("words that are not from an owner message of the helper's own conversation are refused", () => {
  const qs = [{ id: "0", question: "Which database?", options: [{ label: "staging" }, { label: "production" }] }];
  // Its own words, its own reply, a harness input, a message that is not there, words not in the message named.
  expect(relayAnswers(line, { event: "u1", answers: [{ quote: "use production" }] }, qs)).toMatchObject({ refused: expect.stringContaining("not in the owner's message u1") });
  expect(relayAnswers(line, { event: "a1", answers: [{ quote: "Use production" }] }, qs)).toMatchObject({ refused: expect.stringContaining("not a message the owner wrote") });
  expect(relayAnswers(line, { event: "d1", answers: [{ quote: "Use production" }] }, qs)).toMatchObject({ refused: expect.stringContaining("not a message the owner wrote") });
  expect(relayAnswers(line, { event: "nope", answers: [{ quote: "staging" }] }, qs)).toMatchObject({ refused: expect.stringContaining("no message nope") });
  expect(relayAnswers(line, { event: "u1", answers: [{ quote: " " }] }, qs)).toMatchObject({ refused: expect.stringContaining("empty") });
  // A card of several questions needs each named and each answered.
  const two = [...qs, { id: "1", question: "When?", options: [{ label: "now" }, { label: "later" }] }];
  expect(relayAnswers(line, { event: "u1", answers: [{ quote: "staging" }] }, two)).toMatchObject({ refused: expect.stringContaining("say which one") });
  expect(relayAnswers(line, { event: "u1", answers: [{ question: "0", quote: "staging" }] }, two)).toMatchObject({ refused: expect.stringContaining("answer no question 1") });
});
