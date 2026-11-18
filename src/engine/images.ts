// A model whose listing says it does not read images is sent a short note in
// place of each image (a pasted screenshot, a Read of a PNG, an MCP capture),
// so a session that switched to it, or its compaction, keeps working instead
// of failing on the provider's "image not supported" error. Only an explicit
// `images: false` strips them: an unknown capability sends the image, since a
// vision model treated as text-only is the worse mistake. Pure, so the request
// prefix stays byte-stable for that model.
import type { Message } from "../core/types.ts";

export function withoutImages(messages: Message[], model: string): Message[] {
  const note = { type: "text" as const, text: `[image not sent: ${model} does not read images]` };
  let changed = false;
  const out = messages.map((m) => {
    if (!m.content.some((b: any) => b.type === "image" || (b.type === "tool_result" && Array.isArray(b.content) && b.content.some((c: any) => c.type === "image")))) return m;
    changed = true;
    const content = m.content.map((b: any) => {
      if (b.type === "image") return note;
      if (b.type === "tool_result" && Array.isArray(b.content)) return { ...b, content: b.content.map((c: any) => (c.type === "image" ? note : c)) };
      return b;
    });
    return { ...m, content } as Message;
  });
  return changed ? out : messages;
}
