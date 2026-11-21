// Where a manager keeps its server list, and what a save does to a file
// that changed under it.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDir } from "../providers/config.ts";
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

  // A file that no longer parses is not written over.
  writeFileSync(file, "{ not json");
  expect(() => m.setReads("s", [])).toThrow("cannot be read");
  expect(readFileSync(file, "utf8")).toBe("{ not json");
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
    expect(() => configDir()).toThrow("a test asked for the owner's config folder");
    expect(() => defaultStateDir()).toThrow("a test asked for the owner's state folder");
  } finally {
    process.env.KEEL_CONFIG_DIR = kept.c;
    process.env.KEEL_STATE_DIR = kept.s;
  }
});
