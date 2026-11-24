// What a skill file says about itself: its front matter, its description and whether it is another
// harness's own skill. Pure text, so the health check's walk on the read thread reads skills the same way
// the skill list does (src/tools/skills.ts).

// Small YAML subset: scalars, quoted strings, [a, b] and "- a" lists, | and > blocks.
export function frontmatter(text: string): { data: Record<string, any>; body: string } {
  if (!text.startsWith("---")) return { data: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { data: {}, body: text };
  const lines = text.slice(text.indexOf("\n") + 1, end).split("\n");
  const body = text.slice(text.indexOf("\n", end + 1) + 1);
  const data: Record<string, any> = {};
  const unq = (v: string) => v.replace(/^(["'])([\s\S]*)\1$/, "$2");
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const [, key, raw] = m as unknown as [string, string, string];
    if (/^[|>][-+]?$/.test(raw)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]!) || lines[i + 1] === "")) block.push(lines[++i]!.trim());
      data[key] = raw.startsWith(">") ? block.join(" ").trim() : block.join("\n").trim();
    } else if (raw === "") {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1]!)) items.push(unq(lines[++i]!.replace(/^\s*-\s+/, "").trim()));
      data[key] = items.length ? items : "";
    } else if (/^\[.*\]$/.test(raw)) data[key] = raw.slice(1, -1).split(",").map((s) => unq(s.trim())).filter(Boolean);
    else if (raw === "true" || raw === "false") data[key] = raw === "true";
    else data[key] = unq(raw.trim());
  }
  return { data, body };
}

// Other harnesses install their built-in skills into the shared personal
// folders (~/.agents/skills): skills that drive that harness's own product,
// settings or tools, which Keel cannot run. A personal skill is left out when
// its name or description names such a product, or its body uses that
// harness's own config folder or tool names. Project skills always load.
const FOREIGN_TITLE = /\b(codex|cursor|bugbot)\b/i;
const FOREIGN_BODY = /(^|[\s"'`(~/])\.(cursor|codex)\/|\bcursor-[a-z]+-[a-z_-]+|<\/?cursor-[a-z]/m;
export const foreignSkill = (name: string, description: string, body: string) =>
  FOREIGN_TITLE.test(`${name} ${description}`) || FOREIGN_BODY.test(body);

// The description a skill is offered with: its own, else its body's first line, then when to use it.
export const skillDescription = (data: Record<string, any>, body: string): string =>
  [data.description || body.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "") || "", data.when_to_use || ""]
    .filter(Boolean).join(" ").slice(0, 1536);
