import { expect, test } from "./isolate.ts";
import { Phone } from "./fixtures/phone-app.ts";

// Feature: a phone that loses its connection. A stand-in phone app pairs and
// talks to the real daemon over the signed /v1 surface, with the scripted
// model. A send whose answer was lost is sent again under its id and stays one
// prompt. A stream cut in the middle of the work opens again from the phone's
// cursor and starts with what it missed.

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

test("a phone that reconnects gets what it missed with the stream, then what follows", async ({ request, baseURL }) => {
  const phone = await new Phone(request).pair();
  const { session } = await (await request.post("/api/sessions", { data: { model: MODEL, title: "Phone reconnect" } })).json();
  const mine = (frames: any[]) => frames.filter((f) => f.type === "message" && f.message.chat_id === session.id);
  const idle = () => expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).running).toBe(false);

  // From nothing: the first frame is the whole state, at the cursor the stream goes on from.
  const first = await phone.stream(baseURL!, 0);
  await expect.poll(() => first.frames[0]?.type).toBe("hello");
  expect(first.frames[0].sync.chats.some((c: any) => c.id === session.id)).toBe(true);
  expect(first.frames[0].cursor).toBe(first.frames[0].sync.seq);
  await phone.call("POST", `/v1/chats/${session.id}/messages`, { text: "first", client_id: "r-1" });
  await expect.poll(() => mine(first.frames).some((f) => f.message.role === "agent" && f.message.kind === "text")).toBe(true);
  await idle();
  const cursor = Math.max(...first.frames.map((f) => f.cursor ?? 0));
  expect(cursor).toBeGreaterThan(first.frames[0].cursor);
  first.close();

  // While the phone is away, a turn runs from the desktop.
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "while away" } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).events.filter((e: any) => e.kind === "assistant").length).toBe(2);
  await idle();

  // Back: the stream opens with exactly what was stored since, and no request beside it.
  const back = await phone.stream(baseURL!, cursor);
  await expect.poll(() => back.frames[0]?.type).toBe("hello");
  const missed = back.frames[0].sync.messages.filter((m: any) => m.chat_id === session.id);
  expect(missed.map((m: any) => [m.role, m.content])).toEqual([["user", "while away"], ["agent", "Scripted reply."]]);
  expect(back.frames[0].sync.reload).toBeUndefined();
  // And goes on live.
  await phone.call("POST", `/v1/chats/${session.id}/messages`, { text: "after", client_id: "r-2" });
  await expect.poll(() => mine(back.frames).filter((f) => f.message.role === "agent").length).toBe(1);
  expect(mine(back.frames).some((f) => missed.some((m: any) => m.id === f.message.id))).toBe(false);
  back.close();

  // A cursor from another store is told to read everything again.
  const lost = await phone.stream(baseURL!, cursor + 1_000_000);
  await expect.poll(() => lost.frames[0]?.sync?.reload).toBe("ahead");
  lost.close();
  await request.delete(`/api/mobile/devices/${phone.id}`);
});
