// The two-letter code of each session, for the marks of the rail and the bridge. Pure: no page needed.
// A short code per session for its mark on the folded rail: the initials of
// the title's first two telling words, so the mark reads as the session.
// Two sessions never share one, in a folder or across them: the older keeps
// the initials, the newer takes other letters of its title.
const FILLER = new Set("a an the to of for and or in on at by with from into is are be how why what when where which that this it its as do does".split(" "));
const letters = (w: string) => [...w].filter((c) => /[\p{L}\p{N}]/u.test(c));
// The lists it is asked for change with every event of any session (the store hands out a new
// list), while what the callsigns depend on (ids, titles, creation times) rarely does: the last
// answers are kept and given again for the same sessions, so nothing is worked out or allocated.
type Signed = { id: string; title: string; created: number };
const kept: { of: Signed[]; codes: Record<string, string> }[] = [];
const sameSessions = (a: Signed[], b: Signed[]) => a.length === b.length && a.every((s, i) => s.id === b[i]!.id && s.title === b[i]!.title && s.created === b[i]!.created);
export function callsigns(sessions: Signed[]): Record<string, string> {
  const had = kept.find((k) => sameSessions(k.of, sessions));
  if (had) return had.codes;
  const codes = makeCallsigns(sessions);
  kept.unshift({ of: sessions.map(({ id, title, created }) => ({ id, title, created })), codes });
  kept.length = Math.min(kept.length, 4); // the rail and the bridge ask for different lists
  return codes;
}
function makeCallsigns(sessions: Signed[]): Record<string, string> {
  const out: Record<string, string> = {};
  const taken = new Set<string>();
  for (const s of [...sessions].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))) {
    const all = s.title.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const telling = all.filter((w) => !FILLER.has(w.toLowerCase()));
    const words = (telling.length ? telling : all).map(letters).filter((w) => w.length);
    const [a, b] = words;
    const tries: string[] = [];
    if (a && b) tries.push(a[0]! + b[0]!);
    if (a) for (const c of a.slice(1)) tries.push(a[0]! + c);
    if (a) for (const w of words.slice(2)) tries.push(a[0]! + w[0]!);
    if (a && b) for (const c of b.slice(1)) tries.push(a[0]! + c);
    const head = a?.[0] ?? "N";
    if (!a) tries.push("NS"); // an untitled session
    let code = tries.map((t) => t.toLocaleUpperCase()).find((t) => !taken.has(t));
    // Every pair of its letters is taken: a number after the first, the lowest free.
    for (let n = 2; !code && n < 100; n++) { const t = (head + n).toLocaleUpperCase(); if (!taken.has(t)) code = t; }
    code ??= head.toLocaleUpperCase();
    taken.add(code);
    out[s.id] = code;
  }
  return out;
}
