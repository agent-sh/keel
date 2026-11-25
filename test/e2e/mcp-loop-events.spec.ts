import { expect, test } from "./isolate.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionsFolder, specEnv } from "./own-daemon.ts";
import { shoot } from "./shots.ts";

// Feature: a loop that runs on a connected MCP server's notification. `/loop on SERVER METHOD [ADDRESS] prompt` makes
// it; the server is started and kept, an address it names is subscribed to, and a notification of that kind is one
// run with the event framed as data. The loop's card says the trigger. A session the owner stopped takes none.
// Its own daemon on the scripted stand-in; the server is the stand-in under fixtures/events-mcp.ts, told what to
// send through a file.
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");
const EVENTS = join(import.meta.dirname, "fixtures/events-mcp.ts");

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

test("a server's notification runs a loop once, and the owner's Stop keeps it from running the session", async ({ page }) => {
  const state = join(ROOT, `mcp-loop-events-${Date.now()}`);
  mkdirSync(state, { recursive: true });
  const control = join(state, "control.jsonl");
  const log = join(state, "events.log");
  writeFileSync(control, "");
  const d = await daemon(state);
  const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json() as any) }));
  const emit = (method: string, params: unknown) => appendFileSync(control, JSON.stringify({ method, params }) + "\n");
  const logged = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  try {
    expect((await call("/api/mcp/servers", { name: "events", command: "bun", args: [EVENTS], env: { EVENTS_MCP_CONTROL: control, EVENTS_MCP_LOG: log } })).status).toBe(200);
    await expect.poll(async () => ((await call("/api/mcp/servers")).servers as any[]).find((s) => s.name === "events")?.state, { timeout: 30_000 }).toBe("ready");
    const { session } = await call("/api/sessions", { model: "scripted:stand-in", title: "Orders" });
    const id = session.id as string;
    await call(`/api/sessions/${id}/permissions`, { mode: "full-auto" }, "PUT");
    await page.goto(`${d.url}/s/${id}`);

    // 1. /loop on SERVER METHOD: no run at once; a server's own method, sent with the protocol's prefix, matches.
    const made = await call(`/api/sessions/${id}/command`, { text: "/loop on events acme/order_placed Check the new order" });
    expect(made.handled).toBe(true);
    const loop = made.loop;
    expect(loop).toMatchObject({ kind: "mcp", schedule: "on events acme/order_placed", schedule_text: "when events sends acme/order_placed", prompt: "Check the new order", next_ms: null });
    const runs = async () => ((await call(`/api/loops/${loop.id}/runs`)).runs as any[]);
    expect(await runs()).toHaveLength(0);
    emit("notifications/acme/order_placed", { id: 7 });
    await expect.poll(async () => (await runs()).filter((r) => r.started_ms).length, { timeout: 30_000 }).toBe(1);
    const events = async () => (await call(`/api/sessions/${id}`)).events as any[];
    const prompt = JSON.stringify((await events()).find((e) => e.kind === "user" && JSON.stringify(e.data).includes("untrusted_mcp_event"))?.data);
    expect(prompt).toContain("Check the new order");
    expect(prompt).toContain('{\\"server\\":\\"events\\",\\"method\\":\\"acme/order_placed\\",\\"params\\":{\\"id\\":7}}');
    await expect.poll(async () => (await runs())[0]?.outcome, { timeout: 30_000 }).toBe("ok");

    // 2. The card says what it waits for.
    await page.getByTestId("loops-button").click();
    const item = page.getByTestId("loop-item").filter({ hasText: "Check the new order" }).first();
    await expect(item).toContainText("when events sends acme/order_placed");
    await expect(item).toContainText("on event");
    await item.click();
    await expect(page.getByTestId("loop-run")).toHaveCount(1);
    await shoot(page, "mcp-loop-events-01-card");
    await page.keyboard.press("Escape");

    // 3. A loop on resources/updated for an address subscribes to it, and an update of another address is no run.
    const watch = await call("/api/loops", { session_id: id, prompt: "Read the page again", schedule: "on events resources/updated file:///page" });
    expect(watch.status).toBe(201);
    await expect.poll(() => logged().filter((l) => l === "subscribe file:///page").length, { timeout: 30_000 }).toBe(1);
    emit("notifications/resources/updated", { uri: "file:///elsewhere" });
    await expect.poll(() => logged().includes("sent notifications/resources/updated"), { timeout: 10_000 }).toBe(true);
    await new Promise((r) => setTimeout(r, 1_500));
    const watchRuns = async () => ((await call(`/api/loops/${watch.id}/runs`)).runs as any[]);
    expect((await watchRuns()).filter((r) => r.started_ms)).toHaveLength(0);

    // 4. The owner's Stop: the session is held, and a notification is not run (nor kept for later).
    await call(`/api/sessions/${id}/messages`, { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "sleep 60" } }])}` });
    const count = async (kind: string) => (await events()).filter((e) => e.kind === kind).length;
    await expect.poll(async () => (await count("turn_start")) - (await count("turn_end")), { timeout: 30_000 }).toBe(1);
    await new Promise((r) => setTimeout(r, 1_000)); // (the command is under way)
    await call(`/api/sessions/${id}/interrupt`, { by: "owner" });
    await expect.poll(async () => (await count("turn_start")) - (await count("turn_end")), { timeout: 30_000 }).toBe(0);
    const before = (await runs()).filter((r) => r.started_ms).length;
    emit("notifications/acme/order_placed", { id: 8 });
    await expect.poll(async () => (await runs()).filter((r) => r.skip_reason).map((r) => r.skip_reason).join("|"), { timeout: 30_000 }).toContain("the session's queue is held");
    expect((await runs()).filter((r) => r.started_ms)).toHaveLength(before);
    await shoot(page, "mcp-loop-events-02-held");
  } finally {
    d.proc.kill("SIGKILL");
    rmSync(state, { recursive: true, force: true });
  }
});
