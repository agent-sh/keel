import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: a message between two sessions of this daemon. The sender's
// keel__session_send reaches an idle session as its next turn at once, also
// when the sender asks not to wake it: nothing is left waiting in an idle
// session's queue for the owner to type there.
const STAND_IN = "scripted:stand-in";

test("session messages: an idle session takes a message as its next turn", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const mk = async (title: string) => (await (await request.post("/api/sessions", { data: { title, model: STAND_IN } })).json()).session;
  const receiver = await mk(`Receiver ${Date.now()}`);
  const sender = await mk(`Sender ${Date.now()}`);
  await request.put(`/api/sessions/${sender.id}/permissions`, { data: { mode: "full-auto" } });

  // The sender asks not to wake the receiver (an older caller's habit): the idle receiver still takes it now.
  const calls = [{ name: "keel__session_send", input: { to: receiver.id, text: "Status of the import, please.", wake: false } }];
  await request.post(`/api/sessions/${sender.id}/messages`, { data: { text: `script:calls ${JSON.stringify(calls)}` } });

  await expect.poll(async () => {
    const ev = (await (await request.get(`/api/sessions/${receiver.id}`)).json()).events as any[];
    return ev.some((e) => e.kind === "user" && String(e.data.text).includes("Status of the import"));
  }, { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await (await request.get(`/api/sessions/${receiver.id}/queue`)).json()).queue.length, { timeout: 10_000 }).toBe(0);
  await expect.poll(async () => ((await (await request.get(`/api/sessions/${receiver.id}`)).json()).events as any[]).some((e) => e.kind === "turn_end"), { timeout: 30_000 }).toBe(true);

  await page.goto(`/s/${receiver.id}`);
  await expect(page.getByText("Status of the import, please.")).toBeVisible();
  await shoot(page, "session-message-01-received");
});
