// Where a manager keeps its server list, and what a save does to a file
// that changed under it.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDir, inConfigDir } from "../providers/config.ts";
import { defaultStateDir } from "../core/paths.ts";
import { configPath, mergeServers } from "./config.ts";
import { McpManager } from "./manager.ts";

const dir = () => mkdtempSync(join(tmpdir(), "keel-mcp-save-"));
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const off = (command: string) => ({ command, enabled: false }); // off: nothing is started
const errors = { capture() {} } as any;

test("a manager writes the file it was given, and one given none cannot save", () => {
  const d = dir(), file = join(d, "mcp.json");
  const m = new McpManager(errors, join(d, "state"), "/", file);
  expect(m.add("mine", off("x"))).toBeNull();
  expect(Object.keys(read(file).servers)).toEqual(["mine"]);
  m.dispose();

  // No file given: it holds what it is handed, and every writer refuses before it changes anything.
  const none = new McpManager(errors, join(d, "state2"), "/");
  (none as any).addEntry("s", off("x"));
  for (const write of [() => none.add("t", off("y")), () => none.setReads("s", ["a"]), () => none.toggle("s", true), () => none.remove("s")]) expect(write).toThrow("no config file");
  expect(none.list().map((s) => [s.name, s.enabled, s.read_tools])).toEqual([["s", false, []]]);
  none.dispose();
  // The process-wide default was not written by either.
  expect(existsSync(configPath())).toBe(false);
});

test("a save keeps what the file gained since it was read, and what it replaced is the .prev", () => {
  // The file an owner has: two servers and a key of their own. The manager never read it.
  const d = dir(), file = join(d, "mcp.json");
  const owners = JSON.stringify({ servers: { a: off("a"), b: off("b") }, note: "kept" }, null, 2);
  writeFileSync(file, owners);
  const m = new McpManager(errors, join(d, "state"), "/", file);
  (m as any).addEntry("s", off("s"));
  (m as any).cfg.servers.s = off("s");
  m.setReads("s", ["x"]);
  let now = read(file);
  expect(Object.keys(now.servers).sort()).toEqual(["a", "b", "s"]);
  expect(now.servers.s.read_tools).toEqual(["x"]);
  expect(now.note).toBe("kept");
  expect(readFileSync(file + ".prev", "utf8")).toBe(owners);
  // What the file had is taken up, as a reload would.
  expect(m.list().map((s) => s.name)).toEqual(["a", "b", "s"]);

  // A hand edit after that: b changed, c added, a taken out. Then the manager turns s on.
  writeFileSync(file, JSON.stringify({ servers: { b: { ...off("b"), args: ["--by-hand"] }, c: off("c"), s: now.servers.s }, note: "kept" }, null, 2));
  m.toggle("s", true);
  now = read(file);
  expect(Object.keys(now.servers).sort()).toEqual(["b", "c", "s"]);
  expect(now.servers.b.args).toEqual(["--by-hand"]);
  expect(now.servers.s.enabled).toBeUndefined();
  expect(m.list().map((s) => s.name)).toEqual(["b", "c", "s"]);
  // The manager's own removal wins over the file, and its next save sees no change to merge.
  m.remove("c");
  expect(Object.keys(read(file).servers).sort()).toEqual(["b", "s"]);

  m.dispose();
});

test("a save that fails changes nothing, and a later save does not bring the change in", () => {
  const d = dir(), file = join(d, "mcp.json");
  const good = JSON.stringify({ servers: { a: off("a"), b: off("b"), c: off("c") } }, null, 2) + "\n";
  writeFileSync(file, good);
  const m = new McpManager(errors, join(d, "state"), "/", file);
  m.start();
  const shown = () => m.list().filter((s) => !s.bundled).map((s) => [s.name, s.enabled, s.read_tools.join()]);
  const before = shown();
  // A file that no longer parses is not written over, and every writer leaves the manager as it was.
  writeFileSync(file, "{ not json");
  for (const write of [() => m.remove("b"), () => m.add("e", off("e")), () => m.setReads("a", ["x"]), () => m.toggle("c", true)]) expect(write).toThrow("cannot be read");
  expect(readFileSync(file, "utf8")).toBe("{ not json");
  expect(shown()).toEqual(before);
  // The file put right: the next save writes its own change and none of the ones that failed.
  writeFileSync(file, good);
  m.setReads("c", ["y"]);
  const now = read(file).servers;
  expect(Object.keys(now)).toEqual(["a", "b", "c"]);
  expect([now.a.read_tools, now.c.read_tools, now.c.enabled]).toEqual([undefined, ["y"], false]);
  m.dispose();
});

test("a file that is gone is written whole, and a top-level key changed by hand is kept", () => {
  const d = dir(), file = join(d, "mcp.json");
  writeFileSync(file, JSON.stringify({ note: "v1", servers: { a: off("a"), b: off("b"), c: off("c") } }, null, 2) + "\n");
  const m = new McpManager(errors, join(d, "state"), "/", file);
  m.start();
  // Gone is not "every server taken out by hand".
  rmSync(file);
  m.setReads("a", ["x"]);
  expect(Object.keys(read(file))).toEqual(["note", "servers"]);
  expect(Object.keys(read(file).servers)).toEqual(["a", "b", "c"]);
  expect(m.list().filter((s) => !s.bundled).map((s) => s.name)).toEqual(["a", "b", "c"]);
  // The owner changes a key of their own and adds one: the manager's older copy does not win.
  const mine = read(file);
  writeFileSync(file, JSON.stringify({ added: 1, note: "v2-by-hand", servers: mine.servers }, null, 2) + "\n");
  m.toggle("b", true);
  const now = read(file);
  expect(Object.keys(now)).toEqual(["added", "note", "servers"]);
  expect([now.added, now.note, now.servers.b.enabled]).toEqual([1, "v2-by-hand", undefined]);
  m.dispose();
});

test("the merge is by server name: a writer's own changes are its own, the rest is the file's", () => {
  const base = { a: off("a"), b: off("b"), c: off("c") };
  const mine = { a: off("a"), b: { ...off("b"), read_tools: ["x"] } };                 // changed b, removed c
  const disk = { a: { ...off("a"), args: ["hand"] }, b: off("b2"), c: off("c"), d: off("d") }; // changed a and b, added d
  const { servers, theirs } = mergeServers(base, mine, disk);
  expect(servers).toEqual({ a: disk.a, b: mine.b, d: disk.d });
  expect(theirs.sort()).toEqual(["a", "d"]);
});

test("under bun test the owner's own folders are never the default", () => {
  const kept = { c: process.env.KEEL_CONFIG_DIR, s: process.env.KEEL_STATE_DIR };
  expect(kept.c).toContain("keel-test-"); // test/preload.ts
  delete process.env.KEEL_CONFIG_DIR;
  delete process.env.KEEL_STATE_DIR;
  try {
    expect(() => configDir()).toThrow("under a test the owner's config folder is never the default");
    expect(() => defaultStateDir()).toThrow("under a test the owner's state folder is never the default");
    // A folder named with a trailing slash still holds its files.
    process.env.KEEL_CONFIG_DIR = "/scratch/config/";
    expect([inConfigDir("/scratch/config/mcp.json"), inConfigDir("/scratch/config"), inConfigDir("/scratch/config-other/mcp.json")]).toEqual([true, false, false]);
  } finally {
    process.env.KEEL_CONFIG_DIR = kept.c;
    process.env.KEEL_STATE_DIR = kept.s;
  }
});
