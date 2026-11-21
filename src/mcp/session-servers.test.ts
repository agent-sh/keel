// The servers an editor passes with a session (ACP's mcpServers): whose they
// are, what they are called, and what never happens to the owner's own list.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogSources } from "../tools/catalog.ts";
import { McpManager } from "./manager.ts";

const errors = { capture() {} } as any;
const at = (path: string) => ({ url: `http://127.0.0.1:9/${path}` }); // nothing listens there: no server starts

test("a session's own servers are offered to it alone, never written to the owner's file, and go with the session", () => {
  const d = mkdtempSync(join(tmpdir(), "keel-mcp-session-")), file = join(d, "mcp.json");
  const m = new McpManager(errors, join(d, "state"), "/", file);
  expect(m.add("notes", { command: "x", enabled: false })).toBeNull();
  const owners = readFileSync(file, "utf8");
  const own = (session?: string) => m.list(session).filter((x) => x.session).map((x) => x.name);

  const set = m.setSessionServers("s1", [
    { name: "notes", config: at("a") },                                  // the owner has a server of that name
    { name: "My Tools!", config: at("b") },                              // not a name a tool can carry
    { name: "web", config: at("c") },                                    // a built-in group's name
    { name: "old", config: { ...at("d"), transport: "sse" } },           // a transport Keel does not speak
    { name: "both", config: { command: "x", ...at("e") } },
  ], "/");
  expect(set.map((x) => [x.name, x.label ?? null, !!x.error])).toEqual([["notes", "notes-editor", false], ["My Tools!", "My-Tools", false], ["web", "web-editor", false], ["old", null, true], ["both", null, true]]);
  expect([own("s1"), own("s2"), own()]).toEqual([["My-Tools", "notes-editor", "web-editor"], [], []]);
  expect([catalogSources("s1"), catalogSources("s2"), catalogSources()].map((l) => l.filter((s) => s.session).length)).toEqual([3, 0, 0]);
  expect(readFileSync(file, "utf8")).toBe(owners);

  // The owner's routes cannot name one, and reading the file again leaves them.
  expect([m.has("notes"), m.has("notes-editor@s1"), m.has("notes-editor")]).toEqual([true, false, false]);
  m.reload();
  expect(own("s1")).toHaveLength(3);
  expect(readFileSync(file, "utf8")).toBe(owners);

  // Another session may pass the same name; each list is whole, so one not named again goes.
  m.setSessionServers("s2", [{ name: "My Tools!", config: at("b") }]);
  m.setSessionServers("s1", [{ name: "My Tools!", config: at("b") }]);
  expect([own("s1"), own("s2")]).toEqual([["My-Tools"], ["My-Tools"]]);
  m.releaseSession("s1");
  expect([own("s1"), own("s2"), catalogSources("s1").some((s) => s.session)]).toEqual([[], ["My-Tools"], false]);
  m.dispose();
});
