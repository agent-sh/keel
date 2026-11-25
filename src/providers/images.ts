// Pictures made by a provider's model, for the pictures Keel itself asks for (the helper's avatar). Four
// routes, by what the provider speaks; each request makes one picture, and `n` pictures are `n` requests
// side by side (a route that takes a count would bill the same, and one that does not still answers):
//   images  POST {base}/images/generations (OpenAI and the servers that copy it): data[].b64_json or url.
//   chat    POST {base}/chat/completions with modalities [image, text] (for models that answer in text and
//           pictures): message.images[].image_url.url as a data URL.
//   gemini  :generateContent with responseModalities [TEXT, IMAGE]: parts[].inlineData.
//   tool    a sign-in route that speaks the Responses API (the ChatGPT plan, through its image_generation
//           tool, as Codex does): the answer's image_generation_call items carry the picture as base64.
// Which models make pictures is not decided here: the listing's output modalities, else the catalog's
// (src/providers/registry.ts imageModels).
import { ProviderError, postJson, scrub, streamEvents } from "./http.ts";
import type { MadeImage } from "./types.ts";

// Pictures a person looks at: at most this many in one ask, and this many requests at once.
export const MAX_PICTURES = 6;
const AT_ONCE = 3;

// The format the bytes are in, from their first bytes; undefined for what is not a picture Keel keeps.
export function sniff(b64: string): string | undefined {
  const b = Buffer.from(b64.slice(0, 48), "base64");
  if (b.length >= 8 && b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

const made = (data: string, claimed?: string): MadeImage | undefined => {
  const media_type = sniff(data) ?? (claimed && /^image\/(png|jpeg|webp)$/.test(claimed) ? claimed : undefined);
  return media_type ? { media_type, data } : undefined;
};

// `data:image/png;base64,....` to its parts.
export function fromDataUrl(url: string): MadeImage | undefined {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  return m ? made(m[2]!, m[1]) : undefined;
}

// --- request bodies and answers, pure ---------------------------------------------------------------

export const imagesBody = (model: string, prompt: string) => ({ model, prompt, n: 1, size: "1024x1024" });
// The pictures an images route answered: inline bytes, or an address to fetch.
export function imagesFrom(answer: any): ({ data: string } | { url: string })[] {
  return (Array.isArray(answer?.data) ? answer.data : []).flatMap((d: any) => (typeof d?.b64_json === "string" ? [{ data: d.b64_json }] : typeof d?.url === "string" ? [{ url: d.url }] : []));
}

export const chatImageBody = (model: string, prompt: string) => ({ model, messages: [{ role: "user", content: prompt }], modalities: ["image", "text"], stream: false });
export function chatImagesFrom(answer: any): MadeImage[] {
  const out: MadeImage[] = [];
  for (const c of Array.isArray(answer?.choices) ? answer.choices : []) {
    for (const i of Array.isArray(c?.message?.images) ? c.message.images : []) {
      const url = i?.image_url?.url ?? i?.url;
      const m = typeof url === "string" ? fromDataUrl(url) : undefined;
      if (m) out.push(m);
    }
  }
  return out;
}

export const geminiImageBody = (prompt: string) => ({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } });
export function geminiImagesFrom(answer: any): MadeImage[] {
  const out: MadeImage[] = [];
  for (const c of Array.isArray(answer?.candidates) ? answer.candidates : []) {
    for (const p of Array.isArray(c?.content?.parts) ? c.content.parts : []) {
      const d = p?.inlineData ?? p?.inline_data;
      const m = typeof d?.data === "string" ? made(d.data, d.mimeType ?? d.mime_type) : undefined;
      if (m) out.push(m);
    }
  }
  return out;
}

// The Responses request that asks a model to draw: its image_generation tool, forced, and nothing else.
export const toolImageBody = (host: string, prompt: string) => ({
  model: host,
  instructions: "Make the picture the user describes with the image generation tool. Do not answer in words.",
  input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
  tools: [{ type: "image_generation" }],
  tool_choice: { type: "image_generation" },
  store: false,
  stream: true,
});
// The pictures in a Responses stream's events: a finished image_generation_call item holds one as base64.
export function toolImagesFrom(events: any[]): MadeImage[] {
  const out: MadeImage[] = [];
  const add = (item: any) => {
    if (item?.type !== "image_generation_call" || typeof item.result !== "string" || !item.result) return;
    const m = made(item.result);
    if (m && !out.some((o) => o.data === m.data)) out.push(m);
  };
  for (const e of events) {
    if (e?.type === "response.output_item.done") add(e.item);
    else if (e?.type === "response.completed") for (const item of e.response?.output ?? []) add(item);
  }
  return out;
}

// --- requests -----------------------------------------------------------------------------------------

export type Route = { label: string; headers: Record<string, string>; secrets: string[]; signal: AbortSignal };

async function fetched(url: string, route: Route): Promise<MadeImage | undefined> {
  const r = await fetch(url, { signal: AbortSignal.any([route.signal, AbortSignal.timeout(60_000)]) });
  if (!r.ok) throw new ProviderError("server", `${route.label}: the picture's address answered HTTP ${r.status}`, r.status);
  return made(Buffer.from(await r.arrayBuffer()).toString("base64"), r.headers.get("content-type")?.split(";")[0]);
}

export async function viaImages(route: Route, base: string, model: string, prompt: string): Promise<MadeImage[]> {
  const got = imagesFrom(await postJson(route.label, `${base}/images/generations`, route.headers, imagesBody(model, prompt), route.secrets, route.signal));
  const out: MadeImage[] = [];
  for (const g of got) {
    const m = "data" in g ? made(g.data) : await fetched(g.url, route);
    if (m) out.push(m);
  }
  return out;
}

export async function viaChat(route: Route, base: string, model: string, prompt: string): Promise<MadeImage[]> {
  return chatImagesFrom(await postJson(route.label, `${base}/chat/completions`, route.headers, chatImageBody(model, prompt), route.secrets, route.signal));
}

export async function viaGemini(route: Route, base: string, model: string, prompt: string): Promise<MadeImage[]> {
  return geminiImagesFrom(await postJson(route.label, `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, route.headers, geminiImageBody(prompt), route.secrets, route.signal));
}

export async function viaTool(route: Route, url: string, host: string, prompt: string): Promise<MadeImage[]> {
  const events: any[] = [];
  for await (const ev of streamEvents({ label: route.label, url, headers: route.headers, body: toolImageBody(host, prompt), signal: route.signal, secrets: route.secrets })) {
    if (ev.data === "[DONE]") break;
    try { events.push(JSON.parse(ev.data)); } catch { continue; }
    const last = events.at(-1);
    if (last?.type === "response.failed" || last?.type === "error") {
      const m = String(last.response?.error?.message ?? last.error?.message ?? last.message ?? "the provider could not make the picture");
      throw new ProviderError("invalid", `${route.label}: ${scrub(m, route.secrets)}`);
    }
  }
  return toolImagesFrom(events);
}

// `n` pictures from `one`, at most AT_ONCE requests at a time. With some pictures made, a request that
// failed is left out (the owner picks among the rest); with none, the first failure is the answer.
export async function several(n: number, one: () => Promise<MadeImage[]>): Promise<MadeImage[]> {
  const want = Math.max(1, Math.min(MAX_PICTURES, Math.floor(n)));
  const out: MadeImage[] = [];
  let failure: unknown;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, want) }, async () => {
    while (next < want) {
      next++;
      try { out.push(...(await one())); } catch (e) { failure ??= e; }
    }
  }));
  if (!out.length) throw failure ?? new ProviderError("invalid", "the model returned no picture");
  return out.slice(0, want);
}
