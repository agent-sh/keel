// A file of Keel's own configuration that the owner keeps inside a session's
// folder (a variable names it) is a protected file there: what a call the
// owner did not answer makes of it is taken out of the workspace.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { Quarantine, snapshot } from "./quarantine.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "keel-quarantine-")));
const ws = join(root, "ws");
mkdirSync(join(ws, "kept"), { recursive: true });
const was = { hooks: process.env.KEEL_HOOKS, mcp: process.env.KEEL_MCP_CONFIG };
afterAll(() => {
  for (const [k, v] of [["KEEL_HOOKS", was.hooks], ["KEEL_MCP_CONFIG", was.mcp]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(root, { recursive: true, force: true });
});

test("Keel's config kept inside a session's folder by a variable: a file a call makes or changes there is quarantined", () => {
  process.env.KEEL_HOOKS = join(ws, "kept/hooks.json");
  process.env.KEEL_MCP_CONFIG = join(ws, "kept/mcp.json");
  writeFileSync(join(ws, "kept/hooks.json"), "{}\n");
  const store = new Store(join(root, "state"));
  const q = new Quarantine(store, join(root, "held"));
  const before = snapshot(ws);
  expect([...before.keys()]).toEqual(["kept/hooks.json"]);
  // The call changes the one that is there and makes the one that is not.
  writeFileSync(join(ws, "kept/hooks.json"), '{"hooks":{"PreToolUse":[{"command":"evil"}]}}\n');
  writeFileSync(join(ws, "kept/mcp.json"), '{"mcpServers":{"x":{"command":"evil"}}}\n');
  writeFileSync(join(ws, "kept/notes.txt"), "an ordinary file\n");
  const batch = q.sweep("s1", ws, before);
  expect(batch?.paths.sort()).toEqual(["kept/hooks.json", "kept/mcp.json"]);
  // The changed one has what it held before; the made one is gone; the ordinary file stays.
  expect(readFileSync(join(ws, "kept/hooks.json"), "utf8")).toBe("{}\n");
  expect(existsSync(join(ws, "kept/mcp.json"))).toBe(false);
  expect(existsSync(join(ws, "kept/notes.txt"))).toBe(true);
  // A variable that names a file outside the folder adds nothing here.
  process.env.KEEL_MCP_CONFIG = join(root, "elsewhere/mcp.json");
  expect([...snapshot(ws).keys()]).toEqual(["kept/hooks.json"]);

});
