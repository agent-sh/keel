import { expect, test } from "./isolate.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Feature: a session's system prompt is kept with the session. A daemon
// restart sends the same bytes, also while an MCP server is still connecting;
// a session that starts with the daemon waits for a server it has never seen,
// so its prompt has that server's instructions; a session that dropped out of
// the daemon's memory keeps its prompt; and when an input really changed, the
// next daemon start renders the prompt again and says which block differed.
// The spec runs its own daemons on a scratch state folder, on the scripted
// stand-in, which writes each request it gets to a file.
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");
const SLOW_MS = 5_000;
const GUIDANCE = "Slow server guidance: ask it for the tide tables.";

function daemon(state: string): Promise<{ proc: ChildProcess; url: string; spawned: number }> {
  const spawned = Date.now();
  const proc = spawn("bun", ["src/main.ts", "serve", "--bind", "127.0.0.1:0", "--state-dir", join(state, "state"), "--workspace", join(state, "work")], {
    env: {
      ...process.env, KEEL_SCRIPTED_PROVIDER: "1", KEEL_DEFAULT_MODEL: "scripted:stand-in", KEEL_DRAIN_MS: "300", KEEL_RESUME_GAP_MS: "0",
      KEEL_SCRIPTED_LOG: join(state, "requests.jsonl"), KEEL_MCP_CONFIG: join(state, "mcp.json"), KEEL_CONFIG_DIR: join(state, "config"),
      KEEL_IMPORT_HOME: join(state, "home"), KEEL_DESKTOP_NOTIFY: "off", TACIT_BIN: resolve("test/e2e/fixtures/tacit-standin.sh"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((done, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`no listen line:\n${out}`)), 30_000);
    const on = (d: Buffer) => {
      out += d;
      const m = out.match(/keel listening on (http:\/\/\S+?)\/? /);
      if (m) { clearTimeout(t); done({ proc, url: m[1]!.replace(/\/$/, ""), spawned }); }
    };
    proc.stdout!.on("data", on);
    proc.stderr!.on("data", on);
  });
}
const exited = (p: ChildProcess) => new Promise<void>((r) => (p.exitCode !== null ? r() : p.once("exit", () => r())));

test("a restart sends the same system prompt, with a slow MCP server's instructions", async () => {
  const state = join(ROOT, `prompt-${Date.now()}`);
  for (const d of ["state", "work", "config", "home"]) mkdirSync(join(state, d), { recursive: true });
  writeFileSync(join(state, "mcp.json"), JSON.stringify({ servers: { slow: { command: "bun", args: [resolve("test/e2e/fixtures/slow-mcp.ts")], env: { SLOW_MCP_MS: String(SLOW_MS) } } } }));
  const log = join(state, "requests.jsonl");
  type Sent = { ts: number; session: string; purpose: string; system: string };
  const sent = (id: string): Sent[] =>
    (existsSync(log) ? readFileSync(log, "utf8") : "").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Sent).filter((r) => r.session === id && r.purpose === "turn");
  let d = await daemon(state);
  const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as any);
  const open = async () => {
    const { session } = await call("/api/sessions", { model: "scripted:stand-in" });
    await call(`/api/sessions/${session.id}/permissions`, { mode: "full-auto" }, "PUT");
    return session.id as string;
  };
  const ended = (id: string, n: number) =>
    expect.poll(async () => (await call(`/api/sessions/${id}`)).events.filter((e: any) => e.kind === "turn_end").length, { timeout: 30_000 }).toBe(n);
  try {
    // A session that starts with the daemon: the server has never connected,
    // so the first request waits for it and carries its instructions.
    const id = await open();
    await call(`/api/sessions/${id}/messages`, { text: "script:long-tool" });
    await expect.poll(() => sent(id).length, { timeout: 30_000 }).toBe(1);
    const first = sent(id)[0]!;
    expect.soft(first.system, "the first prompt has the slow server's instructions").toContain(GUIDANCE);
    const kept = await call(`/api/telemetry/prompt?session_id=${id}`);

    // A crash while the tool runs. The next daemon continues the turn while
    // the server is still connecting: the same bytes, instructions included.
    await expect.poll(async () => (await call(`/api/sessions/${id}`)).events.some((e: any) => e.kind === "assistant"), { timeout: 15_000 }).toBe(true);
    d.proc.kill("SIGKILL");
    await exited(d.proc);
    d = await daemon(state);
    await expect.poll(() => sent(id).length, { timeout: 30_000 }).toBe(2);
    const second = sent(id)[1]!;
    expect(second.ts - d.spawned, "the continued request left before the server could connect").toBeLessThan(SLOW_MS);
    expect.soft(second.system, "the continued turn's prompt has the instructions").toContain(GUIDANCE);
    expect.soft(second.system === first.system, "the prompt after the restart is the one before it, byte for byte").toBe(true);
    const after = await call(`/api/telemetry/prompt?session_id=${id}`);
    expect.soft({ hash: after.hash, changed: after.changed }).toEqual({ hash: kept.hash, changed: null });
    expect.soft((await call(`/api/telemetry?session_id=${id}`)).breaks).toEqual([]);
    await ended(id, 2);

    // More sessions take a turn than the daemon keeps prompts in memory for,
    // and an input changes meanwhile (the server is turned off): the first
    // session's prompt stays as it is while the daemon runs.
    await expect.poll(async () => (await call("/api/mcp/servers")).servers.find((s: any) => s.name === "slow")?.state, { timeout: 30_000 }).toBe("ready");
    for (let i = 0; i < 65; i++) {
      const other = await open();
      await call(`/api/sessions/${other}/messages`, { text: "hello" });
      await ended(other, 1);
    }
    await call("/api/mcp/servers/slow/toggle", { enabled: false });
    await call(`/api/sessions/${id}/messages`, { text: "hello again" });
    await ended(id, 3);
    expect.soft(sent(id).at(-1)!.system === first.system, "a session that dropped out of memory keeps its prompt").toBe(true);

    // The next daemon start sees the changed input: the prompt is rendered
    // again, once, and the kept prompt names the block that differed.
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    d = await daemon(state);
    await call(`/api/sessions/${id}/messages`, { text: "and again" });
    await ended(id, 4);
    expect.soft(sent(id).at(-1)!.system).not.toContain(GUIDANCE);
    const now = await call(`/api/telemetry/prompt?session_id=${id}`);
    expect.soft(now.changed?.blocks).toEqual(["MCP servers are connected"]);
  } finally {
    d.proc.kill("SIGKILL");
    await exited(d.proc);
    if (test.info().errors.length === 0) rmSync(state, { recursive: true, force: true });
  }
});
