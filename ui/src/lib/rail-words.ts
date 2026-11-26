// The word a session goes by on the folded rail. Pure: no page needed.
// A pair of initials says nothing about which session it is; a word of its title does. It is the
// title's first word, as typed and as the list shows it (an article aside). Two sessions never share
// one: the older keeps its word, the newer takes the next telling word of its title that is free,
// else its first with a number.
const FILLER = new Set("a an the to of for and or in on at by with from into is are be how why what when where which that this it its as do does".split(" "));
const ARTICLE = new Set(["a", "an", "the"]);
type Named = { id: string; title: string; created: number };
// Asked at every event of any session, while what it depends on (ids, titles, creation times)
// rarely changes: the last answer is given again for the same sessions.
let kept: { of: Named[]; words: Record<string, string> } | null = null;
const same = (a: Named[], b: Named[]) => a.length === b.length && a.every((s, i) => s.id === b[i]!.id && s.title === b[i]!.title && s.created === b[i]!.created);
export function railWords(sessions: Named[]): Record<string, string> {
  if (kept && same(kept.of, sessions)) return kept.words;
  const words: Record<string, string> = {};
  const taken = new Set<string>();
  for (const s of [...sessions].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))) {
    const all = s.title.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const first = all.find((w) => !ARTICLE.has(w.toLowerCase())) ?? all[0] ?? "New";
    const tries = [first, ...all.filter((w) => w !== first && !FILLER.has(w.toLowerCase()))];
    let word = tries.find((w) => !taken.has(w.toLowerCase()));
    for (let n = 2; !word; n++) if (!taken.has(`${tries[0]!}${n}`.toLowerCase())) word = `${tries[0]!}${n}`;
    taken.add(word.toLowerCase());
    words[s.id] = word;
  }
  kept = { of: sessions.map(({ id, title, created }) => ({ id, title, created })), words };
  return words;
}

// Which sessions the folded rail names, and which it only counts. The rail is the way back to what
// needs the owner and what works, not the list: a session at rest that the owner has seen is counted,
// never drawn. `rows` is the room (null: all fit); a row is kept for the count when anything is left out.
// Given in the order they are drawn; what is cut is cut from the end. The open session takes the last
// row then, unless that row calls the owner: what calls is never given up for what is already on screen.
export function railShown<T extends { id: string }>(list: T[], keeps: (s: T) => boolean, calls: (s: T) => boolean, current: string | null, rows: number | null): { shown: T[]; rest: T[] } {
  const kept = list.filter(keeps);
  if (rows === null || kept.length + (kept.length < list.length ? 1 : 0) <= rows) return { shown: kept, rest: list.filter((s) => !keeps(s)) };
  const room = Math.max(1, rows - 1);
  const head = kept.slice(0, room);
  const at = kept.findIndex((s) => s.id === current);
  if (at >= room && !calls(head[room - 1]!)) head[room - 1] = kept[at]!;
  const drawn = new Set(head.map((s) => s.id));
  return { shown: head, rest: list.filter((s) => !drawn.has(s.id)) };
}
