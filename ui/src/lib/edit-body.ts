// What an edit would write, for the card that asks for it. An approval is
// given only for what was read, and an edit's summary is its paths alone: the
// card shows this under them, and counts its lines as read like any other
// text (lib/approvals.ts). From the input the daemon kept of the call:
// - a whole file (Write, write_file) or a notebook cell: its lines as they are;
// - a replacement (Edit, replace): what goes, then what comes;
// - a patch (apply_patch): as written, toned by its own signs;
// - an input the daemon kept only the start of: that start, as kept.
// `tone`: how a line is drawn. `clipped`: the rest was not kept.
export type EditLine = { text: string; tone?: "add" | "del" | "note" };
export type EditBody = { lines: EditLine[]; clipped?: true };

const split = (text: string) => { const l = text.split("\n"); if (l.length > 1 && l.at(-1) === "") l.pop(); return l; };

export function editBody(input: unknown): EditBody | null {
  if (typeof input === "string") return patchBody(input);
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  if (typeof i._clipped === "string") return { lines: split(i._clipped).map((text) => ({ text })), clipped: true };
  const whole = typeof i.content === "string" ? i.content : typeof i.new_source === "string" ? i.new_source : null;
  if (whole !== null) return { lines: whole ? split(whole).map((text) => ({ text })) : [{ text: "(an empty file)", tone: "note" }] };
  if (typeof i.old_string === "string" && typeof i.new_string === "string") {
    return {
      lines: [
        ...(i.replace_all ? [{ text: "every occurrence:", tone: "note" as const }] : []),
        ...(i.old_string ? split(i.old_string).map((t) => ({ text: `- ${t}`, tone: "del" as const })) : []),
        ...(i.new_string ? split(i.new_string).map((t) => ({ text: `+ ${t}`, tone: "add" as const })) : []),
      ],
    };
  }
  const patch = typeof i.patch === "string" ? i.patch : typeof i.input === "string" ? i.input : null;
  return patch !== null ? patchBody(patch) : null;
}

// A patch's lines, toned by their first character (its "***" and "+++" headers are not changes).
function patchBody(patch: string): EditBody | null {
  if (!patch) return null;
  return { lines: split(patch).map((text) => (/^\+(?!\+\+ )/.test(text) ? { text, tone: "add" as const } : /^-(?!-- )/.test(text) ? { text, tone: "del" as const } : { text })) };
}
