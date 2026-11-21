import { expect, test } from "./isolate.ts";
import { Phone } from "./fixtures/phone-app.ts";

// Feature: a phone that loses its connection. A stand-in phone app pairs and
// talks to the real daemon over the signed /v1 surface, with the scripted
// model. A send whose answer was lost is sent again under its id and stays one
// prompt.

const MODEL = "scripted:stand-in";

test.beforeEach(async ({ request }) => {
  const ids = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!ids.includes(MODEL), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
});

const userPrompts = async (request: any, sid: string) =>
  (await (await request.get(`/api/sessions/${sid}`)).json()).events.filter((e: any) => e.kind === "user" && !e.data.origin?.startsWith?.("harness"));

test("a phone's send, sent again after a lost answer, is one prompt", async ({ request }) => {
  const phone = await new Phone(request).pair();
  const { session } = await (await request.post("/api/sessions", { data: { model: MODEL, title: "Phone retry" } })).json();
  const path = `/v1/chats/${session.id}/messages`;
  const first = await phone.call("POST", path, { text: "say ok", mode: "send", client_id: "send-1" });
  expect(first.status()).toBe(200);
  const told = (await first.json()).message;
  // The answer never reached the phone: it sends the same send again.
  const again = await (await phone.call("POST", path, { text: "say ok", mode: "steer", client_id: "send-1" })).json();
  expect([again.replayed, again.message.id]).toEqual([true, told.id]);
  await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).running).toBe(false);
  expect((await userPrompts(request, session.id)).map((e: any) => e.data.text)).toEqual(["say ok"]);
  // The same words on purpose are a second prompt.
  expect((await phone.call("POST", path, { text: "say ok", mode: "send", client_id: "send-2" })).status()).toBe(200);
  await expect.poll(async () => (await userPrompts(request, session.id)).length).toBe(2);
  await request.delete(`/api/mobile/devices/${phone.id}`);
});
