import { expect, test } from "./isolate.ts";
import { peerProblem } from "./peer.ts";
import { mkdirSync } from "node:fs";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { shoot } from "./shots.ts";

// Feature: the relay of another daemon's live frames, with a reader that
// stops reading. This daemon reaches the other one through a TCP stand-in the
// spec can stall. During a burst of frames the other daemon holds at most its
// bound for the stalled reader and then ends that stream, a second reader
// gets every frame, and once the stalled one reads again it reconnects: its
// session list and the transcript open here catch up.
const PEER = process.env.KEEL_PEER_URL ?? "http://127.0.0.1:47975";
const ROOT = process.env.KEEL_PEER_ROOT ?? `${process.env.HOME}/.cache/keel-work/bun/dev-fleet-b/root`;

test("fleet relay: a stalled reader is cut at the bound, others keep receiving, and it catches up", async ({ page, request }) => {
  const peerWhy = await peerProblem(request, PEER);
  test.skip(!!peerWhy, peerWhy ?? "");
  const model = ((await (await request.get("/api/models")).json()).models as { provider: string; context: number; id: string }[])
    .filter((m) => m.provider === "scripted").sort((a, b) => b.context - a.context)[0]?.id;
  test.skip(!model, "the daemon runs without the scripted provider");
  mkdirSync(ROOT, { recursive: true });
  const here = (await (await request.get("/api/fleet/identity")).json()).daemon_id as string;
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;

  // The stand-in: every connection to it goes to the peer; the one that
  // carries the stream can be stalled (nothing read from the peer).
  type Conn = { client: net.Socket; up: net.Socket; stream: boolean };
  const conns = new Set<Conn>();
  const proxy = net.createServer((client) => {
    const up = net.connect(Number(new URL(PEER).port), "127.0.0.1");
    const c: Conn = { client, up, stream: false };
    conns.add(c);
    client.on("data", (d) => { if (d.includes("/api/fleet/stream")) c.stream = true; });
    client.pipe(up);
    up.pipe(client);
    const done = () => { conns.delete(c); client.destroy(); up.destroy(); };
    client.on("close", done).on("error", done);
    up.on("close", done).on("error", done);
  });
  await new Promise<void>((resolve, reject) => proxy.once("error", reject).listen(0, "127.0.0.1", resolve));
  const via = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;

  // The machine record of the peer goes through the stand-in for this test.
  const { machines } = await (await request.get("/api/fleet/machines")).json();
  const had = machines.find((m: any) => m.daemon_url === PEER);
  const machine: string = had
    ? (await request.patch(`/api/fleet/machines/${had.id}`, { data: { daemon_url: via } }), had.id)
    : (await (await request.post("/api/fleet/machines", { data: { name: "devbox", daemon_url: via, workspace_root: ROOT } })).json()).id;
  await request.post(`/api/fleet/machines/${machine}/check`);

  // A second reader of the peer's stream that reads all the time.
  const fixture = `relay-reader-${Date.now().toString(36)}`;
  const { key } = await (await request.post(`${PEER}/api/fleet/pair`, { data: { daemon_id: fixture, name: "relay reader" } })).json();
  const reading = new AbortController();
  let drafts = 0, titles: string[] = [];
  const steady = (async () => {
    const res = await fetch(`${PEER}/api/fleet/stream`, { headers: { "x-keel-link": `${fixture} ${key}`, "x-keel-nonce": randomUUID() }, signal: reading.signal });
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as any) {
      buf += dec.decode(chunk, { stream: true });
      for (let i; (i = buf.indexOf("\n\n")) >= 0; buf = buf.slice(i + 2)) {
        const line = buf.slice(0, i);
        if (!line.startsWith("data: ")) continue;
        const f = JSON.parse(line.slice(6));
        if (f.t === "feature" && f.name === "draft") drafts++;
        if (f.t === "session") titles.push(f.session.title);
      }
    }
  })().catch((e) => { if (!reading.signal.aborted) throw e; });

  const make = async (title: string) => (await (await request.post(`${PEER}/api/sessions`, { data: { title, model, workspace: ROOT } })).json()).session;
  const idle = async (id: string) => expect.poll(async () => (await (await request.get(`${PEER}/api/sessions/${id}`)).json()).running, { timeout: 30_000 }).toBe(false);
  const watched = await make("Watched through the relay");
  const burst = await make("Burst of frames");
  let late: any;
  try {
    await request.post(`${PEER}/api/sessions/${watched.id}/messages`, { data: { text: "The first turn, before the stall." } });
    await idle(watched.id);
    await page.goto(`/s/${machine}--${watched.id}`);
    await expect(page.getByTestId("turn-end")).toHaveCount(1);
    const pair = async () => ((await (await request.get(`${PEER}/api/fleet/pairs`)).json()).pairs as any[]).find((p) => p.daemon_id === here);
    await expect.poll(async () => (await pair())?.stream.readers).toBe(1);
    const before = (await pair()).stream;

    // Stall this daemon's reader, then a burst: megabyte frames (a draft's text).
    const stalled = [...conns].filter((c) => c.stream);
    expect(stalled).toHaveLength(1);
    for (const c of stalled) { c.up.unpipe(c.client); c.up.pause(); }
    let sent = 0, most = 0;
    while ((await pair()).stream.stalled === before.stalled) {
      expect(sent, "the stalled reader was never cut").toBeLessThan(80);
      await request.post(`${PEER}/api/sessions/${burst.id}/draft`, { data: { text: `${sent}:${"x".repeat(1_000_000)}` } });
      sent++;
      most = Math.max(most, (await pair()).stream.pending_bytes);
    }
    const after = (await pair()).stream;
    expect(before.limit_bytes).toBeGreaterThan(0);
    expect(most).toBeGreaterThan(0); // frames did wait for it
    expect(most).toBeLessThanOrEqual(before.limit_bytes); // never more than the bound
    expect(after).toMatchObject({ readers: 0, pending_bytes: 0, stalled: before.stalled + 1 });

    // While it is cut off: a new session there, and a turn in the open transcript.
    late = await make("Made while the reader stalled");
    await request.post(`${PEER}/api/sessions/${watched.id}/messages`, { data: { text: "Said while the link was stalled." } });
    await idle(watched.id);
    // The steady reader got every frame of the burst and what came after it.
    await expect.poll(() => drafts).toBe(sent);
    await expect.poll(() => titles).toContain("Made while the reader stalled");
    await expect(page.locator(`[data-testid="session-row"][data-session$="--${late.id}"]`)).toHaveCount(0);
    await expect(page.getByTestId("turn-end")).toHaveCount(1);

    // It reads again: the stream it had ends with the cut, it reconnects and catches up.
    for (const c of stalled) { c.up.pipe(c.client); c.up.resume(); }
    await expect.poll(async () => (await pair()).stream.readers, { timeout: 30_000 }).toBe(1);
    await expect(page.locator(`[data-testid="session-row"][data-session$="--${late.id}"]`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 30_000 });
    await expect(page.locator("main")).toContainText("Said while the link was stalled.");
    const view = (await (await request.get("/api/fleet")).json()).machines.find((m: any) => m.id === machine);
    expect(view.stale).toBeFalsy();
    expect(view.sessions.map((s: any) => s.id)).toEqual(expect.arrayContaining([watched.id, late.id]));
    await shoot(page, "fleet-relay-01-caught-up");
    const errors = (await (await request.get("/api/errors")).json()).errors;
    expect(errors.slice(0, errors.length - errorsBefore).filter((e: any) => e.source !== "provider")).toEqual([]);
  } finally {
    await page.goto("about:blank"); // nothing asks through the link while it is put back
    reading.abort();
    await steady;
    await request.post(`${PEER}/api/sessions/${burst.id}/draft`, { data: { text: "" } });
    for (const s of [watched, burst, late]) if (s) await request.delete(`${PEER}/api/sessions/${s.id}`);
    await request.delete(`${PEER}/api/fleet/pairs/${fixture}`);
    if (had) {
      await request.patch(`/api/fleet/machines/${machine}`, { data: { daemon_url: PEER } });
      await request.post(`/api/fleet/machines/${machine}/check`);
    } else await request.delete(`/api/fleet/machines/${machine}`);
    for (const c of conns) { c.client.destroy(); c.up.destroy(); }
    proxy.close();
  }
});
