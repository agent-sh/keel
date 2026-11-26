import { describe, expect, test } from "bun:test";
import { pickTier, tierLine, tiersProblem, type Tier } from "./tiers.ts";

// A table in the shape the owner gives one; the ids are made up (nothing here is a real model).
const TABLE: Tier[] = [
  { name: "delicate", model: "p:big", effort: "high", use: ["review"] },
  { name: "build", model: "p:mid", effort: "medium", use: ["default"] },
  { name: "research", model: "q:deep", effort: "high", use: ["survey"] },
  { name: "simple", model: "q:small", effort: "high" },
  { name: "reader", model: "q:small" },
];
const LISTED = [
  { id: "p:big", model: "big", efforts: ["low", "medium", "high"] },
  { id: "p:mid", model: "mid", efforts: ["low", "medium", "high"] },
  { id: "q:deep", model: "deep", efforts: ["high"] },
  { id: "q:small", model: "small", efforts: ["low", "high"] },
];

describe("pickTier", () => {
  test("the spawn's tier, by name or by a kind it lists, goes first", () => {
    expect(pickTier(TABLE, { asked: "simple", type: "general-purpose" }, LISTED)).toEqual({ pick: { tier: "simple", model: "q:small", effort: "high", why: "the spawn names tier simple", passed: [] }, by: "asked" });
    const r = pickTier(TABLE, { asked: "Survey", type: "general-purpose" }, LISTED) as any;
    expect(r.pick.tier).toBe("research");
    expect(r.pick.why).toBe("the spawn names the kind Survey, which tier research lists");
  });
  test("a tier the table lacks is refused with the tiers it has", () => {
    expect((pickTier(TABLE, { asked: "fastest", type: "general-purpose" }, LISTED) as any).error).toContain("delicate, build, research, simple, reader");
  });
  test("the definition's tier, then the type a tier lists, then the reader tier for Explore, then the default", () => {
    expect((pickTier(TABLE, { defTier: "research", type: "scout" }, LISTED) as any).pick.why).toBe("its type scout names tier research");
    expect((pickTier(TABLE, { type: "Review" }, LISTED) as any).pick).toMatchObject({ tier: "delicate", why: "tier delicate lists the type Review" });
    expect((pickTier(TABLE, { type: "Explore", explore: true }, LISTED) as any).pick).toMatchObject({ tier: "reader", model: "q:small", why: "Explore agents use the reader tier" });
    expect((pickTier(TABLE, { type: "general-purpose" }, LISTED) as any).pick).toMatchObject({ tier: "build", effort: "medium", why: "tier build is for every other agent" });
  });
  test("no row applies: nothing changes", () => {
    expect(pickTier([], { type: "general-purpose" }, LISTED)).toBeUndefined();
    expect(pickTier(TABLE.filter((t) => t.name !== "build"), { type: "general-purpose" }, LISTED)).toBeUndefined();
  });
  test("a model that does not list falls to the next tier, said in the line", () => {
    const listed = LISTED.filter((m) => m.id !== "p:mid");
    const r = pickTier(TABLE, { type: "general-purpose" }, listed) as any;
    expect(r.pick).toMatchObject({ tier: "research", model: "q:deep", effort: "high", why: "tier build is for every other agent, in place of tier build" });
    expect(r.pick.passed).toEqual(["tier build's model p:mid is not listed now"]);
    expect(tierLine(r.pick)).toBe("Tier research: q:deep at high effort, because tier build is for every other agent, in place of tier build. Not taken: tier build's model p:mid is not listed now.");
  });
  test("a model that takes no work now gives way too; none left says why each did not", () => {
    const r = pickTier(TABLE, { asked: "simple", type: "x", readOnly: true }, LISTED, (id) => (id === "q:small" ? "is out of credit" : undefined)) as any;
    expect(r).toEqual({ none: ["tier simple's model q:small is out of credit", "tier reader's model q:small is out of credit"] });
  });
  test("an effort the model does not list is left off and said", () => {
    const r = pickTier([{ name: "a", model: "q:deep", effort: "medium", use: ["default"] }], { type: "x" }, LISTED) as any;
    expect(r.pick.effort).toBeUndefined();
    expect(r.pick.passed).toEqual(["tier a's effort medium: q:deep does not list it"]);
  });
  test("an agent that does more than read never falls to the reader tier", () => {
    const r = pickTier(TABLE, { asked: "simple", type: "x" }, LISTED, (id) => (id === "q:small" ? "is out of credit" : undefined)) as any;
    expect(r).toEqual({ none: ["tier simple's model q:small is out of credit", "tier reader is for agents that only read"] });
    const table: Tier[] = [{ name: "build", model: "p:gone", use: ["default"] }, { name: "reader", model: "q:small" }, { name: "simple", model: "q:deep" }];
    expect((pickTier(table, { type: "x" }, LISTED) as any).pick).toMatchObject({ tier: "simple", passed: ["tier build's model p:gone is not listed now", "tier reader is for agents that only read"] });
    expect((pickTier(table, { type: "Explore", explore: true, readOnly: true }, LISTED) as any).pick.tier).toBe("reader");
  });
  test("the row's kind is told, so the tier for every other agent can give way to a trial", () => {
    expect((pickTier(TABLE, { type: "general-purpose" }, LISTED) as any).by).toBe("every");
    expect((pickTier(TABLE, { type: "Review" }, LISTED) as any).by).toBe("type");
    expect((pickTier(TABLE, { type: "Explore", explore: true }, LISTED) as any).by).toBe("explore");
  });
  test("a model several providers list is tried on each, past the ones that take no work", () => {
    const listed = [{ id: "a:twin", model: "twin" }, { id: "b:twin", model: "twin" }];
    const r = pickTier([{ name: "t", model: "twin", use: ["default"] }], { type: "x" }, listed, (id) => (id === "a:twin" ? "is out of credit" : undefined)) as any;
    expect(r.pick.model).toBe("b:twin");
    const none = pickTier([{ name: "t", model: "twin", use: ["default"] }], { type: "x" }, listed, () => "is shut") as any;
    expect(none).toEqual({ none: ["tier t's model twin is shut"] });
  });
  test("a model is named by id or as its provider names it", () => {
    expect((pickTier([{ name: "a", model: "deep", use: ["default"] }], { type: "x" }, LISTED) as any).pick.model).toBe("q:deep");
  });
});

describe("tiersProblem", () => {
  test("a table holds", () => expect(tiersProblem(TABLE)).toBeUndefined());
  test("bad rows are named", () => {
    expect(tiersProblem({})).toContain("list");
    expect(tiersProblem([{ name: "a", model: "" }])).toContain("model");
    expect(tiersProblem([{ name: "a", model: "m" }, { name: "A", model: "m" }])).toContain("two tiers");
    expect(tiersProblem([{ name: "a", model: "m", use: [3] }])).toContain("use");
    expect(tiersProblem([{ name: "a", model: "m", color: "red" }])).toContain("no field color");
  });
});
