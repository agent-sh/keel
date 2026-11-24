// What of a pictures run is still to do, read from its row (src/pictures/run.ts). Pure. Each side's result is
// kept in the row as it ends, with its pictures on disk: a run a restart cut goes on at the side it was on.
export type SideName = "before" | "after" | "again";
export type SideState = "waiting" | "running" | "done" | "failed" | "none";
// One side's run: its commit, the command's exit, its wall and processor time, how many pictures it took, and
// for the second run of the base the specs it ran (those whose pictures differ).
export type Side = { state: SideState; commit: string | null; exit?: number | null; ms?: number | null; cpu_ms?: number | null; shots?: number; why?: string; note?: string; specs?: string[] };
export type Sides = { before: Side; after: Side; again?: Side };

// A side that ended keeps its result: one that failed is not run again, one that took pictures is not either
// while they are on disk. A side that was waiting or running when the daemon stopped, or whose pictures are
// gone, is owed.
export const finished = (s: Side | undefined, pictures: number): boolean => !!s && (s.state === "failed" || (s.state === "done" && pictures > 0));

// The sides a cut run still owes, in their order (the base again only when it was asked for).
export function owedSides(sides: Sides, pictures: (s: SideName) => number): SideName[] {
  const owed: SideName[] = [];
  for (const s of ["before", "after"] as const) if (!finished(sides[s], pictures(s))) owed.push(s);
  if (sides.again && !finished(sides.again, pictures("again"))) owed.push("again");
  return owed;
}

// The sides as a restart finds them: what ended is kept, the rest waits for its turn again.
export function resumed(sides: Sides, pictures: (s: SideName) => number): Sides {
  const owed = new Set(owedSides(sides, pictures));
  const wait = (s: Side): Side => ({ state: "waiting", commit: s.commit, ...(s.specs ? { specs: s.specs } : {}) });
  return {
    before: owed.has("before") ? wait(sides.before) : sides.before,
    after: owed.has("after") ? wait(sides.after) : sides.after,
    ...(sides.again ? { again: owed.has("again") ? wait(sides.again) : sides.again } : {}),
  };
}

// The specs the base is taken again with: those that took a picture that differs. `tookBy` names the spec of a
// picture from the side's list (shots.tsv); a picture no list names runs every spec of the run again.
export function againSpecs(differ: readonly string[], tookBy: ReadonlyMap<string, string>, all: readonly string[]): string[] {
  const specs = new Set<string>();
  for (const name of differ) {
    const s = tookBy.get(name);
    if (!s || !all.includes(s)) return [...all];
    specs.add(s);
  }
  return all.filter((s) => specs.has(s));
}

// A side's list of which spec took which picture: "<file>\t<spec>" lines.
export function readTookBy(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const [file, spec] = line.split("\t");
    if (file && spec) out.set(file.trim(), spec.trim());
  }
  return out;
}
