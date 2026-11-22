// A covered view's readers: what they read and when they are told.
import { expect, test } from "bun:test";
import { makeGate } from "./cover.ts";

test("readers under a cover read the store as it was, and are told once when the cover leaves", () => {
  let state = { n: 1 };
  const subs = new Set<() => void>();
  const change = (n: number) => { state = { n }; subs.forEach((f) => f()); };
  const gate = makeGate((f) => (subs.add(f), () => void subs.delete(f)), () => state);
  let told = 0;
  const off = gate.subscribe(() => told++);
  const read = () => (gate.held ?? state).n;

  change(2);
  expect([told, read()]).toEqual([1, 2]);
  gate.set(true);
  gate.set(true); // said twice, covered once
  change(3);
  change(4);
  expect([told, read()]).toEqual([1, 2]); // nothing told, the store as it was
  gate.set(false);
  expect([told, read()]).toEqual([2, 4]); // told once, the store as it is
  change(5);
  expect([told, read()]).toEqual([3, 5]);
  off();
  change(6);
  expect(told).toBe(3);
  expect(subs.size).toBe(0);
});
