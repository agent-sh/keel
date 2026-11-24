import { expect, test } from "bun:test";
import { asksBelow, below, rootOf } from "./agent-tree.ts";

const a = (id: string, parent: string, created: number) => ({ id: `a-${id}`, session_id: id, parent_id: parent, title: id.toUpperCase(), created });

test("the agents under a session come with their paths, at any depth, branch first", () => {
  const agents = Object.fromEntries([a("b", "a", 3), a("a", "root", 1), a("c", "root", 2), a("x", "other", 1), a("d", "b", 4)].map((r) => [r.id, r]));
  expect(below(agents, "root").map((r) => r.path.map((p) => p.title).join(">"))).toEqual(["A", "A>B", "A>B>D", "C"]);
});

test("a loop in the records ends the walk", () => {
  const agents = Object.fromEntries([a("a", "root", 1), a("b", "a", 2), a("root", "b", 3)].map((r) => [r.id, r]));
  expect(below(agents, "root").map((r) => r.agent.session_id)).toEqual(["a", "b"]);
});

test("the root is the last known parent", () => {
  const up: Record<string, string> = { d: "b", b: "a", a: "root" };
  expect(rootOf((id) => up[id], "d")).toBe("root");
  expect(rootOf((id) => ({ d: "b" } as Record<string, string>)[id], "d")).toBe("b");
  expect(rootOf((id) => ({ x: "y", y: "x" } as Record<string, string>)[id], "x")).toBe("y");
});

test("only an asking agent of the tree makes it worth walking", () => {
  const agents = Object.fromEntries([a("a", "root", 1), a("b", "a", 2), a("x", "other", 1), a("y", "x", 2)].map((r) => [r.id, r]));
  expect(asksBelow(agents, "root", [])).toBe(false);
  expect(asksBelow(agents, "root", ["x", "y", "root", "unknown"])).toBe(false);
  expect(asksBelow(agents, "root", ["y", "b"])).toBe(true);
  expect(asksBelow(agents, "other", ["b"])).toBe(false);
  const loop = Object.fromEntries([a("a", "b", 1), a("b", "a", 2)].map((r) => [r.id, r]));
  expect(asksBelow(loop, "root", ["a"])).toBe(false);
});
