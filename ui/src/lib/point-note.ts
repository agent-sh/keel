// A pointed element in a message (lib/point.ts picks it): the lines the model reads, and the same
// lines found again in a sent message, where the page draws them as one quiet line.
// A note is its name in brackets and its facts under it, each a line of two spaces, a word and a
// colon: plain text, so a model with no picture reads the same thing, and a message copied out of
// Keel still says what was pointed at.

// What was pointed at: the name on its chip, and the facts in the order they are said.
export type Point = { id: string; name: string; facts: [string, string][]; image?: string };

const HEAD = /^\[Pointed at "([^"\n]+)"\]$/;

// `picture` is the place of the element's crop among the message's images (1 is the first), when it has one.
export function pointNote(p: Pick<Point, "name" | "facts">, picture?: { at: number; of: number }): string {
  const facts = picture ? [...p.facts, ["picture", picture.of === 1 ? "the image of this message" : `image ${picture.at} of this message's ${picture.of}`] as [string, string]] : p.facts;
  return [`[Pointed at "${p.name.replace(/["\n]/g, " ")}"]`, ...facts.map(([k, v]) => `  ${k}: ${v.replace(/\s*\n\s*/g, " ")}`)].join("\n");
}

// The owner's words with what they pointed at under them.
export function withPoints(text: string, points: Point[], images: string[]): string {
  if (!points.length) return text;
  const notes = points.map((p) => {
    const at = p.image ? images.indexOf(p.image) : -1;
    return pointNote(p, at < 0 ? undefined : { at: at + 1, of: images.length });
  });
  return [text.trim(), ...notes].filter(Boolean).join("\n\n");
}

// A message's text in the order it is read: its words, and each note as its name and facts.
export type Piece = { text: string } | { name: string; facts: [string, string][] };
export function pointPieces(text: string): Piece[] {
  if (!text.includes("[Pointed at ")) return [{ text }];
  const out: Piece[] = [];
  const words: string[] = [];
  const flush = () => { const t = words.join("\n").replace(/^\n+|\n+$/g, ""); words.length = 0; if (t) out.push({ text: t }); };
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = HEAD.exec(lines[i]!);
    if (!m) { words.push(lines[i]!); continue; }
    const facts: [string, string][] = [];
    while (i + 1 < lines.length) {
      const f = /^  ([a-z]+): (.*)$/.exec(lines[i + 1]!);
      if (!f) break;
      facts.push([f[1]!, f[2]!]);
      i++;
    }
    // (A bracketed line with no facts under it is the owner's own words.)
    if (!facts.length) { words.push(lines[i]!); continue; }
    flush();
    out.push({ name: m[1]!, facts });
  }
  flush();
  return out;
}

// The second line of a chip: where the element comes from, as short as it can be said.
export const pointFrom = (p: Pick<Point, "facts">): string => {
  const src = p.facts.find(([k]) => k === "source")?.[1] ?? p.facts.find(([k]) => k === "class")?.[1] ?? "";
  return src.replace(/^ui\/src\/(?:components\/|features\/|lib\/)?/, "").replace(/, .*$/, "");
};
export const pointSize = (p: Pick<Point, "facts">): string => (p.facts.find(([k]) => k === "box")?.[1] ?? "").replace(/ px.*$/, "");
