// A set of entries that run one program is offered to the model once: the first by name, the others as "same as <name>".
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpManager } from "./manager.ts";
import { catalogReady } from "../tools/catalog.ts";

test("a later entry of one program is left out of the tool list and the instructions until the owner offers it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-mcp-twin-"));
  const m = new McpManager({ capture() {} } as any, dir, "/", join(dir, "mcp.json"));
  const prog = { command: "node", args: ["server.js"], env: { A: "1" } };
  (m as any).cfg = { servers: { zeta: prog, alpha: { ...prog, command: "/usr/bin/node" }, other: { ...prog, env: { A: "2" } }, remote: { url: "http://example.test/mcp" }, remote2: { url: "http://EXAMPLE.test:80/mcp" } } };
  for (const [n, c] of Object.entries((m as any).cfg.servers)) {
    const e = (m as any).addEntry(n, c);
    Object.assign(e, { state: "ready", instr: null, tools: [{ name: `${n}_tool`, inputSchema: { type: "object" } }] });
    (m as any).settle(e, `${n} instructions`);
  }
  try {
    const twin = (n: string) => m.list().find((x) => x.name === n)!.twin_of;
    // The same command, arguments and environment (the program by its file name) or the same address: the first by name is offered.
    expect([twin("alpha"), twin("zeta"), twin("other"), twin("remote"), twin("remote2")]).toEqual([undefined, "alpha", undefined, undefined, "remote"]);
    const offered = async () => (await catalogReady(undefined, "s")).filter((t) => t.server).map((t) => t.name);
    expect(await offered()).toEqual(expect.arrayContaining(["alpha_tool", "other_tool"]));
    expect(await offered()).not.toContain("zeta_tool");
    const said = (await m.configured()).find((x) => x.name === "zeta")!;
    expect(said).toEqual({ name: "zeta", same_as: "alpha", instructions: undefined });
    // The owner offers it anyway: kept in the file, and the tools and instructions are there.
    m.setOfferTwin("zeta", true);
    expect(readFileSync(join(dir, "mcp.json"), "utf8")).toContain('"offer_twin": true');
    expect(twin("zeta")).toBeUndefined();
    expect(await offered()).toContain("zeta_tool");
    expect((await m.configured()).find((x) => x.name === "zeta")!.instructions).toBe("zeta instructions");
    m.setOfferTwin("zeta", false);
    expect(twin("zeta")).toBe("alpha");
    // A disabled first entry is not the one offered.
    (m as any).entries.get("alpha").state = "disabled";
    expect(twin("zeta")).toBeUndefined();
  } finally {
    m.dispose();
  }
});
