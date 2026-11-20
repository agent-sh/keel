// The helper's memory as keyed records: one fact per record, found by its
// stable key in one hash lookup, by an alias, by a topic or by a key prefix.
// A lookup returns keys with one-line previews first, so the model asks for
// the values it needs; the per-turn recall sends only records the turn names
// (by key or alias), then the few standing ones, within a budget.
//
// Everything here is plain data in, plain data out (records.test.ts); the
// SQLite table behind it is src/helper/memory.ts.

export type MemoryKind = "preference" | "decision" | "person" | "commitment" | "fact" | "reference";
export const MEMORY_KINDS: MemoryKind[] = ["preference", "decision", "person", "commitment", "fact", "reference"];
export type MemorySource = "helper" | "owner" | "import";
export type MemoryRecord = {
  key: string;
  value: string;
  kind: MemoryKind;
  aliases: string[];
  topics: string[];
  source: MemorySource;
  ts: number;
  updated: number;
  used: number;
};

// A record holds one fact: a short value, a handful of aliases and topics.
export const VALUE_CHARS = 500;
export const KEY_CHARS = 120;
export const MAX_TERMS = 12;
// Lookups are bounded: the model narrows the query or asks for more.
export const FIND_LIMIT = 20;
export const PREVIEW_CHARS = 90;

const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();

// A key: lower case, words joined by dashes, namespaces by dots
// ("mail.label.label_23", "person.dana-levi"). Letters of any script stay.
export function normKey(s: unknown): string {
  return fold(String(s ?? "").trim())
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}._:@/+-]+/gu, "")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/^[.\-/]+|[.\-/]+$/g, "")
    .slice(0, KEY_CHARS);
}

// An alias or topic: folded, single spaces, no edge punctuation.
export function normTerm(s: unknown): string {
  return fold(String(s ?? ""))
    .replace(/\s+/g, " ")
    .replace(/^[\s"'`.,;:!?()[\]{}<>]+|[\s"'`.,;:!?()[\]{}<>]+$/g, "")
    .slice(0, 80);
}

export const terms = (list: unknown): string[] => {
  const arr = Array.isArray(list) ? list : typeof list === "string" ? list.split(",") : [];
  return [...new Set(arr.map(normTerm).filter(Boolean))].slice(0, MAX_TERMS);
};

// The namespaces above a key: "mail.label.x" is under "mail" and "mail.label".
export function namespaces(key: string): string[] {
  const parts = key.split(".");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("."));
  return out;
}

// The key's last segment is an alias of its own ("person.dana" is found by
// "dana", "pref.short-replies" by "short replies").
export function ownAliases(key: string): string[] {
  const last = key.split(".").at(-1) ?? "";
  return [...new Set([last, last.replace(/[-_]+/g, " ")].map(normTerm).filter(Boolean))];
}

const add = (m: Map<string, Set<string>>, k: string, v: string) => {
  let s = m.get(k);
  if (!s) m.set(k, (s = new Set()));
  s.add(v);
};
const del = (m: Map<string, Set<string>>, k: string, v: string) => {
  const s = m.get(k);
  if (!s) return;
  s.delete(v);
  if (!s.size) m.delete(k);
};

export type Hit = { key: string; preview: string; via: "key" | "alias" | "topic" | "prefix" | "words" };
export type Found = { hits: Hit[]; total: number; topics: { topic: string; count: number }[] };

export const preview = (r: MemoryRecord) => {
  const v = r.value.replace(/\s+/g, " ");
  return v.length > PREVIEW_CHARS ? `${v.slice(0, PREVIEW_CHARS - 1)}…` : v;
};

// The index: every lookup is a hash lookup, except the word search that
// find falls back to when nothing names a record exactly.
export class RecordIndex {
  readonly byKey = new Map<string, MemoryRecord>();
  private alias = new Map<string, Set<string>>();
  private topic = new Map<string, Set<string>>();
  private space = new Map<string, Set<string>>();

  constructor(list: MemoryRecord[] = []) {
    for (const r of list) this.set(r);
  }
  get size() {
    return this.byKey.size;
  }
  all(): MemoryRecord[] {
    return [...this.byKey.values()];
  }
  get(key: string): MemoryRecord | undefined {
    return this.byKey.get(normKey(key));
  }

  set(r: MemoryRecord) {
    this.remove(r.key);
    this.byKey.set(r.key, r);
    for (const a of [...r.aliases, ...ownAliases(r.key)]) add(this.alias, a, r.key);
    for (const t of r.topics) add(this.topic, t, r.key);
    for (const n of namespaces(r.key)) add(this.space, n, r.key);
  }
  remove(key: string): MemoryRecord | undefined {
    const r = this.byKey.get(key);
    if (!r) return undefined;
    this.byKey.delete(key);
    for (const a of [...r.aliases, ...ownAliases(r.key)]) del(this.alias, a, key);
    for (const t of r.topics) del(this.topic, t, key);
    for (const n of namespaces(key)) del(this.space, n, key);
    return r;
  }

  byAlias(term: string): string[] {
    return [...(this.alias.get(normTerm(term)) ?? [])];
  }
  byTopic(term: string): string[] {
    return [...(this.topic.get(normTerm(term)) ?? [])];
  }
  // Keys under a namespace ("mail.label" or "mail.label."), else keys that
  // start with the text.
  byPrefix(p: string): string[] {
    const k = normKey(p);
    if (!k) return [];
    const under = this.space.get(k);
    if (under) return [...under];
    return [...this.byKey.keys()].filter((x) => x.startsWith(k));
  }

  // A key, or the one record an alias names.
  resolve(ref: string): { record?: MemoryRecord; candidates: string[] } {
    const exact = this.get(ref);
    if (exact) return { record: exact, candidates: [] };
    const al = this.byAlias(ref);
    if (al.length === 1) return { record: this.byKey.get(al[0]!), candidates: [] };
    return { candidates: al.length ? al : this.byPrefix(ref).slice(0, 5) };
  }

  topicCounts(keys?: Iterable<string>): { topic: string; count: number }[] {
    const pick = keys ? new Set(keys) : null;
    const out: { topic: string; count: number }[] = [];
    for (const [t, s] of this.topic) {
      const n = pick ? [...s].filter((k) => pick.has(k)).length : s.size;
      if (n) out.push({ topic: t, count: n });
    }
    return out.sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic));
  }

  // The index of the index: namespaces (a key's first one or two parts) and
  // topics, with how many records each holds.
  overview(max = 30): { spaces: { space: string; count: number }[]; topics: { topic: string; count: number }[] } {
    // Each key's first part, and the next level down where it holds several records.
    const n = new Map<string, number>();
    for (const k of this.byKey.keys()) {
      const parts = k.split(".");
      const top = parts.length > 1 ? parts[0]! : "(no namespace)";
      n.set(top, (n.get(top) ?? 0) + 1);
      if (parts.length > 2) { const sub = parts.slice(0, 2).join("."); n.set(sub, (n.get(sub) ?? 0) + 1); }
    }
    const spaces = [...n].filter(([sp, count]) => !sp.includes(".") || (count >= 3 && count < (n.get(sp.split(".")[0]!) ?? 0)))
      .map(([space, count]) => ({ space, count })).sort((a, b) => a.space.localeCompare(b.space)).slice(0, max);
    return { spaces, topics: this.topicCounts().slice(0, max) };
  }

  // Exact key, then alias, topic and key prefix, then a word search over
  // keys, aliases, topics and values. Keys with previews, at most `limit`.
  find(query: string, limit = FIND_LIMIT): Found {
    const q = query.trim();
    const seen = new Map<string, Hit["via"]>();
    const put = (keys: string[], via: Hit["via"]) => { for (const k of keys) if (!seen.has(k)) seen.set(k, via); };
    if (q) {
      const exact = this.get(q);
      if (exact) put([exact.key], "key");
      put(this.byAlias(q), "alias");
      put(this.byTopic(q), "topic");
      put(this.byPrefix(q), "prefix");
      if (!seen.size) {
        const want = [...wordSet(q)];
        if (want.length) {
          const scored: { key: string; n: number; u: number }[] = [];
          for (const r of this.byKey.values()) {
            const have = wordSet(`${r.key.replace(/[._-]+/g, " ")} ${r.aliases.join(" ")} ${r.topics.join(" ")} ${r.value}`);
            const n = want.filter((w) => have.has(w)).length;
            if (n) scored.push({ key: r.key, n, u: r.updated });
          }
          const best = Math.max(0, ...scored.map((s) => s.n));
          // Every word when some record has them all; else the best partial matches.
          scored.filter((s) => s.n === best || (best < want.length && s.n >= Math.max(1, best - 1))).sort((a, b) => b.n - a.n || b.u - a.u).forEach((s) => put([s.key], "words"));
        }
      }
    } else {
      put([...this.byKey.values()].sort((a, b) => b.updated - a.updated).map((r) => r.key), "prefix");
    }
    const keys = [...seen.keys()];
    const hits = keys.slice(0, limit).map((k) => ({ key: k, preview: preview(this.byKey.get(k)!), via: seen.get(k)! }));
    return { hits, total: keys.length, topics: this.topicCounts(keys).slice(0, 8) };
  }

  // What a turn recalls: records whose key or alias the text names, then
  // (for records that are not imported reference data) those sharing words
  // with it, then standing preferences and commitments; never one already
  // seen since the last summary; within `budget` characters. Topics and
  // namespaces the text names come back as one-line hints (how many records,
  // how to look them up), never as their values.
  recall(text: string, seen: Set<string>, budget: number): { records: MemoryRecord[]; hints: string[] } {
    const named: string[] = [];
    const hintKeys = new Map<string, number>();
    for (const c of candidates(text)) {
      const k = normKey(c);
      if (this.byKey.has(k)) named.push(k);
      for (const x of this.byAlias(c)) named.push(x);
      const t = this.topic.get(normTerm(c));
      if (t && t.size > 1) hintKeys.set(`topic "${normTerm(c)}"`, t.size);
      const sp = this.space.get(k);
      if (sp && sp.size > 1) hintKeys.set(`keys ${k}.*`, sp.size);
    }
    const q = wordSet(text);
    const scored: { r: MemoryRecord; rank: number; hits: number }[] = [];
    const named1 = [...new Set(named)];
    for (const r of this.byKey.values()) {
      if (seen.has(r.key)) continue;
      const at = named1.indexOf(r.key);
      if (at >= 0) { scored.push({ r, rank: 3, hits: named1.length - at }); continue; }
      if (r.kind === "reference") continue;
      let hits = 0;
      for (const w of wordSet(`${r.value} ${r.aliases.join(" ")} ${r.key.replace(/[._-]+/g, " ")}`)) if (q.has(w)) hits++;
      if (hits) scored.push({ r, rank: 2, hits });
      else if (r.kind === "preference" || r.kind === "commitment") scored.push({ r, rank: 1, hits: 0 });
    }
    scored.sort((a, b) => b.rank - a.rank || b.hits - a.hits || b.r.updated - a.r.updated);
    const records: MemoryRecord[] = [];
    let used = 0;
    for (const { r } of scored) {
      const n = recallLine(r).length + 1;
      if (used + n > budget) continue;
      records.push(r);
      used += n;
    }
    const hints = [...hintKeys].slice(0, 3).map(([what, n]) => `${what}: ${n} records (helper__memory_find)`);
    return { records, hints };
  }
}

export const recallLine = (r: MemoryRecord) => `- ${r.key}${r.kind === "fact" || r.kind === "reference" ? "" : ` (${r.kind})`}: ${r.value}`;

const STOP = new Set("the and for are but not you your with that this from have has was were will what when where which who how about into over than then them they their there these those its our out off can could would should just also very more most some any all each".split(" "));
export const wordSet = (s: string) => new Set(fold(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w)));

// The pieces of a text that could name a key or alias: each token as
// written (ids keep their dots, slashes and underscores), and runs of up to
// four words (multi-word aliases such as "tax office").
export function candidates(text: string): Set<string> {
  const out = new Set<string>();
  const raw = text.split(/[\s,;()[\]{}<>"'`|]+/).map((t) => t.replace(/^[.:!?]+|[.:!?]+$/g, "")).filter((t) => t.length >= 2);
  for (const t of raw) out.add(t);
  const w = fold(text).split(/[^\p{L}\p{N}_@]+/u).filter(Boolean);
  for (let i = 0; i < w.length; i++) {
    for (let n = 1; n <= 4 && i + n <= w.length; n++) {
      const g = w.slice(i, i + n).join(" ");
      if (g.length >= 2) out.add(g);
    }
  }
  return out;
}

// A key for an item written without one: its kind and its first words
// ("preference.short-replies-no-hedging").
export function keyFor(kind: string, value: string, taken: (k: string) => boolean): string {
  const slug = [...wordSet(value)].slice(0, 4).join("-").slice(0, 48) || "item";
  const base = normKey(`${kind}.${slug}`);
  let k = base;
  for (let i = 2; taken(k); i++) k = `${base}-${i}`;
  return k;
}

// --- import ------------------------------------------------------------------

// The arrays of objects in a parsed JSON document, by dotted path ("" is the
// root), with their length and the fields of the first item flattened to
// dotted paths ("names.0.displayName"): what a caller needs to write the
// import's templates without reading the file.
export type Shape = { path: string; count: number; fields: string[]; sample: Record<string, unknown> };
const FIELDS = 30;

function flat(v: unknown, prefix: string, out: Record<string, unknown>, depth: number) {
  if (Object.keys(out).length >= FIELDS) return;
  if (v && typeof v === "object" && depth < 4) {
    const entries = Array.isArray(v) ? v.slice(0, 2).map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
    for (const [k, x] of entries) flat(x, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    return;
  }
  out[prefix] = typeof v === "string" ? v.slice(0, 60) : v && typeof v === "object" ? "{...}" : v;
}

export function shapes(doc: unknown, max = 8): Shape[] {
  const out: Shape[] = [];
  const shape = (path: string, count: number, first: Record<string, unknown>): Shape => {
    const sample: Record<string, unknown> = {};
    flat(first, "", sample, 0);
    return { path, count, fields: Object.keys(sample), sample };
  };
  const walk = (v: unknown, path: string, depth: number) => {
    if (out.length >= max || depth > 4) return;
    if (Array.isArray(v)) {
      const first = v.find((x) => x && typeof x === "object" && !Array.isArray(x)) as Record<string, unknown> | undefined;
      if (first) out.push(shape(path, v.length, first));
      return;
    }
    if (v && typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>);
      // An object of objects keyed by id is a list too ({ "Label_1": {...} }).
      const objs = entries.filter(([, x]) => x && typeof x === "object" && !Array.isArray(x));
      if (entries.length >= 3 && objs.length === entries.length) {
        const [k0, x0] = objs[0]!;
        out.push(shape(path ? `${path}.*` : "*", entries.length, { $key: k0, ...(x0 as object) }));
        return;
      }
      for (const [k, x] of entries) walk(x, path ? `${path}.${k}` : k, depth + 1);
    }
  };
  walk(doc, "", 0);
  return out;
}

// The items at a path: an array, or an object's values when the path ends
// in "*" (each gets its own key as "$key").
export function itemsAt(doc: unknown, path: string): Record<string, unknown>[] | null {
  const parts = path ? path.split(".") : [];
  let v: unknown = doc;
  const star = parts.at(-1) === "*";
  for (const p of star ? parts.slice(0, -1) : parts) {
    if (!v || typeof v !== "object") return null;
    v = (v as Record<string, unknown>)[p];
  }
  if (star) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    return Object.entries(v as Record<string, unknown>).filter(([, x]) => x && typeof x === "object").map(([k, x]) => ({ $key: k, ...(x as object) }));
  }
  return Array.isArray(v) ? v.filter((x) => x && typeof x === "object") as Record<string, unknown>[] : null;
}

// "mail.label.{id}" with an item's fields; dotted paths reach nested ones
// ("{names.0.displayName}"). Strict (a key): undefined when a field is
// missing. Otherwise a missing field is left out with the separator before
// it, and undefined only when nothing is left.
export function fill(template: string, item: Record<string, unknown>, strict = true): string | undefined {
  let missing = false;
  const s = template.replace(/\{([^{}]+)\}/g, (_, f: string) => {
    let v: unknown = item;
    for (const p of f.trim().split(".")) v = v && typeof v === "object" ? (v as Record<string, unknown>)[p] : undefined;
    if (v === undefined || v === null || v === "") { missing = true; return "\u0000"; }
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  });
  if (strict) return missing ? undefined : s;
  const out = s
    .replace(/[\s,;:|/-]*(?:\bat\s+)?\u0000/g, "")
    .replace(/^[\s,;:|/-]+|[\s,;:|/(-]+$/g, "")
    .replace(/\(\s*\)/g, "")
    .trim();
  return /[\p{L}\p{N}]/u.test(out) ? out : undefined;
}
