import { describe, expect, test } from "bun:test";
import type { Session } from "../core/types.ts";
import type { ModelInfo } from "../providers/types.ts";
import { explores, nextRun, readSteps, NOTE_AT, readerFor, readNote, readRunsOf, START, stepsPerRead, type ReadStep, type RunState } from "./read-run.ts";

const model = (id: string, price: { input: number; cache_read: number }, context = 1_000_000): ModelInfo => ({
  id: `p:${id}`, provider: "p", model: id, name: id, family: "claude", context, output: 64_000, efforts: [], billing: "per_token", price: { ...price, output: price.input * 5, cache_write: price.input * 1.25 },
});

describe("explores", () => {
  test("a local read of any family, or a shell command that changes nothing", () => {
    for (const [name, input] of [["Read", { file_path: "a.ts" }], ["Grep", { pattern: "x" }], ["Glob", { pattern: "*.ts" }], ["read_file", { file_path: "a" }],
      ["list_directory", { dir_path: "." }], ["Bash", { command: "cat a.ts; rg -n foo src | head" }], ["exec_command", { cmd: "sed -n 1,20p a.ts" }]] as const)
      expect(explores(name, input)).toBe(true);
  });
  test("not a change, a fetch, a wait, a plan, a sleep or another machine", () => {
    for (const [name, input] of [["Edit", { file_path: "a" }], ["Bash", { command: "rm a" }], ["Bash", { command: "curl -s http://x" }], ["Bash", { command: "sleep 30" }],
      ["WebFetch", { url: "http://x" }], ["WaitFor", { kind: "timer" }], ["TodoWrite", {}], ["keel__run_on", { command: "ls" }], ["Bash", {}]] as const)
      expect(explores(name, input)).toBe(false);
  });
});

describe("nextRun", () => {
  const walk = (steps: ReadStep[]) => {
    let s: RunState = START;
    return steps.map((st) => { const r = nextRun(s, st); s = r.state; return r.note; });
  };
  const one = { calls: 1, reads: 1 }, two = { calls: 2, reads: 2 }, edit = { calls: 1, reads: 0 }, text = { calls: 0, reads: 0 };
  test("the note comes at the second single-call read in a row, once a run", () => {
    expect(NOTE_AT).toBe(2);
    expect(walk([one, one, one, one])).toEqual([false, true, false, false]);
  });
  test("a step that does anything else ends the run, and the next run is told again", () => {
    expect(walk([one, edit, one, one, text, one, one])).toEqual([false, false, false, true, false, false, true]);
  });
  test("a step with a call that writes is not a read step", () => {
    expect(walk([one, { calls: 2, reads: 1 }, one, one])).toEqual([false, false, false, true]);
  });
  test("a run that already batches is not told", () => {
    expect(walk([two, one, one])).toEqual([false, false, false]);
    expect(walk([one, two, one])).toEqual([false, false, false]);
  });
});

test("stepsPerRead: read-only steps over their reads; null with none", () => {
  expect(stepsPerRead([{ calls: 1, reads: 1 }, { calls: 3, reads: 3 }, { calls: 1, reads: 0 }, { calls: 0, reads: 0 }])).toBe(0.5);
  expect(stepsPerRead([{ calls: 1, reads: 1 }, { calls: 1, reads: 1 }])).toBe(1);
  expect(stepsPerRead([{ calls: 2, reads: 1 }])).toBeNull();
});

test("readSteps: a turn's events, an edit beside a read not a read-only step", () => {
  const step = (...calls: [string, unknown][]) => ({ kind: "assistant" as const, data: { blocks: [{ type: "thinking" }, ...calls.map(([name, input], k) => ({ type: "tool_use", id: String(k), name, input }))] } });
  expect(readSteps([step(["Read", { file_path: "a" }]), { kind: "tool_result", data: {} },
    step(["Grep", { pattern: "x" }], ["Bash", { command: "cat b" }], ["Glob", { pattern: "*" }]), step(["Read", { file_path: "c" }], ["Edit", { file_path: "c" }])])).toBe(0.5);
  expect(readSteps([{ kind: "user", data: { text: "hi" } }])).toBeNull();
});

test("readRunsOf: agents take the nearest setting up their tree", () => {
  const s = (id: string, parent_id: string | undefined, settings: Session["settings"] = {}) => ({ id, parent_id, settings }) as Session;
  const all = new Map([["root", s("root", undefined, { read_runs: "reader" })], ["a", s("a", "root")], ["b", s("b", "a", { read_runs: "batch" })], ["c", s("c", "b")]]);
  const up = (id: string) => all.get(id);
  expect(readRunsOf(all.get("root")!, up)).toBeUndefined();
  expect(readRunsOf(all.get("a")!, up)).toBe("reader");
  expect(readRunsOf(all.get("c")!, up)).toBe("batch");
  expect(readRunsOf(s("x", "gone"), up)).toBeUndefined();
});

describe("readerFor", () => {
  const big = model("big", { input: 4, cache_read: 0.4 }), small = model("small", { input: 0.1, cache_read: 0.01 });
  test("the cheapest of the session's own provider and family, when it holds the session's window", () => {
    expect(readerFor([big, small], big, {}, () => undefined, [])?.id).toBe("p:small");
    expect(readerFor([big, model("tiny", { input: 0.1, cache_read: 0.01 }, 200_000)], big, {}, () => undefined, [])).toBeUndefined();
  });
  test("the owner's small model first; none when it is not cheaper than the session's own", () => {
    const other = model("other", { input: 1, cache_read: 0.1 });
    expect(readerFor([big, small, other], big, {}, () => undefined, ["p:other"])?.id).toBe("p:other");
    expect(readerFor([big, small], small, {}, () => undefined, [])).toBeUndefined();
  });
});

test("readNote says the context, its price, and the reader where there is one", () => {
  const n = readNote(412_345, 0.2);
  expect(n).toStartWith("[harness] 2 read-only steps in a row, one call each.");
  expect(n).toContain("(412K tokens, about $0.08)");
  expect(n).toContain("parallel calls in one step");
  expect(n).not.toContain("Explore");
  expect(readNote(900)).toContain("(900 tokens)");
  const r = readNote(300_000, 0.4, { start: "an Explore agent (Agent with subagent_type Explore)", model: "small", share: 0.025 });
  expect(r).toContain("an Explore agent (Agent with subagent_type Explore) searches in its own context on small, which reads at 1/40 of this model's price");
});
