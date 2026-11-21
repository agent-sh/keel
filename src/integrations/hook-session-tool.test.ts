process.env.KEEL_CONFIG_DIR ??= `${process.env.TMPDIR ?? "."}/keel-hook-session-tool-config`;
// A PreToolUse hook is told the tool a call runs, also when that tool is one
// only the calling session is offered (a server an editor passed with it) and
// the call came through the dispatcher.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { Store } = await import("../core/store.ts");
const { Bus } = await import("../core/bus.ts");
const { Engine } = await import("../engine/turn.ts");
const { allHooks } = await import("../engine/hooks.ts");
const { joinHooks } = await import("../server/routes/hooks.ts");
const { registerCatalog, unregisterCatalog } = await import("../tools/catalog.ts");
const { installMcpTools } = await import("../mcp/tools.ts");
const { toolsFor } = await import("../tools/registry.ts");

const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "hks-"));
const before = process.env.KEEL_HOOKS;
// The stand-in hook writes down what it was told, for this test's folder only.
const told = join(dir, "told.jsonl");
const script = join(dir, "pre.sh");
writeFileSync(script, `#!/usr/bin/env bash\ninput=$(cat)\ncase "$input" in *'"cwd":"${dir}'*) echo "$input" >> "${told}" ;; esac\nexit 0\n`);
chmodSync(script, 0o755);
const hooksFile = join(dir, "hooks.json");
writeFileSync(hooksFile, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: script }] }] } }));
process.env.KEEL_HOOKS = hooksFile;

const store = new Store(join(dir, "state")), bus = new Bus();
const ws = join(dir, "ws");
mkdirSync(join(ws, ".git"), { recursive: true });
const errors = { capture: (_s: string, e: unknown) => ({ message: String(e) }) } as any;
const engine = new Engine(store, bus, {} as any, errors, join(dir, "spill"));
const registered = allHooks().length;
joinHooks({ store, bus, engine, errors, workspace: ws } as any, undefined);
installMcpTools({ configured: () => [] } as any);
// What this file joined to the turn loop leaves with it.
const mine = allHooks().slice(registered);
afterAll(() => {
  for (const h of mine) allHooks().splice(allHooks().indexOf(h), 1);
  unregisterCatalog("edsrv@own");
  if (before === undefined) delete process.env.KEEL_HOOKS; else process.env.KEEL_HOOKS = before;
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a hook sees the tool of a session's own server, not the name the dispatcher was given", async () => {
  const own = store.createSession({ model: "fixture:m", workspace: ws });
  const other = store.createSession({ model: "fixture:m", workspace: ws });
  // One tool, offered to one session, as a server an editor passed with it is.
  registerCatalog({ name: "edsrv@own", session: own.id, tools: async () => [{ server: "edsrv", name: "act", qualified: "edsrv__act", mcp: true, description: "Acts.", input_schema: { type: "object" }, run: async () => ({ content: "acted" }) }] });
  const tool = toolsFor("gpt").find((t) => t.name === "mcp_call")!;
  const prepare = async (session: { id: string }, id: string) => {
    for (const h of mine) await h.prepareTool?.(store.session(session.id)!, { id, tool, input: { tool: "act", arguments: { v: 1 } }, ctx: { sessionId: session.id, cwd: ws, signal: new AbortController().signal, seen: new Map(), spillDir: join(dir, "spill") } } as any);
  };
  await prepare(own, "c1");
  await prepare(other, "c2");
  expect(existsSync(told)).toBe(true);
  const seen = readFileSync(told, "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((x) => [x.tool_use_id, x.tool_name, x.tool_input]);
  // The session that has the tool: the hook is told the tool, by its full name, with the tool's own input.
  // A session that does not have it: there is no such tool for it, and the hook is told the name as it was asked for.
  expect(seen).toEqual([["c1", "edsrv__act", { v: 1 }], ["c2", "act", { v: 1 }]]);
});
