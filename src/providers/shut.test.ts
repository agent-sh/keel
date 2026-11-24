// A route marked shut keeps new work off it for a time, then the next request
// on it decides: it clears the mark or marks it again for longer. A model the
// account may not use shuts that model alone.
import { afterEach, expect, test, setSystemTime } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderError } from "./http.ts";
import { Providers } from "./registry.ts";
import { SHUT_FIRST_MS, SHUT_MAX_MS, SHUT_TRY_MS, shutWords } from "./account.ts";

afterEach(() => setSystemTime());

const make = () => {
  const gw = { id: "gw", label: "Gateway", family: "other", available: () => true, list: async () => [], accountOf: (m: string) => (m.startsWith("up/") ? "gw:up" : undefined) } as any;
  const r = new Providers(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "keel-shut-")), { providers: [gw], capture: () => {} });
  r.catalog.load = async () => {};
  return r;
};
const billing = () => new ProviderError("quota", "Gateway: HTTP 402: Your account has no available balance.", 402);

test("a shut route gates new work for a time that doubles while it keeps failing, and an answer clears it", () => {
  const t0 = Date.parse("2026-11-24T10:00:00Z");
  setSystemTime(t0);
  const r = make();
  r.turnAnswered("gw:up/m", billing());
  expect(r.shut("gw:up/m")?.kind).toBe("billing");
  // Another route of the same provider is not shut.
  expect(r.shut("gw:other")).toBeUndefined();
  // A failure inside the time does not lengthen it.
  setSystemTime(t0 + SHUT_FIRST_MS - 1000);
  r.turnAnswered("gw:up/m", billing());
  expect(r.shut("gw:up/m")?.until).toBe(t0 + SHUT_FIRST_MS);
  // Past it the route takes work again; the problem stays listed until a request decides.
  setSystemTime(t0 + SHUT_FIRST_MS + 1);
  expect(r.shut("gw:up/m")).toBeUndefined();
  expect(r.routeProblems("gw").map((p) => [p.route, p.open])).toEqual([["gw:up", true]]);
  // The first request after it fails again: marked for twice as long.
  const t1 = Date.now();
  r.turnAnswered("gw:up/m", billing());
  expect(r.shut("gw:up/m")?.until).toBe(t1 + 2 * SHUT_FIRST_MS);
  expect(r.shut("gw:up/m")?.strikes).toBe(2);
  // Capped however long it keeps failing.
  for (let i = 0; i < 12; i++) { setSystemTime((r.shut("gw:up/m")?.until ?? Date.now()) + 1); r.turnAnswered("gw:up/m", billing()); }
  expect(r.shut("gw:up/m")!.until! - Date.now()).toBe(SHUT_MAX_MS);
  // An answer clears it whole: the next mark starts at the first time again.
  r.turnAnswered("gw:up/m");
  expect(r.shut("gw:up/m")).toBeUndefined();
  expect(r.routeProblems("gw")).toEqual([]);
  r.turnAnswered("gw:up/m", billing());
  expect(r.shut("gw:up/m")!.until! - Date.now()).toBe(SHUT_FIRST_MS);
});

test("a model the account may not use shuts that model, not its route", () => {
  const r = make();
  r.turnAnswered("gw:m1", new ProviderError("auth", "Gateway: HTTP 403: You don't have access to the model with the specified model ID.", 403));
  expect(r.shut("gw:m1")?.kind).toBe("access");
  expect(r.shut("gw:m2")).toBeUndefined();
  // A permission refusal with no word of billing or a sign-in shuts nothing of the route either.
  r.turnAnswered("gw:m2", new ProviderError("auth", "Gateway: HTTP 403: Your API key does not have permission to use the specified resource.", 403));
  expect(r.shut("gw:m3")).toBeUndefined();
  expect(r.routeProblems("gw").map((p) => p.route).sort()).toEqual(["model:gw:m1", "model:gw:m2"]);
  // An answer on the model clears its mark.
  r.turnAnswered("gw:m1");
  expect(r.shut("gw:m1")).toBeUndefined();
});

test("past a mark's time one choice tries the route, and the others pass it over until that try is answered", () => {
  const t0 = Date.parse("2026-11-24T10:00:00Z");
  setSystemTime(t0);
  const r = make();
  r.turnAnswered("gw:up/m", billing());
  setSystemTime(t0 + SHUT_FIRST_MS + 1);
  // The first choice takes it; the second and a third are still kept off, and told why.
  expect(r.shut("gw:up/m")).toBeUndefined();
  const second = r.shut("gw:up/m");
  expect(second?.trying).toBe(true);
  expect(shutWords(second)).toContain("another start is trying it again now");
  expect(r.shut("gw:up/m")?.trying).toBe(true);
  // The try is refused again: a fresh mark, longer, for everyone.
  r.turnAnswered("gw:up/m", billing());
  expect(r.shut("gw:up/m")?.trying).toBeUndefined();
  expect(r.shut("gw:up/m")?.strikes).toBe(2);
  // Past that one, a try that answers opens the route to all.
  setSystemTime(Date.now() + 2 * SHUT_FIRST_MS + 1);
  expect(r.shut("gw:up/m")).toBeUndefined();
  expect(r.shut("gw:up/m")?.trying).toBe(true);
  r.turnAnswered("gw:up/m");
  expect(r.shut("gw:up/m")).toBeUndefined();
  expect(r.shut("gw:up/m")).toBeUndefined();
  // A try that never answers (its start never sent) gives the route to the next choice after its time.
  r.turnAnswered("gw:up/m", billing());
  setSystemTime(Date.now() + SHUT_FIRST_MS + 1);
  expect(r.shut("gw:up/m")).toBeUndefined();
  setSystemTime(Date.now() + SHUT_TRY_MS - 1000);
  expect(r.shut("gw:up/m")?.trying).toBe(true);
  setSystemTime(Date.now() + 2000);
  expect(r.shut("gw:up/m")).toBeUndefined();
});
