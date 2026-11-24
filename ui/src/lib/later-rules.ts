// What of the requests that wait is put away with Later (lib/later.ts): the rule, apart from the page's state.
export type Put = { ids: Set<string>; known: Set<string> };

const EMPTY: ReadonlySet<string> = new Set();
// What of `waiting` is put away: none when a request came that was not there when the pile was put away.
export function awayOf(p: Put | undefined, waiting: readonly string[]): ReadonlySet<string> {
  if (!p || waiting.some((id) => !p.known.has(id))) return EMPTY;
  return new Set(waiting.filter((id) => p.ids.has(id)));
}
