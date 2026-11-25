import { expect, test } from "./isolate.ts";
import { mkdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { shoot } from "./shots.ts";

// Feature: a local MCP server can ask which folders the client works in
// (roots/list), and every server is told what Keel offers. During a call the
// answer is the folder of the session that made the call; a server that asks
// as soon as it is connected gets the folder it was started in. A modern
// server is not offered roots (the 2026-07-28 revision deprecates them). A
// local server is told when the folders change (roots.listChanged): a call
// from a session whose folder it was not told makes it ask again. The
// server is the stand-in under fixtures/ask-mcp.ts; the calls come from the
// scripted provider.
test("mcp roots: a local server is told the session's folder", async ({ page, request }) => {
  const fixture = join(import.meta.dirname, "fixtures/ask-mcp.ts");
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `roots-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const names = ["rooter", "rooter2"];
  try {
    await request.post("/api/mcp/servers", { data: { name: "rooter", command: "bun", args: [fixture] } });
    await request.post("/api/mcp/servers", { data: { name: "rooter2", command: "bun", args: [fixture, "--modern"] } });
    const ready = async () => ((await (await request.get("/api/mcp/servers")).json()).servers as any[]).filter((s) => names.includes(s.name) && s.state === "ready").length;
    await expect.poll(ready, { timeout: 30_000 }).toBe(2);
    const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", workspace: ws, title: "A server asks for the folders" } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
    const call = (tool: string) => ({ name: "mcp_call", input: { tool, arguments: {} } });
    await page.goto(`/s/${session.id}`);
    await page.getByTestId("composer").fill(`script:calls ${JSON.stringify([call("rooter__roots"), call("rooter__start"), call("rooter__caps"), call("rooter2__caps"), call("rooter__latest")])}`);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 60_000 });
    const results = ((await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[])
      // (A memory note may follow a result: the server's words are what comes before it.)
      .filter((e) => e.kind === "tool_result").map((e) => String(e.data.results[0].content).split("\n\n<memory")[0]!);
    expect(results).toHaveLength(5);
    const root = (dir: string) => ({ roots: [{ uri: pathToFileURL(realpathSync(dir)).href, name: basename(dir) }] });
    // In a call: the folder of the session that called.
    expect(results[0]).toBe(`roots: ${JSON.stringify(root(ws))}`);
    // Outside any call: one root, a file URI of a folder that exists (where the server was started).
    const atStart = JSON.parse(results[1]!.slice("start: ".length));
    expect(atStart.roots).toHaveLength(1);
    expect(atStart.roots[0].uri).toMatch(/^file:\/\/\//);
    expect(atStart.roots[0].uri).not.toBe(root(ws).roots[0]!.uri);
    // What each was told Keel offers: roots to the legacy local server only, elicitation in both modes and sampling to both, the apps extension to both, and the tasks and skills extensions to the modern one.
    const apps = { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } };
    expect(JSON.parse(results[2]!)).toEqual({ elicitation: { form: {}, url: {} }, sampling: {}, roots: { listChanged: true }, extensions: apps });
    expect(JSON.parse(results[3]!)).toEqual({ elicitation: { form: {}, url: {} }, sampling: {}, extensions: { "io.modelcontextprotocol/tasks": {}, "io.modelcontextprotocol/skills": {}, ...apps } });
    // Its first call came from a session with another folder: the server was told the folders
    // changed, once, and the folder it asked for again is that session's.
    expect(results[4]).toBe(`latest after 1 changes: ${JSON.stringify(root(ws))}`);

    const tool = page.getByTestId("tool-call").first();
    await tool.click();
    await expect(tool).toContainText(pathToFileURL(realpathSync(ws)).href);
    await shoot(page, "mcp-roots-01-result");
    await request.delete(`/api/sessions/${session.id}`);
  } finally {
    for (const n of names) await request.delete(`/api/mcp/servers/${n}`).catch(() => {});
  }
});
