// Which provider failures are tried again, and how long the wait is.
import { expect, test } from "bun:test";
import { backoffMs, errorText, overloaded, RETRY_WAIT_MAX_MS, retriesLeft, retryable } from "./retry.ts";
import { ProviderError } from "../providers/http.ts";
import { classify } from "../providers/http.ts";

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
  // A long wait is kept as asked (the engine then ends the turn instead of retrying early).
  expect(backoffMs(0, { headers: new Headers({ "retry-after": "900" }) })).toBe(900_000);
  const w = backoffMs(10);
  expect(w).toBeGreaterThanOrEqual(24_000);
  expect(w).toBeLessThanOrEqual(40_000);
});

test("a failure's status is said once", () => {
  // A provider's own failure already names its status: it is not said again in front of it.
  const e = classify("Amazon Bedrock", 503, new Headers(), JSON.stringify({ message: "Bedrock is unable to process your request." }));
  expect(errorText(e)).toBe("Amazon Bedrock: HTTP 503: Bedrock is unable to process your request.");
  // One whose text does not name it gets it in front.
  expect(errorText(Object.assign(new Error("upstream closed"), { status: 502 }))).toBe("HTTP 502: upstream closed");
  expect(errorText(new Error("socket closed"))).toBe("socket closed");
});

// An overloaded model is waited out: its wait grows past the 32 s of the counted retries and never
// past what a turn waits with its jitter (over that, the engine ends the turn as if the provider had
// asked for the wait); only the time it has waited ends it. Other failures keep their count.
test("an overloaded model's waits stay under a turn's longest wait however many tries it took", () => {
  const busy = new ProviderError("overloaded", "Bedrock: serviceUnavailableException: Bedrock is unable to process your request.");
  for (const attempt of [10, 11, 12, 20, 40]) {
    for (let i = 0; i < 2000; i++) {
      const w = backoffMs(attempt, busy);
      expect(w).toBeLessThanOrEqual(RETRY_WAIT_MAX_MS);
      expect(w).toBeGreaterThanOrEqual(0.75 * RETRY_WAIT_MAX_MS);
    }
  }
  expect(backoffMs(7, busy)).toBeGreaterThan(40_000); // past the counted retries' cap
  expect(retriesLeft(busy, 50, Date.now() - 3_600_000)).toBe(true);
  expect(retriesLeft(busy, 9)).toBe(false); // a request that does not wait it out keeps the count
  expect(retriesLeft(new ProviderError("server", "HTTP 500"), 9, Date.now())).toBe(false);
  // A stream's error event says it as the API's own error type.
  expect(overloaded(Object.assign(new Error("overloaded_error: Overloaded"), { wireError: { type: "overloaded_error", message: "Overloaded" } }))).toBe(true);
});

// A 503 is the model at capacity when the provider says so, not every 503: a gateway's page is a server fault.
test("a 503 is overloaded only in the provider's own words", () => {
  expect(classify("Amazon Bedrock", 503, new Headers(), JSON.stringify({ message: "Bedrock is unable to process your request." })).kind).toBe("overloaded");
  expect(classify("Lab", 503, new Headers(), "The model is at capacity, try again later").kind).toBe("overloaded");
  expect(classify("Gateway", 503, new Headers(), "<html><body><h1>503 Service Temporarily Unavailable</h1>nginx</body></html>").kind).toBe("server");
  expect(classify("Anthropic", 529, new Headers(), JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })).kind).toBe("overloaded");
});
