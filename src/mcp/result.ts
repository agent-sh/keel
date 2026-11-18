import type { ImageBlock, TextBlock } from "../core/types.ts";
import { spill } from "../tools/spill.ts";
import type { ToolContext, ToolOutput } from "../tools/types.ts";
import type { McpCallResult } from "./client.ts";

// An MCP tool result as a tool output: text parts joined (long text spilled to
// a file), images kept as images, structured content as compact JSON when the
// server sent no text for it, binary parts named rather than inlined.
export async function toOutput(r: McpCallResult, ctx: ToolContext, label: string): Promise<ToolOutput> {
  const texts: string[] = [];
  const images: ImageBlock[] = [];
  for (const c of r.content ?? []) {
    if (c.type === "text") texts.push(c.text);
    else if (c.type === "image") images.push({ type: "image", media_type: c.mimeType, data: c.data });
    else if (c.type === "resource") texts.push(c.resource.text ?? `[resource ${c.resource.uri}${c.resource.mimeType ? `, ${c.resource.mimeType}` : ""}]`);
    else if (c.type === "resource_link") texts.push(`[link ${c.uri}${c.name ? ` (${c.name})` : ""}]`);
    else if (c.type === "audio") texts.push(`[audio ${c.mimeType}, not shown]`);
  }
  if (!texts.length && r.structuredContent !== undefined) texts.push(JSON.stringify(r.structuredContent));
  const text = await spill(texts.join("\n") || (images.length ? "" : "(no output)"), ctx.spillDir, label);
  const is_error = r.isError || undefined;
  if (!images.length) return { content: text, is_error };
  const blocks: (TextBlock | ImageBlock)[] = [...(text ? [{ type: "text" as const, text }] : []), ...images];
  return { content: blocks, is_error };
}
