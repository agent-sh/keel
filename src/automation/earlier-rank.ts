// Which earlier agents of a repository a new task is closest to: the task's
// words against theirs (title and task), and the files it names against the
// files they touched. Pure; imports nothing of the daemon, so the read thread
// and the tests load it as it is (src/automation/earlier.ts reads the facts).
//
// The ranking is token overlap weighted by how rare each word is among the
// repository's agents (inverse document frequency, taken from the candidates
// themselves): the lines every brief of a program shares weigh nothing, a
// backlog row's id or a feature's name weighs most. No model request: a small
// model was not better on the sample this was measured on (docs in the commit),
// and this one costs nothing and answers in a millisecond.

export type Doc = { title: string; text: string; files?: readonly string[] };
export type Scored = { index: number; score: number; words: string[]; files: string[] };

// Words every task has and none is about.
const STOP = new Set(("the and for with that this from into onto your you are was were will not but can has had its it's one two per via then than when what which while where who why how all any each both more most other some such only own same too very just also should must may might would could about above after again against before below between during over under until these those their there they them our out off yes no nor an as at be by do if in is of on or so to up we first read follow exactly worktree branch commit commits base main origin repo repository task tasks lane keel scratch daemon daemons").split(" "));

// Backlog rows and branches: "find-m17", "res3-s04". Kept whole, and their parts too.
const ROW = /^[a-z]{2,6}\d?-[ms]?\d+$/;

// A word without its plural or its common endings, so "leftovers" and "leftover" meet.
const stem = (w: string) =>
  w.length > 5 && /(ing|ed)$/.test(w) ? w.replace(/(ing|ed)$/, "")
  : w.length > 5 && /(ch|sh|ss|x)es$/.test(w) ? w.slice(0, -2)
  : w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1)
  : w;

export function words(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9_./-]+/)) {
    if (!raw) continue;
    const w = raw.replace(/^[._/-]+|[._/-]+$/g, "");
    if (ROW.test(w)) out.push(w);
    // A path or a name: its parts, and a file's own name whole.
    for (const part of w.split(/[._/-]+/)) {
      if (part.length < 3 && !/\d/.test(part)) continue;
      const w2 = stem(part);
      if (STOP.has(part) || STOP.has(w2) || /^\d+$/.test(part) || /^[0-9a-f]{7,40}$/.test(part)) continue;
      out.push(w2);
    }
  }
  return out;
}

const TITLE_WEIGHT = 3;
const CHARS = 2_000;

const counts = (d: Doc) => {
  const c = new Map<string, number>();
  for (const w of words(d.title)) c.set(w, (c.get(w) ?? 0) + TITLE_WEIGHT);
  for (const w of words(d.text.slice(0, CHARS))) c.set(w, (c.get(w) ?? 0) + 1);
  return c;
};

// The files a task names: a path with a folder or an extension, as its last part.
export function pathsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.slice(0, CHARS).matchAll(/(?<![\w@/:.])((?:[\w.-]+\/)+[\w.-]+\.[a-z]{1,5}|[\w-]+\.(?:ts|tsx|rs|go|py|css|md|json|sh|kt|sql))(?![\w/])/g)) {
    const p = m[1]!.replace(/^\.\//, "");
    if (!/^(?:https?|node_modules|home|usr|tmp|etc)\//.test(p)) out.add(p);
  }
  return [...out];
}

// The files a task names that an earlier agent touched: the same path, or the same file name.
export function sharedFiles(named: readonly string[], touched: readonly string[]): string[] {
  const names = new Map<string, string>();
  for (const t of touched) names.set(t, t);
  const out: string[] = [];
  for (const p of named) {
    const hit = touched.find((t) => t === p || t.endsWith(`/${p}`) || p.endsWith(`/${t}`) || (!p.includes("/") && t.split("/").pop() === p));
    if (hit) out.push(hit);
  }
  return [...new Set(out)];
}

// A file both name counts as this many rare words. (A path is a sharper sign than a word.)
const FILE_WEIGHT = 2.5;

// Cosine of the two weighted word vectors, plus the files they share. 0..1 for words.
export function rank(query: Doc, docs: readonly Doc[]): Scored[] {
  const all = docs.map(counts);
  const df = new Map<string, number>();
  for (const c of all) for (const w of c.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const n = docs.length;
  // (A word in every agent weighs next to nothing, also where there are only a few agents.)
  const idf = (w: string) => { const d = df.get(w) ?? 0; return Math.log(1 + (n - d + 0.5) / (d + 0.5)); };
  const q = counts(query);
  const vec = (c: Map<string, number>) => { const v = new Map<string, number>(); let norm = 0; for (const [w, tf] of c) { const x = (1 + Math.log(tf)) * idf(w); v.set(w, x); norm += x * x; } return { v, norm: Math.sqrt(norm) || 1 }; };
  const qv = vec(q);
  const named = pathsIn(query.text);
  return docs.map((d, index) => {
    const dv = vec(all[index]!);
    let dot = 0;
    const shared: [string, number][] = [];
    for (const [w, x] of qv.v) { const y = dv.v.get(w); if (y) { dot += x * y; shared.push([w, x * y]); } }
    const files = sharedFiles(named, d.files ?? []);
    const score = dot / (qv.norm * dv.norm) + Math.min(files.length, 3) * FILE_WEIGHT * 0.05;
    return { index, score, words: shared.sort((a, b) => b[1] - a[1]).slice(0, 4).map(([w]) => w), files };
  });
}

// The agents that count as close: over the bar, the best first, at most `max`.
export function closest(query: Doc, docs: readonly Doc[], o: { max?: number; bar?: number } = {}): Scored[] {
  const bar = o.bar ?? BAR;
  return rank(query, docs).filter((s) => s.score >= bar).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, o.max ?? 3);
}

// Set from the measurement (see the commit).
export const BAR = 0.2;
