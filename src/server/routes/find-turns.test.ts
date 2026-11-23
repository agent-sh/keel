import { expect, test } from "bun:test";
import { FindTurns } from "./find-turns.ts";

test("one find a session runs; a newer one replaces the one waiting; an aborted one never runs", async () => {
  const t = new FindTurns();
  expect(await t.turn("s")).toBe(true);
  expect(await t.turn("other")).toBe(true); // another session does not wait
  const second = t.turn("s");
  const third = t.turn("s");
  expect(await second).toBe(false); // replaced while it waited
  const gone = new AbortController();
  const fourth = t.turn("s", gone.signal);
  expect(await third).toBe(false);
  gone.abort();
  expect(await fourth).toBe(false); // given up before it ran
  const fifth = t.turn("s");
  t.done("s");
  expect(await fifth).toBe(true);
  t.done("s");
  t.done("other");
  expect(t.running).toBe(0);
  const late = new AbortController();
  late.abort();
  expect(await t.turn("s", late.signal)).toBe(false);
  expect(t.running).toBe(0);
});
