// What a session's requests do with a tool the fit leaves out or a provider
// refused: its tool search does not load it, a reference to it stays declared,
// a restart tells it no second time, and renamed arguments are judged as the
// server gets them. The e2e (test/e2e/mcp-schemas.spec.ts) drives the turns;
// these are the parts it cannot reach (a restart between requests, a server
// reloaded while a call waits).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import type { Message } from "../core/types.ts";
import { registerCatalog, unregisterCatalog } from "../tools/catalog.ts";
import { keepReferenced, toolSearch, withCatalog } from "../tools/defer.ts";
import { allHooks } from "./hooks.ts";
import { ToolFit } from "./tool-fit.ts";

const tool = (name: string, input_schema: any, description = `${name} text`) => ({
  server: "shapes", name, qualified: `shapes__${name}`, mcp: true, description, input_schema,
  run: async (input: any) => ({ content: `${name} got ${JSON.stringify(input)}` }),
});
const listing = (tools: ReturnType<typeof tool>[]) => registerCatalog({ name: "shapes", tools: async () => tools, known: () => tools });
const withStore = async (f: (store: Store, root: string) => Promise<void>) => {
  const root = mkdtempSync(join(tmpdir(), "keel-tool-fit-"));
  try { await f(new Store(root), root); } finally { rmSync(root, { recursive: true, force: true }); }
};
const told: string[] = [];
const hook = { toolsLeftOut: (_s: unknown, left: { name: string }[]) => void told.push(...left.map((l) => l.name)) };
const withHook = async (f: () => Promise<void>) => {
  allHooks().push(hook);
  try { await f(); } finally { allHooks().splice(allHooks().indexOf(hook), 1); told.length = 0; }
};

test("a tool the fit leaves out is not loaded by the session's tool search, and a reference to it stays declared", () => withStore(async (store) => withHook(async () => {
  listing([tool("textual", { type: "string" }), tool("echo", { type: "object", properties: { text: { type: "string" } } })]);
  try {
    const s = store.createSession({ model: "p:m", workspace: "/" });
    const fit = new ToolFit(store, () => {});
    const tools = fit.fit(s, "anthropic_messages", await withCatalog([], "claude", [], undefined, s.id));
    expect(tools.map((t) => t.name)).toEqual(["mcp__shapes__echo"]);
    const search = toolSearch(() => []);
    const ctx = { sessionId: s.id } as any;
    const select = await search.run({ query: "select:mcp__shapes__textual" }, ctx);
    expect(select.is_error).toBe(true);
    expect(select.content).toBe('mcp__shapes__textual is not offered: its input is "string", and a tool\'s input is an object.');
    expect(((await search.run({ query: "+shapes__ text" }, ctx)).content as any[]).map((c) => c.tool_name)).toEqual(["mcp__shapes__echo"]);
    // (Other test files' sources may be listed beside it.)
    expect(String((await search.run({ query: "" }, ctx)).content).split("\n").filter((l) => l.startsWith("shapes:"))).toEqual(["shapes: mcp__shapes__echo"]);
    // A search before the fit (an earlier build) loaded it: the request still declares it, as a stand-in that says why.
    const loaded: Message[] = [{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: [{ type: "tool_reference", tool_name: "mcp__shapes__textual" }] }] } as any];
    const kept = keepReferenced(tools, loaded, s.id);
    const stand = kept.find((t) => t.name === "mcp__shapes__textual")!;
    expect(stand.defer).toBe(true);
    expect((await stand.run({}, ctx)).content).toContain("is not offered: its input is");
  } finally {
    unregisterCatalog("shapes");
  }
})));

test("a restart tells a left-out tool no second time, and keeps a refused one bare", () => withStore(async (store, root) => withHook(async () => {
  listing([tool("textual", { type: "string" }), tool("echo", { type: "object", properties: { text: { type: "string" } } })]);
  try {
    const s = store.createSession({ model: "p:m", workspace: "/" });
    const first = new ToolFit(store, () => {});
    const tools = first.fit(s, "anthropic_messages", await withCatalog([], "claude", [], undefined, s.id));
    first.fit(s, "anthropic_messages", await withCatalog([], "claude", [], undefined, s.id));
    expect(told).toEqual(["mcp__shapes__textual"]);
    const refusal = Object.assign(new Error("tools.0.custom.input_schema: JSON schema is invalid."), { status: 400 });
    expect(first.refused(s, refusal, tools, "anthropic_messages")).toBe("mcp__shapes__echo");
    store.db.close();
    // The next daemon: the same database, nothing in memory.
    const again = new Store(root);
    const next = new ToolFit(again, () => {});
    const tools2 = next.fit(s, "anthropic_messages", await withCatalog([], "claude", [], undefined, s.id));
    expect(told).toEqual(["mcp__shapes__textual"]);
    expect(next.overlay(s.id, tools2).find((t) => t.name === "mcp__shapes__echo")!.input_schema).toEqual({ type: "object" });
    expect(next.refused(s, refusal, tools2, "anthropic_messages")).toBeUndefined();
    again.db.close();
  } finally {
    unregisterCatalog("shapes");
  }
})));

test("a renamed argument is judged as the server gets it, and a server reloaded while the call waits is caught", () => withStore(async (store) => {
  const cells = (description: string) => tool("cells", { type: "object", properties: { "unit price": { type: "string" } }, required: ["unit price"] }, description);
  listing([cells("Writes a cell.")]);
  try {
    const s = store.createSession({ model: "p:m", workspace: "/" });
    const [t] = new ToolFit(store, () => {}).fit(s, "anthropic_messages", await withCatalog([], "claude", [], undefined, s.id));
    const input = { unit_price: "4.20" };
    const judged = await t!.target!(input, s.id);
    expect(judged!.input).toEqual({ "unit price": "4.20" });
    expect((await t!.run(input, { sessionId: s.id } as any)).content).toBe('cells got {"unit price":"4.20"}');
    // The gate judged it; the server is reloaded with another tool under the name before it runs.
    const late = { unit_price: "5" };
    await t!.target!(late, s.id);
    listing([cells("Deletes a cell.")]);
    const out = await t!.run(late, { sessionId: s.id } as any);
    expect(out.is_error).toBe(true);
    expect(String(out.content)).toContain("changed while this call waited");
  } finally {
    unregisterCatalog("shapes");
  }
}));
