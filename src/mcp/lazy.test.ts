// A command server starts at its first call, from the tool list kept of its last run: against stand-in stdio
// servers (test/e2e/fixtures/leash-mcp.ts, which changes its tools when a file appears), with the processes
// counted from /proc. Three servers hold no process until one is called; a server whose tools changed between
// runs is held for the owner as before; one with no call for the idle bound loses its process and starts again.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogTools, surfaced } from "../tools/catalog.ts";
import { McpManager } from "./manager.ts";

const FIXTURE = join(import.meta.dir, "../../test/e2e/fixtures/leash-mcp.ts");
const dir = mkdtempSync(join(tmpdir(), "keel-lazy-"));
const flip = join(dir, "flip");
const marker = `lazy-${process.pid}-${Date.now()}`;
const NAMES = ["alpha", "beta", "gamma"];
const managers: McpManager[] = [];
afterAll(() => { for (const m of managers) m.dispose(); });
const told: string[] = [];
const sink = { capture() {} } as any;
const proc = existsSync("/proc/self/cmdline");

// The server processes of this test that are running: one name each, from the command line.
const running = (): string[] => {
  const out: string[] = [];
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (args.includes(marker) && args.includes(FIXTURE)) out.push(args[args.indexOf(marker) + 1]!);
    } catch { /* gone */ }
  }
  return [...new Set(out)].sort();
};
const manager = (state: string, extra: Record<string, object> = {}) => {
  const m = new McpManager(sink, state, "/");
  m.onToolsHeld = (name, changes) => void told.push(`${name}: ${changes.map((c) => `${c.name} ${c.kind}`).join(", ")}`);
  for (const n of NAMES) (m as any).addEntry(n, { command: "bun", args: [FIXTURE, "--flip", flip, marker, n], ...extra[n] });
  managers.push(m);
  return m;
};
const ctx = () => ({ sessionId: "s1", cwd: "/", signal: new AbortController().signal, spillDir: mkdtempSync(join(tmpdir(), "keel-spill-")) }) as any;
const state = (m: McpManager, n: string) => m.list().find((s) => s.name === n)!;
const until = async (f: () => boolean) => {
  for (let i = 0; i < 100 && !f(); i++) await Bun.sleep(50);
  expect(f()).toBe(true);
};
// A run that connects every server once: what the next daemon finds kept.
const firstRun = async (s: string) => {
  const first = manager(s);
  await Promise.all(NAMES.map((n) => first.ensure(n)));
  expect(running()).toEqual(NAMES);
  first.dispose();
  await until(() => running().length === 0);
};

test.skipIf(!proc)("a daemon with three command servers holds no process until one is called, and the call gets its answer", async () => {
  const s = join(dir, "state");
  await firstRun(s);
  expect(existsSync(join(s, "mcp-tools.json"))).toBe(true);

  // The next daemon lists their tools and starts nothing.
  const m = manager(s);
  m.start();
  await Bun.sleep(300); // (start connects what has no kept listing a moment after it returns)
  expect(running()).toEqual([]);
  expect(NAMES.map((n) => state(m, n).state)).toEqual(["idle", "idle", "idle"]);
  expect(state(m, "beta").tool_names).toEqual(["lookup", "environment"]);
  const listed = (await catalogTools()).filter((t) => NAMES.includes(t.server));
  expect(listed.map((t) => t.qualified).sort()).toEqual(NAMES.flatMap((n) => [`${n}__environment`, `${n}__lookup`]).sort());
  expect(running()).toEqual([]);
  expect((await m.configured()).find((x) => x.name === "alpha")?.instructions).toBe("Use lookup for words. Instructions-one.");

  // One call starts one server, and only it.
  const out = await m.call("beta", "lookup", { word: "tea" }, ctx());
  expect(String(out.content)).toBe("looked up tea");
  expect(running()).toEqual(["beta"]);
  expect(state(m, "beta").state).toBe("ready");
  expect(state(m, "alpha").state).toBe("idle");

  // A search that shows a tool of a sleeping server starts that server.
  surfaced([{ server: "gamma" }]);
  await until(() => running().join() === "beta,gamma" && state(m, "gamma").state === "ready");

  // Idle for the bound: its process ends, its tools stay, the next call starts it again.
  expect(m.stopIdle(Date.now() + 10 * 60_000, 30)).toEqual([]);
  expect(m.stopIdle(Date.now() + 31 * 60_000, 30)).toEqual(["beta", "gamma"]);
  await until(() => running().length === 0);
  expect(state(m, "beta").state).toBe("idle");
  expect(state(m, "beta").tools).toBe(2);
  expect(String((await m.call("beta", "lookup", { word: "again" }, ctx())).content)).toBe("looked up again");
  expect(running()).toEqual(["beta"]);
  m.dispose();
});

test.skipIf(!proc)("a server the owner keeps running connects as before, and another set of environment names is another server", async () => {
  const s = join(dir, "state-keep");
  await firstRun(s);
  const m = manager(s, { alpha: { keep_running: true }, gamma: { env: { LAZY_EXTRA: "1" } } });
  expect(NAMES.map((n) => state(m, n).state)).toEqual(["connecting", "idle", "connecting"]);
  await m.ensure("alpha");
  await m.ensure("gamma");
  await m.ensure("beta");
  expect(m.stopIdle(Date.now() + 31 * 60_000, 30)).toEqual(["beta", "gamma"]);
  expect(state(m, "alpha").state).toBe("ready");
  m.dispose();
});

test.skipIf(!proc)("a server whose tools changed between runs is held for the owner when it starts", async () => {
  const s = join(dir, "state-changed");
  await firstRun(s);
  told.length = 0;
  writeFileSync(flip, "");
  try {
    const m = manager(s);
    const text = async () => Object.fromEntries((await catalogTools()).filter((t) => t.server === "alpha").map((t) => [t.name, t.description]));
    // Asleep it lists what the owner accepted, and nothing is held yet.
    expect(state(m, "alpha").held).toBeUndefined();
    expect((await text()).lookup).toBe("Look up a word. Wording-one.");
    expect(running()).toEqual([]);
    // Its first call starts it; what it lists now differs, and the existing review holds it.
    await m.call("alpha", "lookup", { word: "x" }, ctx());
    expect(running()).toEqual(["alpha"]);
    expect(told).toEqual(["alpha: lookup changed, upload added"]);
    expect(state(m, "alpha").held?.changes.map((c) => `${c.name} ${c.kind}`)).toEqual(["lookup changed", "upload added"]);
    // The model still has the accepted text, and none of the new tool.
    const now = await text();
    expect(now.lookup).toBe("Look up a word. Wording-one.");
    expect(now.upload).toBeUndefined();
    m.dispose();
    await until(() => running().length === 0);

    // The changed list is what is kept: the next daemon shows the hold with no process.
    const again = manager(s);
    expect(state(again, "alpha").state).toBe("idle");
    expect(state(again, "alpha").held?.changes.map((c) => `${c.name} ${c.kind}`)).toEqual(["lookup changed", "upload added"]);
    expect(running()).toEqual([]);
    again.dispose();
  } finally {
    rmSync(flip, { force: true });
  }
});
