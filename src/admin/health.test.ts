import { expect, test } from "bun:test";
import { bounded } from "./health.ts";

test("a check that runs long or fails is a row of its own, and the others still answer", async () => {
  const slow = await bounded("providers", "providers", 30, () => new Promise<never>(() => {}));
  expect(slow).toMatchObject([{ group: "providers", level: "warning", title: "the providers check did not finish in 0 s" }]);
  const failed = await bounded("hooks", "hooks", 1000, () => { throw new Error("EACCES: no"); });
  expect(failed).toMatchObject([{ group: "hooks", level: "warning", title: "the hooks check failed", detail: "EACCES: no" }]);
  const fine = await bounded("disk", "disk", 1000, () => [{ id: "d", group: "disk", level: "ok", title: "ok" }]);
  expect(fine.map((r) => r.id)).toEqual(["d"]);
});

// ---- the provider rows ----

import { providerFacts } from "./health.ts";
import { providerRows } from "./health-rules.ts";
import { EndpointProvider } from "../providers/endpoint.ts";
import { CodexProvider } from "../providers/codex.ts";
import { XaiProvider } from "../providers/xai.ts";

const reg = (...all: any[]) => ({ all: () => all, problem: () => undefined });

test("an endpoint that is not there is broken, even when models are set by hand; its listing fallback is no answer", async () => {
  // A port nothing listens on.
  const dead = Bun.serve({ port: 0, fetch: () => new Response("x") });
  const base = `http://127.0.0.1:${dead.port}/v1`;
  dead.stop(true);
  const p = new EndpointProvider({ id: "gone", base_url: base, models: ["a", "b"] });
  // The provider's own listing offers the configured models: that is what made a dead address look well.
  expect((await p.list()).map((m) => m.model)).toEqual(["a", "b"]);
  const [facts] = await providerFacts(reg(p));
  expect(facts!.result).toMatchObject({ error: expect.any(String), byHand: 2 });
  expect(providerRows([facts!])).toMatchObject([{ level: "broken", title: "gone does not answer its listing" }]);
});

test("an endpoint whose server has no listing route and names models by hand is a warning; one that lists is well", async () => {
  const srv = Bun.serve({ port: 0, fetch: (r) => new URL(r.url).pathname === "/v1/models" && r.headers.get("x-lists") ? Response.json({ data: [{ id: "m1" }] }) : new Response("nope", { status: 404 }) });
  try {
    const byHand = new EndpointProvider({ id: "hand", base_url: `http://127.0.0.1:${srv.port}/v1`, models: ["a"] });
    const [f] = await providerFacts(reg(byHand));
    expect(providerRows([f!])).toMatchObject([{ level: "warning", title: expect.stringContaining("its listing failed, the 1 model set by hand are offered") }]);
  } finally { srv.stop(true); }
  const ok = Bun.serve({ port: 0, fetch: () => Response.json({ data: [{ id: "m1" }, { id: "m2" }] }) });
  try {
    const [f] = await providerFacts(reg(new EndpointProvider({ id: "up", base_url: `http://127.0.0.1:${ok.port}/v1` })));
    expect(providerRows([f!])).toMatchObject([{ level: "ok", title: "up answers", detail: expect.stringContaining("2 models listed") }]);
  } finally { ok.stop(true); }
});

test("Codex and Grok are read from the stored sign-in: their listing is never called", async () => {
  let asked = 0;
  const codex = Object.assign(Object.create(CodexProvider.prototype), { id: "chatgpt", label: "ChatGPT sign-in", available: () => true, stored: () => ({ expires_at_ms: Date.now() + 3600_000, refreshable: true }), list: async () => { asked++; return []; } });
  const grok = Object.assign(Object.create(XaiProvider.prototype), { id: "grok", label: "Grok plan", available: () => true, stored: () => ({ expires_at_ms: Date.now() - 1000, refreshable: false }), list: async () => { asked++; return []; } });
  const facts = await providerFacts(reg(codex, grok));
  expect(asked).toBe(0);
  const rows = providerRows(facts);
  expect(rows[0]).toMatchObject({ level: "ok", title: "ChatGPT sign-in: signed in", detail: expect.stringContaining("valid until") });
  expect(rows[0]!.how).toContain("no call made");
  expect(rows[1]).toMatchObject({ level: "broken", title: expect.stringContaining("cannot be renewed") });
});
