// What changes under a connected server: its prompt list (the server says so)
// and the folders it is told (Keel says so). Both against stand-in servers over
// stdio, since the order of a notification and the request it sets off is the
// point.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { McpManager } from "./manager.ts";

const FIXTURES = join(import.meta.dir, "../../test/e2e/fixtures");
const managers: McpManager[] = [];
afterAll(() => { for (const m of managers) m.dispose?.(); });
const manager = (name: string, args: string[]) => {
  const m = new McpManager({ capture() {} } as any, mkdtempSync(join(tmpdir(), "keel-mcp-")), "/");
  (m as any).addEntry(name, { command: "bun", args });
  managers.push(m);
  return m;
};
const ctx = (sessionId: string, cwd: string) => ({ sessionId, cwd, signal: new AbortController().signal, spillDir: mkdtempSync(join(tmpdir(), "keel-spill-")) }) as any;
const text = (o: { content: unknown }) => String(o.content);

test("a server that says its prompts changed is listed again; one that did not is not asked again", async () => {
  const m = manager("echo", [join(FIXTURES, "echo-mcp.ts"), "--extras"]);
  const c = await m.ensure("echo");
  let lists = 0;
  const list = c.listPrompts.bind(c);
  c.listPrompts = (signal?: AbortSignal) => (lists++, list(signal));
  const rev = () => m.list().find((s) => s.name === "echo")!.prompts_rev;
  const before = rev();
  expect(before).toBeGreaterThan(0);
  const names = async () => (await m.allPrompts()).map((p) => p.name);
  expect(await names()).toEqual(["greet", "summarize", "dialog"]);
  expect(await names()).toEqual(["greet", "summarize", "dialog"]);
  expect(lists).toBe(1);
  expect(text(await m.call("echo", "learn", {}, ctx("s1", "/")))).toBe("learned farewell");
  expect(rev()).toBe(before + 1);
  expect(await names()).toEqual(["greet", "summarize", "dialog", "farewell"]);
  expect(lists).toBe(2);
});

test("a local server is told the folders changed when a call's session has others, and asks again", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "keel-roots-")));
  const a = join(base, "a"), b = join(base, "b");
  mkdirSync(a);
  mkdirSync(b);
  const root = (dir: string) => JSON.stringify({ roots: [{ uri: pathToFileURL(dir).href, name: dir.split("/").pop() }] });
  const m = manager("rooter", [join(FIXTURES, "ask-mcp.ts")]);
  await m.ensure("rooter");
  // (The server asks for the folders as soon as it is connected: it was started in "/".)
  const call = async (tool: string, session: string, dir: string) => text(await m.call("rooter", tool, {}, ctx(session, dir)));
  // It is offered roots that say when they change. That first call told it they did: it asked again
  // while the call ran (the stand-in answers a call before it hears that answer, so the next call shows it).
  expect(JSON.parse(await call("caps", "s1", a)).roots).toEqual({ listChanged: true });
  expect(await call("latest", "s1", a)).toBe(`latest after 1 changes: ${root(a)}`);
  expect(await call("latest", "s1", a)).toBe(`latest after 1 changes: ${root(a)}`);
  await call("caps", "s2", b);
  expect(await call("latest", "s2", b)).toBe(`latest after 2 changes: ${root(b)}`);
});
