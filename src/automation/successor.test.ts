import { expect, test } from "bun:test";
import { capsuleBrief, decideSuccessor, givenUpNote, lossOf, otherFamily, parentLine, rewordHolds, taskWithSteers, type Lost } from "./successor.ts";

const lost = (kind: Lost["kind"], family: Lost["family"], model = `p:${family}`): Lost => ({ kind, model, family, session: "s", at: 1 });

test("a loss is a refusal, a full context or the provider; any other end is not", () => {
  expect(lossOf({ status: "incomplete", end_reason: "refusal" })).toBe("refusal");
  expect(lossOf({ status: "failed", end_reason: "error", cls: "context_overflow" })).toBe("context");
  for (const cls of ["overloaded", "server", "stream_drop", "rate_limit"]) expect(lossOf({ status: "failed", end_reason: "error", cls })).toBe("provider");
  // Its own end, a limit it was given (a turn's step budget is the owner's or its definition's), a stop,
  // or a failure a fresh context would meet again.
  expect(lossOf({ status: "completed", end_reason: "end_turn" })).toBeUndefined();
  expect(lossOf({ status: "incomplete", end_reason: "max_steps" })).toBeUndefined();
  expect(lossOf({ status: "incomplete", end_reason: "budget" })).toBeUndefined();
  expect(lossOf({ status: "incomplete", end_reason: "max_tokens" })).toBeUndefined();
  expect(lossOf({ status: "stopped", end_reason: "interrupted" })).toBeUndefined();
  for (const cls of ["auth", "quota", "invalid_request", "image", "schema", "other", "unreachable"]) expect(lossOf({ status: "failed", end_reason: "error", cls })).toBeUndefined();
  // A provider failure while its outage is open, or with a wait the provider asked for past a turn's: not a loss.
  expect(lossOf({ status: "failed", end_reason: "error", cls: "server", outage: true })).toBeUndefined();
  expect(lossOf({ status: "failed", end_reason: "error", cls: "rate_limit", retryAt: Date.now() + 3_600_000 })).toBeUndefined();
  // A refusal or a full context is the context's own, outage or not.
  expect(lossOf({ status: "incomplete", end_reason: "refusal", outage: true })).toBe("refusal");
  expect(lossOf({ status: "failed", end_reason: "restart", cls: "server" })).toBeUndefined();
});

test("the first refusal goes on with the same model, the second moves family, the third tells the parent", () => {
  expect(decideSuccessor("refusal", [], "gpt")).toEqual({ go: true, n: 1, switchFamily: false, avoid: [] });
  expect(decideSuccessor("refusal", [lost("refusal", "gpt")], "gpt")).toEqual({ go: true, n: 2, switchFamily: true, avoid: ["gpt"] });
  const third = decideSuccessor("refusal", [lost("refusal", "gpt"), lost("refusal", "other")], "other");
  expect(third.go).toBe(false);
  // A refusal after another loss is the first refusal: the same family.
  expect(decideSuccessor("refusal", [lost("provider", "claude")], "claude")).toMatchObject({ go: true, n: 2, switchFamily: false });
  // Losses that are not refusals never move family, and are bounded the same.
  expect(decideSuccessor("context", [lost("provider", "claude")], "claude")).toMatchObject({ go: true, switchFamily: false });
  expect(decideSuccessor("provider", [lost("provider", "claude"), lost("provider", "claude")], "claude").go).toBe(false);
});

test("another family: the parent's model, the owner's default, the same provider's newest, then any", () => {
  const models = [
    { id: "a:claude-1", provider: "a", family: "claude" as const, release: "2026-01" },
    { id: "a:gpt-old", provider: "a", family: "gpt" as const, release: "2025-01" },
    { id: "a:gpt-new", provider: "a", family: "gpt" as const, release: "2026-05" },
    { id: "b:gemini", provider: "b", family: "gemini" as const, release: "2026-09" },
    { id: "b:notools", provider: "b", family: "other" as const, tools: false },
  ];
  const base = { current: "a:claude-1", avoid: ["claude" as const] };
  expect(otherFamily(models, { ...base, parent: "b:gemini" })).toBe("b:gemini");
  expect(otherFamily(models, { ...base, parent: "a:claude-1", preferred: "a:gpt-old" })).toBe("a:gpt-old");
  expect(otherFamily(models, base)).toBe("a:gpt-new");
  expect(otherFamily(models, { current: "a:claude-1", avoid: ["claude", "gpt"] })).toBe("b:gemini");
  expect(otherFamily(models, { current: "a:claude-1", avoid: ["claude", "gpt", "gemini"] })).toBeUndefined();
});

test("the capsule holds the facts and the task, the parent's line is one line", () => {
  const text = capsuleBrief({
    title: "Fix the parser", task: "Make the parser accept empty input.", reworded: false, loss: "refusal", category: "cyber_policy",
    did: "4 steps, 6 tool calls; edited src/parse.ts", worktree: "/w/x", branch: "keel/x", head: { id: "abc123", subject: "Add a test" }, files: ["src/parse.ts", "src/parse.test.ts"],
    checks: "unit passed on this tree", failure: "the model declined (cyber_policy)", lost: [],
  });
  for (const want of ["fresh context", "cyber_policy", "/w/x", "keel/x", "Branch head: abc123", "src/parse.test.ts", "unit passed", "Make the parser accept empty input."]) expect(text).toContain(want);
  // After a refusal the commit's subject (the lost context's words) is left out; after another loss it is there.
  expect(text).not.toContain("Add a test");
  const facts = { title: "t", task: "x", reworded: false, did: "", files: [], checks: "", head: { id: "abc123", subject: "Add a test" } };
  expect(capsuleBrief({ ...facts, loss: "context", lost: [] })).toContain("Branch head: abc123 Add a test");
  expect(capsuleBrief({ ...facts, loss: "context", lost: [lost("refusal", "gpt")] })).not.toContain("Add a test");
  expect(text).not.toContain("second fresh start");
  expect(capsuleBrief({ title: "t", task: "x", reworded: true, loss: "context", did: "", files: [], checks: "", lost: [lost("refusal", "gpt")] })).toContain("second fresh start");
  const line = parentLine({ title: "Fix", id: "ab12", loss: "refusal", category: "cyber", n: 2, model: "p:m", moved: true });
  expect(line.split("\n")).toHaveLength(1);
  expect(line).toContain("another family");
  expect(givenUpNote({ why: "2 successors were started", lost: [lost("refusal", "gpt", "p:g"), lost("refusal", "other", "p:o")] })).toContain("p:g, p:o");
});

test("a restated brief holds only when it is one", () => {
  const task = "Build the cache layer for the reader and check it with the unit suite and one e2e.";
  expect(rewordHolds(task, "Build the cache layer for the reader; check it with the unit suite and one e2e test.")).toBe(true);
  expect(rewordHolds(task, "")).toBe(false);
  expect(rewordHolds(task, "Build it.")).toBe(false);
  expect(rewordHolds(task, "I can't help with restating this brief, it looks like it asks for something else entirely.")).toBe(false);
});

test("a successor's task carries the messages its parent sent to every earlier context", () => {
  expect(taskWithSteers("Do x.", [])).toBe("Do x.");
  const t = taskWithSteers("Do x.", ["first, to context 1", "then, to context 2"]);
  expect(t.indexOf("first, to context 1")).toBeLessThan(t.indexOf("then, to context 2"));
  expect(t.startsWith("Do x.\n\nMessages from the session that started you, oldest first:")).toBe(true);
});
