// Find a setting: which sections a query finds, and which of their rows to name
// under each. Every word of the query is matched on its own, in any order: a
// section is found when each word is in its name, its words or one of its rows;
// a row is named when it holds at least one of the words and the row with its
// section holds them all, those that hold more of the words first.
export type Findable = { id: string; label: string; words?: string };

export const queryWords = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);

const holds = (text: string, w: string) => text.includes(w);

export function findSettings<S extends Findable>(sections: S[], names: (id: string) => string[], q: string, perSection = 3): { section: S; rows: string[] }[] {
  const words = queryWords(q);
  if (!words.length) return sections.map((section) => ({ section, rows: [] }));
  const out: { section: S; rows: string[] }[] = [];
  for (const section of sections) {
    const own = `${section.label} ${section.words ?? ""}`.toLowerCase();
    const list = names(section.id);
    const lower = list.map((n) => n.toLowerCase());
    // A row is named when it holds one word at least and, with its section's own words, all of them.
    // The rows that hold more of the words come first.
    const score = (i: number) => words.filter((w) => holds(lower[i]!, w)).length;
    const rows = list.map((n, i) => ({ n, i })).filter(({ n, i }) => n.toLowerCase() !== section.label.toLowerCase() && score(i) > 0 && words.every((w) => holds(lower[i]!, w) || holds(own, w)))
      .sort((a, b) => score(b.i) - score(a.i) || a.i - b.i).slice(0, perSection).map(({ n }) => n);
    const found = words.every((w) => holds(own, w) || lower.some((n) => holds(n, w)));
    if (found) out.push({ section, rows });
  }
  return out;
}
