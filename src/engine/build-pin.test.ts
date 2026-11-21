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

test("the owner's side of the prompt, an urgent block, the session's own tools and the owner's request do not wait", () => withPins((pins, _store, s) => {
  const v1 = [tool("Read", "Reads.")];
  const kept = blocks("one");
  pins.prompt(s.id, undefined, kept, [], false);
  pins.tools(s, at, v1);
  // The owner's files changed: the prompt is taken at once and the tools follow at the same request.
  expect(pins.prompt(s.id, kept, blocks("one", "rules, edited"), ["instruction files"], false)).toBe(true);
  expect(pins.due(s, at, v1, never)).toBe("the owner's side changed (instruction files)");
  pins.tools(s, at, v1);
  expect(pins.state(s.id).adoptions[0]).toMatchObject({ reason: "the owner's side changed (instruction files)", blocks: ["instruction files"], tools: [] });
  // A block of the owner's data: the build's other words around the same data wait, other data does not.
  const servers = "MCP servers are connected";
  expect(pins.prompt(s.id, kept, blocks("one", "rules", { text: "Connected servers: a", data: "a" }), [servers], false)).toBe(false);
  expect(pins.prompt(s.id, kept, blocks("one", "rules", { text: "Servers: a, b", data: "a, b" }), [servers], false)).toBe(true);
  pins.tools(s, at, v1);
  // The last server went: the block is empty, its data changed.
  expect(pins.prompt(s.id, kept, blocks("one", "rules", { text: "", data: "" }), [servers], false)).toBe(true);
  pins.tools(s, at, v1);
  // A prompt kept from before data was fingerprinted: a changed data block counts as the owner's.
  const before = kept.map(({ data: _, ...b }) => b);
  expect(pins.prompt(s.id, before, blocks("one", "rules", { text: "Connected servers: a", data: "a" }), [servers], false)).toBe(true);
  pins.tools(s, at, v1);
  expect(pins.prompt(s.id, before, blocks("two"), ["core"], false)).toBe(false);
  // A data block new to the prompt is the build's: it waits.
  expect(pins.prompt(s.id, kept.filter((b) => b.name !== servers), kept, [servers], false)).toBe(false);
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
  expect(pins.waits(s.id)).toBe("asked");
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
