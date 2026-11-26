import { expect, test } from "bun:test";
import { tempTree } from "../../test/env.ts";
import { Catalog } from "./catalog.ts";

// The models.dev document as a stand-in serves it: one provider, enough models that its saved copy is long.
const doc = { anthropic: { name: "Anthropic", models: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`claude-${i}`, { name: `Claude ${i}`, limit: { context: 200_000, output: 64_000 }, cost: { input: 3, output: 15 }, tool_call: true }])) } };

test("loads asked for together read and parse the saved catalog once", async () => {
  const dir = tempTree("keel-catalog-");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(doc))) as unknown as typeof fetch;
  try { await new Catalog(dir).load(); } finally { globalThis.fetch = realFetch; }

  // A start: the saved copy is fresh, and many listings ask for the catalog at once.
  const real = JSON.parse;
  let parsed = 0;
  JSON.parse = ((t: string, r?: any) => { if (typeof t === "string" && t.length > 10_000) parsed++; return real(t, r); }) as typeof JSON.parse;
  const c = new Catalog(dir);
  try { await Promise.all([c.ready(), ...Array.from({ length: 12 }, () => c.load())]); } finally { JSON.parse = real; }
  expect(parsed).toBe(1);
  expect(c.lookup("claude-7")?.context).toBe(200_000);
  // Once filled, a load reads nothing.
  JSON.parse = ((t: string, r?: any) => { if (typeof t === "string" && t.length > 10_000) parsed++; return real(t, r); }) as typeof JSON.parse;
  try { await c.load(); } finally { JSON.parse = real; }
  expect(parsed).toBe(1);
});
