import { expect, test } from "./isolate.ts";
import { mkdirSync } from "node:fs";
import { HAIKU, shoot } from "./shots.ts";

// Feature: messages between sessions. A session sends with keel__session_send
// to a session on the other machine (delivered over the link, shown there as
// another session's text) and to a session here that may do more than it can
// (held for the owner, who delivers it from the strip above the composer).
const PEER = process.env.KEEL_PEER_URL ?? "http://127.0.0.1:47975";
const ROOT = process.env.KEEL_PEER_ROOT ?? `${process.env.HOME}/.cache/keel-work/bun/dev-fleet-b/root`;

test("fleet messages: across machines, and held for the owner", async ({ page, request }) => {
  const peerUp = await request.get(`${PEER}/api/health`, { timeout: 3000 }).then((r) => r.ok(), () => false);
  test.skip(!peerUp, `no peer daemon at ${PEER}: start a second daemon and set KEEL_PEER_URL and KEEL_PEER_ROOT`);
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
    await page.getByTestId("composer").fill(
      `Make exactly two keel__session_send calls, one after the other, then reply "done". ` +
      `1) to "${peer.name}/${receiver.id}", text "Hello from the other machine. Answer right in your own conversation, without any tool, with the single word: received". ` +
      `2) to "Wide receiver", text "Answer right in your own conversation, without any tool, with the single word: noted".`,
    );
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 120_000 });
    const sends = page.locator('[data-tool="keel__session_send"]');
    await expect(sends).toHaveCount(2);
    await sends.nth(0).click();
    await expect(sends.nth(0)).toContainText(`Delivered to ${peer.name}/${receiver.id}`);
    await sends.nth(1).click();
    await expect(sends.nth(1)).toContainText("Held for the owner");
    await shoot(page, "fleet-msg-01-sender");

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
  } finally {
    await request.delete(`/api/sessions/${wide.id}`);
    await request.delete(`/api/sessions/${sender.id}`);
    await request.delete(`${PEER}/api/sessions/${receiver.id}`);
  }
});

// notify_when_idle across daemons: the sender gets one notice when the session
// on the other machine has handled its message, from the receiver's record.
test("fleet messages: a notice when the other machine's session has handled it", async ({ page, request }) => {
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
    await page.getByTestId("composer").fill(
      `Make one keel__session_send call to "${peer.name}/${receiver.id}" with notify_when_idle true and text ` +
      `"Answer right in your own conversation, without any tool, with the single word: done". Then reply "waiting" and stop. ` +
      `When the notice comes, reply with the single word: notified.`,
    );
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
