// When a session takes the running build's tools and prompt: the moments its
// cache is cold, and the changes that do not wait. The e2e
// (test/e2e/build-pin.spec.ts) covers the requests across a daemon upgrade;
// these are the decisions it cannot time (an expired cache, another model).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URGENT } from "../core/build.ts";
import { Store } from "../core/store.ts";
import type { StoredEvent } from "../core/types.ts";
import type { Tool } from "../tools/types.ts";
import { pinOf } from "../tools/pin.ts";
import { loadSettings, patchSettings } from "../admin/settings.ts";
import { adoptionBetween, BuildPins, coldReason } from "./build-pin.ts";
import { blocksOf } from "./prompt-store.ts";

const MIN = 60_000;
const ev = (kind: string, ts: number, data: Record<string, unknown> = {}) => ({ id: `${kind}-${ts}`, kind, ts, data }) as unknown as StoredEvent;
const reply = (ts: number, model = "p:m", cached = 5000) => ev("assistant", ts, { model, usage: { input: 10, output: 1, cache_read: cached, cache_write: 0 } });

test("a context is cold after a compaction or clear, on another model, and once the cache lifetime passed", () => {
  const warm = [ev("user", 0), reply(1000)];
  expect(coldReason(warm, "p:m", 60 * MIN, 30 * MIN)).toBeUndefined();
  expect(coldReason(warm, "p:m", 60 * MIN, 61 * MIN + 1000)).toBe("the cache expired");
  // A summary prepared on the same prefix read the cache later: still warm.
  expect(coldReason(warm, "p:m", 60 * MIN, 70 * MIN, 20 * MIN)).toBeUndefined();
  expect(coldReason([...warm, ev("compaction", 2000, { mode: "summary" }), ev("user", 3000)], "p:m", 60 * MIN, 4000)).toBe("a compaction");
  expect(coldReason([...warm, ev("compaction", 2000, { mode: "clear" })], "p:m", 60 * MIN, 4000)).toBe("a clear");
  expect(coldReason(warm, "p:other", 60 * MIN, 4000)).toBe("a model switch");
  expect(coldReason([ev("user", 0)], "p:m", 60 * MIN, 4000)).toBe("a new context");
  // Replies that never used the cache: there is no prefix to lose.
  expect(coldReason([ev("user", 0), reply(1000, "p:m", 0)], "p:m", 60 * MIN, 4000)).toBe("no cached prefix");
});

const tool = (name: string, description: string): Tool =>
  ({ name, description, input_schema: { type: "object", properties: {} }, readOnly: true, run: async () => ({ content: description }) });
// The core block is the build's words; the instruction files and the server list render the owner's data.
const blocks = (core: string, files = "rules", servers = { text: "Servers: a", data: "a" }) =>
  blocksOf([{ name: "core", text: core }, { name: "MCP servers are connected", ...servers }, { name: "instruction files", text: files, data: files }]);
const withPins = (f: (pins: BuildPins, store: Store, session: ReturnType<Store["createSession"]>) => void) => {
  const root = mkdtempSync(join(tmpdir(), "keel-pins-"));
  try {
    const store = new Store(root);
    f(new BuildPins(store), store, store.createSession({ model: "p:m", workspace: "/" }));
  } finally { rmSync(root, { recursive: true, force: true }); }
};
const never = () => undefined;
const at = { model: "p:m", native: false, own: "[[],[]]" };

test("a reworded tool and prompt block wait while the cache is warm and are taken together when it is cold", () => withPins((pins, store, s) => {
  const v1 = [tool("Read", "Reads."), tool("Bash", "Runs.")];
  const v2 = [tool("Read", "Reads, in parts."), tool("Bash", "Runs.")];
  // The first request pins this build's list.
  expect(pins.prompt(s.id, undefined, blocks("one"), [], false)).toBe(true);
  expect(pins.tools(s, at, v1).map((t) => t.description)).toEqual(["Reads.", "Runs."]);
  // The next build, cache warm: nothing is due, the prompt stays, the pinned definitions are sent.
  expect(pins.due(s, at, v2, never)).toBeUndefined();
  expect(pins.prompt(s.id, blocks("one"), blocks("two"), ["core"], false)).toBe(false);
  expect(pins.tools(s, at, v2).map((t) => t.description)).toEqual(["Reads.", "Runs."]);
  expect(pins.state(s.id)).toMatchObject({ waiting: { blocks: ["core"], tools: ["Read"] }, known: true, adoptions: [] });
  expect(pins.waits(s.id)).toBe("behind");
  // Cold: the step has a reason, the prompt and the tools follow, and the adoption is recorded.
  const why = pins.due(s, at, v2, () => "a compaction");
  expect(why).toBe("a compaction");
  pins.begin(s.id, why);
  expect(pins.prompt(s.id, blocks("one"), blocks("two"), ["core"], true)).toBe(true);
  expect(pins.tools(s, at, v2).map((t) => t.description)).toEqual(["Reads, in parts.", "Runs."]);
  pins.end(s.id);
  expect(pins.state(s.id)).toMatchObject({ waiting: { blocks: [], tools: [] }, adoptions: [{ reason: "a compaction", blocks: ["core"], tools: ["Read"] }] });
  expect(pins.waits(s.id)).toBeUndefined();
  expect(adoptionBetween(store, s.id, 0, Date.now())?.reason).toBe("a compaction");
  // A new pins object (a daemon restart) reads the same list back.
  expect(new BuildPins(store).tools(s, at, v2).map((t) => t.description)).toEqual(["Reads, in parts.", "Runs."]);
}));

test("the owner's side of the prompt waits while the cache may be warm, told at the tail, and is taken when it is cold", () => withPins((pins, _store, s) => {
  const v1 = [tool("Read", "Reads.")];
  const kept = blocks("one");
  pins.prompt(s.id, undefined, kept, [], false);
  pins.tools(s, at, v1);
  // The owner's files changed, the cache may be warm: the kept prompt stays, the change is told.
  expect(pins.prompt(s.id, kept, blocks("one", "rules, edited"), ["instruction files"], false)).toBe(false);
  pins.tools(s, at, v1);
  expect(pins.state(s.id)).toMatchObject({ waiting: { blocks: ["instruction files"], tools: [], told: ["instruction files"] }, adoptions: [] });
  expect(pins.waits(s.id)).toBe("behind");
  // No warm cache holds the kept one: taken now, and the tools follow at the same request.
  expect(pins.prompt(s.id, kept, blocks("one", "rules, edited"), ["instruction files"], false, "the cache expired")).toBe(true);
  expect(pins.due(s, at, v1, never)).toBe("the cache expired");
  pins.tools(s, at, v1);
  expect(pins.state(s.id)).toMatchObject({ waiting: { blocks: [], tools: [] }, adoptions: [{ reason: "the cache expired", blocks: ["instruction files"], tools: [] }] });
  // A block of the owner's data: the build's other words around the same data are not told, other data is.
  const servers = "MCP servers are connected";
  expect(pins.prompt(s.id, kept, blocks("one", "rules", { text: "Connected servers: a", data: "a" }), [servers], false)).toBe(false);
  pins.tools(s, at, v1);
  expect(pins.state(s.id).waiting).toEqual({ blocks: [servers], tools: [] });
  expect(pins.prompt(s.id, kept, blocks("one", "rules", { text: "Servers: a, b", data: "a, b" }), [servers], false)).toBe(false);
  pins.tools(s, at, v1);
  expect(pins.state(s.id).waiting).toEqual({ blocks: [servers], tools: [], told: [servers] });
  // A prompt kept from before data was fingerprinted: a changed data block counts as the owner's.
  const before = kept.map(({ data: _, ...b }) => b);
  expect(pins.prompt(s.id, before, blocks("one", "rules", { text: "Connected servers: a", data: "a" }), [servers], false)).toBe(false);
  pins.tools(s, at, v1);
  expect(pins.state(s.id).waiting.told).toEqual([servers]);
  // A data block new to the prompt is the build's: it waits, untold.
  expect(pins.prompt(s.id, kept.filter((b) => b.name !== servers), kept, [servers], false)).toBe(false);
  pins.tools(s, at, v1);
  expect(pins.state(s.id).waiting.told).toBeUndefined();
}));

test("an urgent block, the session's own tools and the owner's request do not wait", () => withPins((pins, _store, s) => {
  const v1 = [tool("Read", "Reads.")];
  const kept = blocks("one");
  pins.prompt(s.id, undefined, kept, [], false);
  pins.tools(s, at, v1);
  // A block this build marks urgent with a mark the kept copy does not carry.
  expect(pins.prompt(s.id, kept, blocks("two"), ["core"], false)).toBe(false);
  URGENT.blocks.core = "no-force-push";
  try {
    expect(pins.prompt(s.id, kept, blocks("two"), ["core"], false)).toBe(true);
    pins.tools(s, at, v1);
    expect(pins.state(s.id).adoptions[0]!.reason).toBe("the core block has an urgent change");
    // Rendered with the mark, the next change of the block waits again.
    expect(pins.prompt(s.id, blocks("two"), blocks("three"), ["core"], false)).toBe(false);
  } finally { delete URGENT.blocks.core; }
  // The session's own part of the list changed (a tool only it gets, one it is not offered).
  expect(pins.due(s, { ...at, own: '[["helper__mail"],[]]' }, v1, never)).toBe("the session's tool set changed");
  // The owner asks: due at the next request, whatever the cache holds.
  expect(pins.ask(s.id)).toBe(true);
  expect(pins.waits(s.id)).toBe("now");
  expect(pins.due(s, at, v1, never)).toBe("the owner asked");
}));

test("a subagent on this machine starts on its parent's pinned list", () => withPins((pins, store, s) => {
  const v1 = [tool("Read", "Reads.")], v2 = [tool("Read", "Reads, in parts.")];
  pins.prompt(s.id, undefined, blocks("one"), [], false);
  pins.tools(s, at, v1);
  const child = { ...store.createSession({ model: "p:m", workspace: "/" }), parent_id: s.id };
  expect(pins.tools(child, at, v2).map((t) => t.description)).toEqual(["Reads."]);
  // On another model it has no prefix of the parent's to read: this build's list.
  const other = { ...store.createSession({ model: "p:n", workspace: "/" }), parent_id: s.id };
  expect(pins.tools(other, { ...at, model: "p:n" }, v2).map((t) => t.description)).toEqual(["Reads, in parts."]);
}));

test("a session that moved takes its prompt at once; one with no pin takes the owner's change at once", () => withPins((pins, store, s) => {
  const kept = blocks("one");
  pins.prompt(s.id, undefined, kept, [], false);
  pins.tools(s, at, [tool("Read", "Reads.")]);
  expect(pins.prompt(s.id, kept, blocks("one", "rules, edited"), ["instruction files"], true)).toBe(true);
  expect(pins.due(s, at, [tool("Read", "Reads.")], never)).toBe("the session moved");
  pins.tools(s, at, [tool("Read", "Reads.")]);
  // Nothing pinned to fold the change into later.
  const bare = store.createSession({ model: "p:m", workspace: "/" });
  expect(pins.prompt(bare.id, kept, blocks("one", "rules, edited"), ["instruction files"], false)).toBe(true);
}));

test("a prompt taken before a restart still brings the tools along after it", () => withPins((pins, store, s) => {
  const v1 = [tool("Read", "Reads.")], v2 = [tool("Read", "Reads, in parts.")];
  const kept = blocks("one");
  pins.prompt(s.id, undefined, kept, [], false);
  pins.tools(s, at, v1);
  // The prompt is taken (the owner's files changed on a cold cache) and the daemon stops before the session's own step.
  expect(pins.prompt(s.id, kept, blocks("one", "rules, edited"), ["instruction files"], false, "the cache expired")).toBe(true);
  const next = new BuildPins(store);
  expect(next.waits(s.id)).toBe("now");
  expect(next.due(s, at, v2, never)).toBe("the cache expired");
  expect(next.tools(s, at, v2).map((t) => t.description)).toEqual(["Reads, in parts."]);
  expect(next.state(s.id).adoptions[0]).toMatchObject({ blocks: ["instruction files"], tools: ["Read"] });
  expect(next.waits(s.id)).toBeUndefined();
}));

test("a session behind for longer than the owner allows takes the build's, and 0 turns that off", () => withPins((pins, store, s) => {
  const v1 = [tool("Read", "Reads.")], v2 = [tool("Read", "Reads, in parts.")];
  pins.prompt(s.id, undefined, blocks("one"), [], false);
  pins.tools(s, at, v1);
  pins.tools(s, at, v2);
  const since = pins.state(s.id).behind_since!;
  expect(since).toBeGreaterThan(0);
  // Warm and behind for an hour: it waits, and the state says when it will not.
  expect(pins.due(s, at, v2, never)).toBeUndefined();
  expect(pins.state(s.id).takes_at).toBe(since + 24 * 3_600_000);
  // Behind since two days ago.
  store.db.run("UPDATE session_pins SET stale = ? WHERE session_id = ?", [Date.now() - 48 * 3_600_000, s.id]);
  expect(pins.waits(s.id)).toBe("now");
  expect(pins.due(s, at, v2, never)).toBe("its tools and prompt were more than 24 hours behind");
  loadSettings(store.stateDir, () => {});
  expect(patchSettings({ build_pin: { max_age_hours: 0 } }).ok).toBe(true);
  try {
    expect(pins.due(s, at, v2, never)).toBeUndefined();
    expect(pins.state(s.id).takes_at).toBeNull();
  } finally { patchSettings({ build_pin: { max_age_hours: 24 } }); }
  pins.begin(s.id, pins.due(s, at, v2, never));
  expect(pins.tools(s, at, v2).map((t) => t.description)).toEqual(["Reads, in parts."]);
  pins.end(s.id);
  expect(pins.state(s.id)).toMatchObject({ behind_since: null, adoptions: [{ reason: "its tools and prompt were more than 24 hours behind", tools: ["Read"] }] });
}));

test("a tool an adopted build took away is remembered, and a pin whose list is missing is no pin", () => withPins((pins, store, s) => {
  pins.prompt(s.id, undefined, blocks("one"), [], false);
  pins.tools(s, at, [tool("Read", "Reads."), tool("Plan", "Plans.")]);
  expect(pins.tools(s, at, [tool("Read", "Reads.")]).map((t) => t.name)).toEqual(["Read"]);
  expect([pins.removed(s.id, "Plan"), pins.removed(s.id, "Read"), pins.removed(s.id, "Nope")]).toEqual([true, false, false]);
  // On another model the list is another family's: nothing was taken away.
  pins.tools(s, { ...at, model: "p:n" }, [tool("shell", "Runs.")]);
  expect(pins.removed(s.id, "Read")).toBe(false);
  store.db.run("DELETE FROM pinned_tools");
  const next = new BuildPins(store);
  expect(next.state(s.id).pinned).toBeNull();
  expect(next.tools(s, at, [tool("Read", "Reads, in parts.")]).map((t) => t.description)).toEqual(["Reads, in parts."]);
}));

test("a deferred tool the conversation loaded keeps its definition until it takes another input", () => withPins((pins, _store, s) => {
  const cat = (name: string, description: string, schema: Record<string, unknown> = { type: "object", properties: { text: { type: "string" } } }) =>
    ({ ...tool(name, description), input_schema: schema, defer: true, catalog: name }) as Tool;
  const names = new Set(["mcp__echo__echo"]);
  const v1 = [tool("Read", "Reads."), cat("mcp__echo__echo", "Echo."), cat("mcp__echo__add", "Add.")];
  expect(pins.loaded(s.id, v1, names).map((t) => t.description)).toEqual(["Reads.", "Echo.", "Add."]);
  // Reworded: the loaded one keeps its words, the one never loaded follows.
  const v2 = [tool("Read", "Reads."), cat("mcp__echo__echo", "Echo, reworded."), cat("mcp__echo__add", "Add, reworded.")];
  const sent = pins.loaded(s.id, v2, names);
  expect(sent.map((t) => t.description)).toEqual(["Reads.", "Echo.", "Add, reworded."]);
  // Another input: the new definition, kept from here.
  const v3 = [cat("mcp__echo__echo", "Echo, again.", { type: "object", properties: { words: { type: "string" } }, required: ["words"] })];
  expect(pins.loaded(s.id, v3, names)[0]!.description).toBe("Echo, again.");
  expect(pins.loaded(s.id, [cat("mcp__echo__echo", "Echo, once more.", v3[0]!.input_schema)], names)[0]!.description).toBe("Echo, again.");
  // The history no longer references it (a compaction): forgotten, so a later load takes the words of then.
  pins.loaded(s.id, v2, new Set());
  expect(pins.loaded(s.id, v2, names)[1]!.description).toBe("Echo, reworded.");
}));

test("a loaded tool whose server is not connected is declared as it was loaded, not as a stand-in", () => withPins((pins, _store, s) => {
  const schema = { type: "object", properties: { text: { type: "string" } } };
  const names = new Set(["mcp__echo__echo"]);
  const live = { ...tool("mcp__echo__echo", "Echo."), input_schema: schema, defer: true, namespace: "mcp__echo", catalog: "echo__echo" } as Tool;
  pins.loaded(s.id, [live], names);
  // After a start the server is still connecting: the catalog has no tool, and a stand-in is declared for the reference.
  const standIn = { ...tool("mcp__echo__echo", "No longer available."), defer: true, catalog: "mcp__echo__echo", left: true } as Tool;
  const sent = pins.loaded(s.id, [standIn], names)[0]!;
  expect([sent.description, sent.input_schema]).toEqual(["Echo.", schema]);
  // Every field a request sends is the loaded one's, the namespace too (the Responses wire nests by it).
  expect(pinOf(sent)).toEqual(pinOf(live));
  // Its run is still the stand-in's: a call gets the plain reason.
  expect(sent.run).toBe(standIn.run);
  // Connected again: the same definition, so the request's bytes never changed.
  expect(pins.loaded(s.id, [live], names)[0]!.description).toBe("Echo.");
  // A stand-in for a tool this session never loaded stays as it is.
  expect(pins.loaded(s.id, [{ ...standIn, name: "mcp__echo__add" } as Tool], new Set(["mcp__echo__add"]))[0]!.description).toBe("No longer available.");
}));

test("a session that takes a new build while a loaded tool's server reconnects still declares the tool as loaded", () => withPins((pins, _store, s) => {
  const schema = { type: "object", properties: { text: { type: "string" } } };
  const names = new Set(["mcp__echo__echo"]);
  const live = (description: string) => ({ ...tool("mcp__echo__echo", description), input_schema: schema, defer: true, namespace: "mcp__echo", catalog: "echo__echo" }) as Tool;
  const standIn = { ...tool("mcp__echo__echo", "No longer available."), defer: true, catalog: "mcp__echo__echo", left: true } as Tool;
  const adopt = (v: Tool[]) => {
    const why = pins.due(s, at, v, () => "a compaction");
    pins.begin(s.id, why);
    pins.tools(s, at, v);
    pins.end(s.id);
  };
  pins.prompt(s.id, undefined, blocks("one"), [], false);
  pins.tools(s, at, [tool("Read", "Reads.")]);
  pins.loaded(s.id, [live("Echo.")], names);
  // A daemon start with a build the session takes at once: the server is still connecting.
  adopt([tool("Read", "Reads, in parts.")]);
  expect(pins.loaded(s.id, [standIn], names)[0]!.description).toBe("Echo.");
  // Connected again: the definition that request carried, so the next request is the same bytes.
  expect(pins.loaded(s.id, [live("Echo.")], names)[0]!.description).toBe("Echo.");
  // A build taken while the server is connected still takes the server's words of now.
  adopt([tool("Read", "Reads, in parts, again.")]);
  expect(pins.loaded(s.id, [live("Echo, reworded.")], names)[0]!.description).toBe("Echo, reworded.");
}));

test("the open sessions behind are listed, and all can be asked at once", () => withPins((pins, store, s) => {
  const v1 = [tool("Read", "Reads.")], v2 = [tool("Read", "Reads, in parts.")];
  const other = store.createSession({ model: "p:m", workspace: "/" });
  for (const x of [s, other]) { pins.prompt(x.id, undefined, blocks("one"), [], false); pins.tools(x, at, v1); }
  pins.tools(s, at, v2);
  expect(pins.open()).toEqual({ behind: [s.id], unknown: [], asked: 0 });
  expect(pins.askAll()).toBe(1);
  expect(pins.open()).toEqual({ behind: [], unknown: [], asked: 1 });
  expect([pins.waits(s.id), pins.waits(other.id)]).toEqual(["now", undefined]);
}));
