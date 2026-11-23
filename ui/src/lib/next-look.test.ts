import { expect, test } from "bun:test";
import { holdOrder, nextLook, sessionCosts, waitsOnOwner } from "./next-look.ts";

const alert = (id: string, ts: number, more: Record<string, unknown> = {}) => ({ id, ts, kind: "approval", session_id: "s", title: "", body: "", read: false, rev: 0, kept: false, ...more }) as any;

test("what waits: open asks, and failures the owner has not looked at while their session is still failed", () => {
  const told = { s: { watch: "fail" }, kid: { watch: "fail" }, back: { watch: "work" } };
  expect(waitsOnOwner(alert("a", 1, { open: true }), told)).toBe(true);
  expect(waitsOnOwner(alert("f", 1, { kind: "failed" }), told)).toBe(true);
  expect(waitsOnOwner(alert("k", 1, { kind: "failed", data: { child_session: "kid" } }), told)).toBe(true);
  expect(waitsOnOwner(alert("r", 1, { kind: "failed", read: true }), told)).toBe(false);
  expect(waitsOnOwner(alert("b", 1, { kind: "failed", session_id: "back" }), told)).toBe(false);
  expect(waitsOnOwner(alert("d", 1, { kind: "finished" }), told)).toBe(false);
});

test("rows the pointer is over stand still; one that came meanwhile joins at the end", () => {
  const cheap = alert("cheap", 1, { open: true });
  const dear = alert("dear", 5, { open: true, data: { wait: { key: 0.5 } } });
  const ranked = nextLook([cheap, dear], (a) => a);
  expect(ranked.map((a) => a.id)).toEqual(["dear", "cheap"]);
  const dearer = alert("dearer", 9, { open: true, data: { wait: { key: 2 } } });
  const now = nextLook([cheap, dear, dearer], (a) => a);
  expect(now.map((a) => a.id)).toEqual(["dearer", "dear", "cheap"]);
  expect(holdOrder(now, (a) => a.id, ["dear", "cheap"]).map((a) => a.id)).toEqual(["dear", "cheap", "dearer"]);
  expect(holdOrder(now, (a) => a.id, null).map((a) => a.id)).toEqual(["dearer", "dear", "cheap"]);
  // Each session takes the key of its costliest wait.
  expect([...sessionCosts([cheap, dear, alert("o", 3, { open: true, session_id: "t" })], {})]).toEqual([["s", { key: 0.5, ts: 5 }], ["t", { key: 0, ts: 3 }]]);
});
