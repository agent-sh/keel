import { expect, test } from "./isolate.ts";
import { peerProblem } from "./peer.ts";
import { mkdirSync } from "node:fs";
import { shoot } from "./shots.ts";

// Feature: the outbox. A daemon that was linked to, with no link back, keeps
// what its sessions write for the linking daemon until that daemon fetches it
// over its relay. Each message settles with the receiving daemon's answer:
// kept there, or refused with the reason, which the sending session reads.
const PEER = process.env.KEEL_PEER_URL ?? "http://127.0.0.1:47975";
const ROOT = process.env.KEEL_PEER_ROOT ?? `${process.env.HOME}/.cache/keel-work/bun/dev-fleet-b/root`;

test("fleet outbox: an accepted message is delivered, a refused one says why to its sender", async ({ page, request }) => {
  const peerWhy = await peerProblem(request, PEER);
  test.skip(!!peerWhy, peerWhy ?? "");
  const model = ((await (await request.get("/api/models")).json()).models as { provider: string; context: number; id: string }[])
    .filter((m) => m.provider === "scripted").sort((a, b) => b.context - a.context)[0]?.id;
  test.skip(!model, "the daemon runs without the scripted provider");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  mkdirSync(ROOT, { recursive: true });
  let { machines } = await (await request.get("/api/fleet/machines")).json();
  let peer = machines.find((m: any) => m.daemon_url === PEER);
  if (!peer) {
    const r = await (await request.post("/api/fleet/machines", { data: { name: "devbox", daemon_url: PEER, workspace_root: ROOT } })).json();
    peer = r.machines.find((m: any) => m.id === r.id);
  }
  const here = (await (await request.get("/api/fleet/identity")).json()).daemon_id as string;
  const session = async (base: string, title: string) => (await (await request.post(`${base}/api/sessions`, { data: { title, model, ...(base ? { workspace: ROOT } : {}) } })).json()).session;
  const open = await session("", "Outbox receiver");
  const archived = await session("", "Archived receiver");
  const deleted = await session("", "Deleted receiver");
  await request.patch(`/api/sessions/${archived.id}`, { data: { archived: true } });
  await request.delete(`/api/sessions/${deleted.id}`);
  const sender = await session(PEER, "Outbox sender");
  await request.put(`${PEER}/api/sessions/${sender.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });

  try {
    const calls = [open, archived, deleted].map((s, i) => ({ name: "keel__session_send", input: { to: `${here}/${s.id}`, text: `Outbox message ${i + 1}.` } }));
    expect((await request.post(`${PEER}/api/sessions/${sender.id}/messages`, { data: { text: `script:calls ${JSON.stringify(calls)}` } })).ok()).toBe(true);

    // Every message settles on the sending daemon: none stays waiting, and
    // only the accepted one counts as delivered.
    const outcome = async () => {
      const all = (await (await request.get(`${PEER}/api/fleet/messages`)).json()).messages as any[];
      return [open, archived, deleted].map((s) => { const m = all.find((x) => x.to_session === s.id); return m ? `${m.state}: ${m.reason}` : "none"; });
    };
    await expect.poll(outcome, { timeout: 30_000 }).toEqual([
      "delivered: received by its daemon",
      "dropped: refused by its daemon: the session is archived",
      "dropped: refused by its daemon: no such session there (deleted)",
    ]);

    // The sender, seen from the linking daemon: each refusal in its transcript.
    await page.goto(`/s/${peer.id}--${sender.id}`);
    const refusal = (why: string) => page.getByTestId("note").filter({ hasText: "was refused there and not delivered" }).filter({ hasText: why });
    await expect(refusal("the session is archived")).toHaveCount(1);
    await expect(refusal("the session is archived")).toContainText(`Your message to session ${archived.id}`);
    await expect(refusal("no such session there (deleted)")).toHaveCount(1);
    await refusal("the session is archived").scrollIntoViewIfNeeded();
    await shoot(page, "fleet-outbox-01-refused");

    // The accepted one reached its session here once, as another session's text.
    await page.goto(`/s/${open.id}`);
    await expect(page.getByTestId("peer-message")).toHaveCount(1);
    await expect(page.getByTestId("peer-message")).toContainText("Outbox message 1.");
    await shoot(page, "fleet-outbox-02-delivered");

    const errors = (await (await request.get("/api/errors")).json()).errors;
    expect(errors.slice(0, errors.length - errorsBefore).filter((e: any) => e.source !== "provider")).toEqual([]);
  } finally {
    await request.delete(`/api/sessions/${open.id}`);
    await request.delete(`/api/sessions/${archived.id}`);
    await request.delete(`${PEER}/api/sessions/${sender.id}`);
  }
});
