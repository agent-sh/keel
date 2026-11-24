import { describe, expect, test } from "bun:test";
import { yieldOf, type AgentRow, type Facts, type RunRow, type VerdictRow } from "./review-yield.ts";

// Fixture rows, in milliseconds of a made-up clock. Builders: two on one model (one refused, then fixed and
// approved; one approved clean), three on another (refused and red; flaky red only; landing sent back).
const agent = (id: string, model: string, o: Partial<AgentRow> = {}): AgentRow => ({ id, session_id: `s-${id}`, type: "general-purpose", model, status: "completed", created: 100, ended: 1000, branch: null, reviews: null, ...o });
const verdict = (agent_id: string, commit_sha: string, branches: string[], land: "yes" | "no", at: number): VerdictRow => ({ agent_id, commit_sha, branches: JSON.stringify(branches), land, at });
const run = (session_id: string, head: string, result: string, ended: number, key = "unit", tree = `tree-${head}`): RunRow => ({ session_id, head, result, ended, key, tree });
const SON = "p:sonnet", OPU = "p:opus";

const facts = (): Facts => ({
  agents: [
    agent("b1", SON, { branch: "keel/a" }), agent("b2", SON, { branch: "keel/b" }),
    agent("b3", OPU, { branch: "keel/c" }), agent("b4", OPU, { branch: "keel/d" }), agent("b5", OPU, { branch: "keel/e" }),
    agent("b6", OPU, { branch: "keel/f", type: "Explore", status: "failed" }),   // never done
    agent("b7", OPU, { branch: "keel/g", created: 5 }),                          // started before the range
    agent("r1", SON, { branch: "keel/review-r1", reviews: "[]" }), agent("r2", OPU, { reviews: "[]" }), agent("r3", SON, { reviews: "[]" }),
  ],
  verdicts: [
    verdict("r1", "c1", ["keel/a", "keel/review-r1"], "no", 2000),
    verdict("r1", "c2", ["keel/a"], "yes", 3000),
    verdict("r1", "c3", ["keel/b"], "yes", 2500),
    verdict("r2", "c4", ["keel/c"], "no", 2200),
    verdict("b3", "c4", ["keel/c"], "yes", 2300),    // a builder's word on its own branch is no review
  ],
  runs: [
    run("s-b1", "c2", "pass", 2800),                  // the builder moved on after the refusal
    run("s-b3", "h3", "pass", 900, "unit", "tree-own"),                 // the head b3 reported
    run("s-x", "h3", "fail", 1500),                   // another session: red on it, no pass of the same check on those files
    run("s-b4", "h4", "pass", 900), run("s-y", "h4", "fail", 1500, "unit", "t4"), run("s-y", "h4", "pass", 1600, "unit", "t4"),   // flaky: not red
    run("s-b2", "c3", "pass", 900, "unit", "tree-own2"), run("s-z", "c3", "fail", 2000),                                                          // red, then approved: not red
  ],
  landings: [{ branch: "keel/e", state: "left", tries: 0 }, { branch: "keel/d", state: "landed", tries: 0 }],
  costs: [{ session_id: "s-r1", usd: 2, unpriced: 0 }, { session_id: "s-r2", usd: 4, unpriced: 0 }, { session_id: "s-r3", usd: 1, unpriced: 3 }],
});

describe("builders", () => {
  const read = yieldOf(facts(), 50, 10_000);
  const line = (model: string) => read.builders.find((b) => b.model === model)!;

  test("a done lane is contradicted by a refusal, a red check on its head, or a landing sent back", () => {
    expect(line(SON)).toMatchObject({ done: 2, reviewed: 2, refused: 1, red: 0, landing: 0, contradicted: 1, rate: 0.5 });
    expect(line(OPU)).toMatchObject({ done: 3, reviewed: 1, refused: 1, red: 1, landing: 1, contradicted: 2 });
    expect(line(OPU).rate).toBeCloseTo(2 / 3);
  });
  test("a lane that is not done, or started before the range, is not counted; the line is by model and type", () => {
    expect(read.builders.map((b) => [b.model, b.type, b.done])).toEqual([[OPU, "general-purpose", 3], [SON, "general-purpose", 2]]);
  });
  test("a flaky red, and a red that an approval followed, is not a contradiction", () => {
    // b4: its head failed once and passed on the same files; b2: red at 2000, approved at 2500.
    expect(line(SON).red).toBe(0);
    expect(line(OPU).red).toBe(1);
  });
  test("a builder that gave a verdict is a reviewer, not a lane", () => {
    expect(yieldOf({ ...facts(), agents: facts().agents.map((a) => (a.id === "b1" ? { ...a, reviews: "[]" } : a)) }, 50, 10_000).builders.find((b) => b.model === SON)?.done).toBe(1);
  });
});

describe("reviewers", () => {
  const read = yieldOf(facts(), 50, 10_000);
  test("refusals a later move of the branch confirmed, per review dollar, with the rounds of the lanes", () => {
    expect(read.reviewers.find((r) => r.model === SON)).toMatchObject({ reviewers: 2, verdicts: 3, refusals: 1, confirmed: 1, usd: 3, unpriced: 3, lanes: 2, rounds_per_lane: 1.5, usd_per_confirmed: 3 });
    expect(read.reviewers.find((r) => r.model === SON)!.confirmed_per_usd).toBeCloseTo(1 / 3);
  });
  test("a refusal the branch never moved on from is not confirmed, and a model with no confirmed has no price of one", () => {
    expect(read.reviewers.find((r) => r.model === OPU)).toMatchObject({ reviewers: 1, verdicts: 1, refusals: 1, confirmed: 0, usd: 4, lanes: 1, rounds_per_lane: 1, confirmed_per_usd: 0, usd_per_confirmed: null });
  });
  test("a later verdict on the same commit does not confirm a refusal", () => {
    const f = facts();
    f.verdicts = f.verdicts.filter((v) => v.commit_sha !== "c2");
    f.runs = f.runs.filter((r) => r.session_id !== "s-b1");
    expect(yieldOf(f, 50, 10_000).reviewers.find((r) => r.model === SON)!.confirmed).toBe(0);
  });
  test("no spend is no yield per dollar", () => {
    const f = facts();
    f.costs = [];
    expect(yieldOf(f, 50, 10_000).reviewers.find((r) => r.model === SON)!.confirmed_per_usd).toBeNull();
  });
});
