import { expect, test } from "bun:test";
import { answer, askFor, askedOf, closedQuestions, decline, DECLINED, pendingQuestions } from "./interact.ts";

const ctx = (callId: string): any => ({ sessionId: "s-interact", callId, signal: new AbortController().signal });
const asked = (id: string, extra: object = {}) => ({ id, from: "srv", message: "m", questions: [{ id: "pw", question: "Password", options: [] }], ...extra });

test("a server's question can be declined, and what was typed for it is not kept", async () => {
  const t0 = Date.now();
  // The model's own question: answered, and the answer is kept for a card opened elsewhere.
  const own = askFor(ctx("c-own"));
  expect(decline("s-interact", "c-own")).toBe(false); // only a server's question is declined
  expect(answer("s-interact", "c-own", { 0: { picked: ["Teal"] } })).toBe(true);
  expect(await own).toEqual({ 0: { picked: ["Teal"] } });

  const first = askFor(ctx("c-srv"), asked("q1"));
  expect(askedOf("s-interact", "c-srv")?.id).toBe("q1");
  // An answer names the question it is for: one with no id, or another question's, is not taken.
  expect(answer("s-interact", "c-srv", { pw: { picked: [], other: "hunter2" } })).toBe("stale");
  expect(answer("s-interact", "c-srv", { pw: { picked: [], other: "hunter2" } }, false, "q1")).toBe(true);
  expect(await first).toEqual({ pw: { picked: [], other: "hunter2" } });
  // The next question on the same call is a new entry with its own id: the
  // same answer sent again, or a decline of the first, does not land on it.
  const second = askFor(ctx("c-srv"), asked("q2"));
  expect(askedOf("s-interact", "c-srv")?.id).toBe("q2");
  expect(answer("s-interact", "c-srv", { pw: { picked: [], other: "hunter2" } }, true, "q1")).toBe("stale");
  expect(decline("s-interact", "c-srv", "q1")).toBe("stale");
  expect(pendingQuestions("s-interact")).toEqual(["c-srv"]);
  expect(decline("s-interact", "c-srv", "q2")).toBe(true);
  expect(await second).toBe(DECLINED);
  expect(pendingQuestions("s-interact")).toEqual([]);

  const closed = closedQuestions(t0).filter((q) => q.session_id === "s-interact");
  expect(closed.map((q) => [q.call_id, q.answered, q.answers])).toEqual([["c-own", true, { 0: { picked: ["Teal"] } }], ["c-srv", true, undefined], ["c-srv", false, undefined]]);
  expect(JSON.stringify(closed)).not.toContain("hunter2");
});

test("a form that asks for what looks like a secret takes an answer only on the owner's word", async () => {
  const q = askFor(ctx("c-secret"), asked("q3", { sensitive: true }));
  expect(answer("s-interact", "c-secret", { pw: { picked: [], other: "x" } }, false, "q3")).toBe("unsent");
  expect(pendingQuestions("s-interact")).toEqual(["c-secret"]);
  // The owner's "send anyway" is for that question too.
  expect(answer("s-interact", "c-secret", { pw: { picked: [], other: "x" } }, true, "q0")).toBe("stale");
  expect(answer("s-interact", "c-secret", { pw: { picked: [], other: "x" } }, true, "q3")).toBe(true);
  expect(await q).toEqual({ pw: { picked: [], other: "x" } });
});
