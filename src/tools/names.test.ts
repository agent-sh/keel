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
