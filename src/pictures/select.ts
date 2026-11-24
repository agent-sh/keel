// Which specs a change's pictures are taken with. Pure: decided from the paths of the branch's tree, the
// texts of its page files and specs, and the files the change touches.
//
// A spec loads a component when it reaches the component's own marks: a test id the component renders
// (`data-testid="x"`, or a `testid="x"` it hands to a part of its own), which the spec finds with
// `getByTestId("x")` or a `[data-testid="x"]` selector, or the component's name in a picture the spec
// takes (`shoot(page, "work-board-...")` for WorkBoard.tsx). A changed file that renders no mark of its
// own (a hook, a helper, a stylesheet) is reached through the files that import it, the nearest ones
// that render marks; one that no such file imports (the entry, the page's stylesheet) reaches every
// page: the repository's `global` specs are taken for it. Only specs that take pictures count.
// Specs are chosen to cover the changed files with as few as can (the one that covers most of what is left,
// then the one that follows those files most closely), up to `max_specs`; the rest are named as not run.
import type { PicturesConfig } from "./config.ts";

export type Chosen = { path: string; files: string[]; how: ("mark" | "name" | "global")[] };
export type Selection = {
  skip?: string;            // why no run is needed
  page: string[];           // the changed page files (tests left out)
  specs: Chosen[];          // the specs to run, in order
  over: string[];           // specs the change touches past max_specs: not run
  unmatched: string[];      // changed page files no spec reaches
};

const SOURCE = /\.(?:[cm]?[jt]sx?|css)$/;
const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".css", "/index.ts", "/index.tsx", "/index.js"];

// A test file: named as one, or in a folder of tests.
export const isTest = (path: string) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || /(?:^|\/)(?:test|tests|__tests__|e2e)\//.test(path);

const globs = (patterns: readonly string[]) => patterns.map((p) => new Bun.Glob(p));
const inPages = (path: string, pages: readonly string[]) => pages.some((p) => path.startsWith(p));

// The relative modules a file imports, by their paths in the tree.
export function importsOf(path: string, text: string, has: (p: string) => boolean): string[] {
  const out = new Set<string>();
  const re = /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|@import\s+(?:url\()?["']([^"']+)["']/g;
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  for (const m of text.matchAll(re)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec || !spec.startsWith(".")) continue;
    const joined = normalize(dir ? `${dir}/${spec}` : spec);
    if (!joined) continue;
    const hit = has(joined) ? joined : EXTS.map((e) => joined + e).find(has);
    if (hit) out.add(hit);
  }
  return [...out];
}
function normalize(p: string): string | undefined {
  const parts: string[] = [];
  for (const s of p.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") { if (!parts.length) return undefined; parts.pop(); } else parts.push(s);
  }
  return parts.join("/");
}

// The test ids a page file renders.
export function marksOf(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:data-testid|testid|testId)\s*[=:]\s*\{?\s*["'`]([A-Za-z0-9_:.-]+)["'`]/g)) out.add(m[1]!);
  return [...out];
}

// What a spec reaches: the test ids it looks for, and the names of the pictures it takes (their fixed start).
export function specReach(text: string): { marks: Set<string>; shots: string[] } {
  const marks = new Set<string>();
  for (const m of text.matchAll(/getByTestId\(\s*["'`]([^"'`$]+)["'`]/g)) marks.add(m[1]!);
  for (const m of text.matchAll(/data-testid=\\?["']?([A-Za-z0-9_:.-]+)/g)) marks.add(m[1]!);
  const shots = [...text.matchAll(/\bshoot\(\s*[\w.]+\s*,\s*["'`]([^"'`$]*)/g)].map((m) => m[1]!);
  return { marks, shots };
}

// "WorkBoard.tsx" -> "work-board"; "board-order.ts" -> "board-order".
export const kebabOf = (path: string) => path.split("/").pop()!.replace(/\..*$/, "").replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/_/g, "-").toLowerCase();

// A spec named after the file it follows (work-board.spec.ts for WorkBoard.tsx) outweighs one that only finds a few of its marks.
const NAMED = 5;

type Reach = { marks: Set<string>; names: Set<string>; global: boolean };

export function selectSpecs(o: { changed: readonly string[]; paths: readonly string[]; text: (path: string) => string | undefined; config: PicturesConfig }): Selection {
  const { config } = o;
  const specGlobs = globs(config.specs);
  const isSpec = (p: string) => specGlobs.some((g) => g.match(p));
  const touched = o.changed.filter((p) => inPages(p, config.pages));
  const page = touched.filter((p) => !isTest(p) && !isSpec(p));
  if (!page.length) return { skip: o.changed.length && o.changed.every((p) => isTest(p) || isSpec(p)) ? "only tests changed" : "no file of the page changed", page, specs: [], over: [], unmatched: [] };

  const all = new Set(o.paths);
  const sources = o.paths.filter((p) => inPages(p, config.pages) && SOURCE.test(p) && !isTest(p));
  // Who imports whom, and what each renders.
  const importers = new Map<string, string[]>();
  const marks = new Map<string, string[]>();
  for (const f of sources) {
    const t = o.text(f) ?? "";
    marks.set(f, marksOf(t));
    for (const dep of importsOf(f, t, (p) => all.has(p))) importers.set(dep, [...(importers.get(dep) ?? []), f]);
  }

  // Each changed file: its own marks, else the nearest importers' that render marks.
  const reach = new Map<string, Reach>();
  for (const f of page) {
    const r: Reach = { marks: new Set(), names: new Set(), global: false };
    let level = [f];
    const seen = new Set(level);
    while (level.length) {
      const found = level.filter((x) => (marks.get(x) ?? []).length);
      if (found.length) {
        for (const x of found) { for (const m of marks.get(x)!) r.marks.add(m); r.names.add(kebabOf(x)); }
        break;
      }
      const next: string[] = [];
      for (const x of level) for (const up of importers.get(x) ?? []) if (!seen.has(up)) { seen.add(up); next.push(up); }
      level = next;
    }
    if (!r.marks.size) r.global = true;
    else r.names.add(kebabOf(f));
    reach.set(f, r);
  }

  // The specs that take pictures, and the changed files each reaches.
  const specs = o.paths.filter(isSpec).sort();
  // (`weight`: how closely a spec follows a file: the marks of it it looks for, more when it is named after it.)
  const covers = new Map<string, { files: Set<string>; how: Set<Chosen["how"][number]>; weight: number }>();
  const add = (spec: string, file: string, how: Chosen["how"][number], weight: number) => {
    const c = covers.get(spec) ?? { files: new Set(), how: new Set(), weight: 0 };
    c.files.add(file); c.how.add(how); c.weight += weight;
    covers.set(spec, c);
  };
  for (const s of specs) {
    const t = o.text(s);
    if (!t || !/\bshoot\(/.test(t)) continue;
    const sr = specReach(t);
    const own = kebabOf(s).replace(/\.spec$/, "");
    for (const [f, r] of reach) {
      if (r.global) { if (config.global.includes(s)) add(s, f, "global", 1); continue; }
      const named = [...r.names].some((n) => n.length >= 4 && own.includes(n)) ? NAMED : 0;
      const hits = [...r.marks].filter((m) => sr.marks.has(m)).length;
      if (hits) add(s, f, "mark", hits + named);
      else if ([...r.names].some((n) => n.length >= 4 && sr.shots.some((x) => x.includes(n)))) add(s, f, "name", 1 + named);
    }
  }

  // As few specs as cover the changed files (the one covering most of what is left, then by name), then the
  // rest by how many files each covers.
  const order: string[] = [];
  const left = new Set(page.filter((f) => [...covers.values()].some((c) => c.files.has(f))));
  const pool = new Set(covers.keys());
  while (left.size && pool.size) {
    let best: string | undefined, n = 0, w = 0;
    for (const s of pool) {
      const c = covers.get(s)!;
      const k = [...c.files].filter((f) => left.has(f)).length;
      if (k > n || (k === n && k > 0 && c.weight > w)) { best = s; n = k; w = c.weight; }
    }
    if (!best) break;
    order.push(best); pool.delete(best);
    for (const f of covers.get(best)!.files) left.delete(f);
  }
  // (Only the cover is run: a spec that reaches no file the cover leaves out takes the same view again, at the
  // cost of a whole spec on each side. The others are named.)
  const rest = [...pool].sort((a, b) => covers.get(b)!.files.size - covers.get(a)!.files.size || covers.get(b)!.weight - covers.get(a)!.weight || (a < b ? -1 : 1));
  const cap = config.max_specs ?? order.length;
  const chosen = order.slice(0, cap).map((path) => ({ path, files: [...covers.get(path)!.files].sort(), how: [...covers.get(path)!.how].sort() }));
  const unmatched = page.filter((f) => !covers.size || ![...covers.values()].some((c) => c.files.has(f)));
  return { page, specs: chosen, over: [...order.slice(cap), ...rest], unmatched };
}
