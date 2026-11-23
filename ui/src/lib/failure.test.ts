import { expect, test } from "bun:test";
import { agentCanFix, failureOf, rowFailure, stoppedOn } from "./failure.ts";

const BILLING = "Scripted: your credit balance is too low to make this request. Add credits at https://example.com/billing.";

test("a failure says its kind and the page that fixes it", () => {
  expect(failureOf({ message: `HTTP 402: ${BILLING}` })).toEqual({ kind: "quota", status: 402, words: BILLING, fix: { label: "Open billing", href: "https://example.com/billing" }, page: undefined });
  expect(failureOf({ message: "bad key", kind: "auth", status: 401 }).fix).toEqual({ label: "Open provider settings", settings: "providers" });
  // Another address the provider gave is a page of its own, not the fix.
  expect(failureOf({ message: "HTTP 529: overloaded, see https://status.example.com." })).toMatchObject({ kind: "overloaded", fix: undefined, page: "https://status.example.com" });
  // Words alone name no kind for a turn's box; a row kept before rows held their kind guesses from them.
  expect(failureOf({ message: BILLING }).kind).toBeUndefined();
  expect(rowFailure({ source: "provider", message: BILLING })?.kind).toBe("quota");
  expect(rowFailure({ source: "provider", message: BILLING, context: { failure: "quota", status: 402 } })).toMatchObject({ kind: "quota", status: 402 });
  expect(rowFailure({ source: "server", message: BILLING })).toBeUndefined();
});

test("an agent is handed only what it could fix", () => {
  expect(agentCanFix({ source: "provider", message: BILLING, context: { failure: "quota", status: 402 } })).toBe(false);
  for (const failure of ["rate", "auth", "overloaded", "network", "unreachable", "server"]) expect(agentCanFix({ source: "provider", message: "x", context: { failure } })).toBe(false);
  // A request the provider refused as sent, or one too long, is the harness's to mend; so is anything not a provider's.
  expect(agentCanFix({ source: "provider", message: "x", context: { failure: "invalid", status: 400 } })).toBe(true);
  expect(agentCanFix({ source: "provider", message: "x", context: { failure: "context" } })).toBe(true);
  expect(agentCanFix({ source: "server", message: "TypeError: x is undefined" })).toBe(true);
  expect(agentCanFix({ source: "tool", message: "ENOENT" })).toBe(true);
});

test("the failure a session stopped on is the newest provider row just before its stamp", () => {
  const site = (session_id: string, ts: number) => ({ session_id, ts, count: 1, healed: 0, first_ts: ts });
  const rows = [
    { id: "billing", source: "provider" as const, sites: [site("a", 10_000), site("b", 3_000)] },
    { id: "retry", source: "provider" as const, sites: [site("a", 9_000)] },
    { id: "tool", source: "tool" as const, sites: [site("a", 10_001)] },
  ];
  expect(stoppedOn(rows, "a", 10_002)).toBe("billing");
  // A later turn started: no stamp, nothing to try again.
  expect(stoppedOn(rows, "a", undefined)).toBeUndefined();
  // The stamp is of a failure no row holds (far after its rows).
  expect(stoppedOn(rows, "b", 60_000)).toBeUndefined();
  expect(stoppedOn(rows, "c", 10_002)).toBeUndefined();
});
