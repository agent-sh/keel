import { expect, test, type APIRequestContext } from "./isolate.ts";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HAIKU, shoot, openMcp } from "./shots.ts";

// Feature: phone control. A stand-in for the Hermes gateway's phone socket
// serves the daemon's phone server; with PHONE_ADB=<emulator serial> it acts on
// that Android emulator through adb (never a real phone), else on a fixed
// screen. Every session has phone control with no setup: a model finds it by
// search, reads the screen, taps an element by its index (a card in ask mode;
// the read asks nothing) and reads the screen again. A phone the owner has not
// armed gets the plain reason and no card; the owner's Stop on the phone ends
// a call in flight and nothing is retried; turned off in Keel it leaves search,
// says so, and nothing reaches the gateway.
const serial = process.env.PHONE_ADB;
const dir = join(tmpdir(), `keel-phone-e2e-${Date.now()}`);
const stateFile = join(dir, "phone.json");
const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
const edit = (f: (s: any) => void) => { const s = state(); f(s); writeFileSync(stateFile, JSON.stringify(s)); };
const adb = (...a: string[]) => spawnSync("adb", ["-s", serial!, ...a], { encoding: "utf8" }).stdout;
const focus = () => /mCurrentFocus=Window\{\S+ \S+ ([^}]+)\}/.exec(adb("shell", "dumpsys", "window"))?.[1] ?? "";

const turnsDone = (request: APIRequestContext, id: string, n: number) =>
  expect.poll(async () => {
    const r = await (await request.get(`/api/sessions/${id}`)).json();
    return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
  }, { timeout: 180_000 }).toBe(n);
const lastResult = async (request: APIRequestContext, id: string) => {
  const events = (await (await request.get(`/api/sessions/${id}`)).json()).events;
  return JSON.stringify(events.filter((e: any) => e.kind === "tool_result").flatMap((e: any) => e.data.results).at(-1)?.content ?? "");
};
const call = (tool: string, args: object) => `Make exactly one tool call: mcp_call with {"tool":"${tool}","arguments":${JSON.stringify(args)}}. Then reply with the tool's result word for word.`;

test("phone control: read, tap by index, read again; not armed, stopped, turned off", async ({ page, request }) => {
  const phone = (await (await request.get("/api/mcp/servers")).json()).servers.find((s: any) => s.name === "phone");
  expect(phone?.bundled).toBe("Phone control");
  // The daemon must speak to a scratch socket, never the owner's gateway.
  test.skip(!phone.target.includes("keel-work"), `the daemon's phone socket ${phone.target} is not a scratch one: start it with dev.sh or KEEL_PHONE_SOCKET`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ armed: true, calls: [], statuses: 0 }));
  let gw: ChildProcess | undefined;
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Phone" } })).json();
  try {
    gw = spawn("bun", [resolve("test/e2e/fixtures/phone-gateway.ts"), phone.target, stateFile], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, PHONE_ADB: serial ?? "" } });
    await new Promise<void>((ok) => gw!.stdout!.once("data", () => ok()));
    if (serial) adb("shell", "am", "start", "-W", "-a", "android.settings.SETTINGS");
    const target = serial ? "Network & internet" : "Settings";
    const before = serial ? focus() : "";

    // Listed armed, with its tools, no setup.
    await request.post("/api/mcp/reload", { data: { server: "phone" } });
    const row = await openMcp(page, "phone");
    await expect(row).toHaveAttribute("data-state", "armed");
    await expect(row).toContainText("Built in · Phone control");
    await shoot(page, "phone-01-armed");
    await page.goto(`/s/${session.id}`);

    // Ask mode: the reads run, the tap is put to the owner.
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask" } });
    await request.post(`/api/sessions/${session.id}/messages`, {
      data: { text: `Use search_tools to find the phone tools. Then with mcp_call: read the screen with phone__phone_state, tap the element whose text is "${target}" with phone__phone_tap and its index, then read the screen with phone__phone_state again to check the tap worked. Reply with one line saying what the screen shows now.` },
    });
    await expect(page.getByTestId("approval")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("approval")).toContainText("phone__phone_tap");
    // The reads ran with no card; nothing acted before the owner's answer.
    const read = state().calls.map((c: any) => c.action);
    expect(read.length).toBeGreaterThan(0);
    expect(read.every((a: string) => a === "state")).toBe(true);
    await shoot(page, "phone-02-tap-card");
    await page.getByTestId("allow-once").click();
    await turnsDone(request, session.id, 1);
    // A tap by index, and the screen read again after it (an act is no proof).
    const acts = state().calls.map((c: any) => c.action);
    const tap = acts.indexOf("tap");
    expect(tap).toBe(read.length);
    expect(typeof state().calls[tap].index).toBe("number");
    expect(acts.slice(tap + 1)).toContain("state");
    if (serial) expect(focus()).not.toBe(before);
    await shoot(page, "phone-03-done");

    // Not armed: the plain reason, no card, nothing reaches the phone.
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
    edit((s) => (s.armed = false));
    const n = state().calls.length;
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: call("phone__phone_tap", { x: 10, y: 10 }) } });
    await turnsDone(request, session.id, 2);
    expect(await lastResult(request, session.id)).toContain("not armed");
    expect(state().calls.length).toBe(n);

    // The owner's Stop on the phone ends a call in flight; the next is refused before the phone.
    edit((s) => Object.assign(s, { armed: true, hold: true }));
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: call("phone__phone_wait", { seconds: 1 }) } });
    await expect.poll(() => state().calls.length, { timeout: 90_000 }).toBe(n + 1);
    edit((s) => (s.stop = true));
    await turnsDone(request, session.id, 3);
    expect(await lastResult(request, session.id)).toContain("stopped phone control");
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `The owner says control is on again. ${call("phone__phone_state", {})}` } });
    await turnsDone(request, session.id, 4);
    expect(await lastResult(request, session.id)).toContain("not armed");
    expect(state().calls.length).toBe(n + 1);
    await shoot(page, "phone-04-stopped");

    // Turned off in Keel: listed off, out of search, a call says so and the gateway is not asked.
    edit((s) => (s.armed = true));
    await openMcp(page, "phone");
    await row.getByTestId("mcp-toggle").click();
    await expect(row).toHaveAttribute("data-state", "disabled");
    const hits = await (await request.get("/api/mcp/search?q=phone tap")).json();
    expect(hits.tools.some((t: any) => t.qualified_name === "phone__phone_tap")).toBe(false);
    const asked = state().statuses;
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `The owner says control is on. ${call("phone__phone_state", {})}` } });
    await turnsDone(request, session.id, 5);
    expect(await lastResult(request, session.id)).toContain("turned off in Keel");
    expect(state().statuses).toBe(asked);
    expect(state().calls.length).toBe(n + 1);
    await shoot(page, "phone-05-off");
    await row.getByTestId("mcp-toggle").click();
    await expect(row).toHaveAttribute("data-state", "armed");
  } finally {
    gw?.kill();
    await request.post("/api/mcp/servers/phone/toggle", { data: { enabled: true } });
    await request.delete(`/api/sessions/${session.id}`);
  }
});
