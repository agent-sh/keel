// The ChatGPT backend lists only the models a client of the version asked for
// knows. Codex's models cache names the version of whichever Codex wrote it
// last, which can be an older install than the one this daemon runs.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexProvider, newerVersion } from "./codex.ts";

test("newer of two versions compares numbers, not text", () => {
  expect(newerVersion("0.9.0", "0.10.0")).toBe("0.10.0");
  expect(newerVersion("1.2.3", undefined)).toBe("1.2.3");
  expect(newerVersion(undefined, undefined)).toBeUndefined();
});

test("the listing asks for the installed Codex's version over an older cache, and sees an upgrade without a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-codex-"));
  const home = join(dir, "home"), bin = join(dir, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-access", refresh_token: "fixture-refresh" }, last_refresh: new Date().toISOString() }));
  writeFileSync(join(home, "models_cache.json"), JSON.stringify({ client_version: "0.1.0", models: [] }));
  const codex = (v: string) => { writeFileSync(join(bin, "codex"), `#!/bin/sh\necho "codex-cli ${v}"\n`); chmodSync(join(bin, "codex"), 0o755); };
  codex("0.3.0");
  const asked: string[] = [];
  const server = Bun.serve({ port: 0, fetch: (req) => { asked.push(new URL(req.url).searchParams.get("client_version") ?? ""); return Response.json({ models: [] }); } });
  const env = { home: process.env.CODEX_HOME, base: process.env.KEEL_CODEX_BASE_URL, path: process.env.PATH };
  process.env.CODEX_HOME = home;
  process.env.KEEL_CODEX_BASE_URL = `http://127.0.0.1:${server.port}`;
  process.env.PATH = `${bin}:${env.path}`;
  try {
    const p = new CodexProvider();
    await p.list();
    expect(asked.at(-1)).toBe("0.3.0");
    // Codex upgraded while the daemon runs: the next listing asks for the new version.
    codex("0.4.10");
    await p.list();
    expect(asked.at(-1)).toBe("0.4.10");
    // A cache written by a newer Codex than the one on PATH wins.
    writeFileSync(join(home, "models_cache.json"), JSON.stringify({ client_version: "0.5.0", models: [] }));
    await p.list();
    expect(asked.at(-1)).toBe("0.5.0");
  } finally {
    server.stop(true);
    for (const [k, v] of [["CODEX_HOME", env.home], ["KEEL_CODEX_BASE_URL", env.base], ["PATH", env.path]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});

// A stand-in for the backend's Responses route over HTTP and WebSocket. Like
// the documented stream, each response event carries the response object, and
// in it the tool catalog the request sent and the usage's attribution per item,
// unless the request's x-codex-exclude names them.
function echoingBackend() {
  const seen: { via: string; exclude: string | null }[] = [];
  let bytes = 0;
  const events = (body: any, exclude: string) => {
    const drop = new Set(exclude.split(",").map((s) => s.trim()));
    const usage = { input_tokens: 1200, output_tokens: 7, input_tokens_details: { cached_tokens: 1000 }, ...(drop.has("usage.attribution") ? {} : { attribution: (body.tools ?? []).map((t: any) => ({ tool: t.name, input_tokens: 40 })) }) };
    const response = (status: string, more: object = {}) => ({ id: "resp_1", status, model: body.model, ...(drop.has("tools") ? {} : { tools: body.tools ?? [] }), ...more });
    const item = { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] };
    return [
      { type: "response.created", response: response("in_progress") },
      { type: "response.in_progress", response: response("in_progress") },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: response("completed", { output: [item], usage }) },
    ].map((e) => JSON.stringify(e));
  };
  const srv = Bun.serve({
    port: 0,
    async fetch(req, s) {
      const exclude = req.headers.get("x-codex-exclude");
      if (req.headers.get("upgrade") === "websocket") {
        seen.push({ via: "ws", exclude });
        return s.upgrade(req, { data: { exclude: exclude ?? "" } }) ? undefined : new Response("no", { status: 400 });
      }
      seen.push({ via: new URL(req.url).pathname, exclude });
      const out = events(await req.json(), exclude ?? "").map((e) => `data: ${e}\n\n`).join("");
      bytes += out.length;
      return new Response(out, { headers: { "content-type": "text/event-stream" } });
    },
    websocket: {
      data: {} as { exclude: string },
      message(ws, raw) {
        for (const e of events(JSON.parse(String(raw)), ws.data.exclude)) { bytes += e.length; ws.send(e); }
      },
    },
  });
  return { base: `http://127.0.0.1:${srv.port}`, seen, bytes: () => bytes, stop: () => srv.stop(true) };
}

// Codex asks the backend not to echo the tool catalog or the attribution per
// item on every Responses request and handshake (openai/codex#62863, #63219):
// each response event of a stream repeats the whole catalog otherwise.
test("a response is asked without the echoed tool catalog over HTTP and the socket, and its usage is still read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-codex-"));
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-access", refresh_token: "fixture-refresh" }, last_refresh: new Date().toISOString() }));
  const b = echoingBackend();
  const env = { home: process.env.CODEX_HOME, base: process.env.KEEL_CODEX_BASE_URL, broker: process.env.KEEL_PROVIDER_ENV_FILE };
  process.env.CODEX_HOME = dir;
  process.env.KEEL_CODEX_BASE_URL = b.base;
  delete process.env.KEEL_PROVIDER_ENV_FILE;
  // A catalog of 40 tools of about 4 KB each: the size a turn's tools zone has.
  const tools = Array.from({ length: 40 }, (_, i) => ({ name: `tool_${i}`, description: "d".repeat(3000), input_schema: { type: "object", properties: { a: { type: "string", description: "x".repeat(1000) } } } }));
  const ask = (sessionKey?: string) => new CodexProvider().stream({ model: "gpt-test", system: "be brief", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools, signal: new AbortController().signal, sessionKey }, () => {});
  try {
    const http = await ask();
    const ws = await ask("s1");
    expect(b.seen).toEqual([{ via: "/responses", exclude: "tools,usage.attribution" }, { via: "ws", exclude: "tools,usage.attribution" }]);
    for (const r of [http, ws]) expect(r.usage).toMatchObject({ input: 200, cache_read: 1000, output: 7 });
    // Four response events with the catalog in three would be over 450 KB a call.
    expect(b.bytes()).toBeLessThan(4000);
  } finally {
    b.stop();
    for (const [k, v] of [["CODEX_HOME", env.home], ["KEEL_CODEX_BASE_URL", env.base], ["KEEL_PROVIDER_ENV_FILE", env.broker]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});
