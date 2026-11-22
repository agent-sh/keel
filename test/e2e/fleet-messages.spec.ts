import { expect, test } from "./isolate.ts";
import { peerProblem } from "./peer.ts";
import { mkdirSync } from "node:fs";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ask, HAIKU, shoot } from "./shots.ts";

// Feature: messages between sessions. A session sends with keel__session_send
// to a session on the other machine (delivered over the link, shown there as
// another session's text) and to a session here that may do more than it can
// (held for the owner, who delivers it from the strip above the composer).
const PEER = process.env.KEEL_PEER_URL ?? "http://127.0.0.1:47975";
const ROOT = process.env.KEEL_PEER_ROOT ?? `${process.env.HOME}/.cache/keel-work/bun/dev-fleet-b/root`;

test("fleet messages: across machines, and held for the owner", async ({ page, request }) => {
  const peerWhy = await peerProblem(request, PEER);
  test.skip(!!peerWhy, peerWhy ?? "");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  mkdirSync(ROOT, { recursive: true });
  let { machines } = await (await request.get("/api/fleet/machines")).json();
  let peer = machines.find((m: any) => m.daemon_url === PEER);
  if (!peer) {
    const r = await (await request.post("/api/fleet/machines", { data: { name: "devbox", daemon_url: PEER, workspace_root: ROOT } })).json();
    peer = r.machines.find((m: any) => m.id === r.id);
  }
  const receiver = (await (await request.post(`${PEER}/api/sessions`, { data: { workspace: ROOT, title: "Receiver on devbox", model: HAIKU } })).json()).session;
  // Sandboxed like the sender, so the sender is not narrower than it.
  await request.put(`${PEER}/api/sessions/${receiver.id}/permissions`, { data: { sandbox: "workspace-write" } });
  const wide = (await (await request.post("/api/sessions", { data: { title: "Wide receiver", model: HAIKU } })).json()).session;
  const sender = (await (await request.post("/api/sessions", { data: { title: "Sender", model: HAIKU } })).json()).session;
  await request.put(`/api/sessions/${wide.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  // The sender runs without asking, but in a sandbox: narrower than the wide receiver.
  await request.put(`/api/sessions/${sender.id}/permissions`, { data: { mode: "full-auto", sandbox: "workspace-write" } });

  try {
    await page.goto(`/s/${sender.id}`);
    await expect(page.getByTestId("composer")).toBeVisible();
    // The two sends are the product's part; a real model makes them from words, the stand-in from its script.
    const hello = "Hello from the other machine. Answer right in your own conversation, without any tool, with the single word: received";
    const note = "Answer right in your own conversation, without any tool, with the single word: noted";
    await page.getByTestId("composer").fill(ask(
      `Make exactly two keel__session_send calls, one after the other, then reply "done". ` +
      `1) to "${peer.name}/${receiver.id}", text "${hello}". ` +
      `2) to "Wide receiver", text "${note}".`,
      `script:calls ${JSON.stringify([{ name: "keel__session_send", input: { to: `${peer.name}/${receiver.id}`, text: hello } }, { name: "keel__session_send", input: { to: "Wide receiver", text: note } }])}`,
    ));
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 120_000 });
    const sends = page.locator('[data-tool="keel__session_send"]');
    await expect(sends).toHaveCount(2);
    await sends.nth(0).click();
    await expect(sends.nth(0)).toContainText(`Delivered to ${peer.name}/${receiver.id}`);
    await sends.nth(1).click();
    await expect(sends.nth(1)).toContainText("Held for the owner");
    await shoot(page, "fleet-msg-01-sender");
    // The sender's own list has both, the one to the other machine with where it went and the state its daemon gave.
    const list = (await (await request.get(`/api/sessions/${sender.id}/peer-messages`)).json()).messages;
    expect(list.filter((m: any) => m.direction === "sent").map((m: any) => [m.other.session_id, m.other.machine ?? null, m.state]).sort())
      .toEqual([[receiver.id, peer.name, "delivered"], [wide.id, null, "held"]].sort());
    const lines = await (await request.get(`/api/sessions/${sender.id}/peer-messages?format=text`)).text();
    expect(lines).toContain(`sent to "Receiver on devbox" on ${peer.name}: delivered`);

    // Held here: the owner sees why and delivers it.
    await page.goto(`/s/${wide.id}`);
    const held = page.getByTestId("held-message");
    await expect(held).toBeVisible();
    await expect(held).toContainText("sandbox");
    await shoot(page, "fleet-msg-02-held");
    await held.getByTestId("held-deliver").click();
    await expect(page.getByTestId("peer-message")).toContainText("noted");
    await expect(page.getByTestId("held-message")).toHaveCount(0);
    await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 90_000 });

    // Over the link: the other machine's session read it as another session's text.
    await page.locator(`[data-testid="session-row"][data-session$="--${receiver.id}"]`).click();
    await expect(page.getByTestId("peer-message")).toContainText("Hello from the other machine");
    await expect(page.getByTestId("peer-message")).toContainText("Sender");
    await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 90_000 });
    await expect(page.locator("main")).toContainText(/received/i);
    await shoot(page, "fleet-msg-03-remote-received");

    const errors = (await (await request.get("/api/errors")).json()).errors;
    expect(errors.slice(0, errors.length - errorsBefore).filter((e: any) => e.source !== "provider")).toEqual([]);
    // An archived session is called archived, not "no session".
    const shelf = (await (await request.post("/api/sessions", { data: { title: "Archived receiver", model: HAIKU } })).json()).session;
    await request.patch(`/api/sessions/${shelf.id}`, { data: { archived: true } });
    await page.goto(`/s/${sender.id}`);
    await page.getByTestId("composer").fill(ask(
      `Make exactly one keel__session_send call to "${shelf.id}" with the text "anyone there?", then reply "done".`,
      `script:calls ${JSON.stringify([{ name: "keel__session_send", input: { to: shelf.id, text: "anyone there?" } }])}`,
    ));
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 120_000 });
    await expect(sends).toHaveCount(3);
    await sends.nth(2).click();
    await expect(sends.nth(2)).toContainText("that session is archived");
    await expect(sends.nth(2)).not.toContainText("no session");
    await request.delete(`/api/sessions/${shelf.id}`);
  } finally {
    await request.delete(`/api/sessions/${wide.id}`);
    await request.delete(`/api/sessions/${sender.id}`);
    await request.delete(`${PEER}/api/sessions/${receiver.id}`);
  }
});

// notify_when_idle across daemons: the sender gets one notice when the session
// on the other machine has handled its message, from the receiver's record.
test("fleet messages: a notice when the other machine's session has handled it", async ({ page, request }) => {
  const peerWhy = await peerProblem(request, PEER);
  test.skip(!!peerWhy, peerWhy ?? "");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  mkdirSync(ROOT, { recursive: true });
  let { machines } = await (await request.get("/api/fleet/machines")).json();
  let peer = machines.find((m: any) => m.daemon_url === PEER);
  if (!peer) {
    const r = await (await request.post("/api/fleet/machines", { data: { name: "devbox", daemon_url: PEER, workspace_root: ROOT } })).json();
    peer = r.machines.find((m: any) => m.id === r.id);
  }
  const receiver = (await (await request.post(`${PEER}/api/sessions`, { data: { workspace: ROOT, title: "Worker on devbox", model: HAIKU } })).json()).session;
  const sender = (await (await request.post("/api/sessions", { data: { title: "Waiting sender", model: HAIKU } })).json()).session;
  await request.put(`/api/sessions/${sender.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  try {
    await page.goto(`/s/${sender.id}`);
    const text = "Answer right in your own conversation, without any tool, with the single word: done";
    await page.getByTestId("composer").fill(ask(
      `Make one keel__session_send call to "${peer.name}/${receiver.id}" with notify_when_idle true and text ` +
      `"${text}". Then reply "waiting" and stop. ` +
      `When the notice comes, reply with the single word: notified.`,
      `script:calls ${JSON.stringify([{ name: "keel__session_send", input: { to: `${peer.name}/${receiver.id}`, text, notify_when_idle: true } }])}`,
    ));
    await page.keyboard.press("Enter");
    const send = page.locator('[data-tool="keel__session_send"]');
    await expect(send).toHaveCount(1, { timeout: 120_000 });
    // The notice wakes the sender once, after the other side's turn ended.
    await expect(page.getByTestId("wake-notice")).toHaveCount(1, { timeout: 150_000 });
    await expect(page.getByTestId("wake-notice")).toContainText("session fired");
    await page.getByTestId("wake-notice").click();
    await expect(page.getByTestId("wake-notice")).toContainText("handled your message and is idle");
    await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 90_000 });
    await shoot(page, "fleet-msg-04-notice");

    const events = (await (await request.get(`${PEER}/api/sessions/${receiver.id}/events`)).json()).events;
    expect(events.filter((e: any) => e.kind === "user")).toHaveLength(1); // the watch cost the receiver no turn
    const waits = (await (await request.get("/api/waits")).json()).waits.filter((w: any) => w.session_id === sender.id);
    expect(waits.filter((w: any) => w.kind === "session").map((w: any) => w.status)).toEqual(["fired"]);
    const errors = (await (await request.get("/api/errors")).json()).errors;
    expect(errors.slice(0, errors.length - errorsBefore).filter((e: any) => e.source !== "provider")).toEqual([]);
  } finally {
    await request.delete(`/api/sessions/${sender.id}`);
    await request.delete(`${PEER}/api/sessions/${receiver.id}`);
  }
});

test("fleet messages: a missing or unproven receipt does not confirm delivery", async ({ page, request }) => {
  const model = ((await (await request.get("/api/models")).json()).models as { provider: string; context: number; id: string }[])
    .filter((m) => m.provider === "scripted").sort((a, b) => b.context - a.context)[0]?.id;
  test.skip(!model, "the daemon runs without the scripted provider");

  // HTTP success alone is not a receipt, and a receipt without valid proof
  // is not the peer's answer. The second proof matches in characters, not bytes.
  const name = "receipt-fixture", daemon_id = randomUUID(), key = randomUUID();
  let sends = 0;
  const peer = createServer((req, res) => {
    req.resume();
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/fleet/pair") return res.end(JSON.stringify({ daemon_id, key }));
    const proof = createHmac("sha256", key).update(`${req.headers["x-keel-nonce"]}|${daemon_id}`).digest("hex");
    res.setHeader("x-keel-proof", proof);
    if (req.url === "/api/fleet/identity") return res.end(JSON.stringify({ daemon_id, server_name: name }));
    if (req.url === "/api/fleet/facts") return res.end(JSON.stringify({ cpus: 1, load1: 0, tools: [] }));
    if (req.url === "/api/fleet/messages") {
      if (++sends === 1) return res.end("{}");
      res.setHeader("x-keel-proof", "\u00e9".repeat(proof.length));
      return res.end(JSON.stringify({ id: randomUUID(), state: "delivered" }));
    }
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve, reject) => peer.once("error", reject).listen(0, "127.0.0.1", resolve));
  let machine: string | undefined, sender: string | undefined;
  try {
    machine = (await (await request.post("/api/fleet/machines", { data: { name, daemon_url: `http://127.0.0.1:${(peer.address() as AddressInfo).port}` } })).json()).id;
    sender = (await (await request.post("/api/sessions", { data: { title: "Receipt sender", model } })).json()).session.id;
    await request.put(`/api/sessions/${sender}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
    const calls = ["Check the receipt.", "Check the proof."].map((text) => ({
      name: "keel__session_send", input: { to: `${name}/receiver`, text, notify_when_idle: true },
    }));
    const posted = await request.post(`/api/sessions/${sender}/messages`, { data: { text: `script:calls ${JSON.stringify(calls)}` } });
    expect(posted.ok()).toBe(true);
    await expect.poll(async () => (await (await request.get(`/api/sessions/${sender}`)).json()).running).toBe(false);

    await page.goto(`/s/${sender}`);
    const sendsShown = page.locator('[data-tool="keel__session_send"]');
    await expect(sendsShown).toHaveCount(2);
    for (const [i, reason] of ["no usable receipt", "did not prove the pairing"].entries()) {
      const send = sendsShown.nth(i);
      // Closed, the row says why in one line under its head, ended at a word when it is long. The whole
      // of it is in the open call, which the row's head opens (a press on the line of words opens nothing).
      await expect(send.getByTestId("tool-why")).toContainText(`Delivery to ${name}/receiver is unconfirmed`);
      await expect(send.getByTestId("tool-why")).not.toHaveText(/[a-z]$/);
      await send.getByRole("button").first().click({ timeout: 15_000 });
      await expect(send).toHaveAttribute("data-open", "");
      await expect(send).toContainText(reason);
      await expect(send).toContainText("The message may have arrived; check the receiving session before retrying.");
    }
    expect(sends).toBe(2);
    await shoot(page, "fleet-msg-05-unconfirmed");
  } finally {
    if (sender) await request.delete(`/api/sessions/${sender}`);
    if (machine) await request.delete(`/api/fleet/machines/${machine}`);
    peer.close();
  }
});
