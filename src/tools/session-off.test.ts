// RSH-S109: an MCP server turned off for one session leaves that session's catalog and no other's.
import { afterAll, expect, test } from "bun:test";
import { catalogReady, catalogSources, catalogTools, registerCatalog, sessionOff, turnedOff, unregisterCatalog, type CatalogTool } from "./catalog.ts";
import { referenced, withCatalog } from "./defer.ts";

const tool = (server: string, name: string): CatalogTool => ({ server, name, qualified: `${server}__${name}`, description: name, input_schema: { type: "object" }, mcp: true, run: async () => ({ content: "ran" }) });
registerCatalog({ name: "offsrv", server: true, tools: async () => [tool("offsrv", "list")], known: () => [tool("offsrv", "list")] });
registerCatalog({ name: "keepsrv", server: true, tools: async () => [tool("keepsrv", "list")], known: () => [tool("keepsrv", "list")] });
registerCatalog({ name: "builtin", tools: async () => [{ ...tool("builtin", "x"), mcp: false }] });
afterAll(() => { for (const n of ["offsrv", "keepsrv", "builtin"]) unregisterCatalog(n); sessionOff.of = undefined; });

test("a server turned off for a session is no source of that session's alone", async () => {
  sessionOff.of = (id) => (id === "s1" ? ["offsrv"] : undefined);
  const names = (s?: string) => catalogSources(s).map((x) => x.name).filter((n) => ["offsrv", "keepsrv", "builtin"].includes(n)).sort();
  expect(names("s1")).toEqual(["builtin", "keepsrv"]);
  expect(names("s2")).toEqual(["builtin", "keepsrv", "offsrv"]);
  expect(names()).toEqual(["builtin", "keepsrv", "offsrv"]);
  expect((await catalogTools("s1")).map((t) => t.qualified).filter((q) => q.endsWith("__list"))).toEqual(["keepsrv__list"]);
  expect((await catalogReady("claude", "s1")).some((t) => t.server === "offsrv")).toBe(false);
  expect((await catalogReady("claude", "s2")).some((t) => t.server === "offsrv")).toBe(true);
});

test("a call of a tool of a turned off server is told why, by either of its names", async () => {
  sessionOff.of = (id) => (id === "s1" ? ["offsrv"] : undefined);
  expect(turnedOff("offsrv__list", "s1")).toContain("offsrv is turned off for this session");
  expect(turnedOff("mcp__offsrv__list", "s1")).toContain("offsrv is turned off");
  expect(turnedOff("mcp__offsrv__list", "s2")).toBeUndefined();
  expect(turnedOff("keepsrv__list", "s1")).toBeUndefined();
  // A server named like a prefix of another is not the other.
  expect(turnedOff("offsrv2__list", "s1")).toBeUndefined();
  // A tool its conversation loaded stays declared (so the request keeps its bytes), and its call says why.
  const loaded = [{ role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "t", content: [{ type: "tool_reference" as const, tool_name: "mcp__offsrv__list" }] }] }] as any;
  expect([...referenced(loaded)]).toEqual(["mcp__offsrv__list"]);
  const tools = await withCatalog([], "claude", loaded, undefined, "s1");
  const stand = tools.find((t) => t.name === "mcp__offsrv__list")!;
  expect(stand).toBeTruthy();
  const out = await stand.run({}, { sessionId: "s1" } as any);
  expect(String((out as any).content)).toContain("turned off for this session");
  expect(tools.some((t) => t.name === "mcp__keepsrv__list")).toBe(true);
  expect(tools.some((t) => t.name === "mcp__offsrv__list" && !(t as any).left)).toBe(false);
});
