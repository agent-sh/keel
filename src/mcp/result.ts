import type { ImageBlock, TextBlock } from "../core/types.ts";
import { spill } from "../tools/spill.ts";
import type { ToolContext, ToolOutput } from "../tools/types.ts";
import type { McpCallResult } from "./client.ts";
import { schemaProblems } from "./schema.ts";

// A text part that is the structured content again (2025-11-25 server/tools:
// a tool that returns structured content SHOULD also send it serialized in a
// text block, for clients that read only text).
function sameJson(text: string, value: unknown): boolean {
  try { return JSON.stringify(JSON.parse(text)) === JSON.stringify(value); } catch { return false; }
}

// An MCP tool result as a tool output: text parts joined (long text spilled to
// a file), images kept as images, binary parts named rather than inlined.
// Structured content goes as compact JSON when the server sent no text for it.
// `outputSchema`: the tool declares one (2025-11-25 server/tools, Output
// Schema). Its result must then carry structured content that conforms: one
// that does not is an error that says what is wrong, with what the server
// sent under it. One that conforms is given as its JSON, once: a text part
// that only repeats it is left out. A tool's error result is not held to the
// schema.
export async function toOutput(r: McpCallResult, ctx: ToolContext, label: string, outputSchema?: Record<string, unknown>): Promise<ToolOutput> {
  const texts: string[] = [];
  const images: ImageBlock[] = [];
  const schema = outputSchema && !r.isError ? outputSchema : undefined;
  const structured = schema && r.structuredContent !== undefined;
  for (const c of r.content ?? []) {
    if (c.type === "text") { if (!(structured && sameJson(c.text, r.structuredContent))) texts.push(c.text); }
    else if (c.type === "image") images.push({ type: "image", media_type: c.mimeType, data: c.data });
    else if (c.type === "resource") texts.push(c.resource.text ?? `[resource ${c.resource.uri}${c.resource.mimeType ? `, ${c.resource.mimeType}` : ""}]`);
    else if (c.type === "resource_link") texts.push(`[link ${c.uri}${c.name ? ` (${c.name})` : ""}]`);
    else if (c.type === "audio") texts.push(`[audio ${c.mimeType}, not shown]`);
  }
  let wrong: string | undefined;
  if (schema) {
    const problems = r.structuredContent === undefined ? [] : schemaProblems(r.structuredContent, schema as Record<string, any>);
    if (r.structuredContent === undefined) wrong = `${label} declares an output schema, and its result has no structured content.`;
    else if (problems.length) wrong = `${label} returned structured content that does not match its output schema: ${problems.join("; ")}.`;
  }
  if (structured) texts.unshift(JSON.stringify(r.structuredContent));
  else if (!texts.length && r.structuredContent !== undefined) texts.push(JSON.stringify(r.structuredContent));
  const body = texts.join("\n");
  const text = await spill(wrong ? `${wrong}${body ? `\nWhat it sent:\n${body}` : ""}` : body || (images.length ? "" : "(no output)"), ctx.spillDir, label);
  const is_error = r.isError || !!wrong || undefined;
  if (!images.length) return { content: text, is_error };
  const blocks: (TextBlock | ImageBlock)[] = [...(text ? [{ type: "text" as const, text }] : []), ...images];
  return { content: blocks, is_error };
}
