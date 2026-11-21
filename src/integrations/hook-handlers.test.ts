process.env.KEEL_CONFIG_DIR ??= `${process.env.TMPDIR ?? "."}/keel-hook-handlers-config`;
// The hook handlers that are not a shell command: a POST of the event to a
// URL, a tool of an MCP server, and a program run without a shell.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { Store } = await import("../core/store.ts");
const { Hooks, fillInput, hookMcp, parseHooks } = await import("./hooks.ts");

const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "hk-kind-"));
const kept = { hooks: process.env.KEEL_HOOKS, call: hookMcp.call };
const hooksFile = join(dir, "hooks.json");
process.env.KEEL_HOOKS = hooksFile;
process.env.HK_SINK_TOKEN = "sink-token";
process.env.HK_OTHER_SECRET = "must-not-leave";
const ws = join(dir, "ws");
mkdirSync(join(ws, ".git"), { recursive: true });
const store = new Store(join(dir, "state"));
const hooks = new Hooks(store);
const s = store.createSession({ model: "fixture:m", workspace: ws });

// The local sink: it keeps what it was sent and answers by its path.
const got: { path: string; headers: Record<string, string>; body: any }[] = [];
const sink = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    got.push({ path, headers: Object.fromEntries(req.headers), body: await req.json() });
    if (path === "/deny") return Response.json({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "the sink says no" } });
    if (path === "/context") return Response.json({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "from the sink" } });
    if (path === "/text") return new Response("plain words, not an answer");
    if (path === "/broken") return new Response("down", { status: 500 });
    if (path === "/away") return Response.redirect("http://127.0.0.1:1/elsewhere", 302);
    return new Response("");
  },
});
afterAll(() => {
  sink.stop(true);
  hookMcp.call = kept.call;
  if (kept.hooks === undefined) delete process.env.KEEL_HOOKS; else process.env.KEEL_HOOKS = kept.hooks;
  delete process.env.HK_SINK_TOKEN;
  delete process.env.HK_OTHER_SECRET;
  rmSync(dir, { recursive: true, force: true });
});
const url = (path: string) => `http://127.0.0.1:${sink.port}${path}`;
const file = (handlers: unknown[], event = "PreToolUse") => writeFileSync(hooksFile, JSON.stringify({ hooks: { [event]: [{ matcher: "Bash", hooks: handlers }] } }));
const pre = () => hooks.run("PreToolUse", s, { tool_name: "Bash", tool_input: { command: "npm test", count: 3 }, tool_use_id: "call-1" }, ["Bash"]);

test("an http hook receives the event and its answer is read like a command's", async () => {
  file([{ type: "http", url: url("/quiet"), headers: { Authorization: "Bearer $HK_SINK_TOKEN", "X-Other": "${HK_OTHER_SECRET}" }, allowedEnvVars: ["HK_SINK_TOKEN"] }]);
  expect(await pre()).toEqual({ context: [], ran: 1 });
  expect(got.at(-1)).toMatchObject({ path: "/quiet", body: { session_id: s.id, cwd: ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "call-1" } });
  // A header takes an environment variable only when the hook lists it.
  expect(got.at(-1)!.headers).toMatchObject({ "content-type": "application/json", authorization: "Bearer sink-token", "x-other": "" });
  // A JSON object is the hook's answer.
  file([{ type: "http", url: url("/deny") }]);
  expect((await pre()).block).toBe("the sink says no");
  file([{ type: "http", url: url("/context") }]);
  expect((await pre()).context).toEqual(["from the sink"]);
});

test("an http hook that fails blocks only when it says so", async () => {
  // Text that is not JSON, a 500, a redirect and a server that is not there: failed hooks, and the call goes ahead.
  for (const u of [url("/text"), url("/broken"), url("/away"), "http://127.0.0.1:1/nothing-listens"]) {
    file([{ type: "http", url: u }]);
    expect(await pre()).toEqual({ context: [], ran: 1 });
    file([{ type: "http", url: u, onFailure: "block" }]);
    expect((await pre()).block).toStartWith("a hook failed");
  }
});

test("an mcp_tool hook calls the server's tool with the event's values", async () => {
  const called: any[] = [];
  hookMcp.call = async (server, tool, input, ms) => {
    called.push({ server, tool, input, ms });
    if (tool === "refuse") return { text: JSON.stringify({ decision: "block", reason: "the scanner refused it" }) };
    if (tool === "broken") return { text: "it broke", error: true };
    return { text: "scanned: clean" };
  };
  const input = { command: "${tool_input.command}", count: "${tool_input.count}", note: "Scanning ${tool_input.command} (${tool_input.count})", missing: "${tool_input.nothing}", nested: { id: ["${tool_use_id}"] } };
  file([{ type: "mcp_tool", server: "scanner", tool: "scan", input, timeout: 30 }]);
  expect((await pre()).context).toEqual(["scanned: clean"]);
  expect(called.at(-1)).toEqual({ server: "scanner", tool: "scan", ms: 30_000, input: { command: "npm test", count: 3, note: "Scanning npm test (3)", missing: null, nested: { id: ["call-1"] } } });
  file([{ type: "mcp_tool", server: "scanner", tool: "refuse" }]);
  expect((await pre()).block).toBe("the scanner refused it");
  // An error answer, or a server that cannot be reached, fails the hook and not the call.
  file([{ type: "mcp_tool", server: "scanner", tool: "broken" }]);
  expect(await pre()).toEqual({ context: [], ran: 1 });
  hookMcp.call = async () => { throw new Error("no MCP server named scanner"); };
  expect(await pre()).toEqual({ context: [], ran: 1 });
  expect(fillInput("${a.b}", { a: { b: [1, 2] } })).toEqual([1, 2]);
});

test("a command hook with args runs the program itself, each argument one word", async () => {
  const script = join(dir, "args.sh");
  writeFileSync(script, `#!/usr/bin/env bash\ncat > /dev/null\nprintf '%s' "$#:$1:$2:$3"\n`);
  chmodSync(script, 0o755);
  file([{ type: "command", command: script, args: ["two words", "$(echo not-run)", "${KEEL_PROJECT_DIR}/x"] }]);
  expect((await pre()).context).toEqual([`3:two words:$(echo not-run):${ws}/x`]);
});

test("a handler that cannot run is named in the file's problems", () => {
  const { groups, problems } = parseHooks(JSON.stringify({ hooks: { Stop: [{ hooks: [
    { type: "prompt", prompt: "Is the work done? $ARGUMENTS" }, { type: "agent", prompt: "Check the tests." },
    { type: "http", url: "ftp://example.test/x" }, { type: "mcp_tool", server: "scanner" }, { type: "command", command: "true", args: "x" }, { type: "webhook" },
    { type: "http", url: "http://127.0.0.1:9/ok" },
  ] }] } }));
  expect(groups.Stop![0]!.hooks).toEqual([{ type: "http", url: "http://127.0.0.1:9/ok" }]);
  expect(problems).toEqual([
    "Stop: prompt hooks are read and not run: they ask a model on every event",
    "Stop: agent hooks are read and not run: they ask a model on every event",
    "Stop: an http hook needs an http or https url",
    "Stop: an mcp_tool hook needs a server and a tool",
    "Stop: a command hook's args must be a list of strings",
    "Stop: no handler of type webhook",
  ]);
});
