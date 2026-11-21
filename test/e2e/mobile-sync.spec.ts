import { expect, test } from "./isolate.ts";
import { Phone } from "./fixtures/phone-app.ts";

// Feature: a phone that loses its connection. A stand-in phone app pairs and
// talks to the real daemon over the signed /v1 surface, with the scripted
// model. A send whose answer was lost is sent again under its id and stays one
// prompt. A stream cut in the middle of the work opens again from the phone's
// cursor and starts with what it missed. A branch picked on the desktop
// replaces the phone's transcript, live and after a reconnect. A photo goes
// with its caption and is there when the conversation is opened again.

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

test("the phone's transcript follows the branch shown on the desktop", async ({ request, baseURL }) => {
  const phone = await new Phone(request).pair();
  const { session } = await (await request.post("/api/sessions", { data: { model: MODEL, title: "Phone branches" } })).json();
  const events = async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).events;
  const idle = () => expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).running).toBe(false);
  const shown = (messages: any[]) => messages.filter((m) => m.chat_id === session.id && m.kind === "text" && m.role === "user").map((m) => m.content);

  // Two versions of one prompt: the second is shown.
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "version one" } });
  await idle();
  const one = (await events()).find((e: any) => e.kind === "user");
  const st = await phone.stream(baseURL!, 0);
  await expect.poll(() => st.frames[0]?.type).toBe("hello");
  expect(shown(st.frames[0].sync.messages)).toEqual(["version one"]);
  // An edit on the desktop makes a sibling branch: the phone's transcript is replaced by it.
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "version two", edit_of: one.id } });
  await expect.poll(() => st.frames.filter((f) => f.type === "chat_reset").length).toBe(1);
  expect(shown(st.frames.find((f) => f.type === "chat_reset").messages)).toEqual(["version two"]);
  await idle();

  // The first version is picked again: no event is stored, the phone still follows.
  expect((await request.post(`/api/sessions/${session.id}/head`, { data: { head_event_id: one.id } })).status()).toBe(200);
  await expect.poll(() => st.frames.filter((f) => f.type === "chat_reset").length).toBe(2);
  const live = st.frames.filter((f) => f.type === "chat_reset").at(-1);
  expect(shown(live.messages)).toEqual(["version one"]);
  expect(live.messages.some((m: any) => m.kind === "deleted")).toBe(true);
  const cursor = Math.max(...st.frames.map((f) => f.cursor ?? 0));
  st.close();

  // Picked while the phone is away: the reconnect brings the chosen branch in place of what it holds.
  const two = (await events()).find((e: any) => e.kind === "user" && e.data.text === "version two");
  expect((await request.post(`/api/sessions/${session.id}/head`, { data: { head_event_id: two.id } })).status()).toBe(200);
  const back = await phone.stream(baseURL!, cursor);
  await expect.poll(() => back.frames[0]?.type).toBe("hello");
  expect(back.frames[0].sync.reset.map((r: any) => r.chat_id)).toEqual([session.id]);
  expect(shown(back.frames[0].sync.messages)).toEqual(["version two"]);
  back.close();
  // Level again: nothing to reset.
  const level = await phone.stream(baseURL!, back.frames[0].cursor);
  await expect.poll(() => level.frames[0]?.type).toBe("hello");
  expect([level.frames[0].sync.reset, level.frames[0].sync.messages]).toEqual([undefined, []]);
  level.close();
  await request.delete(`/api/mobile/devices/${phone.id}`);
});

test("a photo from the phone goes with its caption and shows when the chat is opened again", async ({ request }) => {
  const phone = await new Phone(request).pair();
  const { session } = await (await request.post("/api/sessions", { data: { model: MODEL, title: "Phone photo" } })).json();
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
  const limits = (await (await phone.call("GET", "/v1/me")).json()).uploads;
  expect(limits.inline_images).toContain("image/png");
  const path = `/v1/chats/${session.id}/messages`;

  // An upload that did not arrive: the caption does not go alone.
  const lost = await phone.call("POST", path, { text: "look at this", client_id: "p-1", attachments: [{ id: "f".repeat(64), mime: "image/png", file_name: "photo.png" }] });
  expect(lost.status()).toBe(400);
  expect((await (await request.get(`/api/sessions/${session.id}`)).json()).events).toHaveLength(0);

  // Stored, then sent under the same send id.
  const up = await (await phone.upload("/v1/upload?name=photo.png&mime=image/png", png, "image/png")).json();
  expect(up).toMatchObject({ kind: "image", mime: "image/png", file_name: "photo.png", size: png.length });
  const sent = await phone.call("POST", path, { text: "look at this", client_id: "p-1", attachments: [{ id: up.id, mime: up.mime, file_name: up.file_name }] });
  expect(sent.status()).toBe(200);
  await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).running).toBe(false);

  // Opened again: the prompt names its photo, and the daemon serves the same bytes.
  const page = await (await phone.call("GET", `${path}?paged=1&limit=150`)).json();
  const mine = page.messages.find((m: any) => m.role === "user");
  expect([mine.content, mine.meta.attachments.map((a: any) => [a.kind, a.mime])]).toEqual(["look at this", [["image", "image/png"]]]);
  const media = await phone.call("GET", `/v1/media/${mine.meta.attachments[0].media}`);
  expect([media.status(), media.headers()["content-type"], Buffer.compare(await media.body(), Buffer.from(png))]).toEqual([200, "image/png", 0]);
  // The model was sent the image with the words.
  const prompt = (await (await request.get(`/api/sessions/${session.id}`)).json()).events.find((e: any) => e.kind === "user");
  expect(prompt.data.images.map((b: any) => [b.type, b.media_type])).toEqual([["image", "image/png"]]);
  await request.delete(`/api/mobile/devices/${phone.id}`);
});
