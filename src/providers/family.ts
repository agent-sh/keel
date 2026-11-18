import type { Family } from "./types.ts";

// The family a model id names, for routes that list many vendors' models. The
// tools lane gives each family the tools it was trained on.
export function familyOf(id: string, fallback: Family = "other"): Family {
  const m = id.toLowerCase();
  if (/(^|[/.:])claude|anthropic/.test(m)) return "claude";
  if (/(^|[/.:])(gpt-|o\d(-|$)|codex)|openai\//.test(m)) return "gpt";
  if (/(^|[/.:])gemini/.test(m)) return "gemini";
  return fallback;
}

// Listing entries that are not chat models: embeddings, rerankers, speech,
// images, moderation. A kind filter, not a model list.
export const notChat = (id: string) =>
  /embed|rerank|whisper|tts|transcri|speech|voice|audio|realtime|image|imagen|veo|flux|sdxl|diffusion|dall-e|moderation|guard|ocr|(^|[/-])sam-|aqa|starcoder|:batch$/i.test(id);
