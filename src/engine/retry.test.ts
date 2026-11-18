// Which provider failures are tried again, and how long the wait is.
import { expect, test } from "bun:test";
import { backoffMs, retryable } from "./retry.ts";

test("passing failures retry, the rest fail at once", () => {
  for (const status of [408, 429, 500, 503, 529]) expect(retryable({ status })).toBe(true);
  for (const status of [400, 401, 403, 404, 413]) expect(retryable({ status })).toBe(false);
  expect(retryable({ error: { type: "overloaded_error" } })).toBe(true); // an SSE error mid-stream
  expect(retryable(new Error("socket connection was closed unexpectedly"))).toBe(true);
  expect(retryable(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(false);
  expect(retryable(new TypeError("cannot read properties of undefined"))).toBe(false);
});

test("retry-after wins over the exponential wait", () => {
  expect(backoffMs(0, { headers: new Headers({ "retry-after": "7" }) })).toBe(7000);
  expect(backoffMs(0, { headers: new Headers({ "retry-after-ms": "1500" }) })).toBe(1500);
  const w = backoffMs(10);
  expect(w).toBeGreaterThanOrEqual(24_000);
  expect(w).toBeLessThanOrEqual(40_000);
});
