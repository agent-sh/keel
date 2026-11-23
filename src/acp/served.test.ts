import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearServed, ServedTools, withoutMemory } from "./served.ts";

const deps = { list: async () => [], call: async (_n: string, _a: unknown, id: string) => ({ type: "tool_result" as const, tool_use_id: id, content: "" }) };

// What an agent left in the folders it reaches is never written through: a listen makes its folder anew,
// and the relay is written by a rename.
test("a link left in the served folders does not lead the daemon's writes elsewhere", async () => {
  const root = mkdtempSync(join(tmpdir(), "keel-served-"));
  try {
    const victim = join(root, "victim.txt");
    writeFileSync(victim, "owner data\n");
    const a = new ServedTools(join(root, "state"), "sess-1", deps);
    await a.listen();
    // The relay lives outside the session's folder.
    expect(a.relayFile.startsWith(a.dir)).toBe(false);
    a.close();
    // A daemon that ended without closing: a link at the relay's name and one in the session's folder.
    const b = new ServedTools(join(root, "state"), "sess-1", deps);
    await b.listen();
    rmSync(b.relayFile);
    symlinkSync(victim, b.relayFile);
    symlinkSync(victim, join(b.dir, "left"));
    (b as any).server?.close();
    const c = new ServedTools(join(root, "state"), "sess-1", deps);
    await c.listen();
    expect(readFileSync(victim, "utf8")).toBe("owner data\n");
    expect(readFileSync(c.relayFile, "utf8")).toContain("Keel's tools are not reachable");
    expect(existsSync(join(c.dir, "left"))).toBe(false);
    (c as any).server?.close();
    // A start clears what the daemon before it left.
    clearServed(join(root, "state"));
    expect(existsSync(c.dir)).toBe(false);
    expect(readFileSync(victim, "utf8")).toBe("owner data\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the owner's memory a hook adds to a result does not reach another agent", () => {
  const block = `<memory source="tacit" hook="pre-tool">\nFrom the owner's memory store.\n- a fact\n</memory>`;
  expect(withoutMemory(`echo: hi\n\n${block}`)).toBe("echo: hi");
  expect(withoutMemory(`a\n${block}\nb`)).toBe("a\nb");
  expect(withoutMemory("plain")).toBe("plain");
});
