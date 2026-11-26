// The one-time import of the owner's agent tiers from his own words (Settings > Models): his typed messages
// that speak of models, tiers or effort are read by a small model of his chain, which writes them as a
// table; the card shows the rows with the words each came from, and only his yes makes them the setting.
// Pure: what is read, what is asked, what of the answer holds.
import type { Tier } from "./tiers.ts";

// How far back his words are read, and how much of them.
export const IMPORT_DAYS = 14;
export const WORDS_MAX = 40;
export const MESSAGE_CHARS = 2_000;
export const PROMPT_CHARS = 24_000;
export const DRAFT_OUT = 2_000;

export const TIERS_SYSTEM = "You turn what an owner said about which models his coding agents should run on into a table of tiers. Answer only with JSON.";

export type DraftRow = Tier & { words: string; listed: boolean };
type Listed = { id: string; model: string; name: string; provider?: string; family?: string };

const wordsOf = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && /[a-z]/.test(w));

// The words a listed model is spoken of by: its name's and id's own words of four or more characters, less
// the words that say nothing of which model it is, taken from the listing itself: its providers' and
// families' names, and a word most of the listed models share.
export function modelWords(listed: readonly Listed[]): Set<string> {
  const ignore = new Set<string>();
  for (const m of listed) for (const w of wordsOf(`${m.provider ?? ""} ${m.family ?? ""} ${m.id.split(":")[0] ?? ""}`)) ignore.add(w);
  const count = new Map<string, number>();
  for (const m of listed) for (const w of new Set(wordsOf(`${m.name} ${m.model}`))) count.set(w, (count.get(w) ?? 0) + 1);
  const out = new Set<string>();
  for (const [w, n] of count) if (!ignore.has(w) && !(listed.length >= 4 && n * 2 > listed.length)) out.add(w);
  return out;
}

// His messages that speak of tiers, effort or a listed model, the newest first, within the bounds.
export function speaks(m: string, words: ReadonlySet<string>): boolean {
  const lower = m.trim().toLowerCase();
  return !!lower && (/\b(tiers?|effort)\b/.test(lower) || lower.split(/[^a-z0-9]+/).some((w) => words.has(w)));
}

// The same allowed providers (src/safety/content-routes.ts): null is every provider.
type Route = { providers: string[] } | null;
const routeKey = (r: Route) => (r ? [...new Set(r.providers)].sort().join(" ") : "");

// Of his messages that speak of tiers (each with its session's folder rule, newest first), the ones that may
// go in one request: those of the newest one's rule, and those of folders with no rule. His words never
// reach a provider another folder's rule keeps them from. `at`: the session the request is counted on.
export function oneRoute<T extends { text: string; route: Route; session: string }>(said: readonly T[], words: ReadonlySet<string>): { at: string; texts: string[] } | undefined {
  const hits = said.filter((m) => speaks(m.text, words));
  const first = hits[0];
  if (!first) return undefined;
  const key = routeKey(first.route);
  return { at: first.session, texts: hits.filter((m) => !m.route || routeKey(m.route) === key).map((m) => m.text) };
}

export function wordsFor(messages: readonly string[], words: ReadonlySet<string>): string[] {
  const out: string[] = [];
  let total = 0;
  for (const m of messages) {
    const t = m.trim();
    if (!t || !speaks(t, words)) continue;
    const cut = t.slice(0, MESSAGE_CHARS);
    if (total + cut.length > PROMPT_CHARS || out.length >= WORDS_MAX) break;
    out.push(cut);
    total += cut.length;
  }
  return out;
}

export function tiersPrompt(said: readonly string[], listed: readonly Listed[]): string {
  return [
    "The models listed now (id: name):",
    ...listed.map((m) => `- ${m.id}: ${m.name}`),
    "",
    "What the owner said, newest first:",
    ...said.map((s, i) => `<said n="${i + 1}">\n${s}\n</said>`),
    "",
    "Write the tiers he set for his agents as a JSON array, best fitting first, one object a tier:",
    '{"name": a short tier name, "model": the id of the listed model he named for it, "effort": the effort he named (or leave it out), "use": the agent types or task kinds he named for it (use "default" for the tier most work goes to), "words": his own words for it, quoted exactly}',
    "A tier for reading code or long material is named reader. Only what he said: no tier he did not name. If he named none, answer [].",
  ].join("\n");
}

const str = (v: unknown, max = 60) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

// The listed model a row names: its id, its model, its name, or the one listed model whose id or name holds the words.
export function modelOf(listed: readonly Listed[], want: string): string | undefined {
  const w = want.trim().toLowerCase();
  const exact = listed.find((m) => m.id.toLowerCase() === w || m.model.toLowerCase() === w || m.name.toLowerCase() === w);
  if (exact) return exact.id;
  const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]+/g, "-");
  const some = listed.filter((m) => flat(m.id).includes(flat(w)) || flat(m.name).includes(flat(w)));
  return some.length === 1 ? some[0]!.id : undefined;
}

// The rows the answer holds: a JSON array (in a fence or not) of named rows; a model not listed keeps its words,
// marked so. Undefined when the answer is no table.
export function draftRows(text: string, listed: readonly Listed[]): DraftRow[] | undefined {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let v: unknown;
  try { v = JSON.parse(t); } catch { return undefined; }
  if (!Array.isArray(v)) return undefined;
  const out: DraftRow[] = [];
  const seen = new Set<string>();
  for (const r of v.slice(0, 20)) {
    if (!r || typeof r !== "object") continue;
    const name = str((r as any).name), model = str((r as any).model, 200);
    if (!name || !model || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const id = modelOf(listed, model);
    const effort = str((r as any).effort);
    const use = Array.isArray((r as any).use) ? ((r as any).use as unknown[]).map((u) => str(u)).filter((u): u is string => !!u).slice(0, 12) : [];
    out.push({ name, model: id ?? model, ...(effort ? { effort } : {}), ...(use.length ? { use } : {}), words: str((r as any).words, 400) ?? "", listed: !!id });
  }
  return out;
}

// The table the setting takes from rows the owner accepted: the words and marks left out.
export const asTiers = (rows: readonly DraftRow[]): Tier[] => rows.map(({ name, model, effort, use }) => ({ name, model, ...(effort ? { effort } : {}), ...(use?.length ? { use } : {}) }));
