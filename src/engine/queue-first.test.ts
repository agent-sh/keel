import { expect, test } from "bun:test";
import { firstPos } from "./queue-first.ts";

const row = (id: string, pos: number, o: { steer?: boolean; kind?: string } = {}) => ({ id, pos, steer: !!o.steer, meta: o.kind ? { kind: o.kind } : undefined });
const order = (rows: ReturnType<typeof row>[], id: string) => {
  const p = firstPos(rows, id);
  const moved = p === null ? rows : rows.map((r) => (r.id === id ? { ...r, pos: p } : r));
  return moved.filter((r) => !r.steer).sort((a, b) => a.pos - b.pos).map((r) => r.id);
};

test("next goes first among the queued prompts, steers aside", () => {
  const rows = [row("s", 9, { steer: true }), row("a", 1), row("b", 2), row("c", 3)];
  expect(order(rows, "c")).toEqual(["c", "a", "b"]);
  const p = firstPos(rows, "c")!;
  expect(p).toBeLessThan(1);
});

test("the first one stays, and an unknown or steered row is not moved", () => {
  const rows = [row("s", 0, { steer: true }), row("a", 1), row("b", 2)];
  expect(firstPos(rows, "a")).toBeNull();
  expect(firstPos(rows, "s")).toBeNull();
  expect(firstPos(rows, "gone")).toBeNull();
});

test("a decision another session waits on keeps its place ahead", () => {
  const rows = [row("a", 1), row("ask", 2, { kind: "write_asks" }), row("b", 3), row("c", 4)];
  expect(firstPos(rows, "c")).toBeNull();
  expect(firstPos(rows, "b")).toBeNull();
  expect(firstPos(rows, "ask")).toBeNull();
  // Only decisions ahead of it hold it back: one behind it is passed by nothing.
  expect(order([row("a", 1), row("b", 2), row("ask", 3, { kind: "write_asks" })], "b")).toEqual(["b", "a", "ask"]);
});
