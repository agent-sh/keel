// Hiding and the default model: a new session never starts on a model the
// owner took out of the picker, in either order of the two changes.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Providers } from "./registry.ts";
import { providersRoutes } from "../server/routes/providers.ts";
import type { Provider } from "./types.ts";

const dir = mkdtempSync(join(tmpdir(), "keel-choices-"));
const env = { ...process.env };
const realFetch = globalThis.fetch;
beforeAll(() => {
  delete process.env.KEEL_DEFAULT_MODEL;
  delete process.env.ANTHROPIC_DEFAULT_MODEL;
  // The catalog stays empty: no network in this test.
  globalThis.fetch = (() => Promise.reject(new Error("offline"))) as any;
});
afterAll(() => {
  Object.assign(process.env, env);
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

const fixture = (id: string, models: string[]): Provider => ({
  id, family: "other", available: () => true,
  list: async () => models.map((m) => ({ model: m, name: m.toUpperCase(), context: 1000 })),
  stream: async () => { throw new Error("no requests here"); },
});

test("the default and hiding agree in both orders", async () => {
  const providers = new Providers(dir, { providers: [fixture("p", ["a", "b"]), fixture("q", ["c"])] });
  const route = providersRoutes({ providers, store: { session: () => undefined } } as any)["/api/providers/choices"].POST;
  const choose = async (body: unknown) => {
    const r: Response = await route(new Request("http://x/api/providers/choices", { method: "POST", body: JSON.stringify(body) }));
    return { status: r.status, body: await r.json() };
  };

  // No named default: the first listed model, until it is hidden.
  expect(await providers.defaultModel()).toBe("p:a");
  expect((await choose({ provider: "p", hide: ["a"] })).status).toBe(200);
  expect(await providers.defaultModel()).toBe("p:b");
  // A whole provider hidden: the fallback moves to the next provider.
  expect((await choose({ hide_provider: "p" })).status).toBe(200);
  expect(await providers.defaultModel()).toBe("q:c");
  expect((await choose({ show_provider: "p" })).status).toBe(200);

  // A hidden model cannot become the default unless the same change shows it.
  const refused = await choose({ default: "p:a" });
  expect(refused.status).toBe(400);
  expect(refused.body.error).toContain("hidden");
  expect(await providers.defaultModel()).toBe("p:b");
  expect((await choose({ default: "p:a", provider: "p", show: ["a"] })).status).toBe(200);
  expect(await providers.defaultModel()).toBe("p:a");

  // A named default cannot be hidden, nor its provider; the configured one counts too.
  expect((await choose({ provider: "p", hide: ["a"] })).status).toBe(400);
  expect((await choose({ hide_provider: "p" })).status).toBe(400);
  expect((await choose({ default: null })).status).toBe(200);
  process.env.KEEL_DEFAULT_MODEL = "c";
  expect((await choose({ provider: "q", hide: ["c"] })).status).toBe(400);
  delete process.env.KEEL_DEFAULT_MODEL;
  expect((await choose({ provider: "q", hide: ["c"] })).status).toBe(200);
});
