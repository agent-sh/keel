// A tool's name names one tool: grants, hook matchers and agent tool lists go
// by it, so no eager tool shares a name with a catalog tool's full name.
import { expect, test } from "bun:test";
import "../fleet/tools.ts";
import { driveTools } from "../drive/tools.ts";
import { toolsFor } from "./registry.ts";

test("tool names are unique across the eager tools and the keel catalog", () => {
  const eager = (["claude", "gpt", "gemini"] as const).flatMap((f) => toolsFor(f).map((t) => t.name));
  for (const f of ["claude", "gpt", "gemini"] as const) {
    const names = toolsFor(f).map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  }
  const catalog = driveTools({} as any, {} as any, {} as any).map((t) => t.qualified);
  expect(catalog.filter((n) => eager.includes(n))).toEqual([]);
});

// MCP tool names may hold dots: search.docs and search_docs are two tools, and
// each keeps its own native name whatever order the catalog lists them in.
test("deferred tools whose names only differ by a character the wire refuses stay two tools", async () => {
  const { registerCatalog, unregisterCatalog } = await import("./catalog.ts");
  const { nativeName, toolSearch, withCatalog } = await import("./defer.ts");
  const tool = (name: string) => ({
    server: "fixture", name, qualified: `fixture__${name}`, mcp: true, description: `${name === "search_docs" ? "alpha" : "beta"} lookup`,
    input_schema: { type: "object" }, run: async () => ({ content: name }),
  });
  const names: string[][] = [];
  try {
    for (const order of [["search_docs", "search.docs"], ["search.docs", "search_docs"]]) {
      registerCatalog({ name: "fixture", tools: async () => order.map(tool), known: () => order.map(tool) });
      const reported: string[] = [];
      const declared = (await withCatalog([], "claude", [], (e) => reported.push(e.message))).filter((t) => t.name.startsWith("mcp__fixture__"));
      expect(declared.length).toBe(2);
      expect(reported).toEqual([]);
      const search = toolSearch(() => []);
      for (const [word, want] of [["alpha", "search_docs"], ["beta", "search.docs"]] as const) {
        const ref = ((await search.run({ query: word, max_results: 1 }, {} as any)).content as any[])[0].tool_name;
        const t = declared.find((d) => d.name === ref)!;
        expect((await t.run({}, {} as any)).content).toBe(want);
      }
      names.push(declared.map((d) => d.name).sort());
    }
    expect(names[0]).toEqual(names[1]!);
    expect(names[0]).toContain("mcp__fixture__search_docs");
    for (const n of names[0]!) expect(n).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    const long = nativeName({ qualified: `fixture__${"x".repeat(80)}.a`, mcp: true });
    expect(long.length).toBe(64);
    expect(long).not.toBe(nativeName({ qualified: `fixture__${"x".repeat(80)}.b`, mcp: true }));
    // A tool literally named like another's made-fit name: still a clash, reported once, never dropped in silence.
    const fitted = nativeName({ qualified: "fixture__a.b", mcp: true }).slice("mcp__fixture__".length);
    registerCatalog({ name: "fixture", tools: async () => [tool("a.b"), tool(fitted)], known: () => [tool("a.b"), tool(fitted)] });
    const reported: string[] = [];
    await withCatalog([], "claude", [], (e) => reported.push(e.message));
    await withCatalog([], "claude", [], (e) => reported.push(e.message));
    expect(reported.length).toBe(1);
    expect(reported[0]).toContain("fixture__a.b is declared");
  } finally {
    unregisterCatalog("fixture");
  }
});
