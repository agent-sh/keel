import { expect, test } from "bun:test";
import { apportion, originClass, sizeParts } from "./context-parts.ts";

test("apportion adds up to the total and keeps the order of the weights", () => {
  const out = apportion([10, 3, 3, 0], 100);
  expect(out.reduce((a, b) => a + b, 0)).toBe(100);
  expect(out[0]!).toBeGreaterThan(out[1]!);
  expect(out[3]).toBe(0);
  expect(apportion([0, 0], 50)).toEqual([0, 0]);
});

test("an unmeasured context is sized from its bytes", () => {
  expect(sizeParts([300, 90], 3, 0)).toEqual([100, 30]);
  expect(sizeParts([300, 90], 3, 13)).toEqual([10, 3]);
});

test("inputs fall into the owner's, an agent's, another session's and the harness's", () => {
  expect(originClass({})).toBe("owner");
  expect(originClass({ origin: "queued" })).toBe("owner");
  expect(originClass({ kind: "subagent" })).toBe("agent");
  expect(originClass({ kind: "steer", agent_id: "a" })).toBe("session");
  expect(originClass({ kind: "steer" })).toBe("owner");
  expect(originClass({ origin: "restart" })).toBe("harness");
  expect(originClass({ kind: "harness" })).toBe("harness");
});
