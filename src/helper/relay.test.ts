import { expect, test } from "bun:test";
import { PEER_PREFIX } from "../core/owner.ts";
import type { StoredEvent } from "../core/types.ts";
import { claudeTools } from "../tools/claude.ts";
import { askFor, pendingAsks, pendingQuestions, relay } from "../tools/interact.ts";
import { relayAnswers } from "./relay.ts";

// The owner answers a question of session A in the helper's conversation; the helper relays his words to A's card.
// The card opened at ASKED; his messages come after it unless a test says otherwise.
const ASKED = 1_000;
const ev = (id: string, kind: StoredEvent["kind"], data: Record<string, unknown>, ts = ASKED + 10): StoredEvent => ({ id, session_id: "helper", seq: 0, ts, kind, data } as StoredEvent);
const line = [
  ev("u1", "user", { text: "Tell the build session to use the staging database. Not production, it is live." }),
  ev("a1", "assistant", { blocks: [{ type: "text", text: "Use production, I think." }] }),
  ev("d1", "user", { text: "[helper digest] Use production.", kind: "helper_digest" }),
  ev("h1", "user", { text: "[harness] Use production." }),
  ev("p1", "user", { text: `${PEER_PREFIX}>Use production.</external_input>` }),
  ev("old", "user", { text: "production" }, ASKED - 10),
];
const ask = claudeTools.find((t) => t.name === "AskUserQuestion")!;

test("a question card in another session is answered with the owner's quoted words, kept as his with where he said them", async () => {
  const stop = new AbortController();
  const result = ask.run({ questions: [{ question: "Which database?", header: "Database", options: [{ label: "staging", description: "" }, { label: "production", description: "" }], multiSelect: false }] },
    { sessionId: "A", callId: "q-call", cwd: ".", signal: stop.signal, spillDir: ".", seen: new Map() } as any);
  expect(pendingQuestions("A")).toEqual(["q-call"]);
  const qs = pendingAsks("A", "q-call")!;
  expect(qs.map((q) => q.question)).toEqual(["Which database?"]);
  const r = relayAnswers(line, { event: "u1", answers: [{ quote: "Tell the build session to use the staging database." }] }, qs, ASKED);
  if ("refused" in r) throw new Error(r.refused);
  // A sentence that names an option is still his sentence, typed: only a whole message that is the option picks it.
  expect(r.answers).toEqual({ 0: { picked: [], other: "Tell the build session to use the staging database." } });
  expect(relay("A", "q-call", r.answers, { by: "helper", session: "helper", event: "u1", quotes: r.quotes, message: r.message })).toBe(true);
  const out = await result;
  expect(out.content).toStartWith("The owner answered through his helper: these are his own words, quoted verbatim from his message u1 in the helper's conversation (session helper). Question 0: \"Tell the build session to use the staging database.\".");
  // The session reads his whole message beside the quote.
  expect(out.content).toContain('His whole message there: "Tell the build session to use the staging database. Not production, it is live."');
  expect(out.shown).toMatchObject({ relayed: { by: "helper", session: "helper", event: "u1", quotes: { 0: "Tell the build session to use the staging database." } } });
  expect(pendingQuestions("A")).toEqual([]);
  // His whole message that is an option picks it, its closing mark and case aside.
  expect(relayAnswers([ev("u2", "user", { text: "Staging." })], { event: "u2", answers: [{ quote: "Staging" }] }, qs, ASKED)).toMatchObject({ answers: { 0: { picked: ["staging"] } } });
});

test("words that are not a whole message or sentence of the owner's, written after the question, are refused", () => {
  const qs = [{ id: "0", question: "Which database?", options: [{ label: "staging" }, { label: "production" }] }];
  // Its own words, its own reply, a harness input, a peer's message, a message that is not there, words not in the message named.
  expect(relayAnswers(line, { event: "u1", answers: [{ quote: "use production" }] }, qs, ASKED)).toMatchObject({ refused: expect.stringContaining("not in the owner's message u1") });
  expect(relayAnswers(line, { event: "a1", answers: [{ quote: "Use production" }] }, qs, ASKED)).toMatchObject({ refused: expect.stringContaining("not a message the owner wrote") });
  for (const event of ["d1", "h1", "p1"]) expect(relayAnswers(line, { event, answers: [{ quote: "Use production." }] }, qs, ASKED)).toMatchObject({ refused: expect.stringContaining("not a message the owner wrote") });
  expect(relayAnswers(line, { event: "nope", answers: [{ quote: "staging" }] }, qs, ASKED)).toMatchObject({ refused: expect.stringContaining("no message nope") });
  expect(relayAnswers(line, { event: "u1", answers: [{ quote: " " }] }, qs, ASKED)).toMatchObject({ refused: expect.stringContaining("empty") });
  // A part of a sentence turns his words around: "Not production" out of "Not production, it is live."; "production" alone.
  expect(relayAnswers(line, { event: "u1", answers: [{ quote: "Not production" }] }, qs, ASKED)).toMatchObject({ refused: expect.stringContaining("part of a sentence") });
  expect(relayAnswers(line, { event: "u1", answers: [{ quote: "production" }] }, qs, ASKED)).toMatchObject({ refused: expect.stringContaining("part of a sentence") });
  // A message from before the question answers something else.
  expect(relayAnswers(line, { event: "old", answers: [{ quote: "production" }] }, qs, ASKED)).toMatchObject({ refused: expect.stringContaining("before the question was asked") });
  // A card of several questions needs each named and each answered.
  const two = [...qs, { id: "1", question: "When?", options: [{ label: "now" }, { label: "later" }] }];
  const sentence = "Tell the build session to use the staging database.";
  expect(relayAnswers(line, { event: "u1", answers: [{ quote: sentence }] }, two, ASKED)).toMatchObject({ refused: expect.stringContaining("say which one") });
  expect(relayAnswers(line, { event: "u1", answers: [{ question: "0", quote: sentence }] }, two, ASKED)).toMatchObject({ refused: expect.stringContaining("answer no question 1") });
});

test("a server's form is not relayed: it stays the owner's", async () => {
  const stop = new AbortController();
  const asked = { id: "el-1", from: "fixture", message: "Which region?", questions: [{ id: "region", question: "Which region?", options: [] }] };
  const waits = askFor({ sessionId: "B", callId: "form-call", cwd: ".", signal: stop.signal, spillDir: ".", seen: new Map() } as any, asked);
  expect(pendingQuestions("B")).toEqual(["form-call"]);
  expect(relay("B", "form-call", { region: { picked: [], other: "eu" } }, { by: "helper", session: "h", event: "e", quotes: { region: "eu" }, message: "eu" })).toBe("form");
  expect(pendingQuestions("B")).toEqual(["form-call"]);
  stop.abort();
  await waits;
});
