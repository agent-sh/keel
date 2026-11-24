import { describe, expect, test } from "bun:test";
import { compare, meetings, namesIn, predict, propose, resolve, strays, type LaneFile, type RepoMap } from "./lanes.ts";
import type { Graph } from "./pairs.ts";

const known = new Set(["src/a/agents.ts", "src/a/tools.ts", "src/b/tools.ts", "src/c/tools.ts", "src/d/tools.ts", "src/x.ts", "src/y.ts", "src/z.ts", "src/x.test.ts", "AGENTS.md", "ui/src/styles.css", "test/e2e/one.spec.ts"]);
const g: Graph = new Map([["src/y.ts", new Set(["src/x.ts"])], ["src/x.test.ts", new Set(["src/x.ts"])], ["src/z.ts", new Set(["src/a/agents.ts"])]]);
const map: RepoMap = { known, g, hubs: new Set(["src/a/agents.ts", "AGENTS.md"]) };
const lane = (brief: string, files?: string[]) => ({ title: "t", brief, files });
const paths = (fs: readonly LaneFile[]) => fs.map((f) => `${f.how}:${f.path}`);

describe("the files a lane will touch", () => {
  test("a brief's names: paths, folders and file names, not URLs, home paths or the repository's absolute paths", () => {
    expect(namesIn("Edit src/x.ts and `ui/src/styles.css`; see AGENTS.md. Not https://h.io/a/b.ts, ~/.cache/w/BRIEF.md or /etc/x/y.ts. The tests in test/e2e/ and /r/src/y.ts.", ["/r"])).toEqual(["src/x.ts", "ui/src/styles.css", "AGENTS.md", "test/e2e/", "src/y.ts"]);
  });
  test("a name is resolved against the tree: a path, a folder, a file name, a file to make", () => {
    expect(resolve("src/x.ts", known)).toEqual({ paths: ["src/x.ts"], how: "found" });
    expect(resolve("src/a", known)).toEqual({ paths: ["src/a/"], how: "found" });
    expect(resolve("agents.ts", known)).toEqual({ paths: ["src/a/agents.ts"], how: "found" });
    // Four files end with tools.ts: the name says too little.
    expect(resolve("tools.ts", known)).toBeUndefined();
    expect(resolve("a/tools.ts", known)).toEqual({ paths: ["src/a/tools.ts"], how: "found" });
    expect(resolve("src/new.ts", known)).toEqual({ paths: ["src/new.ts"], how: "new" });
    expect(resolve("nowhere/new.ts", known)).toBeUndefined();
  });
  test("a prediction: declared, named, made, and the importers of what is no hub", () => {
    const p = predict(lane("Change src/x.ts and agents.ts, add src/w.ts; tools.ts too."), map);
    expect(paths(p.files)).toEqual(["named:src/a/agents.ts", "named:src/x.ts", "new:src/w.ts", "importer:src/x.test.ts", "importer:src/y.ts"]);
    expect(p.unresolved).toEqual(["tools.ts"]);
    // A declared file stays declared when the brief names it too; a declared one the tree lacks is kept.
    expect(paths(predict(lane("src/x.ts"), map, {}).files)).toContain("named:src/x.ts");
    expect(paths(predict(lane("see src/x.ts", ["src/x.ts", "docs/plan.md"]), map).files).slice(0, 2)).toEqual(["declared:docs/plan.md", "declared:src/x.ts"]);
  });
});

describe("lanes that meet, and the order that keeps them apart", () => {
  const A = predict(lane("Rework src/x.ts and AGENTS.md"), map);
  const B = predict(lane("Fix src/x.ts and src/a/agents.ts"), map);
  const C = predict(lane("Style ui/src/styles.css"), map);
  test("a file both name, a hub both name, a file one reaches as an importer", () => {
    expect(meetings([A, B, C], map.hubs)).toEqual([{ a: 0, b: 1, kind: "file", files: ["src/x.ts"] }]);
    const H1 = predict(lane("AGENTS.md rule"), map), H2 = predict(lane("AGENTS.md table"), map);
    expect(meetings([H1, H2], map.hubs)).toEqual([{ a: 0, b: 1, kind: "hub", files: ["AGENTS.md"] }]);
    const N = predict(lane("src/y.ts only"), map);
    expect(meetings([predict(lane("src/x.ts"), map), N], map.hubs)).toEqual([{ a: 0, b: 1, kind: "near", files: ["src/y.ts"] }]);
    // A folder holds the files under it.
    expect(meetings([predict(lane("all of src/a/"), map), predict(lane("src/a/tools.ts"), map)], map.hubs)[0]).toMatchObject({ kind: "file", files: ["src/a/tools.ts"] });
  });
  test("three lanes, two meeting: the busier first, the other after it, the third beside", () => {
    const D = predict(lane("Rework src/x.ts, src/z.ts, src/y.ts and AGENTS.md"), map);
    const E = predict(lane("Fix src/z.ts and test/e2e/one.spec.ts, ui/src/styles.css, src/a/tools.ts"), map);
    const F = predict(lane("New src/b/tools.ts"), map);
    const ms = meetings([D, E, F], map.hubs);
    expect(ms).toEqual([{ a: 0, b: 1, kind: "file", files: ["src/z.ts"] }]);
    expect(propose([D, E, F], ms)).toEqual({ units: [{ lanes: [0], wave: 0, after: [] }, { lanes: [1], wave: 1, after: [0] }, { lanes: [2], wave: 0, after: [] }], waves: 2 });
  });
  test("lanes that share most of their files are proposed as one; near meetings order nothing", () => {
    const ms = meetings([A, B, C], map.hubs);
    // A and B share src/x.ts, half the named files of each (src/x.ts and a hub).
    expect(propose([A, B, C], ms)).toEqual({ units: [{ lanes: [0, 1], wave: 0, after: [], why: "they share src/x.ts" }, { lanes: [2], wave: 0, after: [] }], waves: 1 });
    const near = meetings([predict(lane("src/x.ts"), map), predict(lane("src/y.ts"), map)], map.hubs);
    expect(propose([{ files: [] }, { files: [] }], near).waves).toBe(1);
  });
  test("a chain waits in turn, and a unit waits only for the ones it meets", () => {
    const f = (p: string): { files: LaneFile[] } => ({ files: p.split(" ").map((x) => ({ path: x, how: "declared" as const })) });
    const ls = [f("a b c d"), f("d e f g"), f("g h i j"), f("k")];
    const p = propose(ls, meetings(ls, new Set()));
    expect(p.units.map((u) => [u.wave, u.after])).toEqual([[1, [1]], [0, []], [1, [1]], [0, []]]);
  });
});

describe("what a lane changed against its plan", () => {
  const own: LaneFile[] = [{ path: "src/x.ts", how: "named" }, { path: "src/y.ts", how: "importer", via: "src/x.ts" }, { path: "docs/", how: "declared" }];
  const other = [{ lane: "B", files: [{ path: "src/z.ts", how: "named" }, { path: "src/q.ts", how: "importer", via: "src/z.ts" }] as LaneFile[] }];
  test("a file another lane named is a stray, once; another's importer is not", () => {
    expect(strays(own, ["src/x.ts", "docs/a.md", "src/z.ts", "src/q.ts", "src/new.ts"], other)).toEqual([{ file: "src/z.ts", lanes: ["B"] }]);
    expect(strays(own, ["src/z.ts"], other, new Set(["src/z.ts"]))).toEqual([]);
  });
  test("hit, missed and unplanned", () => {
    expect(compare(own, ["src/x.ts", "docs/a.md", "src/new.ts"])).toEqual({ hit: ["src/x.ts", "docs/a.md"], missed: [], unplanned: ["src/new.ts"] });
    expect(compare(own, ["src/y.ts"]).missed).toEqual(["src/x.ts", "docs/"]);
  });
});
