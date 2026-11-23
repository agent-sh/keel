// The event's own words from its frame (src/mcp/channel.ts frame): what the
// page shows under the source's name. Apart, with no imports, for the page.
export function bodyOf(text: string): string {
  const at = text.indexOf("\n\n");
  return (at < 0 ? text : text.slice(at + 2)).replace(/\n<\/channel>\s*$/, "");
}
