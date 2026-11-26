import { expect, test } from "bun:test";
import { askHost, changed, commandOf, gapOf, reachOf, stillGreen, covers, dueAt, failureOf, finished, fingerprint, fresh, hostLoadOf, importsOf, limitOf, noticeText, NOTICE_MAX, parentWords, placeOf, refsIn, RUN_MAX_MS, started, sweepable, testFilesOf, testsFor, toTell, toWhom, treeReadsOf, turnEnded, WINDOW_MS, type Red } from "./beside.ts";
import { parseChecks } from "./named.ts";

test("the steps of a window are one run, one run at a time, and a turn's end runs what waits at once", () => {
  let l = fresh();
  expect(dueAt(l)).toBeNull();
  l = changed(l, 1_000);
  l = changed(l, 20_000); // a later step of the same window
  expect(dueAt(l)).toBe(1_000 + WINDOW_MS);
  l = started(l);
  expect(dueAt(l)).toBeNull();
  // A change while it runs waits for it, from its own time.
  l = changed(l, 40_000);
  expect(dueAt(l)).toBeNull();
  l = finished(l, "t1");
  expect(dueAt(l)).toBe(40_000 + WINDOW_MS);
  expect(l.tree).toBe("t1");
  // The turn ended: no step follows, so it is due from its first change.
  l = turnEnded(l);
  expect(dueAt(l)).toBe(40_000);
  l = finished(started(l), null);
  expect(l.tree).toBe("t1"); // a run that read no tree keeps the last one
  expect(dueAt(turnEnded(l))).toBeNull(); // nothing waits: the end starts nothing
});

test("the copy goes once the turn ended and nothing runs or waits, and the next change keeps it", () => {
  // A run that ended while the agent worked, then the turn's end with nothing waiting: the copy goes then.
  let l = finished(started(changed(fresh(), 1_000)), "t1");
  expect(sweepable(l)).toBe(false);
  l = turnEnded(l);
  expect(sweepable(l)).toBe(true);
  // A turn that ended with a change waiting: it runs first, and the copy goes at that run's end.
  l = turnEnded(changed(fresh(), 1_000));
  expect(sweepable(l)).toBe(false);
  l = started(l);
  expect(sweepable(l)).toBe(false);
  expect(sweepable(finished(l, "t2"))).toBe(true);
  // A step after the end (the agent was given more work) keeps it.
  expect(sweepable(changed(finished(l, "t2"), 5_000))).toBe(false);
});

test("a red is told to a working agent, kept for one that waits, given to the parent of a finished one, and to nobody past the owner's stop", () => {
  expect(toWhom("working")).toBe("agent");
  expect(toWhom("parked")).toBe("later");
  expect(toWhom("ended")).toBe("parent");
  expect(toWhom("held")).toBe("none");
  expect(toWhom(undefined)).toBe("none");
  const w = parentWords([{ name: "unit", command: "bun test ./a.test.ts", exit: 1, pass: 1, fail: 1, failure: { names: ["a > b"], first: ["error: boom"] } }], "0123456789abcdef");
  expect(w).toEqual({ cls: "unit", message: "unit (a > b) failed after it ended: error: boom (tree 012345678)" });
});

test("a failure is told once, and again only after a pass", () => {
  const red = (first: string, names = ["a > b"]): Red => ({ name: "unit", command: "bun test ./a.test.ts", exit: 1, pass: 1, fail: 1, failure: { names, first: [first] } });
  let l = fresh();
  const a = toTell(l, [red("error: expect(received).toBe(expected) [1.20ms]")]);
  expect(a.tell).toBe(true);
  l = finished(l, "t1", a.told);
  // The same failure on the next tree, with other times: not told again.
  expect(toTell(l, [red("error: expect(received).toBe(expected) [3.00ms]")]).tell).toBe(false);
  // Another failure is.
  expect(toTell(l, [red("error: boom", ["a > c"])]).tell).toBe(true);
  // A pass clears it: the first failure found again is told again.
  const green = toTell(l, []);
  expect(green).toEqual({ tell: false, told: null });
  l = finished(l, "t2", green.told);
  expect(toTell(l, [red("error: expect(received).toBe(expected)")]).tell).toBe(true);
  expect(fingerprint([red("x"), { ...red("y"), name: "typecheck" }])).toBe(fingerprint([{ ...red("y"), name: "typecheck" }, red("x")]));
});

test("the tests a change touches: its own tests, the tests of its folders and the tests that import it, the most direct first", () => {
  const tests = ["src/a/x.test.ts", "src/a/y.test.ts", "src/b/z.test.ts", "src/c/w.test.ts", "src/c/v.test.ts", "test/i.test.ts"];
  const text: Record<string, string> = {
    "src/b/z.test.ts": `import { f } from "../a/lib.ts";\n`,
    "src/c/w.test.ts": `const m = await import("../d/mod");\n`,
    "src/c/v.test.ts": `import "./other.ts";\n`,
    "test/i.test.ts": `export { g } from "../src/d/mod/index.ts";\n`,
  };
  const refsOf = (p: string) => (text[p] ? refsIn(text[p]!, p) : undefined);
  expect(testsFor(["src/a/lib.ts"], tests, refsOf)).toEqual(["src/a/x.test.ts", "src/a/y.test.ts", "src/b/z.test.ts"]);
  // An import without its extension, and of a folder's index.
  expect(testsFor(["src/d/mod.ts"], tests, refsOf)).toEqual(["src/c/w.test.ts"]);
  expect(testsFor(["src/d/mod/index.ts"], tests, refsOf)).toEqual(["src/c/w.test.ts", "test/i.test.ts"]);
  expect(testsFor(["test/i.test.ts", "docs/x.md"], tests, refsOf)).toEqual(["test/i.test.ts"]);
  // A test that reads the source tree under its place reads every file there.
  const walker = `const ROOT = join(import.meta.dir, "..", "ui/src");\nfor (const f of new Bun.Glob("**/*.tsx").scanSync(ROOT)) check(f);\n`;
  expect(treeReadsOf(walker, "src/conv.test.ts")).toEqual(["src", "ui/src"]);
  expect(testsFor(["ui/src/components/Panel.tsx"], ["src/conv.test.ts", "src/other.test.ts"], (p) => refsIn(p === "src/conv.test.ts" ? walker : "readdirSync(tmp)", p))).toEqual(["src/conv.test.ts"]);
  expect(treeReadsOf(`readdirSync(tmpdir())`, "src/x.test.ts")).toEqual([]);
  // A listing counts when it lists a place of the tree: a path made from the test's own place (also through a name
  // it was bound to), or what a helper is given. A test that lists a scratch folder of its own and only knows where
  // it sits (to copy itself, to find a link) reads no tree: it is not picked for every change.
  const scratch = `const HERE = join(import.meta.dir, "../..");\nconst home = join(root, "host");\nconst bare = readdirSync(join(home, ".cache")).find(isGit);\nlink(join(HERE, "node_modules"));\n`;
  expect(treeReadsOf(scratch, "src/landing/pair.test.ts")).toEqual([]);
  expect(treeReadsOf(`const ROOT = join(import.meta.dir, "..");\nconst SRC = join(ROOT, "src");\nreaddirSync(join(SRC, "core"));`, "src/c.test.ts")).toEqual(["src", "."]);
  expect(treeReadsOf(`const ROOT = join(import.meta.dir, "..");\nfunction files(dir) { return readdirSync(dir); }`, "src/c.test.ts")).toEqual(["src", "."]);
  // So a change far from such a test does not pick it, and a change beside it does.
  const pairRefs = (p: string) => refsIn(p === "src/landing/pair.test.ts" ? scratch : "", p);
  expect(testsFor(["src/engine/turn.ts"], ["src/landing/pair.test.ts"], pairRefs)).toEqual([]);
  expect(testsFor(["src/landing/queue.ts"], ["src/landing/pair.test.ts"], pairRefs)).toEqual(["src/landing/pair.test.ts"]);
  expect(importsOf(`import a from "./a"; const b = require( '../b.js' ); import x from "pkg";`, "s/t.test.ts")).toEqual(["s/a", "b.js"]);
  // The order: a changed test and the ones still red, the changed file's own test, the tests that read the tree
  // under it, its folder's other tests, then the tests that import it, the nearest first.
  const many = ["src/core/types.test.ts", "src/core/aa.test.ts", "src/conv.test.ts", "src/x/far.test.ts", "src/core/sub/near.test.ts", "src/y/red.test.ts", "src/z/mine.test.ts"];
  const imp = refsIn(`import { T } from "../core/types.ts";`, "src/x/far.test.ts");
  const refs: Record<string, ReturnType<typeof refsIn>> = { "src/conv.test.ts": refsIn(walker, "src/conv.test.ts"), "src/x/far.test.ts": imp, "src/core/sub/near.test.ts": refsIn(`import { T } from "../types.ts";`, "src/core/sub/near.test.ts") };
  expect(testsFor(["src/core/types.ts", "src/z/mine.test.ts"], many, (p) => refs[p], ["src/y/red.test.ts"])).toEqual(["src/z/mine.test.ts", "src/y/red.test.ts", "src/core/types.test.ts", "src/conv.test.ts", "src/core/aa.test.ts", "src/core/sub/near.test.ts", "src/x/far.test.ts"]);
});

test("a run's time limit is sized from its test files, and a run longer than a result beside the work is worth is not made", () => {
  expect(limitOf(1)).toBe(60_000);
  expect(limitOf(20, 2_000)).toBe(120_000);
  expect(limitOf(20, 5_000)).toBe(300_000);
  expect(limitOf(20, RUN_MAX_MS / 20 + 1)).toBeNull();
});

test("a beside check is named in the file, and what it runs", () => {
  const n = parseChecks(JSON.stringify({ checks: {
    typecheck: { run: "bunx tsc --noEmit -p .", beside: true },
    unit: { run: "bun test", args: true, tests: ["src/**/*.test.ts"], beside: true },
    web: { run: "npm test", args: true, dir: "web", tests: ["web/**/*.test.ts"], beside: true },
    e2e: { run: "bunx playwright test", args: true, cache: false, beside: true },
  } }));
  expect(n.checks.map((c) => `${c.name}:${!!c.beside}`)).toEqual(["typecheck:true", "unit:true", "web:true"]);
  expect(n.problems).toEqual(['e2e: "beside" needs a check of the work tree in a folder of its own, kept in the ledger']);
  const [typecheck, unit, web] = n.checks;
  expect(commandOf(typecheck!)).toBe("bunx tsc --noEmit -p .");
  expect(testFilesOf(unit!, ["src/a.ts", "src/a.test.ts", "web/b.test.ts"])).toEqual(["src/a.test.ts"]);
  expect(commandOf(unit!, ["src/a.test.ts", "src/it's.test.ts"])).toBe("bun test ./src/a.test.ts './src/it'\\''s.test.ts'");
  expect(commandOf(web!, ["web/b.test.ts"])).toBe("npm test ./b.test.ts");
});

test("what a failure says: the failed names and the first lines of the first failure", () => {
  const bun = [
    "bun test v1.3.0",
    "src/a.test.ts:",
    "(pass) a > ok [0.10ms]",
    "1 | test('x', () => {",
    "2 |   expect(1).toBe(2);",
    "error: expect(received).toBe(expected)",
    "",
    "Expected: 2",
    "Received: 1",
    "      at <anonymous> (src/a.test.ts:2:13)",
    "(fail) a > breaks [0.40ms]",
    "(fail) a > breaks too [0.20ms]",
    "",
    " 1 pass",
    " 2 fail",
  ].join("\n");
  const f = failureOf(bun);
  expect(f.names).toEqual(["a > breaks", "a > breaks too"]);
  expect(f.first).toEqual(["error: expect(received).toBe(expected)", "Expected: 2", "Received: 1", "      at <anonymous> (src/a.test.ts:2:13)", "(fail) a > breaks [0.40ms]"]);
  const tsc = failureOf("src/x.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/y.ts(1,1): error TS2304: Cannot find name 'z'.\nFound 2 errors.");
  expect(tsc.names).toEqual(["src/x.ts", "src/y.ts"]);
  expect(tsc.first).toEqual(["src/x.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'."]);
  // Nothing it knows: the last lines.
  expect(failureOf("one\ntwo\n").first).toEqual(["one", "two"]);
});

test("the notice names the checks, stays within its size and tells where it ran", () => {
  const long = Array.from({ length: 40 }, (_, i) => `line ${i} ${"x".repeat(300)}`);
  const reds: Red[] = [
    { name: "typecheck", command: "bunx tsc --noEmit -p .", exit: 2, pass: null, fail: null, failure: { names: ["src/x.ts"], first: long } },
    { name: "unit", command: "bun test ./src/a.test.ts", exit: 1, pass: 3, fail: 1, failure: { names: Array.from({ length: 9 }, (_, i) => `t${i}`), first: ["error: boom"] }, base: "red on main too (abc, 14:00)" },
  ];
  const t = noticeText(reds, { tree: "0123456789abcdef", at: "14:05", ran: ["typecheck", "unit (1 test file)"], where: "build-box" });
  expect(t.length).toBeLessThanOrEqual(NOTICE_MAX);
  expect(t).toStartWith("[harness] Checks beside your work: Keel ran typecheck and unit (1 test file) by itself on your files as they were at 14:05 (tree 012345678) on build-box, and these failed:");
  expect(t).toContain("- typecheck (`bunx tsc --noEmit -p .`): exit 2: src/x.ts");
  expect(t).toContain("- unit (`bun test ./src/a.test.ts`): 1 of 4 failed: t0; t1; t2; t3; t4; t5; 3 more (red on main too (abc, 14:00))");
  expect(t).toContain("First failure (typecheck):");
});

test("where a run goes: here with room, else the host with room, else the line here", () => {
  expect(placeOf({ localFree: true, host: "h", hostLoad: { load1: 0, cores: 8 }, share: 0.83 })).toBe("local");
  expect(placeOf({ localFree: false, host: "h", hostLoad: { load1: 2, cores: 8 }, share: 0.83 })).toBe("host");
  expect(placeOf({ localFree: false, host: "h", hostLoad: { load1: 7, cores: 8 }, share: 0.83 })).toBe("line");
  expect(placeOf({ localFree: false, host: "h", hostLoad: undefined, share: 0.83 })).toBe("line");
  expect(placeOf({ localFree: false, host: null, hostLoad: undefined, share: 0.83 })).toBe("line");
  // This machine over half its threads: the host goes first when it has room, even with a slot here.
  expect(placeOf({ localFree: true, host: "h", hostLoad: { load1: 2, cores: 32 }, share: 0.83, localLoad: { load1: 9, cores: 16 } })).toBe("host");
  expect(placeOf({ localFree: true, host: "h", hostLoad: { load1: 30, cores: 32 }, share: 0.83, localLoad: { load1: 9, cores: 16 } })).toBe("local");
  expect(placeOf({ localFree: true, host: "h", hostLoad: { load1: 2, cores: 32 }, share: 0.83, localLoad: { load1: 8, cores: 16 } })).toBe("local");
  expect(placeOf({ localFree: true, host: null, hostLoad: undefined, share: 0.83, localLoad: { load1: 15, cores: 16 } })).toBe("local");
  expect(askHost({ localFree: true, host: "h", localLoad: { load1: 9, cores: 16 } })).toBe(true);
  expect(askHost({ localFree: true, host: "h", localLoad: { load1: 3, cores: 16 } })).toBe(false);
  expect(askHost({ localFree: false, host: "h" })).toBe(true);
  expect(askHost({ localFree: false, host: null })).toBe(false);
  expect(hostLoadOf("1.70 2.30 2.36 3/900 1234\n32\n")).toEqual({ load1: 1.7, cores: 32 });
  expect(hostLoadOf("")).toBeUndefined();
});

test("a run of a check covers the files of a run beside it when it is the whole check or names each of them", () => {
  const [unit] = parseChecks(JSON.stringify({ checks: { unit: { run: "bun test", args: true, tests: ["**/*.test.ts"], beside: true } } })).checks;
  expect(covers(unit!, [], "bun test src/a.test.ts")).toBe(true); // a check of the whole tree: any run of it
  expect(covers(unit!, ["src/a.test.ts"], "bun test")).toBe(true);
  expect(covers(unit!, ["src/a.test.ts", "src/b.test.ts"], "bun test ./src/b.test.ts  'src/a.test.ts'")).toBe(true);
  expect(covers(unit!, ["src/a.test.ts", "src/b.test.ts"], "bun test src/a.test.ts")).toBe(false);
});

test("an agent gets at most per_hour runs an hour: a change inside the gap waits for it, a turn's end does not", () => {
  const gap = gapOf(6);
  expect(gap).toBe(600_000);
  expect(gapOf(0)).toBe(0);
  let l = finished(started(changed(fresh(), 0), 30_000), "t1");
  l = changed(l, 60_000);
  // The window ends at 90 s, the gap at 630 s: the run waits for the gap, and the changes of the gap are one run.
  expect(dueAt(l, WINDOW_MS, gap)).toBe(630_000);
  expect(dueAt(changed(l, 400_000), WINDOW_MS, gap)).toBe(630_000);
  // Past the gap, the window as before.
  expect(dueAt(changed(finished(started(changed(fresh(), 0), 0), "t1"), 900_000), WINDOW_MS, gap)).toBe(900_000 + WINDOW_MS);
  // No cap: the window alone.
  expect(dueAt(l, WINDOW_MS, 0)).toBe(60_000 + WINDOW_MS);
  // The turn ended: what waits runs now.
  expect(dueAt(turnEnded(l), WINDOW_MS, gap)).toBe(60_000);
});

test("a test that passed stands while nothing it reaches changed: its imports to the end and the folders it walks", () => {
  const files = ["src/a.ts", "src/b.ts", "src/c.ts", "src/lib/index.ts", "src/a.test.ts", "src/d.test.ts", "src/walk.test.ts", "docs/x.md"];
  const refs: Record<string, { imports: string[]; reads: string[] }> = {
    "src/a.test.ts": { imports: ["src/a"], reads: [] },
    "src/a.ts": { imports: ["src/b.ts"], reads: [] },
    "src/b.ts": { imports: ["src/lib"], reads: [] },
    "src/lib/index.ts": { imports: [], reads: [] },
    "src/d.test.ts": { imports: ["src/c.js"], reads: [] },
    "src/c.ts": { imports: [], reads: [] },
    "src/walk.test.ts": { imports: [], reads: ["src"] },
  };
  const reach = (t: string) => reachOf(t, (p) => refs[p], files);
  expect([...reach("src/a.test.ts").files].sort()).toEqual(["src/a.test.ts", "src/a.ts", "src/b.ts", "src/lib/index.ts"]);
  const green = ["src/a.test.ts", "src/d.test.ts", "src/walk.test.ts"];
  // A change three imports down touches a.test.ts; a doc touches nothing.
  expect(stillGreen(green, ["src/lib/index.ts"], reach)).toEqual(["src/d.test.ts"]);
  expect(stillGreen(green, ["docs/x.md"], reach)).toEqual(green);
  expect(stillGreen(green, ["src/c.ts"], reach)).toEqual(["src/a.test.ts"]);
  // A test file changed is not green any more.
  expect(stillGreen(green, ["src/d.test.ts"], reach)).toEqual(["src/a.test.ts"]);
  // A fixture beside a file of the reach is read (and the walk of src reads it too); another kind of test never stands.
  expect(stillGreen(green, ["src/lib/data.json"], reach)).toEqual(["src/d.test.ts"]);
  expect(stillGreen(["t/a.sh", "src/a.test.ts"], ["docs/x.md"], reach)).toEqual(["src/a.test.ts"]);
  // A file not read yet ends the walk there: what it imports is not known, so nothing past it is counted.
  expect([...reachOf("src/a.test.ts", (p) => (p === "src/a.ts" ? undefined : refs[p]), files).files].sort()).toEqual(["src/a.test.ts", "src/a.ts"]);
});
