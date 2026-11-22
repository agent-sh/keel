// A configuration file of the owner's that a variable puts inside a folder a
// session works in is not loaded: a command of that session could have
// written it, and Keel would run what it names outside any sandbox.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hooks } from "../integrations/hooks.ts";
import { readConfig } from "../mcp/config.ts";
import { readCustom } from "../acp/agents.ts";
import { onConfigRefused, refusedConfigs, sessionFoldersOf, setSessionFolders } from "./named-config.ts";
import { Store } from "./store.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "keel-named-")));
const ws = join(root, "ws"), outside = join(root, "outside"), marker = join(root, "hook-ran");
for (const d of [join(ws, "kept"), outside]) mkdirSync(d, { recursive: true });
const NAMES = ["KEEL_HOOKS", "KEEL_MCP_CONFIG", "KEEL_ACP_AGENTS", "KEEL_ACP_FOLDERS"] as const;
const was = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
afterAll(() => {
  for (const n of NAMES) if (was[n] === undefined) delete process.env[n]; else process.env[n] = was[n];
  setSessionFolders(() => []);
  onConfigRefused(undefined);
  rmSync(root, { recursive: true, force: true });
});

test("a hooks file a variable puts inside a session's folder never runs, made before the session or by a command while one runs", async () => {
  const store = new Store(join(root, "state"));
  const hooks = new Hooks(store);
  const mine = store.createSession({ model: "fixture:m", workspace: ws });
  const other = store.createSession({ model: "fixture:m", workspace: join(root, "elsewhere") });
  const said: string[] = [];
  onConfigRefused((r) => said.push(`${r.name} in ${r.folder}`));
  const hook = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: `touch ${marker}` }] }] } });
  const fire = async (s: typeof mine) => (await hooks.run("PreToolUse", s, { tool_name: "Read", tool_input: { file_path: "x" } }, ["Read"])).ran;
  // The file does not exist yet: nothing to run. A command of the session then makes it.
  process.env.KEEL_HOOKS = join(ws, "kept/hooks.json");
  expect(await fire(other)).toBe(0);
  writeFileSync(join(ws, "kept/hooks.json"), hook);
  // An event of another session and of the same one: the file is there, and it is not the owner's to Keel.
  expect([await fire(other), await fire(mine), existsSync(marker)]).toEqual([0, 0, false]);
  expect(said).toEqual([`KEEL_HOOKS in ${ws}`]);
  expect(refusedConfigs().map((r) => r.name)).toEqual(["KEEL_HOOKS"]);
  // The same file outside every session's folder is the owner's: it runs.
  writeFileSync(join(outside, "hooks.json"), hook);
  process.env.KEEL_HOOKS = join(outside, "hooks.json");
  expect([await fire(other), existsSync(marker)]).toEqual([1, true]);
  expect(refusedConfigs()).toEqual([]);
  // The MCP servers and the ACP agents the same way (the daemon gives the sessions' folders).
  setSessionFolders(() => sessionFoldersOf(store));
  const servers = JSON.stringify({ servers: { x: { command: "evil" } } });
  for (const [dir, loaded] of [[join(ws, "kept"), 0], [outside, 1]] as const) {
    writeFileSync(join(dir, "mcp.json"), servers);
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { a: { command: "evil", args: [] } } }));
    process.env.KEEL_MCP_CONFIG = join(dir, "mcp.json");
    process.env.KEEL_ACP_AGENTS = join(dir, "agents.json");
    expect([dir, Object.keys(readConfig(process.env.KEEL_MCP_CONFIG).servers).length, Object.keys(readCustom()).length]).toEqual([dir, loaded, loaded]);
  }
  // A file read by its path with no variable naming it (a test's, a project's own) is not this rule's.
  delete process.env.KEEL_MCP_CONFIG;
  expect(Object.keys(readConfig(join(ws, "kept/mcp.json")).servers)).toEqual(["x"]);
});
