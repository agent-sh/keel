// Speech through the owner's providers, for dictation and conversation mode in the page:
//   GET  /api/speech                     the speech models the providers list ({ models, failed }); ?fresh=1 reads again
//   POST /api/speech/transcribe?route=   the recording as the body (its content type), ?lang=: { text }
//   POST /api/speech/speak               { route, text, voice? }: the audio of the text (no voice: none is sent; a provider
//                                        that refuses for it is answered 422 with { error, voice_needed: true })
// A text to speech model carries `voices` when its provider lists them (GET <base>/audio/voices).
// What speaks and what listens is chosen in the page (Settings > Speech); the daemon sends only to a
// model its provider's own listing names as a speech model.
import { Speech, SpeechError } from "../../speech/speech.ts";
import type { RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

export const speechRoutes: RouteModule = ({ providers }) => {
  const speech = new Speech({ providers: () => providers.all(), lookup: (m) => providers.catalog.lookup(m) });
  const answer = (e: unknown) => (e instanceof SpeechError ? json({ error: e.message, ...(e.voiceNeeded ? { voice_needed: true } : {}) }, e.status) : json({ error: (e as Error).message }, 502));
  return {
    "/api/speech": {
      GET: async (req: Request) => {
        await providers.catalog.ready();
        return json(await speech.models(new URL(req.url).searchParams.get("fresh") === "1"));
      },
    },
    "/api/speech/transcribe": {
      POST: async (req: Request) => {
        const u = new URL(req.url);
        const route = u.searchParams.get("route") ?? "";
        const type = req.headers.get("content-type") ?? "audio/webm";
        if (!/^audio\/|^video\/webm|^application\/ogg/.test(type)) return json({ error: "the body is a recording: send it with its audio content type" }, 400);
        try {
          await providers.catalog.ready();
          const ext = /ogg/.test(type) ? "ogg" : /mp4|m4a|aac/.test(type) ? "m4a" : /wav/.test(type) ? "wav" : /mpeg|mp3/.test(type) ? "mp3" : "webm";
          const text = await speech.transcribe(route, new Blob([await req.arrayBuffer()], { type }), { language: u.searchParams.get("lang") ?? undefined, name: `speech.${ext}` });
          return json({ text });
        } catch (e) {
          return answer(e);
        }
      },
    },
    "/api/speech/speak": {
      POST: async (req: Request) => {
        const b = (await req.json().catch(() => ({}))) as any;
        if (typeof b.route !== "string" || typeof b.text !== "string") return json({ error: "send { route, text }" }, 400);
        try {
          await providers.catalog.ready();
          return await speech.speak(b.route, b.text, { voice: typeof b.voice === "string" ? b.voice : undefined });
        } catch (e) {
          return answer(e);
        }
      },
    },
  };
};
