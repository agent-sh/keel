import { describe, expect, test } from "bun:test";
import { dueAt, newestSentence, NOW_MS, nowPrint, nowWords, statusLine } from "./now-line.ts";

describe("an agent's now line", () => {
  test("the newest whole sentence of its thinking", () => {
    expect(newestSentence("I should look at the tests first. Reading the store schema.")).toBe("Reading the store schema.");
    expect(newestSentence("Reading the store schema. Then I")).toBe("Reading the store schema.");
    expect(newestSentence("Reading the store schema. Then the migration in the second file needs")).toBe("Then the migration in the second file needs");
    expect(newestSentence("**Plan**\n\nCheck `agents.ts` for the slot gate")).toBe("Check agents.ts for the slot gate");
    expect(newestSentence("")).toBe("");
    expect(newestSentence("x".repeat(400)).length).toBe(160);
  });

  test("thinking first, then the running call as the transcript says it, then the wait", () => {
    expect(nowWords({ thinking: "Reading the store schema.", calls: [{ name: "Bash", input: { command: "sleep 20" } }] })).toEqual({ text: "Reading the store schema.", from: "thinking" });
    expect(nowWords({ calls: [{ name: "Bash", input: { command: "bun test" } }] })).toEqual({ text: "Running bun test", from: "tool" });
    expect(nowWords({ calls: [{ name: "Read", input: { file_path: "/w/src/a.ts" } }], cwd: "/w" })).toEqual({ text: "Reading src/a.ts", from: "tool" });
    expect(nowWords({ waits: "a timer" })).toEqual({ text: "Waiting for a timer", from: "wait" });
    expect(nowWords({})).toEqual({ text: "", from: "none" });
  });

  test("a call whose line names only its tool says what its input is about", () => {
    // (Prose the model wrote is quoted and marked as its words; a URL, a path or a command is the call itself.)
    expect(nowWords({ calls: [{ name: "WaitFor", input: { kind: "log", note: "the build to finish" } }] })).toEqual({ text: "Using WaitFor: \u201cthe build to finish\u201d (its note)", from: "tool" });
    expect(nowWords({ calls: [{ name: "Agent", input: { prompt: "Fix the parser" } }] })).toEqual({ text: "Using Agent: \u201cFix the parser\u201d (its prompt)", from: "tool" });
    expect(nowWords({ calls: [{ name: "Bash", input: { command: "bun run build", description: "The long build" } }] })).toEqual({ text: "\u201cThe long build\u201d (its description)", from: "tool" });
    expect(nowWords({ calls: [{ name: "mcp__web__fetch", input: { url: "https://example.com/a" } }] })).toEqual({ text: "Calling mcp__web__fetch: https://example.com/a", from: "tool" });
    // A line that already says what it does is kept as it is.
    expect(nowWords({ calls: [{ name: "Bash", input: { command: "bun test", note: "x" } }] })).toEqual({ text: "Running bun test", from: "tool" });
    expect(nowWords({ calls: [{ name: "Thing", input: { n: 1 } }] })).toEqual({ text: "Using Thing", from: "tool" });
    // A call's words are not markdown: a path keeps its underscores.
    expect(nowWords({ calls: [{ name: "Read", input: { file_path: "/w/src/my_file.ts" } }], cwd: "/w" })).toEqual({ text: "Reading src/my_file.ts", from: "tool" });
  });

  test("a change is told at once the first time and when the owner is needed, else after the interval", () => {
    expect(dueAt(undefined, false, 1000)).toBe(1000);
    expect(dueAt({ at: 1000 }, false, 2000)).toBe(1000 + NOW_MS);
    expect(dueAt({ at: 1000 }, false, 1000 + NOW_MS + 5)).toBe(1000 + NOW_MS + 5);
    expect(dueAt({ at: 1000 }, true, 2000)).toBe(2000);
    expect(dueAt({ at: 1000, need: true }, true, 2000)).toBe(1000 + NOW_MS);
  });

  test("its clock is no change; its words, steps, cents and the owner's part are", () => {
    const l = { text: "Running bun test", steps: 3, usd: 0.311, need: false, since: 5 };
    expect(nowPrint(l)).toBe(nowPrint({ ...l, usd: 0.312 }));
    expect(nowPrint(l)).not.toBe(nowPrint({ ...l, steps: 4 }));
    expect(nowPrint(l)).not.toBe(nowPrint({ ...l, need: true }));
  });

  test("the parent's status read is one line an agent", () => {
    const l = { agent_id: "a1", session_id: "s", parent_id: "p", text: "Running bun test", from: "tool" as const, steps: 12, since: 0, usd: 0.31, at: 0, title: "Counter", status: "running" };
    expect(statusLine(l, 4 * 60_000)).toBe("Counter (a1): Running bun test · 12 steps, 4 min, $0.31");
    expect(statusLine({ ...l, need: true, usd: 0 }, 35_000)).toBe("Counter (a1): needs the owner · 12 steps, 35 s");
    expect(statusLine(l, 2 * 3600_000 + 5 * 60_000)).toBe("Counter (a1): Running bun test · 12 steps, 2 h 5 min, $0.31");
    // Calls of a model with no listed price leave its spend short, and it says so.
    expect(statusLine({ ...l, unpriced: 4 }, 0)).toBe("Counter (a1): Running bun test · 12 steps, 0 s, $0.31 and unpriced calls");
    expect(statusLine({ ...l, usd: 0, unpriced: 4 }, 0)).toBe("Counter (a1): Running bun test · 12 steps, 0 s, no price listed");
  });
});
