// A plan of lanes, the pure part: the files each lane of a plan will touch, the pairs of lanes that
// meet in a file, the order (or the merge) that keeps them apart, and what a lane changed that the plan
// gave another. The part that reads the repository, keeps the plan and starts its agents is
// src/automation/lane-plans.ts.
//
// A lane's files are the files and folders it declares, else the ones its brief names, resolved
// against the repository's tree (a path as it is, a file name by the paths that end with it), and
// the files that import a named one (an importer is where a change of a module's shape lands next).
// A name the tree does not hold, in a folder it holds, is a file the lane will make.
//
// Two lanes meet in a file both name (declare, name or make). A hub file (src/landing/pairs.ts
// hubsOf: one much of the repository's work touches, or many files import) counts the same here: the
// pair checks relate two branches in a hub only where both change lines near each other, which a
// plan cannot know before the work, and two lanes that both say they edit the agents module are the
// collision a plan is for. A file one lane names and the other only reaches as an importer is a
// near meeting: said, and ordered by nothing.
import { dirname } from "node:path";
import type { Graph } from "./pairs.ts";

export type LaneSpec = { title: string; brief: string; files?: readonly string[] };
// declared: the plan said the lane touches it. named: its brief names it. new: its brief names a file
// the tree does not hold yet, in a folder it holds. importer: it imports a declared or named file.
export type How = "declared" | "named" | "new" | "importer";
// A folder ends with "/" and holds every file under it.
export type LaneFile = { path: string; how: How; via?: string };
export type Prediction = { files: LaneFile[]; unresolved: string[] };
export type RepoMap = { known: ReadonlySet<string>; g: Graph; hubs: ReadonlySet<string> };

// A bare file name is taken when this many paths of the tree or fewer end with it: past that the name
// says too little (index.ts) to give a lane every one of them.
export const AMBIGUOUS = 3;
// A named file's importers are its lane's when it has this many or fewer: past that it is a hub by its
// importers (pairs.ts HUB_MIN_IMPORTERS is the repository-wide floor), and every lane would reach them.
export const IMPORTERS_MAX = 8;
// A brief is read this far for names. A coordinator's brief names its files near the top; a long one
// quotes logs and reports past this.
export const BRIEF_CHARS = 12_000;

const EXT = "ts|tsx|mts|cts|js|jsx|mjs|cjs|rs|go|py|css|md|json|jsonl|sh|kt|swift|sql|toml|yaml|yml|html|txt|tsv|c|h|cc|cpp|hpp|java|rb|lua";
const PATH = new RegExp(String.raw`(?<![\w@/:.~$-])((?:[\w.-]+/)+(?:[\w.-]+\.(?:${EXT})|[\w.-]+/)|[\w-][\w.-]*\.(?:${EXT}))(?![\w/-])`, "g");
const FOREIGN = /^(?:https?|node_modules|home|usr|tmp|etc|var|proc|dev)\//;

// The paths a brief names: a path with a folder (a file, or a folder ending with "/"), or a bare file
// name with a known extension. `roots`: absolute folders of the repository, taken off a path that
// starts with one.
export function namesIn(text: string, roots: readonly string[] = []): string[] {
  let t = text.slice(0, BRIEF_CHARS);
  for (const r of roots) if (r) t = t.split(r.endsWith("/") ? r : `${r}/`).join(" ");
  const out = new Set<string>();
  for (const m of t.matchAll(PATH)) {
    const p = m[1]!.replace(/^\.\//, "");
    if (FOREIGN.test(p) || p.startsWith("../") || p.includes("/../")) continue;
    // (A sentence's last word: "see AGENTS.md." matches AGENTS.md already; a version "1.2.3" has no extension.)
    out.add(p);
  }
  return [...out];
}

// What one name is in the tree: the files (or a folder) it names, a file to make, or nothing.
export function resolve(name: string, known: ReadonlySet<string>): { paths: string[]; how: "found" | "new" } | undefined {
  const n = name.replace(/^\.\//, "");
  if (n.endsWith("/")) {
    for (const f of known) if (f.startsWith(n)) return { paths: [n], how: "found" };
    return undefined;
  }
  if (known.has(n)) return { paths: [n], how: "found" };
  // A folder named without its slash.
  for (const f of known) if (f.startsWith(`${n}/`)) return { paths: [`${n}/`], how: "found" };
  const tail = `/${n}`;
  const hits: string[] = [];
  for (const f of known) if (f.endsWith(tail)) { hits.push(f); if (hits.length > AMBIGUOUS) break; }
  if (hits.length && hits.length <= AMBIGUOUS) return { paths: hits.sort(), how: "found" };
  if (hits.length) return undefined;
  // A file to make: its folder is in the tree.
  if (n.includes("/")) {
    const dir = `${dirname(n)}/`;
    for (const f of known) if (f.startsWith(dir)) return { paths: [n], how: "new" };
  }
  return undefined;
}

// Who imports each file of the graph.
export function importersOf(g: Graph): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [a, ts] of g) for (const t of ts) (out.get(t) ?? out.set(t, new Set()).get(t)!).add(a);
  return out;
}

// A lane's files: what it declares (each resolved; one the tree lacks is kept as declared), what its
// brief names, and the importers of each declared or named file that is no hub.
export function predict(lane: LaneSpec, map: RepoMap, o: { roots?: readonly string[]; importers?: ReadonlyMap<string, ReadonlySet<string>> } = {}): Prediction {
  const files = new Map<string, LaneFile>();
  const unresolved: string[] = [];
  const add = (f: LaneFile) => { const had = files.get(f.path); if (!had || rank[f.how] < rank[had.how]) files.set(f.path, f); };
  for (const d of lane.files ?? []) {
    const r = resolve(d.trim(), map.known);
    if (r) for (const p of r.paths) add({ path: p, how: "declared" });
    else if (d.trim()) add({ path: d.trim().replace(/^\.\//, ""), how: "declared" });
  }
  for (const n of namesIn(`${lane.title}\n${lane.brief}`, o.roots)) {
    const r = resolve(n, map.known);
    if (!r) { unresolved.push(n); continue; }
    for (const p of r.paths) add({ path: p, how: r.how === "new" ? "new" : "named" });
  }
  const imp = o.importers ?? importersOf(map.g);
  for (const f of [...files.values()]) {
    if (f.how === "importer" || f.path.endsWith("/") || map.hubs.has(f.path)) continue;
    const by = imp.get(f.path);
    if (!by || by.size > IMPORTERS_MAX) continue;
    for (const p of [...by].sort()) add({ path: p, how: "importer", via: f.path });
  }
  return { files: [...files.values()].sort((a, b) => rank[a.how] - rank[b.how] || (a.path < b.path ? -1 : 1)), unresolved };
}
const rank: Record<How, number> = { declared: 0, named: 1, new: 2, importer: 3 };
const strong = (f: LaneFile) => f.how !== "importer";

// Whether two of a lane's paths are one file: the same path, or a file under a folder the other is.
const covers = (a: string, b: string) => a === b || (a.endsWith("/") && b.startsWith(a)) || (b.endsWith("/") && a.startsWith(b));

// file: both name a file that is no hub. hub: both name a hub file. near: one names a file the other
// reaches only as an importer of what it names.
export type MeetKind = "file" | "hub" | "near";
export type Meeting = { a: number; b: number; kind: MeetKind; files: string[] };

// The pairs of lanes that meet, the strongest kind first, each pair once with every file it meets in.
export function meetings(lanes: readonly Pick<Prediction, "files">[], hubs: ReadonlySet<string>): Meeting[] {
  const out: Meeting[] = [];
  for (let i = 0; i < lanes.length; i++) for (let j = i + 1; j < lanes.length; j++) {
    const by: Record<MeetKind, Set<string>> = { file: new Set(), hub: new Set(), near: new Set() };
    for (const x of lanes[i]!.files) for (const y of lanes[j]!.files) {
      if (!covers(x.path, y.path)) continue;
      const at = x.path.length >= y.path.length ? x.path : y.path; // the narrower of the two
      if (strong(x) && strong(y)) by[hubs.has(at) ? "hub" : "file"].add(at);
      else if (strong(x) || strong(y)) by.near.add(at);
    }
    const kind: MeetKind | undefined = by.file.size ? "file" : by.hub.size ? "hub" : by.near.size ? "near" : undefined;
    if (!kind) continue;
    const files = [...by.file, ...by.hub, ...(kind === "near" ? by.near : [])];
    out.push({ a: i, b: j, kind, files: [...new Set(files)].sort() });
  }
  const r: Record<MeetKind, number> = { file: 0, hub: 1, near: 2 };
  return out.sort((x, y) => r[x.kind] - r[y.kind] || x.a - y.a || x.b - y.b);
}

// Two lanes are proposed as one when they meet in a file and the files they share are at least
// MERGE_SHARE of the named files of the smaller: most of one's work is in the other's files, so in
// order the second would mostly redo the first's ground, and side by side they would collide in most
// of it. A merged unit holds at most MERGE_MAX lanes: past that it is not a lane but the plan.
export const MERGE_SHARE = 0.5;
export const MERGE_MAX = 3;

// The proposal: units (one lane, or lanes proposed as one) in waves. A unit of wave 0 starts at
// once; a later one starts when each unit it waits on (`after`: one it meets, in an earlier wave) is
// done. Lanes that meet only near each other run side by side.
export type Unit = { lanes: number[]; wave: number; after: number[]; why?: string };
export type Proposal = { units: Unit[]; waves: number };

export function propose(lanes: readonly Pick<Prediction, "files">[], ms: readonly Meeting[]): Proposal {
  const n = lanes.length;
  const named = lanes.map((l) => l.files.filter(strong).length);
  // Union of lanes proposed as one.
  const group = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i]!)));
  const size = (r: number) => group.filter((_, i) => find(i) === r).length;
  for (const m of ms) {
    if (m.kind !== "file") continue;
    const small = Math.min(named[m.a]!, named[m.b]!);
    if (!small || m.files.length / small < MERGE_SHARE) continue;
    const ra = find(m.a), rb = find(m.b);
    if (ra === rb || size(ra) + size(rb) > MERGE_MAX) continue;
    group[Math.max(ra, rb)] = Math.min(ra, rb);
  }
  const roots = [...new Set(Array.from({ length: n }, (_, i) => find(i)))].sort((a, b) => a - b);
  const unitOf = new Map(roots.map((r, k) => [r, k]));
  const units: Unit[] = roots.map((r) => ({ lanes: Array.from({ length: n }, (_, i) => i).filter((i) => find(i) === r), wave: 0, after: [] }));
  for (const u of units) if (u.lanes.length > 1) {
    const shared = ms.filter((m) => m.kind === "file" && u.lanes.includes(m.a) && u.lanes.includes(m.b)).flatMap((m) => m.files);
    u.why = `they share ${listOf([...new Set(shared)])}`;
  }
  // Edges between units: a file or hub meeting.
  const edges = new Map<number, Set<number>>();
  for (const m of ms) {
    if (m.kind === "near") continue;
    const x = unitOf.get(find(m.a))!, y = unitOf.get(find(m.b))!;
    if (x === y) continue;
    (edges.get(x) ?? edges.set(x, new Set()).get(x)!).add(y);
    (edges.get(y) ?? edges.set(y, new Set()).get(y)!).add(x);
  }
  // Waves by a greedy colouring, the unit with the most meetings first (it waits for none, so the
  // fewest lanes wait), then in the plan's order.
  const order = units.map((_, k) => k).sort((a, b) => (edges.get(b)?.size ?? 0) - (edges.get(a)?.size ?? 0) || a - b);
  const wave = new Map<number, number>();
  for (const k of order) {
    const taken = new Set([...(edges.get(k) ?? [])].map((x) => wave.get(x)).filter((w): w is number => w !== undefined));
    let w = 0;
    while (taken.has(w)) w++;
    wave.set(k, w);
  }
  for (const [k, u] of units.entries()) {
    u.wave = wave.get(k)!;
    u.after = [...(edges.get(k) ?? [])].filter((x) => wave.get(x)! < u.wave).sort((a, b) => a - b);
  }
  return { units, waves: Math.max(0, ...units.map((u) => u.wave)) + 1 };
}

// What a lane changed that the plan gave another lane and not it: each such file with the lanes it is
// theirs. `told`: files it was told of already (each is told once).
export function strays(own: readonly LaneFile[], changed: readonly string[], others: readonly { lane: string; files: readonly LaneFile[] }[], told: ReadonlySet<string> = new Set()): { file: string; lanes: string[] }[] {
  const out: { file: string; lanes: string[] }[] = [];
  for (const c of changed) {
    if (told.has(c) || own.some((f) => covers(f.path, c))) continue;
    const lanes = others.filter((o) => o.files.some((f) => strong(f) && covers(f.path, c))).map((o) => o.lane);
    if (lanes.length) out.push({ file: c, lanes });
  }
  return out;
}

// How a lane's actual changes compare with its plan: the planned files it changed, the planned ones
// it did not, and the changes no lane planned.
export function compare(own: readonly LaneFile[], changed: readonly string[]): { hit: string[]; missed: string[]; unplanned: string[] } {
  const hit = changed.filter((c) => own.some((f) => covers(f.path, c)));
  const missed = own.filter((f) => strong(f) && !changed.some((c) => covers(f.path, c))).map((f) => f.path);
  const unplanned = changed.filter((c) => !own.some((f) => covers(f.path, c)));
  return { hit, missed, unplanned };
}

export const listOf = (xs: readonly string[], n = 4) => (xs.length > n ? `${xs.slice(0, n).join(", ")} and ${xs.length - n} more` : xs.join(", "));
