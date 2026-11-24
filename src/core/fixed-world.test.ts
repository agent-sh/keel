import { expect, test } from "bun:test";
import { fixedDate, idMaker, placeOf, seeded } from "./fixed-world.ts";

test("the same instant and start make the same ids, in UUID shape and in order", () => {
  const ra = seeded(7), rb = seeded(7);
  const a = idMaker(1_800_000_000_000, () => ra), b = idMaker(1_800_000_000_000, () => rb);
  const xs = [a.v7(), a.v7(), a.v4()], ys = [b.v7(), b.v7(), b.v4()];
  expect(xs).toEqual(ys);
  expect(xs[0]! < xs[1]!).toBe(true);
  for (const x of xs) expect(x).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const r8 = seeded(8);
  expect(idMaker(1_800_000_000_000, () => r8).v7()).not.toBe(xs[0]);
});

test("an id's place is its caller's function and file, whatever line it is on", () => {
  const at = (line: number) => `Error\n    at randOf (/x/src/core/fixed-world.ts:90:20)\n    at spawn (/w/1/src/automation/agents.ts:${line}:14)\n    at run (/w/1/src/x.ts:3:1)`;
  expect(placeOf(at(1040))).toBe("spawn@agents.ts");
  expect(placeOf(at(1077))).toBe(placeOf(at(1040)));
  expect(placeOf("Error\n    at async /w/src/a.ts:5:2")).toBe("@a.ts");
});

test("a fixed Date says the given now and is a Date for every other use", () => {
  const D = fixedDate(() => 1_800_000_000_000);
  expect(D.now()).toBe(1_800_000_000_000);
  expect(new D().getTime()).toBe(1_800_000_000_000);
  expect(new D(5).getTime()).toBe(5);
  expect(new D() instanceof Date).toBe(true);
  expect(D.UTC(2020, 0, 1)).toBe(Date.UTC(2020, 0, 1));
});
