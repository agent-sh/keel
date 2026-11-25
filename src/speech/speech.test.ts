import { afterAll, expect, test } from "bun:test";
import type { Provider } from "../providers/types.ts";
import { parseVoices, Speech, SpeechError, speechKind, splitRoute } from "./speech.ts";

const seen: { path: string; auth: string | null; body?: unknown }[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const auth = req.headers.get("authorization");
    if (path === "/v1/models") {
      seen.push({ path, auth });
      return Response.json({ data: ["gpt-chat", "whisper-1", "tts-1", "gpt-4o-mini-transcribe", "vox-stt-x", "plain-model"].map((id) => ({ id })) });
    }
    if (path === "/v1/audio/transcriptions") {
      const f = await req.formData();
      seen.push({ path, auth, body: { model: f.get("model"), language: f.get("language"), size: (f.get("file") as File).size } });
      return Response.json({ text: " hello there " });
    }
    // A provider that lists voices (key "listed"), and one that refuses a request that names none (key "strict").
    if (path === "/v1/audio/voices") return auth === "Bearer listed" ? Response.json({ voices: ["ember", { id: "vale" }, "ember", ""] }) : new Response("no", { status: 404 });
    if (path === "/v1/audio/speech") {
      const body = await req.json();
      seen.push({ path, auth, body });
      if (auth === "Bearer strict" && !(body as any).voice) return Response.json({ error: { message: "Missing required parameter: voice. Supported values are: 'ash', 'coral'." } }, { status: 400 });
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
    }
    return new Response("no", { status: 404 });
  },
});
afterAll(() => server.stop(true));

const provider = (over: Partial<Provider> = {}): Provider => ({
  id: "lab", label: "Lab", family: "other", available: () => true,
  list: async () => [], stream: async () => { throw new Error("no"); },
  speech: async () => ({ base: `http://127.0.0.1:${server.port}/v1`, headers: { authorization: "Bearer lab-key-not-real" }, secrets: ["lab-key-not-real"] }),
  ...over,
});
const speech = (p: Provider[], lookup: (m: string) => any = () => undefined) => new Speech({ providers: () => p, lookup });

test("a speech model is told by the catalog, else by the words of its id", () => {
  expect(speechKind("whisper-large-v3")).toBe("stt");
  expect(speechKind("gpt-4o-mini-transcribe")).toBe("stt");
  expect(speechKind("tts-1")).toBe("tts");
  expect(speechKind("gpt-4o-mini-tts")).toBe("tts");
  expect(speechKind("gpt-5")).toBeNull();
  expect(speechKind("realtime-voice")).toBeNull();
  // The catalog wins over the id.
  expect(speechKind("vox-x", { speech: "stt" })).toBe("stt");
  expect(speechKind("whisper-1", { speech: "tts" })).toBe("tts");
});

test("a route splits at its first colon", () => {
  expect(splitRoute("lab:whisper-1")).toEqual({ provider: "lab", model: "whisper-1" });
  expect(splitRoute("lab:a:b")).toEqual({ provider: "lab", model: "a:b" });
  expect(splitRoute("nothing")).toBeNull();
  expect(splitRoute(":x")).toBeNull();
});

test("the listing names the speech models, the catalog adds one, and a provider with no speech is left out", async () => {
  const s = speech([provider(), provider({ id: "chat", speech: undefined })], (m) => (m === "vox-stt-x" ? { speech: "stt" } : undefined));
  const r = await s.models();
  expect(r.failed).toEqual([]);
  expect(r.models.map((m) => `${m.route} ${m.kind}`).sort()).toEqual(["lab:gpt-4o-mini-transcribe stt", "lab:tts-1 tts", "lab:vox-stt-x stt", "lab:whisper-1 stt"]);
  expect(seen.at(-1)).toEqual({ path: "/v1/models", auth: "Bearer lab-key-not-real" });
});

test("a recording goes to the speech to text model's route and the words come back trimmed", async () => {
  const s = speech([provider()]);
  const text = await s.transcribe("lab:whisper-1", new Blob([new Uint8Array(40)], { type: "audio/webm" }), { language: "he-IL" });
  expect(text).toBe("hello there");
  expect(seen.findLast((x) => x.path === "/v1/audio/transcriptions")!.body).toEqual({ model: "whisper-1", language: "he", size: 40 });
});

test("a model the listing does not name as the kind asked for is never sent a recording or a text", async () => {
  const s = speech([provider()]);
  await expect(s.transcribe("lab:gpt-chat", new Blob([new Uint8Array(4)]))).rejects.toMatchObject({ status: 404 });
  await expect(s.transcribe("lab:tts-1", new Blob([new Uint8Array(4)]))).rejects.toBeInstanceOf(SpeechError);
  await expect(s.speak("lab:whisper-1", "hi")).rejects.toMatchObject({ status: 404 });
  await expect(s.speak("gone:tts-1", "hi")).rejects.toMatchObject({ status: 404 });
});

test("a text goes to the text to speech route with the voice asked for, and the audio comes back as sent", async () => {
  const s = speech([provider()]);
  const r = await s.speak("lab:tts-1", "Hello.", { voice: "nova" });
  expect(r.headers.get("content-type")).toBe("audio/mpeg");
  expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([1, 2, 3]);
  expect(seen.findLast((x) => x.path === "/v1/audio/speech")!.body).toEqual({ model: "tts-1", input: "Hello.", voice: "nova", response_format: "mp3" });
  await expect(s.speak("lab:tts-1", "x".repeat(5000))).rejects.toMatchObject({ status: 413 });
});

test("a provider that cannot be listed is reported, not thrown", async () => {
  const s = speech([provider({ speech: async () => { throw new Error("Lab: no key"); } })]);
  expect(await s.models()).toEqual({ models: [], failed: [{ provider: "lab", error: "Lab: no key" }] });
});

test("the voices a provider lists are read from its voices route, and a provider with none lists none", async () => {
  expect(parseVoices({ voices: ["a", { id: "b" }, { voice_id: "c" }, { name: "d" }, "a", ""] })).toEqual(["a", "b", "c", "d"]);
  expect(parseVoices({ data: [{ id: "x" }] })).toEqual(["x"]);
  expect(parseVoices({ object: "list" })).toEqual([]);
  expect(parseVoices(null)).toEqual([]);
  const withKey = (key: string) => provider({ speech: async () => ({ base: `http://127.0.0.1:${server.port}/v1`, headers: { authorization: `Bearer ${key}` }, secrets: [key] }) });
  const listed = (await speech([withKey("listed")]).models()).models.filter((m) => m.kind === "tts");
  expect(listed.map((m) => m.voices)).toEqual([["ember", "vale"]]);
  const none = (await speech([withKey("other")]).models()).models.filter((m) => m.kind === "tts");
  expect(none.map((m) => m.voices)).toEqual([undefined]);
});

test("no voice is sent when none was chosen, and a provider that refuses for it is told to the page as needing one", async () => {
  const strict = provider({ speech: async () => ({ base: `http://127.0.0.1:${server.port}/v1`, headers: { authorization: "Bearer strict" }, secrets: ["strict"] }) });
  const s = speech([strict]);
  const e = await s.speak("lab:tts-1", "Hello.").catch((x) => x);
  expect(e).toBeInstanceOf(SpeechError);
  expect(e).toMatchObject({ status: 422, voiceNeeded: true });
  expect(e.message).toContain("Supported values are: 'ash', 'coral'");
  expect(seen.findLast((x) => x.path === "/v1/audio/speech")!.body).toEqual({ model: "tts-1", input: "Hello.", response_format: "mp3" });
  // With a voice named, the same provider answers.
  expect((await s.speak("lab:tts-1", "Hello.", { voice: "ash" })).status).toBe(200);
});
