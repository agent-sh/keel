import { expect, test } from "./isolate.ts";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

// Feature: a message a session was told is sent is delivered, once. A message
// to a working session is kept in its queue (the page and the sender's agent
// list show it), a working agent takes its parent's message at its next step,
// and neither a restart, a kill nor a turn that ended while the daemon was
// stopping loses it: the next daemon delivers it, after the restart note when
// the turn was cut. A message whose session went away is told to its sender.
// This spec runs its own daemons on a scratch state folder, on the scripted
// stand-in.
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");

function daemon(state: string, extra: Record<string, string> = {}): Promise<{ proc: ChildProcess; url: string }> {
  const proc = spawn("bun", ["src/main.ts", "serve", "--bind", "127.0.0.1:0", "--state-dir", state, "--workspace", state], {
    // A config folder of its own: never the owner's.
    env: { KEEL_CONFIG_DIR: join(state, "config"), ...process.env, KEEL_SCRIPTED_PROVIDER: "1", KEEL_DRAIN_MS: "300", KEEL_DEFAULT_MODEL: "scripted:stand-in", KEEL_DESKTOP_NOTIFY: "off", ...extra },
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

const made: string[] = [];
test.afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

// One daemon over a scratch state folder, restarted in place. A held tool
// reads a named pipe: it ends when something is written there.
async function rig(name: string) {
  const state = join(ROOT, `${name}-${Date.now()}`);
  made.push(state);
  mkdirSync(state, { recursive: true });
  let d = await daemon(state);
  const call = (path: string, body?: unknown, method = "POST") =>
    fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as any);
  const gate = (n: string) => { const p = join(state, `gate-${n}`); spawnSync("mkfifo", [p]); return p; };
  const hold = (g: string) => ({ name: "Bash", input: { command: `timeout 120 cat ${g} > /dev/null; echo released` } });
  const release = (g: string) => spawnSync("sh", ["-c", `echo go > ${g}`], { timeout: 10_000 });
  const view = (id: string) => call(`/api/sessions/${id}`, undefined, "GET");
  const events = async (id: string) => (await view(id)).events as any[];
  // The commands of the tool calls the session's model made, in order.
  const commands = async (id: string) => (await events(id)).flatMap((e) => (e.kind === "assistant" ? e.data.blocks.filter((b: any) => b.type === "tool_use").map((b: any) => String(b.input?.command ?? b.name)) : []));
  const prompts = async (id: string, words: string) => (await events(id)).filter((e) => e.kind === "user" && String(e.data.text).includes(words));
  const session = async (title: string) => {
    const { session } = await call("/api/sessions", { model: "scripted:stand-in", title });
    await call(`/api/sessions/${session.id}/permissions`, { mode: "full-auto" }, "PUT");
    return session.id as string;
  };
  return {
    state, call, gate, hold, release, view, events, commands, prompts, session,
    url: () => d.url,
    // SIGTERM stops the daemon as `keel restart` and the unit do: a drain, then the turns still running are parked.
    stop: (how: "SIGTERM" | "SIGKILL") => { d.proc.kill(how); },
    start: async (extra: Record<string, string> = {}) => { await exited(d.proc); d = await daemon(state, extra); },
    restart: async (how: "SIGTERM" | "SIGKILL", extra: Record<string, string> = {}) => { d.proc.kill(how); await exited(d.proc); d = await daemon(state, extra); },
    end: () => d.proc.kill("SIGKILL"),
  };
}

// A parent and one background agent that holds on a pipe.
async function withAgent(r: Awaited<ReturnType<typeof rig>>, title: string, calls: unknown[]) {
  const parent = await r.session(`${title} parent`);
  await r.call(`/api/sessions/${parent}/messages`, { text: `script:calls ${JSON.stringify([{ name: "spawn_agent", input: { message: `${title}\nscript:calls ${JSON.stringify(calls)}`, isolation: "none" } }])}` });
  const agent = async () => (await r.call(`/api/sessions/${parent}/agents`, undefined, "GET")).agents[0];
  await expect.poll(async () => (await agent())?.session_id, { timeout: 30_000 }).toBeTruthy();
  const child = (await agent()).session_id as string;
  await expect.poll(async () => (await r.commands(child)).length, { timeout: 30_000 }).toBe(1);
  await expect.poll(async () => (await r.view(parent)).running, { timeout: 30_000 }).toBe(false);
  return { parent, child, agent };
}

// The index of the first event after `from` that matches.
const after = (ev: any[], from: number, is: (e: any) => boolean) => ev.findIndex((e, i) => i > from && is(e));
// In the continued turn's first request: stored after the restart note, with nothing but the turn's start between them.
const joins = (ev: any[], note: number, got: number) => note >= 0 && got > note && ev.slice(note + 1, got).every((e) => e.kind === "turn_start");

test("a working agent takes its parent's message at its next step, and a restart keeps the one still waiting", async ({ page }) => {
  const r = await rig("message-agent");
  try {
    const [a, z, b, c] = ["a", "z", "b", "c"].map(r.gate) as [string, string, string, string];
    // By itself the agent would hold on A, then on Z. Each message names what it does next.
    const { parent, child, agent } = await withAgent(r, "Holder", [r.hold(a), r.hold(z)]);
    const id = (await agent()).id as string;

    // The parent's model sends while the agent's first command runs.
    const first = `First message, sent while the first command ran. script:calls ${JSON.stringify([r.hold(b)])}`;
    await r.call(`/api/sessions/${parent}/messages`, { text: `script:calls ${JSON.stringify([{ name: "send_input", input: { target: id, message: first } }])}` });
    await expect.poll(async () => (await r.events(parent)).filter((e) => e.kind === "tool_result").length, { timeout: 30_000 }).toBe(2);
    // The sender is told it waits, and where: the agent's queue and the parent's list of agents show it.
    const answer = JSON.stringify((await r.events(parent)).filter((e) => e.kind === "tool_result").at(-1).data.results[0].content);
    expect.soft(answer).toContain("after its current step");
    expect.soft((await r.call(`/api/sessions/${child}/queue`, undefined, "GET")).queue.map((q: any) => [q.steer, String(q.text).includes("First message")])).toEqual([[true, true]]);
    expect.soft((await agent()).messages_waiting).toBe(1);
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`${r.url()}/s/${parent}`);
    await expect.soft(page.getByTestId("agent-call-waiting").first()).toHaveText("1 message waiting", { timeout: 10_000 });
    await shoot(page, "message-delivery-01-waiting");
    expect((await r.prompts(child, "First message")).length).toBe(0);

    // The first command ends: the message is the next thing the agent reads, in the same turn.
    r.release(a);
    await expect.poll(async () => (await r.commands(child)).length, { timeout: 30_000 }).toBe(2);
    expect((await r.commands(child))[1]).toContain(b); // what the message asked for, not the Z it would have gone on with
    let ev = await r.events(child);
    expect(ev.filter((e) => e.kind === "turn_start")).toHaveLength(1);
    expect(await r.prompts(child, "First message")).toHaveLength(1);
    expect.soft((await agent()).messages_waiting).toBe(0);

    // A second one waits when the daemon is stopped: the turn is parked with it still in the queue.
    const second = `Second message, waiting when the daemon stopped. script:calls ${JSON.stringify([r.hold(c)])}`;
    await r.call(`/api/sessions/${parent}/agents/${id}/message`, { message: second });
    await r.restart("SIGTERM");
    await expect.poll(async () => (await r.commands(child)).length, { timeout: 60_000 }).toBe(3);
    ev = await r.events(child);
    const cut = ev.findIndex((e) => e.kind === "turn_end" && e.data.reason === "restart");
    const note = after(ev, cut, (e) => e.kind === "user" && e.data.origin === "restart");
    const got = after(ev, cut, (e) => e.kind === "user" && String(e.data.text).includes("Second message"));
    // After the restart note and before the model's next reply: the first request of the continued turn carries both.
    expect(note).toBeGreaterThan(cut);
    expect(joins(ev, note, got)).toBe(true);
    expect((await r.commands(child))[2]).toContain(c);
    expect((await r.call(`/api/sessions/${child}/queue`, undefined, "GET")).queue).toHaveLength(0);

    // Its work goes on to its report, and each message is in its transcript once.
    r.release(c);
    const reports = async () => (await r.events(parent)).filter((e) => e.kind === "user" && String(e.data.text).includes("<subagent_result"));
    await expect.poll(async () => (await reports()).length, { timeout: 60_000 }).toBe(1);
    expect(await r.prompts(child, "First message")).toHaveLength(1);
    expect(await r.prompts(child, "Second message")).toHaveLength(1);
    expect((await agent()).status).toBe("completed");
    await page.goto(`${r.url()}/s/${child}`);
    await expect(page.getByTestId("harness-notice").filter({ hasText: "Second message" })).toHaveCount(1, { timeout: 15_000 });
    await shoot(page, "message-delivery-02-agent-after-restart");
  } finally {
    r.end();
  }
});

test("a message waiting for a working agent survives a kill of the daemon", async () => {
  const r = await rig("message-kill");
  try {
    const [a, b] = ["a", "b"].map(r.gate) as [string, string];
    const { parent, child, agent } = await withAgent(r, "Killed holder", [r.hold(a)]);
    const id = (await agent()).id as string;
    await r.call(`/api/sessions/${parent}/agents/${id}/message`, { message: `Kept through the kill. script:calls ${JSON.stringify([r.hold(b)])}` });
    await r.restart("SIGKILL");
    await expect.poll(async () => (await r.commands(child)).length, { timeout: 60_000 }).toBe(2);
    const ev = await r.events(child);
    const cut = ev.findIndex((e) => e.kind === "turn_end" && e.data.reason === "restart");
    const note = after(ev, cut, (e) => e.kind === "user" && e.data.origin === "restart");
    expect(joins(ev, note, after(ev, cut, (e) => e.kind === "user" && String(e.data.text).includes("Kept through the kill")))).toBe(true);
    expect((await r.commands(child))[1]).toContain(b);
    r.release(b);
    await expect.poll(async () => (await agent()).status, { timeout: 60_000 }).toBe("completed");
    expect(await r.prompts(child, "Kept through the kill")).toHaveLength(1);
    // A second kill with nothing waiting delivers nothing again.
    await r.restart("SIGKILL");
    await expect.poll(async () => (await r.view(child)).running, { timeout: 30_000 }).toBe(false);
    expect(await r.prompts(child, "Kept through the kill")).toHaveLength(1);
  } finally {
    r.end();
  }
});

test("a message from another session is delivered after a restart, also when the turn it waited for ended while the daemon stopped", async () => {
  const r = await rig("message-peer");
  try {
    const [a, b] = ["a", "b"].map(r.gate) as [string, string];
    const receiver = await r.session("Receiver across a restart");
    const sender = await r.session("Sender across a restart");
    const send = (text: string) => r.call(`/api/sessions/${sender}/messages`, { text: `script:calls ${JSON.stringify([{ name: "keel__session_send", input: { to: receiver, text } }])}` });
    const queued = async () => (await r.call(`/api/sessions/${receiver}/queue`, undefined, "GET")).queue.length;

    // The receiver's turn ends by itself while the daemon is stopping: no turn is cut, and the message still waits.
    await r.restart("SIGKILL", { KEEL_DRAIN_MS: "20000" });
    await r.call(`/api/sessions/${receiver}/messages`, { text: `script:calls ${JSON.stringify([r.hold(a)])}` });
    await expect.poll(async () => (await r.commands(receiver)).length, { timeout: 30_000 }).toBe(1);
    await send("Peer note one, sent while the receiver worked.");
    await expect.poll(queued, { timeout: 30_000 }).toBe(1);
    await expect.poll(async () => (await r.view(sender)).running, { timeout: 30_000 }).toBe(false);
    r.stop("SIGTERM");
    await new Promise((res) => setTimeout(res, 1_000)); // the drain has begun
    r.release(a);
    await r.start();
    await expect.poll(async () => (await r.prompts(receiver, "Peer note one")).length, { timeout: 60_000 }).toBe(1);
    await expect.poll(queued, { timeout: 15_000 }).toBe(0);
    await expect.poll(async () => (await r.view(receiver)).running, { timeout: 30_000 }).toBe(false);
    expect((await r.events(receiver)).filter((e) => e.kind === "turn_end").map((e) => e.data.reason)).toEqual(["end_turn", "end_turn"]);

    // The receiver's turn is cut by a kill: the message is its next turn after the continued one.
    await r.call(`/api/sessions/${receiver}/messages`, { text: `script:calls ${JSON.stringify([r.hold(b)])}` });
    await expect.poll(async () => (await r.commands(receiver)).length, { timeout: 30_000 }).toBe(2);
    await send("Peer note two, sent before the kill.");
    await expect.poll(queued, { timeout: 30_000 }).toBe(1);
    await r.restart("SIGKILL");
    await expect.poll(async () => (await r.prompts(receiver, "Peer note two")).length, { timeout: 60_000 }).toBe(1);
    await expect.poll(async () => (await r.view(receiver)).running, { timeout: 30_000 }).toBe(false);
    const ev = await r.events(receiver);
    const note = ev.findIndex((e) => e.kind === "user" && e.data.origin === "restart");
    expect(note).toBeGreaterThan(0);
    expect(ev.findIndex((e) => e.kind === "user" && String(e.data.text).includes("Peer note two"))).toBeGreaterThan(note);
    expect(await r.prompts(receiver, "Peer note one")).toHaveLength(1);
    expect(await r.prompts(receiver, "Peer note two")).toHaveLength(1);
    expect(await queued()).toBe(0);
  } finally {
    r.end();
  }
});

test("the owner's steer and queued prompt are delivered once across a restart", async ({ page }) => {
  const r = await rig("message-owner");
  try {
    const [a, b] = ["a", "b"].map(r.gate) as [string, string];
    const s = await r.session("Steered across a restart");
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`${r.url()}/s/${s}`);
    const composer = page.getByTestId("composer");
    await composer.fill(`script:calls ${JSON.stringify([r.hold(a)])}`);
    await composer.press("Enter");
    await expect(page.getByTestId("tool-call")).toHaveCount(1, { timeout: 20_000 });
    // Enter steers the running turn, Ctrl+Shift+Enter queues for the next one.
    await composer.fill("Steered while the command ran.");
    await composer.press("Enter");
    await composer.fill("Queued while the command ran.");
    await composer.press("Control+Shift+Enter");
    await expect(page.getByTestId("queue-item")).toHaveCount(2);
    await shoot(page, "message-delivery-03-owner-queue");

    // A stop parks the turn: the continued turn takes the steer after the restart note, and the queued prompt is the turn after it.
    await r.restart("SIGTERM");
    await page.goto(`${r.url()}/s/${s}`);
    await expect.poll(async () => (await r.prompts(s, "Queued while the command ran.")).length, { timeout: 60_000 }).toBe(1);
    await expect.poll(async () => (await r.view(s)).running, { timeout: 30_000 }).toBe(false);
    let ev = await r.events(s);
    const cut = ev.findIndex((e) => e.kind === "turn_end" && e.data.reason === "restart");
    const note = after(ev, cut, (e) => e.kind === "user" && e.data.origin === "restart");
    expect(joins(ev, note, after(ev, cut, (e) => e.kind === "user" && e.data.text === "Steered while the command ran."))).toBe(true);
    expect(ev.filter((e) => e.kind === "user" && e.data.text === "Steered while the command ran.")).toHaveLength(1);
    expect(ev.filter((e) => e.kind === "turn_end").map((e) => e.data.reason)).toEqual(["restart", "end_turn", "end_turn"]);
    await expect(page.getByTestId("queue-item")).toHaveCount(0);
    await expect(page.getByTestId("origin-steer")).toHaveCount(1);
    await expect(page.getByTestId("origin-queued")).toHaveCount(1);
    await shoot(page, "message-delivery-04-owner-after-restart");

    // The turn ends by itself while the daemon is stopping: the queued prompt is not left behind.
    await r.restart("SIGKILL", { KEEL_DRAIN_MS: "20000" });
    await r.call(`/api/sessions/${s}/messages`, { text: `script:calls ${JSON.stringify([r.hold(b)])}` });
    await expect.poll(async () => (await r.commands(s)).length, { timeout: 30_000 }).toBe(2);
    await r.call(`/api/sessions/${s}/messages`, { text: "Queued when the daemon stopped.", mode: "queue" });
    r.stop("SIGTERM");
    await new Promise((res) => setTimeout(res, 1_000));
    r.release(b);
    await r.start();
    await expect.poll(async () => (await r.prompts(s, "Queued when the daemon stopped.")).length, { timeout: 60_000 }).toBe(1);
    await expect.poll(async () => (await r.view(s)).running, { timeout: 30_000 }).toBe(false);
    ev = await r.events(s);
    expect(ev.filter((e) => e.kind === "user" && e.data.text === "Queued when the daemon stopped.")).toHaveLength(1);
    expect((await r.call(`/api/sessions/${s}/queue`, undefined, "GET")).queue).toHaveLength(0);
  } finally {
    r.end();
  }
});

test("a message that cannot be delivered is told to the session that sent it", async () => {
  const r = await rig("message-gone");
  try {
    const [a, b] = ["a", "b"].map(r.gate) as [string, string];
    const told = async (id: string) => (await r.events(id)).filter((e) => e.kind === "user" && /not delivered/.test(String(e.data.text))).map((e) => String(e.data.text));

    // To an agent whose session is deleted while the message waits.
    const { parent, child, agent } = await withAgent(r, "Deleted holder", [r.hold(a)]);
    await r.call(`/api/sessions/${parent}/agents/${(await agent()).id}/message`, { message: "For the agent that is deleted." });
    await r.call(`/api/sessions/${child}`, undefined, "DELETE");
    await expect.poll(async () => (await told(parent)).length, { timeout: 30_000 }).toBe(1);
    expect((await told(parent))[0]).toContain("deleted");
    expect((await told(parent))[0]).toContain("For the agent that is deleted.");

    // To another session that is archived while the message waits.
    const receiver = await r.session("Archived receiver");
    const sender = await r.session("Sender to an archived session");
    await r.call(`/api/sessions/${receiver}/messages`, { text: `script:calls ${JSON.stringify([r.hold(b)])}` });
    await expect.poll(async () => (await r.commands(receiver)).length, { timeout: 30_000 }).toBe(1);
    await r.call(`/api/sessions/${sender}/messages`, { text: `script:calls ${JSON.stringify([{ name: "keel__session_send", input: { to: receiver, text: "For the session that is archived." } }])}` });
    await expect.poll(async () => (await r.call(`/api/sessions/${receiver}/queue`, undefined, "GET")).queue.length, { timeout: 30_000 }).toBe(1);
    await expect.poll(async () => (await r.view(sender)).running, { timeout: 30_000 }).toBe(false);
    await r.call(`/api/sessions/${receiver}`, { archived: true, stop_shells: true }, "PATCH");
    await expect.poll(async () => (await told(sender)).length, { timeout: 30_000 }).toBe(1);
    expect((await told(sender))[0]).toContain("archived");
    expect((await told(sender))[0]).toContain("For the session that is archived.");
    expect((await r.call(`/api/sessions/${receiver}/queue`, undefined, "GET")).queue).toHaveLength(0);
    // Told once: a restart does not say it again.
    await r.restart("SIGTERM");
    await new Promise((res) => setTimeout(res, 3_000));
    expect(await told(sender)).toHaveLength(1);
    expect(await told(parent)).toHaveLength(1);
  } finally {
    r.end();
  }
});
