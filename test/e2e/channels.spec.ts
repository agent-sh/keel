import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./isolate.ts";
import { scriptBash, shoot } from "./shots.ts";

// Feature: channels. A connected MCP server that declares Claude Code's
// channel capability pushes events into a session that is already running.
// Off by default; the owner names the session in Settings > MCP servers. A
// working session reads an event at its next step, an idle one starts a turn
// with it, a resend under the same event id is not taken twice, and a session
// the owner stopped keeps it behind the stop. The transcript shows each one
// as the server's, never as the owner's words, and the server is told what
// became of each event. A stand-in chat server on a local port pushes them.
const FIXTURE = `${import.meta.dirname}/fixtures/channel-mcp.ts`;
const STAND_IN = "scripted:stand-in";
const NAME = "chat";

test.afterEach(async ({ request }) => {
  await request.delete(`/api/mcp/servers/${NAME}`).catch(() => {});
});

test("channels: a server's events reach a working, an idle and a stopped session", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  await request.delete(`/api/mcp/servers/${NAME}`).catch(() => {});
  const dir = join(process.env.HOME!, ".cache/keel-e2e-channels");
  mkdirSync(dir, { recursive: true });
  const portFile = join(dir, `port-${Date.now()}`);
  rmSync(portFile, { force: true });

  const added = await request.post("/api/mcp/servers", { data: { name: NAME, command: "bun", args: [FIXTURE], env: { CHANNEL_PORT_FILE: portFile } } });
  expect(added.ok()).toBe(true);
  const server = async () => ((await (await request.get("/api/mcp/servers")).json()).servers as any[]).find((s) => s.name === NAME);
  await expect.poll(async () => (await server())?.channel?.declared, { timeout: 30_000 }).toBe(true);
  expect((await server()).channel.on).toBe(false);
  await expect.poll(() => { try { return Number(readFileSync(portFile, "utf8")); } catch { return 0; } }, { timeout: 10_000 }).toBeGreaterThan(0);
  const chat = `http://127.0.0.1:${readFileSync(portFile, "utf8").trim()}`;
  const push = (content: string, meta?: Record<string, string>) => fetch(`${chat}/push`, { method: "POST", body: JSON.stringify({ content, meta }) });
  const told = async () => (await (await fetch(`${chat}/told`)).json()) as { event_id?: string; outcomes: { session?: string; state: string; reason?: string }[] }[];

  const { session } = await (await request.post("/api/sessions", { data: { title: `Channel ${Date.now()}`, model: STAND_IN } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  const events = async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[];
  const channelEvents = async () => (await events()).filter((e) => e.kind === "user" && e.data.kind === "channel");

  // Off by default: the event is dropped, and the server is told so.
  await push("Nobody should read this.");
  await expect.poll(async () => (await told())[0]?.outcomes[0]?.reason, { timeout: 10_000 }).toBe("the owner does not take its events");

  // The owner names the session in the server's reader; that turns the channel on.
  await page.goto("/settings/mcp");
  await page.locator(`[data-testid="mcp-entry"][data-name="${NAME}"]`).click();
  const section = page.getByTestId("mcp-channel");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("mcp-channel-says")).toContainText("Off: its events are dropped.");
  await section.getByTestId("mcp-channel-add").click();
  await page.getByRole("option", { name: session.title }).click();
  await expect(section.locator(`[data-testid="mcp-channel-session"][data-session="${session.id}"]`)).toBeVisible();
  await expect(section).toHaveAttribute("data-on", "true");
  await shoot(page, "channels-01-panel");

  // A working session: the event and its resend arrive while a command runs.
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: scriptBash("sleep 4; echo built") } });
  await expect.poll(async () => (await events()).some((e) => e.kind === "assistant" && e.data.blocks.some((b: any) => b.type === "tool_use")), { timeout: 20_000 }).toBe(true);
  await push("CI: build 41 failed on main", { event_id: "ci-41", severity: "high" });
  await push("CI: build 41 failed on main", { event_id: "ci-41", severity: "high" });
  await expect.poll(async () => (await told()).filter((t) => t.event_id === "ci-41").map((t) => t.outcomes[0]!.state), { timeout: 10_000 }).toEqual(["next_step", "duplicate"]);
  await expect.poll(async () => (await events()).filter((e) => e.kind === "turn_end").length, { timeout: 30_000 }).toBe(1);
  let ch = await channelEvents();
  expect(ch).toHaveLength(1);
  // Read inside the working turn, at its next step: after the command's result, before the turn's end.
  const all = await events();
  const result = all.find((e) => e.kind === "tool_result" || (e.kind === "user" && JSON.stringify(e.data).includes("tool_result")));
  const end = all.find((e) => e.kind === "turn_end");
  expect(ch[0].data.origin).toBe("steer");
  expect(ch[0].seq).toBeLessThan(end.seq);
  if (result) expect(ch[0].seq).toBeGreaterThan(result.seq);
  expect(ch[0].data.source).toBe(NAME);
  expect(String(ch[0].data.text)).toContain(`<channel source="${NAME}" event_id="ci-41" severity="high">`);
  expect(String(ch[0].data.text)).toContain("not the owner's words");

  // An idle session: the event starts a turn of its own.
  await push("Ping from the phone: how is the build?", { chat_id: "7", event_id: "chat-7" });
  await expect.poll(async () => (await told()).find((t) => t.event_id === "chat-7")?.outcomes[0]?.state, { timeout: 10_000 }).toBe("started");
  await expect.poll(async () => (await events()).filter((e) => e.kind === "turn_end").length, { timeout: 30_000 }).toBe(2);
  ch = await channelEvents();
  expect(ch.map((e) => e.data.event_id)).toEqual(["ci-41", "chat-7"]);

  // A session the owner stopped: the event waits behind the stop, and the server is told.
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: scriptBash("sleep 20") } });
  await expect.poll(async () => (await events()).filter((e) => e.kind === "turn_start").length, { timeout: 20_000 }).toBe(3);
  await request.post(`/api/sessions/${session.id}/interrupt`, { data: { by: "owner" } });
  await expect.poll(async () => (await events()).filter((e) => e.kind === "turn_end").length, { timeout: 20_000 }).toBe(3);
  await push("Deploy finished.", { event_id: "deploy-3" });
  await expect.poll(async () => (await told()).find((t) => t.event_id === "deploy-3")?.outcomes[0]?.state, { timeout: 10_000 }).toBe("held");
  const queue = (await (await request.get(`/api/sessions/${session.id}/queue`)).json()).queue as any[];
  expect(queue.map((q) => q.meta?.event_id)).toEqual(["deploy-3"]);

  // The transcript: each event under the server's name, never as a prompt of the owner's.
  await page.goto(`/s/${session.id}`);
  const cards = page.getByTestId("channel-event");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText("CI: build 41 failed on main");
  await expect(cards.nth(0).getByTestId("channel-source")).toHaveText(NAME);
  await expect(cards.nth(0)).toContainText("a connected server, not you");
  await expect(cards.nth(1).getByTestId("channel-attrs")).toContainText("chat_id=7");
  await expect(page.getByTestId("queue-item")).toContainText(`${NAME}: Deploy finished.`);
  await shoot(page, "channels-02-transcript");

  // The owner goes on: the event that waited is read.
  await request.post(`/api/sessions/${session.id}/queue/resume`, { data: {} });
  await expect.poll(async () => (await channelEvents()).map((e) => e.data.event_id), { timeout: 20_000 }).toEqual(["ci-41", "chat-7", "deploy-3"]);
  await expect(cards).toHaveCount(3);

  // The reader lists what became of the latest events.
  await page.goto("/settings/mcp");
  await page.locator(`[data-testid="mcp-entry"][data-name="${NAME}"]`).click();
  await expect(page.getByTestId("mcp-channel-event").first()).toContainText("deploy-3");
  await shoot(page, "channels-03-recent");

  // The command line: the server's switch off stops it everywhere and keeps the session named.
  const keel = (...args: string[]) => spawnSync("bun", ["src/main.ts", "mcp", ...args, "--url", process.env.KEEL_URL!], { encoding: "utf8", timeout: 30_000 });
  const off = keel("channel", NAME, "off", "--json");
  expect(off.status, off.stderr).toBe(0);
  expect(JSON.parse(off.stdout).servers[0].channel).toMatchObject({ on: false, sessions: [{ id: session.id }] });
  const listed = keel("list");
  expect(listed.stdout).toMatch(new RegExp(`^${NAME} .*declares a channel.*channel off$`, "m"));
  await push("After the switch went off.", { event_id: "late-1" });
  await expect.poll(async () => (await told()).find((t) => t.event_id === "late-1")?.outcomes[0]?.reason, { timeout: 10_000 }).toBe("the owner does not take its events");

  // Another server under the same name (another program) takes no session named for the one before.
  expect((await request.post("/api/mcp/servers", { data: { name: NAME, command: "bun", args: [FIXTURE, "--another"], env: { CHANNEL_PORT_FILE: `${portFile}-2` } } })).ok()).toBe(true);
  expect((await server()).channel.sessions).toEqual([]);
  // And the same program again, after it was removed, starts with none either.
  await request.delete(`/api/mcp/servers/${NAME}`);
  expect((await request.post("/api/mcp/servers", { data: { name: NAME, command: "bun", args: [FIXTURE], env: { CHANNEL_PORT_FILE: portFile } } })).ok()).toBe(true);
  expect((await server()).channel).toMatchObject({ on: false, sessions: [] });
});

// A webhook loop that pushes: each request is an event in the loop's
// session, as a server's is, and a resend under the same delivery id is told
// it is a duplicate.
test("channels: a push webhook loop's request is an event in its running session", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { title: `Hook ${Date.now()}`, model: STAND_IN } })).json();
  const made = await (await request.post("/api/loops", { data: { session_id: session.id, name: "deploys", schedule: "webhook", signed: false, push: true } })).json();
  expect(made.push).toBe(true);
  const hook = (body: string) => request.post(`/api/webhooks/${made.hook_key}`, { data: body, headers: { "content-type": "text/plain", "webhook-id": "dep-9" } });
  expect(await (await hook("Deploy 9 is live.")).json()).toEqual({ ok: true, state: "started" });
  expect(await (await hook("Deploy 9 is live.")).json()).toEqual({ ok: true, state: "duplicate" });
  const ch = async () => ((await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[]).filter((e) => e.kind === "user" && e.data.kind === "channel");
  await expect.poll(async () => (await ch()).length, { timeout: 10_000 }).toBe(1);
  expect((await ch())[0].data).toMatchObject({ source: "deploys", via: "webhook", event_id: "dep-9" });
  await page.goto(`/s/${session.id}`);
  await expect(page.getByTestId("channel-event")).toContainText("a webhook loop, not you");
  await request.delete(`/api/loops/${made.id}`);
});
