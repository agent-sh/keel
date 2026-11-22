// What the daemon's answer to a send means for the message: a refusal the daemon made is a certain
// non-send (the draft is kept and says why), anything else may have arrived.
import { expect, test } from "bun:test";
import { daemonAway, messageRefused } from "./send-refusal.ts";

const answer = (status: number, body: object, path = "/api/sessions/s1/messages") => ({ status, body, path });

test("a send the daemon turned away is not one that may have arrived", () => {
  // The store takes no writes (its disk does not answer): not taken, said with the reason.
  const refusing = answer(503, { error: "the daemon's disk does not answer and its store takes no writes", store_refusing: true });
  expect(messageRefused(refusing, "s1")).toBe(true);
  // It waits on its shelf and goes out by itself when the store takes writes again, as one a restarting daemon turned away does.
  expect(daemonAway(refusing)).toBe(true);
  expect(daemonAway(answer(503, { error: "the daemon is restarting", draining: true }))).toBe(true);
  expect(daemonAway(answer(503, { error: "upstream" }))).toBe(false);
  expect(messageRefused(answer(503, { error: "the daemon is restarting", draining: true }), "s1")).toBe(true);
  // A 503 of anything else (a proxy, a fault after the prompt was stored) may have arrived.
  expect(messageRefused(answer(503, { error: "upstream" }), "s1")).toBe(false);
  expect(messageRefused(answer(500, { error: "attempt to write a readonly database" }), "s1")).toBe(false);
});
