import { describe, expect, test } from "bun:test";
import type { Check } from "../checks/named.ts";
import { commandOf, due, fastChecks, graphOf, hubsOf, hunksOf, nearHunks, pairKey, pairTests, PAIR_TESTS, relatedPairs, setupLineOf, brokenText, testMatcher, verdictOf, type Side } from "./pairs.ts";

const check = (name: string, o: Partial<Check> = {}): Check => ({ name, run: name === "unit" ? "bun test" : `run-${name}`, args: false, dir: ".", cache: true, tree: { kind: "work" }, drop: [], inputs: [], ...o });

describe("which pairs are checked together", () => {
  // A small repository: accounts.ts, provenance.ts imports it, provenance.test.ts imports provenance.ts;
  // docs and ui stand apart.
  const known = new Set(["src/accounts.ts", "src/provenance.ts", "src/provenance.test.ts", "src/routes.ts", "docs/notes.md", "ui/app.tsx", "ui/app.test.tsx", "py/pkg/__init__.py", "py/pkg/a.py", "py/pkg/b.py", "go/x/a.go", "go/x/b.go"]);
  const lines = [
    { path: "src/provenance.ts", line: 'import { allowed } from "./accounts.ts";' },
    { path: "src/provenance.test.ts", line: 'import { stamp } from "./provenance.js";' },
    { path: "src/routes.ts", line: 'import { x } from "../ui/app";' },
    { path: "ui/app.test.tsx", line: 'import { App } from "./app";' },
    { path: "py/pkg/a.py", line: "from .b import thing" },
  ];
  const g = graphOf(lines, known);
  const isTest = testMatcher();
  const tests = [...known].filter(isTest);
  const side = (branch: string, files: string[]): Side => ({ branch, tip: branch.padEnd(40, "0"), files });

  test("imports resolve relative paths, a .js name to its .ts file, a folder to its index, Python's relative modules and a Go package", () => {
    expect([...g.get("src/provenance.ts")!]).toEqual(["src/accounts.ts"]);
    expect([...g.get("src/provenance.test.ts")!]).toEqual(["src/provenance.ts"]);
    expect([...g.get("src/routes.ts")!]).toEqual(["ui/app.tsx"]);
    expect([...g.get("py/pkg/a.py")!]).toEqual(["py/pkg/b.py"]);
    expect([...g.get("go/x/a.go")!]).toEqual(["go/x/b.go"]);
  });

  test("a shared file, an import between the sides' files, and a test that reaches both relate a pair; nothing else does", () => {
    const accounts = side("accounts", ["src/accounts.ts"]);
    const provenance = side("provenance", ["src/provenance.test.ts"]);
    const sameFile = side("also-accounts", ["src/accounts.ts", "docs/notes.md"]);
    const importer = side("prov-code", ["src/provenance.ts"]);
    const docs = side("docs", ["docs/notes.md"]);
    const ui = side("ui", ["ui/app.tsx"]);
    const r = relatedPairs([accounts, provenance, sameFile, importer, docs, ui], g, tests, isTest);
    const said = r.map((p) => `${p.a}+${p.b}:${p.why}`);
    // The accounts-and-provenance shape: no shared file, no direct import; the provenance test reaches the accounts rule.
    expect(said).toContain("accounts+provenance:test");
    expect(r.find((p) => p.a === "accounts" && p.b === "provenance")!.tests).toEqual(["src/provenance.test.ts"]);
    expect(said).toContain("accounts+also-accounts:file");
    expect(said).toContain("also-accounts+docs:file");
    expect(said).toContain("accounts+prov-code:import");
    // Shared file first, then import, then a test.
    expect(r.map((p) => p.why)).toEqual([...r.map((p) => p.why)].sort((x, y) => ["file", "import", "test"].indexOf(x) - ["file", "import", "test"].indexOf(y)));
    // The ui branch touches nothing the others touch; docs and accounts meet only through also-accounts.
    expect(said.filter((x) => x.includes("ui"))).toEqual([]);
    expect(said).not.toContain("accounts+docs:file");
    expect(said.some((x) => x.startsWith("accounts+docs"))).toBe(false);
  });

  test("a pair runs only the tests that reach both sides, nearest first, as the merged tree holds them, at most PAIR_TESTS", () => {
    const accounts = side("accounts", ["src/accounts.ts"]), code = side("prov-code", ["src/provenance.ts", "src/routes.ts"]);
    // (The ui test is in a folder prov-code changed a file of, and reaches routes.ts's import only: not the pair's.)
    const [r] = relatedPairs([accounts, code], g, tests, isTest);
    expect(pairTests(r!, known)).toEqual(["src/provenance.test.ts"]);
    expect(pairTests({ tests: ["src/provenance.test.ts", "gone.test.ts"] }, known)).toEqual(["src/provenance.test.ts"]);
    const many = Array.from({ length: 40 }, (_, i) => `t${String(i).padStart(2, "0")}.test.ts`);
    expect(pairTests({ tests: many }, new Set(many))).toEqual(many.slice(0, PAIR_TESTS));
    expect(commandOf(check("unit", { args: true, tests: ["**/*.test.ts"] }), ["src/provenance.test.ts"], "/h")).toBe("bun test src/provenance.test.ts");
    expect(commandOf(check("unit", { args: true, tests: ["**/*.test.ts"] }), [], "/h")).toBeUndefined();
    expect(commandOf(check("typecheck", { run: "~/bin/tsc -p ." }), ["x"], "/h")).toBe("/h/bin/tsc -p .");
    expect(commandOf(check("unit", { args: true, dir: "src", tests: ["src/**/*.test.ts"] }), ["src/a b.test.ts"], "/h")).toBe("bun test 'a b.test.ts'");
  });

  test("a test that a side changed comes first, then the nearer ones; one past REACH is not the pair's", () => {
    const k2 = new Set([...known, "src/far.test.ts", "src/mid.ts", "src/z.test.ts"]);
    const g2 = graphOf([...lines, { path: "src/far.test.ts", line: 'import "./mid.ts";' }, { path: "src/mid.ts", line: 'import "./provenance.ts";' }, { path: "src/z.test.ts", line: 'import "./accounts.ts";' }], k2);
    const a = side("a", ["src/accounts.ts"]), b = side("b", ["src/provenance.ts"]);
    // far.test reaches provenance in 2 steps but accounts in 3: past REACH.
    expect(relatedPairs([a, b], g2, [...k2].filter(isTest), isTest)[0]!.tests).toEqual(["src/provenance.test.ts"]);
    // c changed z.test, which reaches accounts in one step: it runs before provenance.test.
    const c = side("c", ["src/provenance.ts", "src/z.test.ts"]);
    expect(relatedPairs([a, c], g2, [...k2].filter(isTest), isTest)[0]!.tests).toEqual(["src/z.test.ts", "src/provenance.test.ts"]);
  });

  test("a hub relates nothing alone: a shared hub file only where both change lines near each other, no import of a hub, no walk through one", () => {
    // types.ts is a hub: most files import it. turn.ts is a hub by the work: most commits touch it.
    const k3 = new Set(["src/types.ts", "src/turn.ts", "src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/x.test.ts", ...Array.from({ length: 30 }, (_, i) => `src/m${i}.ts`)]);
    const l3 = [
      ...Array.from({ length: 30 }, (_, i) => ({ path: `src/m${i}.ts`, line: 'import type { T } from "./types.ts";' })),
      { path: "src/a.ts", line: 'import type { T } from "./types.ts";' },
      { path: "src/b.ts", line: 'import type { T } from "./types.ts";' },
      { path: "src/x.test.ts", line: 'import { T } from "./types.ts";' },
    ];
    const g3 = graphOf(l3, k3);
    const hubs = hubsOf({ touched: new Map([["src/turn.ts", 30], ["src/a.ts", 2]]), commits: 200, g: g3 });
    expect([...hubs].sort()).toEqual(["src/turn.ts", "src/types.ts"]);
    // A young repository names no hub by its work.
    expect(hubsOf({ touched: new Map([["src/turn.ts", 30]]), commits: 40, g: new Map() }).size).toBe(0);
    const t = [...k3].filter(isTest);
    const near = (b: string, f: string, at: [number, number][]): Side => ({ branch: b, tip: b.padEnd(40, "0"), files: [f, "src/turn.ts"], hunks: new Map([["src/turn.ts", at]]) });
    // Both edit the turn loop, far apart: not related. Near each other: related by the hub file.
    expect(relatedPairs([near("p", "src/c.ts", [[10, 12]]), near("q", "src/d.ts", [[400, 410]])], g3, t, isTest, hubs)).toEqual([]);
    expect(relatedPairs([near("p", "src/c.ts", [[10, 12]]), near("q", "src/d.ts", [[30, 31]])], g3, t, isTest, hubs).map((r) => r.why + " " + r.detail)).toEqual(["file src/turn.ts (both near line 30)"]);
    // One changes the core types, the other a file that imports them, and a test reaches both through types.ts: not related.
    expect(relatedPairs([side("t", ["src/types.ts"]), side("u", ["src/a.ts"])], g3, t, isTest, hubs)).toEqual([]);
    // With no hubs, the same pair is related by the import.
    expect(relatedPairs([side("t", ["src/types.ts"]), side("u", ["src/a.ts"])], g3, t, isTest).map((r) => r.why)).toEqual(["import"]);
  });

  test("the changed lines of a diff, a file each, in the old side's numbering", () => {
    const d = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -10,3 +10,4 @@", "-a", "@@ -40 +41,0 @@", "diff --git a/gone b/gone", "--- a/gone", "+++ /dev/null", "@@ -1,5 +0,0 @@", "--- /dev/null", "+++ b/new", "@@ -0,0 +1,2 @@"].join("\n");
    expect(Object.fromEntries(hunksOf(d))).toEqual({ x: [[10, 12], [40, 40]], gone: [[1, 5]], new: [[0, 0]] });
    expect(nearHunks([[10, 12]], [[42, 50]])).toBe(42);
    expect(nearHunks([[10, 12]], [[43, 50]])).toBeUndefined();
  });

  test("the fast checks: those that take no words or name their tests, unless the repository names its own or turns them off", () => {
    const named = [check("typecheck"), check("unit", { args: true, tests: ["**/*.test.ts"] }), check("e2e", { args: true, cache: false }), check("smoke", { args: true }), check("remote", { args: true, tree: { kind: "commit" } })];
    expect(fastChecks(named, undefined)).toEqual({ checks: [named[0]!, named[1]!] });
    expect(fastChecks(named, { checks: ["unit"] })).toEqual({ checks: [named[1]!] });
    expect(fastChecks(named, false)).toHaveProperty("off");
    expect(fastChecks(named, { checks: ["lint"] })).toEqual({ problem: "pairs.checks names lint, which .keel/checks.json does not name" });
    expect(fastChecks([named[2]!], undefined)).toHaveProperty("off");
  });
});

describe("the result", () => {
  test("is kept by the repository and the two heads, whichever side comes first", () => {
    const a = "a".repeat(40), b = "b".repeat(40);
    expect(pairKey("/r", a, b)).toEqual({ repo: "/r", tip1: a, tip2: b });
    expect(pairKey("/r", b, a)).toEqual(pairKey("/r", a, b));
    expect(pairKey("/r", a, "c".repeat(40))).not.toEqual(pairKey("/r", a, b));
    expect(pairKey("/other", a, b)).not.toEqual(pairKey("/r", a, b));
  });

  test("a pair is due once both heads stayed still for the quiet window", () => {
    expect(due(0, 1_000, 120_999, 120_000)).toBe(false);
    expect(due(0, 1_000, 121_000, 120_000)).toBe(true);
  });

  test("red only when it fails together, passes on each side alone and fails together again", () => {
    const T = [{ check: "unit", exit: 1, names: ["stamp > keeps bots"] }, { check: "typecheck", exit: 0, names: [] }];
    const ok = [{ check: "unit", exit: 0, names: [] }];
    expect(verdictOf([{ check: "unit", exit: 0, names: [] }])).toEqual({ state: "green" });
    expect(verdictOf(T, { a: ok, b: ok }, [{ check: "unit", exit: 1, names: ["stamp > keeps bots"] }])).toEqual({ state: "red", checks: [{ name: "unit", tests: ["stamp > keeps bots"] }] });
    expect(verdictOf(T, { a: ok, b: ok }, [{ check: "unit", exit: 0, names: [] }]).state).toBe("flaky");
    // Red on a side alone with the same test: that side's own red, not the pair's.
    expect(verdictOf(T, { a: [{ check: "unit", exit: 1, names: ["stamp > keeps bots"] }], b: ok })).toEqual({ state: "own", checks: [{ name: "unit", branch: "a" }] });
    // Red on a side alone on another test: the test that fails only together is the pair's.
    expect(verdictOf(T, { a: [{ check: "unit", exit: 1, names: ["other"] }], b: ok })).toEqual({ state: "red", checks: [{ name: "unit", tests: ["stamp > keeps bots"] }] });
    // Red alone with names it cannot say: not known to be the pair's.
    expect(verdictOf(T, { a: [{ check: "unit", exit: 1, names: [] }], b: ok }).state).toBe("own");
    // Red on both sides alone on what fails together: the base or the setup is red where the pairs run.
    const both = [{ check: "unit", exit: 1, names: ["stamp > keeps bots"] }];
    expect(verdictOf(T, { a: both, b: both })).toEqual({ state: "broken", checks: [{ name: "unit", branch: "both" }] });
    expect(verdictOf(T, { a: [{ check: "unit", exit: 2, names: [] }], b: [{ check: "unit", exit: 2, names: [] }] }).state).toBe("broken");
  });
});

describe("a run that could not start is the setup's, not a red base", () => {
  test("a missing package, type file or program is named by its first line; a path of the tree's own is not", () => {
    expect(setupLineOf("$ bunx tsc --noEmit -p .\nerror TS2688: Cannot find type definition file for 'bun'.\n  The file is in the program")).toBe("error TS2688: Cannot find type definition file for 'bun'.");
    expect(setupLineOf("$ bun test\nerror: Cannot find module '@simplewebauthn/server' from '/s/src/x.ts'\nerror: Cannot find module 'other'")).toBe("error: Cannot find module '@simplewebauthn/server' from '/s/src/x.ts'");
    expect(setupLineOf("bash: tsc: command not found", 127)).toBe("bash: tsc: command not found");
    expect(setupLineOf("$ run\nsomething odd", 127)).toBe("something odd");
    expect(setupLineOf("error: Cannot find module './gone.ts' from '/s/src/x.ts'")).toBeUndefined();
    expect(setupLineOf("1 fail\nexpect(received).toBe(expected)")).toBeUndefined();
  });
  test("the owner is told it is the setup's, with the line, and that the next pair is tried", () => {
    const t = brokenText({ repo: "/r", base: "main", baseTip: "a".repeat(40), checks: ["typecheck", "unit"], missing: "error: Cannot find module 'x'" });
    expect(t).toContain("typecheck, unit could not run where the pairs run: error: Cannot find module 'x'");
    expect(t).toContain("not a red base");
    expect(t).not.toContain("checked again until");
  });
});
