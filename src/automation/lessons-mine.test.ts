import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { describe, expect, test } from "bun:test";
import { FAMILIES_PER_ARM } from "../admin/experiments.ts";
import { getConcealer, setConcealer } from "../core/conceal.ts";
import { draftHolds, draftPrompt, fateOf, kindOfAnswer, kindPrompt, lessonBlock, plainDraft, REVIEW_KINDS, SHOWN, toDraft } from "./lesson-draft.ts";
import { clusterFindings, decidable, errorShape, exampleOf, toolClass, kindKey, verdictRef, familyHas, hitsOf, MIN_PER_ARM, mineFrom, mineRead, ofClass, perArm, reviewKey, similar, toolKey, treeOf, trialOf, wordsOf, type Candidate, type Hit, type SessionRow } from "./lessons-mine.ts";

describe("class keys", () => {
  test("a tool error's repeats share a key: paths, numbers, ids and quoted text fold", () => {
    const key = (tool: string, error: string) => toolKey(tool, toolClass(error)!);
    const a = key("Bash", "tail: option used in invalid context -- 2 (exit code 1)");
    expect(a).toBe(key("Bash", "tail: option used in invalid context -- 5 (exit code 1)"));
    expect(key("Read", "tail: option used in invalid context -- 2 (exit code 1)")).not.toBe(a);
    expect(key("Bash", "cat: no such file (exit code 2)")).not.toBe(key("Bash", "cat: permission denied (exit code 2)"));
    expect(errorShape('Edit failed: "foo bar" not found in /a/b.ts (id 0123abcd9f)')).toBe("Edit failed: <q> not found in <path> (id <hex>)");
  });
  test("a line the ledger cut at another length is the same class", () => {
    expect(toolClass("/home/x/a/very/long/path/reader.ts exists and was not read in this session. Its start is below; write aga..."))
      .toBe(toolClass("/s/b.sh exists and was not read in this session. Its start is below; write again to replace it."));
  });
  test("a line that names no cause is no class, unless the command reached its time limit", () => {
    expect(toolClass("0 (exit code 1)")).toBeNull();
    expect(toolClass("08:31:23 (exit code 1)")).toBeNull();
    expect(toolClass("} (exit code 1)")).toBeNull();
    expect(toolClass("Exit code 124")).toBe("the command reached its time limit");
    expect(toolClass("No tool named bash.")).toBe("No tool named bash.");
  });
});

describe("review findings by their words", () => {
  test("findings said in other words are one class; a different finding is another", () => {
    const a = wordsOf("The builder did not run the full unit suite after its last fix");
    const b = wordsOf("Unit suite not run after the final fix");
    const c = wordsOf("A hand-made button fails the conventions test");
    expect(similar(a, b)).toBe(true);
    expect(similar(a, c)).toBe(false);
    expect(wordsOf("Tests tested testing")).toEqual(["test"]);
  });
  test("a class keeps the key of its oldest finding as newer ones join", () => {
    const items = [
      { ts: 3, words: wordsOf("unit suite not run after the final fix") },
      { ts: 1, words: wordsOf("builder did not run the full unit suite after its last fix") },
      { ts: 2, words: wordsOf("a test id carries data from the owner") },
    ];
    const out = clusterFindings(items);
    expect(out.map((o) => o.ts)).toEqual([1, 2, 3]);
    expect(reviewKey(out[2]!.seed)).toBe(reviewKey(out[0]!.seed));
    expect(reviewKey(out[1]!.seed)).not.toBe(reviewKey(out[0]!.seed));
  });
});

const row = (id: string, parent: string | null, workspace = "/r/a"): SessionRow => ({ id, parent_id: parent, workspace, machine: null, repo_root: null });
const hit = (session: string, key = "tool:Bash:x", n = 1, ts = 1): Hit => ({ source: "tool", key, label: "Bash", example: "Exit code 1", session, ts, n });

describe("mineFrom", () => {
  // top: a coordinator; a1..a3 its agents; a1b an agent of a1; solo a session of its own.
  const sessions = new Map([row("top", null), row("a1", "top"), row("a2", "top"), row("a3", "top"), row("a1b", "a1"), row("solo", null), row("far", null, "/r/b")].map((r) => [r.id, r]));
  const root = (dir: string) => dir;

  test("the tree of a session is the agent under its top-level session", () => {
    expect(treeOf(sessions, "a1b")).toBe("a1");
    expect(treeOf(sessions, "a1")).toBe("a1");
    expect(treeOf(sessions, "top")).toBe("top");
  });
  test("a cause in three trees of a repository is a candidate; three sessions of one tree are not", () => {
    expect(mineFrom([hit("a1"), hit("a1b"), hit("a1", undefined, 4)], sessions, root)).toEqual([]);
    const [c, ...rest] = mineFrom([hit("a1", undefined, 1, 5), hit("a1b", undefined, 2, 6), hit("a2", undefined, 1, 7), hit("solo", undefined, 1, 8)], sessions, root);
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ key: "tool:Bash:x", repo: "/r/a", repo_name: "a", failures: 5, sessions: 4, trees: 3, first_ts: 5, last_ts: 8, examples: ["Exit code 1"] });
    expect(c!.evidence.map((e) => [e.tree, e.n])).toEqual([["solo", 1], ["a2", 1], ["a1", 3]]);
  });
  test("repositories are counted apart, and a session with no repository is not read", () => {
    expect(mineFrom([hit("a1"), hit("a2"), hit("far")], sessions, root)).toEqual([]);
    expect(mineFrom([hit("a1"), hit("a2"), hit("a3")], sessions, () => null)).toEqual([]);
  });
});

// The tables the miner reads, as the daemon makes them (the columns it reads).
function store() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_id TEXT, workspace TEXT NOT NULL, machine TEXT, created INTEGER);
    CREATE TABLE agents (id TEXT PRIMARY KEY, session_id TEXT, parent_id TEXT, branch TEXT, created INTEGER);
    CREATE TABLE worktrees (session_id TEXT PRIMARY KEY, repo_root TEXT NOT NULL);
    CREATE TABLE telemetry_tools (id INTEGER PRIMARY KEY, session_id TEXT, ts INTEGER, tool TEXT, is_error INTEGER, error TEXT);
    CREATE TABLE session_failures (session_id TEXT, fp TEXT, kind TEXT, cls TEXT, sample TEXT, count INTEGER, first_ts INTEGER, last_ts INTEGER, refs TEXT);
    CREATE TABLE review_verdicts (agent_id TEXT, commit_sha TEXT, branches TEXT, land TEXT, why TEXT, at INTEGER);
    CREATE TABLE reviews (id TEXT, session_id TEXT, state TEXT, data TEXT, created INTEGER);
    CREATE TABLE lesson_kinds (ref TEXT PRIMARY KEY, kind TEXT, model TEXT, ts INTEGER NOT NULL);`);
  db.query("INSERT INTO sessions VALUES ('top', NULL, '/r/a', NULL, 0)").run();
  for (const [i, s] of ["s1", "s2", "s3"].entries()) {
    db.query("INSERT INTO sessions VALUES (?, 'top', ?, NULL, 0)").run(s, `/wt/${s}`);
    db.query("INSERT INTO agents VALUES (?, ?, 'top', ?, ?)").run(`ag${i}`, s, `keel/b${i}`, i);
    db.query("INSERT INTO worktrees VALUES (?, '/r/a')").run(s);
  }
  return db;
}

describe("hitsOf and mineRead over the tables", () => {
  const now = 10 * 86_400_000;
  test("the same tool failure in three agents' worktrees of one repository is one candidate", () => {
    const db = store();
    for (const [i, s] of ["s1", "s2", "s3"].entries()) db.query("INSERT INTO telemetry_tools (session_id, ts, tool, is_error, error) VALUES (?, ?, 'Bash', 1, ?)").run(s, now - 1000 + i, `tail: option used in invalid context -- ${i + 2} (exit code 1)`);
    // Old, and a call that worked: neither is read.
    db.query("INSERT INTO telemetry_tools (session_id, ts, tool, is_error, error) VALUES ('s1', 1, 'Bash', 1, 'Exit code 9')").run();
    db.query("INSERT INTO telemetry_tools (session_id, ts, tool, is_error, error) VALUES ('s1', ?, 'Bash', 0, NULL)").run(now);
    const got = mineRead(db, { now, days: 7 });
    expect(got.map((c) => [c.source, c.repo, c.trees, c.failures])).toEqual([["tool", "/r/a", 3, 3]]);
  });
  test("a failure row's agents are their own sessions; provider and message causes are not read", () => {
    const db = store();
    const refs = JSON.stringify([{ id: "ag0", n: 2, ts: now - 5 }, { id: "ag1", n: 1, ts: now - 4 }, { id: "ag2", n: 1, ts: now - 3 }]);
    db.query("INSERT INTO session_failures VALUES ('top', 'fp1', 'agent', 'context', 'lost its context', 4, ?, ?, ?)").run(now - 9, now - 3, refs);
    db.query("INSERT INTO session_failures VALUES ('top', 'fp2', 'provider', 'overloaded', 'HTTP 529', 4, ?, ?, ?)").run(now - 9, now - 3, refs);
    const got = mineRead(db, { now });
    expect(got.map((c) => [c.key, c.trees, c.failures])).toEqual([["failure:fp1", 3, 4]]);
  });
  test("refusing verdicts said in other words in three trees are one review class, in the tree of the branch judged", () => {
    const db = store();
    db.query("INSERT INTO sessions VALUES ('rv', 'top', '/r/a', NULL, 0)").run();
    db.query("INSERT INTO agents VALUES ('rva', 'rv', 'top', NULL, 9)").run();
    const whys = ["The builder did not run the full unit suite after its last fix", "unit suite not run after the final fix", "full unit suite was not run after the last fix"];
    whys.forEach((why, i) => db.query("INSERT INTO review_verdicts VALUES ('rva', ?, ?, 'no', ?, ?)").run(`c${i}`, JSON.stringify([`keel/b${i}`]), why, now - 10 + i));
    db.query("INSERT INTO review_verdicts VALUES ('rva', 'c9', '[]', 'yes', 'fine', ?)").run(now);
    const [c, ...rest] = mineRead(db, { now });
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ source: "review", trees: 3, failures: 3 });
    expect(new Set(c!.evidence.map((e) => e.session))).toEqual(new Set(["s1", "s2", "s3"]));
  });
  test("refusals in other words of one kind are one class once a model gave their kind; the rest are classed by their words", () => {
    const db = store();
    db.query("INSERT INTO sessions VALUES ('rv', 'top', '/r/a', NULL, 0)").run();
    db.query("INSERT INTO agents VALUES ('rva', 'rv', 'top', NULL, 9)").run();
    const whys = ["Two existing turn tests fail on this commit; they pass on main", "mcp.spec.ts fails under remote-verify", "the leash test breaks after the last edit"];
    whys.forEach((why, i) => db.query("INSERT INTO review_verdicts VALUES ('rva', ?, ?, 'no', ?, ?)").run(`c${i}`, JSON.stringify([`keel/b${i}`]), why, now - 10 + i));
    // Not asked yet: three findings with no words in common are no class.
    expect(mineRead(db, { now })).toEqual([]);
    const kind = REVIEW_KINDS[1];
    whys.forEach((_, i) => db.query("INSERT INTO lesson_kinds VALUES (?, ?, 'small', ?)").run(verdictRef("rva", `c${i}`), kind, now));
    const [c, ...rest] = mineRead(db, { now });
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ source: "review", key: kindKey(kind), label: kind, trees: 3, failures: 3 });
    // The trial's count reads the same kinds.
    expect([...familyHas(db, { source: "review", key: kindKey(kind) }, [{ id: "s1", root: "s1" }, { id: "s2", root: "s2" }], 0, now)]).toEqual([["s1", 1], ["s2", 1]]);
  });
  test("a model's answer names a kind by its number, none by 0, and anything else is not an answer", () => {
    expect(kindOfAnswer("2")).toBe(REVIEW_KINDS[1]);
    expect(kindOfAnswer(" 0.")).toBeNull();
    expect(kindOfAnswer("The second one")).toBeUndefined();
    expect(kindOfAnswer("42")).toBeUndefined();
  });
  test("a draft holds when it is a short note or NONE, never a refusal; an agent's block lists the notes", () => {
    expect(draftHolds("Run the whole unit suite after your last fix, before you report.")).toBe(true);
    expect(draftHolds("NONE: a provider outage")).toBe(true);
    expect(draftHolds("I'm sorry, I can't help with that.")).toBe(false);
    expect(draftHolds("x".repeat(700))).toBe(false);
    expect(lessonBlock("repo", ["One.", "Two\n words."])).toBe("Lessons of this repository (repo), each from a failure that repeated across its agents; the owner accepted them:\n- One.\n- Two words.");
    expect(lessonBlock("repo", [])).toBe("");
  });
  test("a trial's count: whether the class failed in each family's sessions, once a tree", () => {
    const db = store();
    const key = toolKey("Bash", toolClass("tail: no such option (exit code 1)")!);
    db.query("INSERT INTO telemetry_tools (session_id, ts, tool, is_error, error) VALUES ('s1', 5, 'Bash', 1, 'tail: no such option (exit code 1)')").run();
    db.query("INSERT INTO telemetry_tools (session_id, ts, tool, is_error, error) VALUES ('s1', 6, 'Bash', 1, 'tail: no such option (exit code 1)')").run();
    db.query("INSERT INTO telemetry_tools (session_id, ts, tool, is_error, error) VALUES ('s2', 6, 'Bash', 1, 'cat: other cause (exit code 2)')").run();
    db.query("INSERT INTO telemetry_tools (session_id, ts, tool, is_error, error) VALUES ('s3', 6, 'Bash', 1, 'tail: no such option (exit code 1)')").run();
    const got = familyHas(db, { source: "tool", key }, [{ id: "s1", root: "s1" }, { id: "s2", root: "s2" }], 0, 100);
    expect([...got]).toEqual([["s1", 1], ["s2", 0]]);
    // A failure class: the agent's own count, under its parent's row.
    db.query("INSERT INTO session_failures VALUES ('top', 'fpx', 'agent', 'context', 'x', 3, 1, 50, ?)").run(JSON.stringify([{ id: "ag0", n: 2 }, { id: "ag2", n: 1 }]));
    expect([...familyHas(db, { source: "failure", key: "failure:fpx" }, [{ id: "s1", root: "s1" }, { id: "s2", root: "s2" }], 0, 100)]).toEqual([["s1", 1], ["s2", 0]]);
  });
  test("a review hit is of a class when its words are like the class's seed", () => {
    const words = wordsOf("builder did not run the full unit suite after its last fix");
    const h = (text: string): Hit => ({ source: "review", key: "", label: "", example: "", session: "", ts: 0, n: 1, words: wordsOf(text) });
    expect(ofClass({ source: "review", key: "review:x", words }, h("the unit suite was not run after the last fix"))).toBe(true);
    expect(ofClass({ source: "review", key: "review:x", words }, h("a test id carries the owner's data"))).toBe(false);
  });
  test("tables a store never made read as empty", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_id TEXT, workspace TEXT NOT NULL, machine TEXT, created INTEGER)");
    expect(hitsOf(db, 0)).toEqual([]);
  });
});

describe("what a failure's words carry to a model and the owner", () => {
  const home = "/home/someone";
  const token = "ghp_" + "abcdefghijklmnopqrstuv1234567890AB";
  test("an example folds the machine's folders and hides what is shaped like a key", () => {
    const got = exampleOf(`error: cannot open ${home}/projects/x/.env: token ${token} rejected (exit code 1)`, `${home}/projects/x`, home);
    expect(got).toBe("error: cannot open ./.env: token <redacted> rejected (exit code 1)");
    expect(exampleOf(`${home}/.local/share/keel-bun/state/worktrees/keel-bun-ad7b39/src/a.ts not found; see ${home}/projects/x.worktrees/feat/b.ts and ${home}/notes`, `${home}/projects/x`, home))
      .toBe("<worktree>/src/a.ts not found; see <worktree>/b.ts and ~/notes");
    // A folder is folded whole, never the start of a longer name.
    expect(exampleOf(`${home}/projects/x2/a.ts`, `${home}/projects/x`, home)).toBe("~/projects/x2/a.ts");
  });
  test("a reviewer's words are read with a leaked key hidden, in the class's words too", () => {
    const db = store();
    const now = 10 * 86_400_000;
    db.query("INSERT INTO sessions VALUES ('rv', 'top', '/r/a', NULL, 0)").run();
    db.query("INSERT INTO agents VALUES ('rva', 'rv', 'top', NULL, 9)").run();
    for (const i of [0, 1, 2]) db.query("INSERT INTO review_verdicts VALUES ('rva', ?, ?, 'no', ?, ?)").run(`c${i}`, JSON.stringify([`keel/b${i}`]), `The builder committed the deploy token ${token} into the fixture file config`, now - 10 + i);
    const [c] = mineRead(db, { now });
    expect(JSON.stringify(c)).not.toContain(token);
    expect(c!.examples[0]).toContain("<redacted>");
  });
  test("the prompts a model reads carry the vault's secrets as placeholders, and a plain draft names no path", () => {
    const home = homedir();
    const before = getConcealer();
    setConcealer({ text: (s) => s.split("hunter2-value").join("[secret:1a2b3c4d]"), pairs: () => [] });
    try {
      const c: Candidate = { key: "k", source: "tool", label: "Bash", repo: `${home}/projects/x`, repo_name: "x", failures: 5, sessions: 3, trees: 3, first_ts: 0, last_ts: 0,
        examples: [`login failed with hunter2-value for ${home}/projects/x/src/a.ts`], evidence: [] };
      const prompt = draftPrompt(c, "s1");
      expect(prompt).not.toContain("hunter2-value");
      expect(prompt).toContain("login failed with [secret:1a2b3c4d] for ./src/a.ts");
      expect(kindPrompt(`the fixture holds hunter2-value and ${token} at ${home}/x`, "s1")).toContain("the fixture holds [secret:1a2b3c4d] and <redacted> at ~/x");
      const plain = plainDraft(c);
      expect(plain).not.toContain("/");
      expect(plain).not.toContain("hunter2-value");
    } finally { setConcealer(before); }
  });
});

describe("what is shown and what a trial needs", () => {
  test("a trial's size finds a halved class four times in five, never under the trials' default", () => {
    expect(MIN_PER_ARM).toBe(FAMILIES_PER_ARM);
    expect(perArm(0.2)).toBe(197);
    expect(perArm(0.088)).toBe(496);
    expect(perArm(1)).toBe(MIN_PER_ARM);
    expect(perArm(0)).toBe(Number.POSITIVE_INFINITY);
    // A repository that starts 100 trees a day decides a class in a fifth of them in four days; one in 2% of them in months.
    expect(trialOf(0.2, 1400, 100)).toMatchObject({ per_arm: 197, trial_days: 4 });
    expect(decidable(trialOf(0.2, 1400, 100))).toBe(true);
    expect(decidable(trialOf(0.02, 1400, 100))).toBe(false);
  });
  test("a mine counts the repository's trees, and its candidate says what its trial needs", () => {
    const db = store();
    const now = 10 * 86_400_000;
    for (const [i, s] of ["s1", "s2", "s3"].entries()) db.query("INSERT INTO telemetry_tools (session_id, ts, tool, is_error, error) VALUES (?, ?, 'Bash', 1, 'tail: no such option (exit code 1)')").run(s, now - 1000 + i);
    // Twelve trees of the repository in the week: the class failed in three (the top-level session is one tree too).
    for (let i = 0; i < 8; i++) {
      db.query("INSERT INTO sessions VALUES (?, 'top', ?, NULL, 0)").run(`q${i}`, `/wt/q${i}`);
      db.query("INSERT INTO worktrees VALUES (?, '/r/a')").run(`q${i}`);
    }
    db.query("INSERT INTO worktrees VALUES ('top', '/r/a')").run();
    db.query("UPDATE sessions SET created = ?").run(now - 7 * 86_400_000);
    const [c] = mineRead(db, { now, days: 7 });
    expect(c).toMatchObject({ trees: 3, repo_trees: 12, rate: 0.25, per_arm: perArm(0.25), trees_a_day: 1.7 });
    expect(c!.trial_days).toBe(Math.ceil((2 * perArm(0.25)) / (12 / 7)));
  });
  test("the owner is shown the five causes in the most trees whose trial can decide; a settled one makes room", () => {
    const w = (id: string, trees: number, days = 3) => ({ id, evidence: { trees, failures: trees, trial_days: days } as Candidate });
    const waiting = [w("a", 3), w("b", 9), w("c", 40, 90), w("d", 7), w("e", 5), w("f", 4), w("g", 8), w("h", 6)];
    expect(toDraft(waiting, 0)).toEqual(["b", "g", "d", "h", "e"]);
    expect(toDraft(waiting, 3)).toEqual(["b", "g"]);
    expect(toDraft(waiting, SHOWN)).toEqual([]);
    expect(toDraft(waiting, 0, 1)).toEqual(["b"]);
  });
  test("a trial keeps its lesson when it won, drops it when it hurt, and leaves it in use, undecided, otherwise", () => {
    expect(fateOf({ winner: "with lesson", verdict: "won" })).toBe("kept");
    expect(fateOf({ winner: "without", verdict: "won" })).toBe("dropped");
    expect(fateOf({ winner: "without", verdict: "regression" })).toBe("dropped");
    expect(fateOf({ winner: null, verdict: "inconclusive" })).toBe("undecided");
  });
});
