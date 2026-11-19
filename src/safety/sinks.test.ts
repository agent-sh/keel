// A secret's value is put back only where a credential is used: a shell
// command. A scheduled prompt, an advisor question, a subagent's task and an
// MCP call keep the placeholder, so the value reaches no stored row and no
// provider request; and a request that somehow holds a known value is masked
// before it is sent.
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { ErrorTracker } from "../core/errors.ts";
import { Store } from "../core/store.ts";
import { Engine } from "../engine/turn.ts";
import { anthropicWire } from "../providers/wires/anthropic.ts";
import { secretRoutes } from "../server/routes/secrets.ts";
import { registerCatalog, unregisterCatalog } from "../tools/catalog.ts";
import { toolsFor } from "../tools/registry.ts";
import { installMcpTools } from "../mcp/tools.ts";
import * as activity from "../automation/activity.ts";
import * as agents from "../automation/agents.ts";
import { advisorTool, migrate as migrateAdvisor, setDefault } from "../automation/consult.ts";
import { setDeps } from "../automation/core.ts";
import * as loops from "../automation/loops.ts";
import { automationTools } from "../automation/tools.ts";
import { vault } from "./secrets.ts";

const files = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? files(p) : [p]; });

test("only a shell command gets a secret's value; nothing else stores it or sends it to a model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-sinks-"));
  const store = new Store(join(dir, "state")), bus = new Bus(), errors = new ErrorTracker(store, bus);
  const sentinel = `fixture-only-${crypto.randomUUID()}`;
  const bodies: string[] = [];
  const info = { id: "fixture:m", model: "fixture", name: "Fixture", family: "claude", context: 16384, output: 64, efforts: [], images: false, pdf: false, tools: true };
  const provider = {
    wire: "anthropic_messages",
    stream: async (req: any) => {
      bodies.push(JSON.stringify(anthropicWire.body(req, { origin: info.id, sessionKey: req.sessionKey, efforts: [] } as any)));
      return { blocks: [{ type: "text", text: "done" }], usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, stop: "end_turn", model: "fixture" };
    },
  };
  const providers = { resolve: async () => ({ provider, info }), current: () => [info], models: async () => [info] };
  const engine = new Engine(store, bus, providers as any, errors, join(dir, "spill"));
  (engine as any).step = async () => ({ provider, info, tools: [], system: "Fixture system", systemSplit: 0, native: false });
  setDeps({ store, bus, engine, providers, errors } as any);
  store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT");
  loops.migrate(); activity.migrate(); agents.migrate(); migrateAdvisor();
  secretRoutes({ store, bus } as any);
  installMcpTools({ configured: () => [] } as any);
  const mcpGot: any[] = [];
  registerCatalog({ name: "fx", tools: async () => [{ server: "fx", name: "call", qualified: "fx__call", mcp: true, description: "fixture", readOnly: true, input_schema: { type: "object" }, run: async (i: any) => (mcpGot.push(i), { content: "ok" }) }] });
  await setDefault(info.id);

  const s = store.createSession({ workspace: dir, model: info.id, title: "sinks" });
  vault.add(sentinel, "synthetic", "card", s.id, "FIXTURE_SINK");
  const ref = "[value of $FIXTURE_SINK]";
  const ctx = { sessionId: s.id, cwd: dir, signal: new AbortController().signal, seen: new Map(), spillDir: join(dir, "spill") };
  const run = (tool: any, input: any, id: string) => (engine as any).runTool(s, [tool], { type: "tool_use", id, name: tool.name, input }, ctx);
  try {
    const cron = automationTools.find((t) => t.name === "CronCreate")!;
    expect((await run(cron, { cron: "10m", prompt: `Later use ${ref} as a reference.` }, "c1")).is_error).toBeFalsy();
    expect((await run(advisorTool, { question: `Check the plan with ${ref}.` }, "c2")).is_error).toBeFalsy();
    const agent = automationTools.find((t) => t.name === "Agent")!;
    await run(agent, { description: "check", prompt: `Look at ${ref} as a name only.`, isolation: "none", run_in_background: true }, "c3");
    const child = agents.list(s.id)[0]!;
    await engine.idle(child.session_id);
    const mcp = toolsFor("gpt").find((t) => t.name === "mcp_call")!;
    await run(mcp, { tool: "fx__call", arguments: { token: ref } }, "c4");
    // A known value in a request by any path is masked before it is sent.
    await engine.ask(s.id, [{ role: "user", content: [{ type: "text", text: `raw ${sentinel}` }] }], ctx.signal, info.id);
    // The one sink: a shell command gets the exact value as a quoted variable.
    const bash = toolsFor("claude").find((t) => t.name === "Bash")!;
    const out = await run(bash, { command: `printf %s ${ref} | sha256sum` }, "c5");
    expect(String(out.content)).toContain(new Bun.CryptoHasher("sha256").update(sentinel).digest("hex"));

    expect(mcpGot).toEqual([{ token: ref }]);
    expect(bodies.length).toBeGreaterThanOrEqual(3); // the advisor, the subagent's turn, the ask
    for (const b of bodies) expect(b).not.toContain(sentinel);
    expect(bodies.some((b) => b.includes(ref))).toBe(true);
    for (const l of loops.list(s.id)) expect(JSON.stringify(l)).not.toContain(sentinel);
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    for (const f of files(join(dir, "state"))) expect({ f, has: readFileSync(f).includes(sentinel) }).toEqual({ f, has: false });
  } finally {
    for (const l of loops.list(s.id)) loops.remove(l.id);
    unregisterCatalog("fx");
    vault.forgetSession(s.id);
    store.db.close();
  }
}, 30_000);
