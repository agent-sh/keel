import { expect, test } from "bun:test";
import { endpoint } from "./sources.ts";

// Scheme and host case and the default port do not make another server; path and query case do.
test("a URL's identity keeps its path and query exact", () => {
  const id = (url: string) => endpoint({ url } as any);
  const base = id("https://Example.invalid/MCP/Lookup?resource=AbC");
  expect(id("HTTPS://EXAMPLE.INVALID:443/MCP/Lookup/?resource=AbC")).toBe(base);
  expect(id("https://example.invalid/mcp/lookup?resource=AbC")).not.toBe(base);
  expect(id("https://example.invalid/MCP/Lookup?resource=abc")).not.toBe(base);
  expect(id("http://example.invalid:8080/mcp")).not.toBe(id("http://example.invalid/mcp"));
});
