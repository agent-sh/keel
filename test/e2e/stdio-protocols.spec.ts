import { expect, test } from "./isolate.ts";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { sessionsFolder } from "./own-daemon.ts";
import { exited, ownDaemon, ownEnv } from "./peer.ts";

// Feature: the streams Keel speaks a protocol on carry the protocol and nothing else. The
// daemon writes its own account of its life to its log (a start, what it found, a settings
// change, an agent, a Stop, a drain, a restart, the spans a kill cut); none of that, and no other
// byte, is on a stream an editor, a script, an MCP server, a language server or an ACP agent
// reads. Every byte of each stream is kept (fixtures/stdio-tap.ts, or the command's own output)
// while the daemon says each kind of line, across a kill and a stop, and then read back whole:
//   - an MCP server over stdio, both directions
//   - a language server, both directions
//   - an ACP agent the daemon starts, both directions
//   - keel acp, what an editor reads
//   - keel run with stream-json, against the daemon and with no daemon answering
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");
const fx = (f: string) => resolve("test/e2e/fixtures", f);
const MAIN = resolve("src/main.ts");
const calls = (c: unknown[]) => `script:calls ${JSON.stringify(c)}`;

// A stream of JSON-RPC, one message a line: every byte belongs to a message.
function rpcLines(bytes: Buffer, what: string): any[] {
  const text = bytes.toString("utf8");
  expect(`${what}: ends with a newline: ${text.endsWith("\n")}`).toBe(`${what}: ends with a newline: true`);
  return text.split("\n").slice(0, -1).map((l) => {
    let m: any;
    try { m = JSON.parse(l); } catch { throw new Error(`${what}: a line that is no JSON: ${JSON.stringify(l.slice(0, 200))}`); }
    expect(`${what}: ${m?.jsonrpc}`).toBe(`${what}: 2.0`);
    return m;
  });
}
// A stream of the language server protocol: a header, a body of exactly that length, and nothing between two messages.
function frames(bytes: Buffer, what: string): any[] {
  const out: any[] = [];
  for (let at = 0; at < bytes.length; ) {
    const end = bytes.indexOf("\r\n\r\n", at);
    const head = end < 0 ? bytes.subarray(at, at + 200).toString("latin1") : bytes.subarray(at, end).toString("latin1");
    const m = /^Content-Length: (\d+)(?:\r\nContent-Type: [^\r\n]+)?$/.exec(head);
    if (!m) throw new Error(`${what}: bytes that are no message header at ${at}: ${JSON.stringify(head.slice(0, 200))}`);
    const body = bytes.subarray(end + 4, end + 4 + Number(m[1]));
    expect(`${what}: a whole body: ${body.length}`).toBe(`${what}: a whole body: ${m[1]}`);
    const msg = JSON.parse(body.toString("utf8"));
    expect(`${what}: ${msg?.jsonrpc}`).toBe(`${what}: 2.0`);
    out.push(msg);
    at = end + 4 + Number(m[1]);
  }
  return out;
}
// What keel run writes with stream-json: one JSON object a line, each with a type.
function streamLines(text: string, what: string): any[] {
  expect(`${what}: ends with a newline: ${text.endsWith("\n")}`).toBe(`${what}: ends with a newline: true`);
  return text.split("\n").slice(0, -1).map((l) => {
    let m: any;
    try { m = JSON.parse(l); } catch { throw new Error(`${what}: a line that is no JSON: ${JSON.stringify(l.slice(0, 200))}`); }
    expect(`${what}: ${typeof m?.type}`).toBe(`${what}: string`);
    return m;
  });
}
// A command, its input given whole, its two outputs read whole.
function runWith(args: string[], env: NodeJS.ProcessEnv, stdin: string, cwd: string): Promise<{ code: number | null; out: Buffer; err: string }> {
  return new Promise((done) => {
    const p = spawn("bun", [MAIN, ...args], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [], err: Buffer[] = [];
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => err.push(d));
    p.on("close", (code) => done({ code, out: Buffer.concat(out), err: Buffer.concat(err).toString() }));
    p.stdin.end(stdin);
  });
}

const made: string[] = [];
test.afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

test("every byte on a protocol's stream is the protocol, while the daemon logs every kind of line", async () => {
  test.setTimeout(300_000);
  // (The sessions' folder is beside the state, not in it: Keel refuses a write into its own state.)
  const state = join(ROOT, `stdio-${Date.now()}`), taps = join(state, "taps"), ws = sessionsFolder(state), alone = join(state, "alone");
  made.push(state);
  for (const d of [taps, ws, alone]) mkdirSync(d, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: ws });
  const tap = (name: string, ...cmd: string[]) => [fx("stdio-tap.ts"), join(taps, name), ...cmd];
  const env = { KEEL_RESUME_GAP_MS: "0" };
  let d = await ownDaemon(state, 0, env);
  const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => {
      const t = await r.text();
      try { return JSON.parse(t); } catch { return t; }
    }) as Promise<any>;
  const open = async (title: string, more: object = {}) => {
    const { session } = await call("/api/sessions", { model: "scripted:stand-in", title, workspace: ws, ...more });
    await call(`/api/sessions/${session.id}/permissions`, { mode: "full-auto", sandbox: "off" }, "PUT");
    return session.id as string;
  };
  const idle = (id: string) => expect.poll(async () => (await call(`/api/sessions/${id}`)).running, { timeout: 60_000 }).toBe(false);
  const run = async (id: string, text: string) => { await call(`/api/sessions/${id}/messages`, { text }); await idle(id); };
  const results = async (id: string) => JSON.stringify(((await call(`/api/sessions/${id}`)).events as any[]).filter((e) => e.kind === "tool_result").map((e) => e.data.results));
  try {
    // --- the three programs the daemon starts, each behind a tap
    expect((await call("/api/mcp/servers", { name: "tapped", command: "bun", args: tap("mcp", "bun", fx("echo-mcp.ts")) })).error).toBeUndefined();
    expect((await call("/api/acp/agents", { id: "tapped", command: "bun", args: tap("acp", "bun", fx("acp-agent-standin.ts")) })).error).toBeUndefined();
    // (A settings change: its own line in the log.)
    await call("/api/settings", { diagnostics: { mode: "errors", min_free_mb: 0, wait_ms: 400, servers: { tapped: { command: ["bun", ...tap("lsp", "bun", fx("lsp-standin.ts"), "slow", "100")], extensions: { ".slow": "plaintext" } } } } }, "PATCH");
    await expect.poll(async () => ((await call("/api/mcp/servers")).servers as any[]).find((s) => s.name === "tapped")?.state, { timeout: 30_000 }).toBe("ready");
    const tools = await open("Tools"), agent = await open("Agent", { model: "acp:tapped" });

    // One round of every protocol.
    const round = async (n: number) => {
      // An MCP tool, and a file the language server is asked about.
      await run(tools, calls([{ name: "mcp_call", input: { tool: "tapped__echo", arguments: { text: `round ${n}` } } }, { name: "Write", input: { file_path: join(ws, `note-${n}.slow`), content: "fine\nthis line is an ERROR\n" } }]));
      expect(await results(tools)).toContain(`echo: round ${n}`);
      // The ACP agent the daemon starts: a prompt, the command it asks for, the file it writes, its reply.
      await run(agent, `hello ${n}`);
      expect(readFileSync(join(ws, "acp-note.txt"), "utf8")).toBe(`hello ${n}`);
      // An editor over keel acp: what it reads is kept whole.
      const ed = spawn("bun", [MAIN, "acp", "--url", d.url], { env: ownEnv(state), stdio: ["pipe", "pipe", "pipe"] });
      const read: Buffer[] = [];
      let seen = 0;
      const waiting = new Map<number, (m: any) => void>();
      ed.stdout.on("data", (b: Buffer) => {
        read.push(b);
        const lines = Buffer.concat(read).toString("utf8").split("\n").slice(0, -1);
        for (const l of lines.slice(seen)) { try { const m = JSON.parse(l); if (m.id !== undefined && !m.method) waiting.get(m.id)?.(m); else if (m.id !== undefined) ed.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: "once" } } })}\n`); } catch {} }
        seen = lines.length;
      });
      let next = 1;
      const ask = (method: string, params: unknown) => new Promise<any>((res, rej) => { const id = next++; waiting.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))); ed.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); });
      await ask("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const made = await ask("session/new", { cwd: ws, mcpServers: [] });
      await ask("session/set_config_option", { sessionId: made.sessionId, configId: "model", value: "scripted:stand-in" });
      expect((await ask("session/prompt", { sessionId: made.sessionId, prompt: [{ type: "text", text: `script:say Editor round ${n}.` }] })).stopReason).toBe("end_turn");
      ed.stdin.end();
      await exited(ed);
      const editor = rpcLines(Buffer.concat(read), `keel acp, round ${n}`);
      expect(JSON.stringify(editor)).toContain(`Editor round ${n}.`);
      // A script over keel run with stream-json, against this daemon.
      const said = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
      const held = await runWith(["run", "--input-format", "stream-json", "--url", d.url], ownEnv(state), `${said(`script:say Script round ${n}.`)}\n${said(calls([{ name: "Bash", input: { command: "echo from-the-script" } }]))}\n`, ws);
      const lines = streamLines(held.out.toString("utf8"), `keel run to the daemon, round ${n}`);
      expect([held.code, lines.filter((l) => l.type === "result").map((l) => l.subtype)]).toEqual([0, ["success", "success"]]);
    };

    await round(1);
    // --- the daemon says each kind of line: an agent's start and end, the owner's Stop, then a kill under a running turn
    const lane = await open("Coordinator");
    await run(lane, calls([{ name: "spawn_agent", input: { message: "Lane\nscript:say The lane is done.", isolation: "none" } }, { name: "wait_agent", input: { timeout_ms: 30000 } }]));
    const stopped = await open("Stopped");
    await call(`/api/sessions/${stopped}/messages`, { text: calls([{ name: "Bash", input: { command: "sleep 60; echo never" } }]) });
    await expect.poll(async () => (await call(`/api/sessions/${stopped}`)).running, { timeout: 30_000 }).toBe(true);
    await call(`/api/sessions/${stopped}/interrupt`, { by: "owner" });
    await idle(stopped);
    const long = await open("Long tool");
    await call(`/api/sessions/${long}/messages`, { text: calls([{ name: "Bash", input: { command: "sleep 6; echo slept" } }]) });
    await expect.poll(async () => ((await call(`/api/sessions/${long}`)).events as any[]).some((e) => e.kind === "assistant" && (e.data.blocks as any[]).some((b) => b.type === "tool_use")), { timeout: 30_000 }).toBe(true);
    d.proc.kill("SIGKILL");
    await exited(d.proc);
    d = await ownDaemon(state, d.port, env);
    await expect.poll(async () => !!(await call("/api/daemon")).last_start?.settled_ms, { timeout: 60_000 }).toBe(true);
    await idle(long);
    await expect.poll(async () => ((await call("/api/mcp/servers")).servers as any[]).find((s) => s.name === "tapped")?.state, { timeout: 30_000 }).toBe("ready");
    await round(2);
    // A stop that was asked for, and the next start.
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    d = await ownDaemon(state, d.port, env);

    // --- keel run with no daemon answering: the daemon is inside the command, and its output is the command's
    const soloEnv = { ...ownEnv(alone), KEEL_SCRIPTED_PROVIDER: "1", KEEL_DEFAULT_MODEL: "scripted:stand-in", KEEL_DESKTOP_NOTIFY: "off", KEEL_MCP_CONFIG: join(alone, "mcp.json") };
    const said = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
    const solo = await runWith(["run", "--input-format", "stream-json", "--permission-mode", "full-auto"], soloEnv, `${said("script:say Alone.")}\n${said(calls([{ name: "spawn_agent", input: { message: "Lane\nscript:say The lane is done.", isolation: "none" } }, { name: "wait_agent", input: { timeout_ms: 30000 } }]))}\n`, ws);
    const soloLines = streamLines(solo.out.toString("utf8"), "keel run with no daemon");
    // (The agent's report is a turn of its own: three results.)
    const ended = soloLines.filter((l) => l.type === "result").map((l) => l.subtype);
    expect([solo.code, ended.length >= 2, ended.every((x) => x === "success")], solo.err).toEqual([0, true, true]);
    // Its plain answer is the answer and nothing else.
    const plain = await runWith(["run", "-p", "script:say Only this."], soloEnv, "", ws);
    expect([plain.code, plain.out.toString("utf8")]).toEqual([0, "Only this.\n"]);

    // --- every byte of the taps is protocol, in both directions
    const bytes = (name: string) => readFileSync(join(taps, name));
    for (const name of ["mcp.in", "mcp.out", "acp.in", "acp.out", "lsp.in", "lsp.out"]) expect(`${name}: ${existsSync(join(taps, name))}`).toBe(`${name}: true`);
    const methods = (ms: any[]) => [...new Set(ms.map((m) => m.method).filter(Boolean))];
    expect(methods(rpcLines(bytes("mcp.in"), "to the MCP server"))).toEqual(expect.arrayContaining(["initialize", "tools/list", "tools/call"]));
    expect(rpcLines(bytes("mcp.out"), "from the MCP server").length).toBeGreaterThan(3);
    expect(methods(rpcLines(bytes("acp.in"), "to the ACP agent"))).toEqual(expect.arrayContaining(["initialize", "session/new", "session/prompt"]));
    expect(methods(rpcLines(bytes("acp.out"), "from the ACP agent"))).toEqual(expect.arrayContaining(["session/update"]));
    expect(methods(frames(bytes("lsp.in"), "to the language server"))).toEqual(expect.arrayContaining(["initialize", "textDocument/didOpen"]));
    expect(frames(bytes("lsp.out"), "from the language server").length).toBeGreaterThan(1);

    // --- and the daemon did say each kind of line meanwhile, in its log
    const log = async (q: string) => ((await call(`/api/logs?limit=2000&q=${encodeURIComponent(q)}`)).lines as { text: string }[]).length;
    const kinds = ["[daemon] started", "[daemon] providers found", "[daemon] MCP servers", "[daemon] settings changed", "[agent] started", "[agent] ended", "[turn] stopped by the owner",
      "[daemon] The daemon went down without stopping", "left running", "[turn] cut", "[turn] continued after the restart", "[daemon] draining for a stop", "[daemon] stopping cleanly"];
    await expect.poll(async () => (await Promise.all(kinds.map(async (k) => ((await log(k)) > 0 ? "" : k)))).filter(Boolean), { timeout: 30_000 }).toEqual([]);
    expect(await log("[daemon] started")).toBe(3);
  } finally {
    if (d.proc.exitCode === null && d.proc.signalCode === null) { d.proc.kill("SIGKILL"); await exited(d.proc); }
  }
});
