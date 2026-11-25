import { expect, test } from "./isolate.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { sessionsFolder, specEnv } from "./own-daemon.ts";
import { inHead, leaveHead, shoot } from "./shots.ts";

// Feature: an MCP call that runs long goes on in the background. After the
// server's time (mcp_background.after_secs, two seconds here) the model is
// told so with a handle, its turn goes on, and the call's end wakes the
// session once with the file the result is in, not the result itself (a
// server's text is read with a tool). The call is a wait of the session: the
// page lists it, the owner cancels it, and a task a remote server made of the
// call is followed again by a daemon that started after the restart.
// Each test runs its own daemon on the scripted stand-in; the servers are the
// stand-ins under fixtures/ (long-mcp.ts, task-http-mcp.ts).
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");
const LONG = join(import.meta.dirname, "fixtures/long-mcp.ts");
const TASKS = join(import.meta.dirname, "fixtures/task-http-mcp.ts");

function daemon(state: string): Promise<{ proc: ChildProcess; url: string }> {
  const proc = spawn("bun", ["src/main.ts", "serve", "--bind", "127.0.0.1:0", "--state-dir", state, "--workspace", sessionsFolder(state)], {
    env: specEnv(state, { KEEL_DRAIN_MS: "300" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`no listen line:\n${out}`)), 30_000);
    const on = (d: Buffer) => {
      out += d;
      const m = out.match(/keel listening on (http:\/\/\S+?)\/? /);
      if (m) { clearTimeout(t); resolve({ proc, url: m[1]!.replace(/\/$/, "") }); }
    };
    proc.stdout!.on("data", on);
    proc.stderr!.on("data", on);
  });
}
const exited = (p: ChildProcess) => new Promise<void>((r) => (p.exitCode !== null ? r() : p.once("exit", () => r())));

async function setup(name: string) {
  const state = join(ROOT, `mcp-background-${name}-${Date.now()}`);
  mkdirSync(state, { recursive: true });
  const at = { d: await daemon(state) };
  const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(at.d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json() as any) }));
  expect((await call("/api/settings", { mcp_background: { after_secs: 2 } }, "PATCH")).status).toBe(200);
  const session = async (title: string) => {
    const { session } = await call("/api/sessions", { model: "scripted:stand-in", title });
    await call(`/api/sessions/${session.id}/permissions`, { mode: "full-auto" }, "PUT");
    return session.id as string;
  };
  const events = async (id: string) => (await call(`/api/sessions/${id}`)).events as any[];
  return {
    at, state, call, session, events,
    send: (id: string, ...calls: { name: string; input: unknown }[]) => call(`/api/sessions/${id}/messages`, { text: `script:calls ${JSON.stringify(calls)}` }),
    results: async (id: string) => (await events(id)).filter((e) => e.kind === "tool_result").map((e) => String(e.data.results[0].content)),
    // The wakes of MCP calls the session was given, in the text the model read.
    wakes: async (id: string) => (await events(id)).filter((e) => e.kind === "user" && JSON.stringify(e.data).includes('kind=\\"mcp_call\\"')).map((e) => JSON.stringify(e.data)),
    ends: async (id: string) => (await events(id)).filter((e) => e.kind === "turn_end").length,
    restart: async () => {
      at.d.proc.kill("SIGTERM");
      await exited(at.d.proc);
      at.d = await daemon(state);
    },
    stop: async () => {
      at.d.proc.kill("SIGKILL");
      await exited(at.d.proc);
      rmSync(state, { recursive: true, force: true });
    },
  };
}

test("a call that runs long goes on in the background, and its end wakes the session once", async ({ page }) => {
  const k = await setup("long");
  try {
    const log = join(k.state, "long.log");
    expect((await k.call("/api/mcp/servers", { name: "long", command: "bun", args: [LONG], env: { LONG_MCP_LOG: log } })).status).toBe(200);
    await expect.poll(async () => ((await k.call("/api/mcp/servers")).servers as any[]).find((s) => s.name === "long")?.state, { timeout: 30_000 }).toBe("ready");
    const id = await k.session("A long call");
    await page.goto(`${k.at.d.url}/s/${id}`);

    // The nap takes six seconds. At two the turn is told it goes on, and the next call of the same turn runs.
    const t0 = Date.now();
    await k.send(id, { name: "mcp_call", input: { tool: "long__nap", arguments: { seconds: 6 } } }, { name: "mcp_call", input: { tool: "long__quick", arguments: {} } });
    await expect.poll(async () => (await k.results(id)).length, { timeout: 20_000 }).toBe(2);
    expect(Date.now() - t0).toBeLessThan(5_500);
    const [handle, quick] = await k.results(id);
    expect(handle).toMatch(/^long__nap has run for \d+ s, so it goes on in the background \(wait \w+\)/);
    expect(quick).toContain("quick: done");
    const waitId = /\(wait (\w+)\)/.exec(handle!)![1]!;
    // (Told how to stop it, and that a restart ends it: this server runs in the daemon.)
    expect(handle).toContain("a restart ends it");
    expect(handle).toMatch(/Stop it with (TaskStop|cancel_wait) and \w+/);

    // The page lists it with the session's waits while it runs.
    await expect.poll(async () => await k.ends(id), { timeout: 20_000 }).toBe(1);
    await (await inHead(page, "background-button")).click();
    await expect(page.getByTestId("bg-wait")).toContainText("MCP call long__nap");
    await shoot(page, "mcp-background-01-listed");
    await page.keyboard.press("Escape");
    await leaveHead(page);

    // Its end starts the next turn, with the file its result is in.
    await expect.poll(async () => (await k.wakes(id)).length, { timeout: 30_000 }).toBe(1);
    const wake = (await k.wakes(id))[0]!;
    expect(wake).toContain(waitId);
    const file = /(\/[^\s"\\]+mcp-call-\w+\.txt)/.exec(wake)?.[1];
    expect(file).toBeTruthy();
    expect(wake).not.toContain("napped 6 seconds"); // a server's words are read from the file, not given as the harness's
    expect(readFileSync(file!, "utf8")).toBe("napped 6 seconds\n");
    await expect.poll(async () => await k.ends(id), { timeout: 30_000 }).toBe(2);
    await shoot(page, "mcp-background-02-woken");
    // Called once, woken once.
    expect(readFileSync(log, "utf8").trim().split("\n").filter((l) => l.startsWith("start nap"))).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 1_500));
    expect((await k.wakes(id)).length).toBe(1);
    expect(((await k.call("/api/waits")).waits as any[]).filter((w) => w.kind === "mcp_call").map((w) => w.status)).toEqual(["fired"]);
  } finally {
    await k.stop();
  }
});

test("a task a remote server made of the call is followed after a restart, and the owner can cancel one", async () => {
  const k = await setup("task");
  // A free port, found and given up: the stand-in server takes it.
  const port = await new Promise<number>((resolve) => { const l = createServer().listen(0, "127.0.0.1", () => { const p = (l.address() as { port: number }).port; l.close(() => resolve(p)); }); });
  const srv = spawn("bun", [TASKS], { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, TASK_MCP_PORT: String(port) } });
  try {
    await expect.poll(() => fetch(`http://127.0.0.1:${port}/stats`).then((r) => r.ok, () => false), { timeout: 15_000 }).toBe(true);
    const stats = async () => ((await (await fetch(`http://127.0.0.1:${port}/stats`)).json()) as { seen: { method: string; taskId?: string }[] }).seen;
    expect((await k.call("/api/mcp/servers", { name: "jobs", url: `http://127.0.0.1:${port}/mcp` })).status).toBe(200);
    await expect.poll(async () => { const s = ((await k.call("/api/mcp/servers")).servers as any[]).find((x) => x.name === "jobs"); return `${s?.state} ${s?.error ?? ""}`.trim(); }, { timeout: 30_000 }).toBe("ready");
    const id = await k.session("A task call");

    // 1. The call is a task its server runs; two seconds on, it goes on in the background with its task kept.
    await k.send(id, { name: "mcp_call", input: { tool: "jobs__job", arguments: {} } });
    await expect.poll(async () => (await k.results(id)).length, { timeout: 20_000 }).toBe(1);
    expect((await k.results(id))[0]).toContain("followed again if the daemon restarts");
    await expect.poll(async () => await k.ends(id), { timeout: 20_000 }).toBe(1);
    const looked = (await stats()).filter((s) => s.method === "tasks/get").length;
    expect(looked).toBeGreaterThan(0);

    // 2. The daemon restarts: its wait is still there, and the task is looked at again, never cancelled.
    await k.restart();
    await expect.poll(async () => (await stats()).filter((s) => s.method === "tasks/get").length, { timeout: 30_000 }).toBeGreaterThan(looked);
    expect(((await k.call("/api/waits")).waits as any[]).filter((w) => w.kind === "mcp_call").map((w) => w.status)).toEqual(["active"]);
    expect(await k.wakes(id)).toHaveLength(0);

    // 3. The task ends: the session is woken once, with the file the result is in.
    await fetch(`http://127.0.0.1:${port}/control`, { method: "POST", body: JSON.stringify({ finish: true }) });
    await expect.poll(async () => (await k.wakes(id)).length, { timeout: 30_000 }).toBe(1);
    const file = /(\/[^\s"\\]+mcp-call-\w+\.txt)/.exec((await k.wakes(id))[0]!)?.[1];
    expect(readFileSync(file!, "utf8")).toBe("task job-1 result\n");
    await expect.poll(async () => await k.ends(id), { timeout: 30_000 }).toBe(2);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(await k.wakes(id)).toHaveLength(1);
    expect((await stats()).some((s) => s.method === "tasks/cancel")).toBe(false);

    // 4. A second call, cancelled by the owner: its task is cancelled, and nothing wakes the session.
    await fetch(`http://127.0.0.1:${port}/control`, { method: "POST", body: JSON.stringify({ finish: false }) });
    await k.send(id, { name: "mcp_call", input: { tool: "jobs__job", arguments: {} } });
    await expect.poll(async () => ((await k.call("/api/waits")).waits as any[]).filter((w) => w.kind === "mcp_call" && w.status === "active").length, { timeout: 20_000 }).toBe(1);
    const wait = ((await k.call("/api/waits")).waits as any[]).find((w) => w.kind === "mcp_call" && w.status === "active");
    expect((await k.call(`/api/waits/${wait.id}`, undefined, "DELETE")).cancelled).toBe(true);
    await expect.poll(async () => (await stats()).filter((s) => s.method === "tasks/cancel").length, { timeout: 15_000 }).toBe(1);
    expect(await k.wakes(id)).toHaveLength(1);
  } finally {
    srv.kill("SIGKILL");
    await k.stop();
  }
});
