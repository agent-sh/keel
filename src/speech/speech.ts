// Speech in and out through the owner's providers. A provider that speaks the OpenAI audio routes
// (its `/models`, `/audio/transcriptions`, `/audio/speech`) offers the speech models its own listing
// names; nothing is named here. The chat listing leaves speech models out (notChat), so the listing
// is read again for them, kept for a few minutes.
import { classify, fetchFailure, getJson, ProviderError, scrub } from "../providers/http.ts";
import type { CatalogEntry } from "../providers/catalog.ts";
import type { Provider, SpeechAccess } from "../providers/types.ts";

export type SpeechKind = "stt" | "tts";
export type SpeechModel = { route: string; provider: string; provider_label: string; model: string; kind: SpeechKind };

// The kind of a listed model: the catalog's modalities when it knows the model, else the words of
// its id (a kind filter like notChat in family.ts, not a model list).
export function speechKind(id: string, entry?: Pick<CatalogEntry, "speech">): SpeechKind | null {
  if (entry?.speech) return entry.speech;
  if (/whisper|transcri|(^|[-_/.])(stt|asr)($|[-_/.])/i.test(id)) return "stt";
  if (/(^|[-_/.])(tts|speech)|text-to-speech|orpheus/i.test(id)) return "tts";
  return null;
}

// "provider:model": the first colon ends the provider's id, the model keeps any other.
export function splitRoute(route: string): { provider: string; model: string } | null {
  const i = route.indexOf(":");
  return i > 0 && i < route.length - 1 ? { provider: route.slice(0, i), model: route.slice(i + 1) } : null;
}

const KEEP_MS = 5 * 60_000;
const LISTING_MS = 15_000;
export const MAX_AUDIO = 25 * 1024 * 1024; // the largest upload the OpenAI audio route takes
export const MAX_TEXT = 4096;              // the longest text its speech route takes

export type SpeechDeps = {
  providers: () => Provider[];
  lookup: (model: string) => CatalogEntry | undefined;
};

export class Speech {
  private seen = new Map<string, { at: number; identity: string; models: SpeechModel[]; error?: string }>();
  constructor(private deps: SpeechDeps) {}

  private async forProvider(p: Provider, fresh: boolean): Promise<{ models: SpeechModel[]; error?: string }> {
    const identity = p.identity?.() ?? p.id;
    const hit = this.seen.get(p.id);
    if (!fresh && hit && hit.identity === identity && Date.now() - hit.at < KEEP_MS) return hit;
    let out: { models: SpeechModel[]; error?: string };
    try {
      const a = await p.speech!();
      if (!a) return { models: [] };
      const d = await getJson(p.label ?? p.id, `${a.base}/models`, a.headers, a.secrets, Date.now() + LISTING_MS);
      const models: SpeechModel[] = [];
      for (const m of d.data ?? d.models ?? []) {
        const model = String(m?.id ?? m?.name ?? "");
        const kind = model ? speechKind(model, this.deps.lookup(model)) : null;
        if (kind) models.push({ route: `${p.id}:${model}`, provider: p.id, provider_label: p.label ?? p.id, model, kind });
      }
      out = { models };
    } catch (e) {
      out = { models: [], error: (e as Error).message };
    }
    this.seen.set(p.id, { at: Date.now(), identity, ...out });
    return out;
  }

  // Every speech model of every provider that is set up and speaks the audio routes.
  async models(fresh = false): Promise<{ models: SpeechModel[]; failed: { provider: string; error: string }[] }> {
    const list = this.deps.providers().filter((p) => p.speech && p.available());
    const got = await Promise.all(list.map(async (p) => ({ p, r: await this.forProvider(p, fresh) })));
    return {
      models: got.flatMap((g) => g.r.models),
      failed: got.filter((g) => g.r.error).map((g) => ({ provider: g.p.id, error: g.r.error! })),
    };
  }

  private async access(route: string, kind: SpeechKind): Promise<{ a: SpeechAccess; model: string; label: string }> {
    const r = splitRoute(route);
    const p = r && this.deps.providers().find((x) => x.id === r.provider);
    if (!r || !p?.speech) throw new SpeechError(404, `no provider takes speech under ${route || "an empty route"}`);
    const listed = (await this.forProvider(p, false)).models.find((m) => m.model === r.model);
    // A model the provider's listing does not name as a speech model of this kind is not sent.
    if (!listed || listed.kind !== kind) throw new SpeechError(404, `${route} is not a ${kind === "stt" ? "speech to text" : "text to speech"} model its provider lists`);
    const a = await p.speech();
    if (!a) throw new SpeechError(404, `${p.label ?? p.id} takes no speech`);
    return { a, model: r.model, label: p.label ?? p.id };
  }

  private async send(label: string, url: string, init: RequestInit, a: SpeechAccess): Promise<Response> {
    let r: Response;
    try {
      r = await fetch(url, { ...init, headers: { ...init.headers, ...a.headers }, signal: AbortSignal.timeout(120_000), redirect: "manual" });
    } catch (e) {
      throw new SpeechError(502, fetchFailure(label, e, a.secrets, url).message);
    }
    if (!r.ok) {
      const body = scrub(await r.text().catch(() => ""), a.secrets);
      const e: ProviderError = classify(label, r.status, r.headers, body);
      throw new SpeechError(e.kind === "auth" ? 401 : 502, e.message);
    }
    return r;
  }

  // The words in a recording, by the speech to text model of `route`.
  async transcribe(route: string, audio: Blob, opts: { language?: string; name?: string } = {}): Promise<string> {
    if (audio.size === 0) return "";
    if (audio.size > MAX_AUDIO) throw new SpeechError(413, `the recording is over ${MAX_AUDIO / 1024 / 1024} MB`);
    const { a, model, label } = await this.access(route, "stt");
    const form = new FormData();
    form.set("model", model);
    form.set("response_format", "json");
    // A language code of two letters or a tag, as the provider takes it; anything else is left out.
    if (opts.language && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(opts.language)) form.set("language", opts.language.slice(0, 2).toLowerCase());
    form.set("file", audio, opts.name ?? "speech.webm");
    const r = await this.send(label, `${a.base}/audio/transcriptions`, { method: "POST", body: form }, a);
    const d = (await r.json().catch(() => null)) as any;
    if (typeof d?.text !== "string") throw new SpeechError(502, `${label}: the transcription has no text`);
    return d.text.trim();
  }

  // The audio of `text`, as the provider sends it (the response to stream on).
  async speak(route: string, text: string, opts: { voice?: string; format?: string } = {}): Promise<Response> {
    if (!text.trim()) throw new SpeechError(400, "nothing to say");
    if (text.length > MAX_TEXT) throw new SpeechError(413, `the text is over ${MAX_TEXT} characters`);
    const { a, model, label } = await this.access(route, "tts");
    const format = opts.format === "wav" ? "wav" : "mp3";
    // `voice` is the provider's own name for one; the OpenAI route requires the field.
    const body = JSON.stringify({ model, input: text, voice: opts.voice?.trim() || DEFAULT_VOICE, response_format: format });
    const r = await this.send(label, `${a.base}/audio/speech`, { method: "POST", body, headers: { "content-type": "application/json" } }, a);
    return new Response(r.body, { headers: { "content-type": r.headers.get("content-type") ?? (format === "wav" ? "audio/wav" : "audio/mpeg"), "cache-control": "no-store" } });
  }
}

// The OpenAI route's own default voice: a field its API requires, changed in Settings > Speech.
export const DEFAULT_VOICE = "alloy";

export class SpeechError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
