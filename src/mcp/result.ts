import type { ImageBlock, TextBlock } from "../core/types.ts";
import { spill } from "../tools/spill.ts";
import { base64Blob, blobType, saveBlob, sizeWords, type SavedFile } from "../tools/blob.ts";
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
// a file), images kept as images, binary parts (an embedded resource's blob,
// audio, a long base64 text) saved as files under the session's spill folder
// with the extension their type gives, and named by their path. An image is
// kept as an image within the image limits, and its original bytes are the
// file the result names. The files are also in `shown` for the transcript.
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
  const files: SavedFile[] = [];
  const schema = outputSchema && !r.isError ? outputSchema : undefined;
  const structured = schema && r.structuredContent !== undefined;
  // The bytes as a file, and the words that name it: what it is, its type and size, and where it is.
  // No folder to keep it in, or one that cannot be written: the words say that instead of a path.
  const keep = async (what: string, data: Buffer, declared: string | undefined, from?: string): Promise<{ words: string; file?: SavedFile }> => {
    const mime = blobType(declared, data);
    const head = `${what}, ${mime}, ${sizeWords(data.byteLength)}`;
    if (!ctx.spillDir) return { words: `${head}, not saved` };
    try {
      const file = await saveBlob(ctx.spillDir, label, data, mime, from);
      files.push(file);
      return { words: `${head}, saved to ${file.path}`, file };
    } catch (e) {
      return { words: `${head}, not saved (${String((e as Error).message ?? e).slice(0, 100)})` };
    }
  };
  for (const c of r.content ?? []) {
    if (c.type === "text") {
      if (structured && sameJson(c.text, r.structuredContent)) continue;
      const blob = base64Blob(c.text);
      texts.push(blob ? `[${(await keep("base64 text", blob.bytes, blob.mime)).words}]` : c.text);
    } else if (c.type === "image") {
      const k = await keep("image", Buffer.from(c.data, "base64"), c.mimeType);
      images.push({ type: "image", media_type: c.mimeType, data: c.data, ...(k.file ? { path: k.file.path } : {}) });
      if (k.file) texts.push(`[${k.words}]`);
    } else if (c.type === "resource") {
      const { uri, mimeType, text, blob } = c.resource;
      if (text !== undefined) texts.push(text);
      else if (blob === undefined) texts.push(`[resource ${uri}${mimeType ? `, ${mimeType}` : ""}]`);
      else {
        const name = (() => { try { return decodeURIComponent(new URL(uri).pathname.split("/").pop() ?? ""); } catch { return ""; } })();
        texts.push(`[${(await keep(`resource ${uri}`, Buffer.from(blob, "base64"), mimeType, name || undefined)).words}]`);
      }
    }
    else if (c.type === "resource_link") texts.push(`[link ${c.uri}${c.name ? ` (${c.name})` : ""}]`);
    else if (c.type === "audio") texts.push(`[${(await keep("audio", Buffer.from(c.data, "base64"), c.mimeType)).words}]`);
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
  const shown = files.length ? { files } : undefined;
  if (!images.length) return { content: text, is_error, ...(shown ? { shown } : {}) };
  const blocks: (TextBlock | ImageBlock)[] = [...(text ? [{ type: "text" as const, text }] : []), ...images];
  return { content: blocks, is_error, ...(shown ? { shown } : {}) };
}
