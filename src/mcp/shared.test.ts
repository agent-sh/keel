// The servers sessions own, one connection for each spec: against a stand-in stdio server
// (test/e2e/fixtures/editor-mcp.ts), with its processes counted from /proc. Sessions given the same command,
// arguments, environment, folder and sandbox share one process; any difference is another; the process ends with
// its last holder; a session never given the server neither sees nor reaches it; and the next daemon starts none
// of them until one is called, from the tool list kept for the spec.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogTools } from "../tools/catalog.ts";
import { McpManager } from "./manager.ts";

const FIXTURE = join(import.meta.dir, "../../test/e2e/fixtures/editor-mcp.ts");
const dir = mkdtempSync(join(tmpdir(), "keel-shared-"));
const marker = `shared-${process.pid}-${Date.now()}`;
const proc = existsSync("/proc/self/cmdline");
const sink = { capture() {} } as any;
const managers: McpManager[] = [];
afterAll(() => { for (const m of managers) m.dispose(); });

// How many processes of this test's server run.
const running = (): number => {
  let n = 0;
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (args.includes(marker) && args.includes(FIXTURE)) n++;
    } catch { /* gone */ }
  }
  return n;
};
const until = async (f: () => boolean) => {
  for (let i = 0; i < 100 && !f(); i++) await Bun.sleep(50);
  expect(f()).toBe(true);
};
const ctx = (sessionId: string) => ({ sessionId, cwd: "/", signal: new AbortController().signal, spillDir: mkdtempSync(join(tmpdir(), "keel-spill-")) }) as any;
const folder = (n: string) => { const d = join(dir, n); mkdirSync(d, { recursive: true }); return d; };
const server = (env?: Record<string, string>) => ({ name: "notes", config: { command: "bun", args: [FIXTURE, marker], ...(env ? { env } : {}) } });
const call = async (m: McpManager, session: string, text: string) => String((await m.call(`notes@${session}`, "echo", { text }, ctx(session))).content);
const offered = async (session: string) => (await catalogTools(session)).filter((t) => t.server === "notes").length;

test.skipIf(!proc)("sessions given the same server share one process; another environment, folder or sandbox is another; it ends with its last holder; a session never given it cannot reach it", async () => {
  const m = new McpManager(sink, join(dir, "state-a"), "/");
  managers.push(m);
  let wrap = "a";
  m.sessionSandbox = (_s, argv) => ({ argv: ["sh", "-c", 'exec "$@"', wrap, ...argv], as: "read-only" });
  const one = folder("one"), two = folder("two");

  m.setSessionServers("s1", [server()], { cwd: one });
  m.setSessionServers("s2", [server()], { cwd: one });
  await until(() => m.list("s1").some((x) => x.session && x.state === "ready") && m.list("s2").some((x) => x.session && x.state === "ready"));
  expect([running(), m.sharedStats()]).toEqual([1, { connections: 1, holders: [2] }]);
  expect([await call(m, "s1", "x"), await call(m, "s2", "y")]).toEqual(["echo: x", "echo: y"]);

  // A session that was never given the server: no entry, no tool offered, and nothing named for it.
  expect([m.list("s3").filter((x) => x.session).length, await offered("s1"), await offered("s2"), await offered("s3")]).toEqual([0, 3, 3, 0]);
  expect(String((await m.call("notes@s3", "echo", { text: "z" }, ctx("s3"))).content)).toContain("no MCP server");

  // The environment, the folder and the sandbox each make another connection; the same again joins.
  m.setSessionServers("s3", [server({ SHARED_PROBE: "1" })], { cwd: one });
  m.setSessionServers("s4", [server()], { cwd: two });
  wrap = "b";
  m.setSessionServers("s5", [server()], { cwd: one });
  await until(() => m.sharedStats().connections === 4);
  expect(running()).toBe(4);
  wrap = "a";
  m.setSessionServers("s6", [server()], { cwd: one });
  // (Its tool list was kept when the first of them started: it waits for its first call, which joins the process.)
  expect([m.list("s6").find((x) => x.session)?.state, running(), m.sharedStats().holders.slice().sort()]).toEqual(["idle", 4, [1, 1, 1, 2]]);
  expect(await call(m, "s6", "joined")).toBe("echo: joined");
  expect([running(), m.sharedStats().connections, m.sharedStats().holders.slice().sort()]).toEqual([4, 4, [1, 1, 1, 3]]);
  for (const s of ["s3", "s4", "s5"]) m.releaseSession(s);
  await until(() => running() === 1);

  // One holder goes: the others' calls go on. The last goes: the process ends.
  m.releaseSession("s1");
  expect([running(), m.sharedStats().holders, await call(m, "s2", "still")]).toEqual([1, [2], "echo: still"]);
  m.releaseSession("s2");
  expect([running(), m.sharedStats().holders, await call(m, "s6", "last")]).toEqual([1, [1], "echo: last"]);
  expect(await offered("s1")).toBe(0);
  m.releaseSession("s6");
  await until(() => running() === 0);
  expect(m.sharedStats().connections).toBe(0);
}, 20_000);

test.skipIf(!proc)("the next daemon starts none of them until a call, one start serves every holder, and the process stops when the last holder idles", async () => {
  const state = join(dir, "state-b");
  const cwd = folder("kept");
  const first = new McpManager(sink, state, "/");
  managers.push(first);
  first.setSessionServers("s1", [server()], { cwd });
  await until(() => first.list("s1").some((x) => x.session && x.state === "ready"));
  expect(running()).toBe(1);
  await first.keptWritten();
  first.dispose();
  await until(() => running() === 0);

  const m = new McpManager(sink, state, "/");
  managers.push(m);
  m.start();
  for (const s of ["s1", "s2", "s3"]) m.setSessionServers(s, [server()], { cwd });
  await Bun.sleep(300);
  const states = () => ["s1", "s2", "s3"].map((s) => m.list(s).find((x) => x.session)!);
  expect([running(), states().map((x) => x.state), states().map((x) => x.tools)]).toEqual([0, ["idle", "idle", "idle"], [3, 3, 3]]);
  expect(await offered("s2")).toBe(3);
  expect(running()).toBe(0);

  // A call from one starts the process; another's call joins it.
  expect(await call(m, "s2", "a")).toBe("echo: a");
  expect([running(), m.sharedStats()]).toEqual([1, { connections: 1, holders: [1] }]);
  expect(await call(m, "s3", "b")).toBe("echo: b");
  expect([running(), m.sharedStats()]).toEqual([1, { connections: 1, holders: [2] }]);

  // Idle: each holder lets go; the process ends with the last of them. A call starts it again.
  expect(m.stopIdle(Date.now() + 3 * 3_600_000, 30).length).toBe(2);
  await until(() => running() === 0);
  expect(states().map((x) => x.state)).toEqual(["idle", "idle", "idle"]);
  expect(await call(m, "s1", "again")).toBe("echo: again");
  expect(running()).toBe(1);
  m.dispose();
  await until(() => running() === 0);
});
