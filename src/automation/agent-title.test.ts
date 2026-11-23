import { expect, test } from "bun:test";
import { agentTitle, fromTaskName } from "./agent-title.ts";

const study = (n: number) => `Harness ${n} cache study. Study how harness ${n} saves prompt-cache tokens. Report the numbers with sources and the files you read.`;

test("a spawn's own name is the title", () => {
  expect(agentTitle({ title: "Review the store", prompt: study(3) })).toBe("Review the store");
  expect(agentTitle({ task_name: "harness_3_cache_study", prompt: study(3) })).toBe("Harness 3 cache study");
  expect(fromTaskName("review-auth")).toBe("Review auth");
  expect(fromTaskName("Already words")).toBe("Already words");
});

test("a long first line is named by its first sentence, not cut mid-line", () => {
  const titles = [1, 2, 10].map((n) => agentTitle({ prompt: study(n) }));
  expect(titles).toEqual(["Harness 1 cache study", "Harness 2 cache study", "Harness 10 cache study"]);
});

test("a short first line stays whole, and a line with no early stop is cut at a word", () => {
  expect(agentTitle({ prompt: "Worker\nscript:calls []" })).toBe("Worker");
  expect(agentTitle({ prompt: "\n  Look at v1.2 of a.ts\nmore" })).toBe("Look at v1.2 of a.ts");
  const long = "Read every file under src and list what each one exports along with who imports it and from where in the tree";
  const t = agentTitle({ prompt: long });
  expect(t.length).toBeLessThanOrEqual(80);
  expect(t.endsWith("…")).toBe(true);
  expect(long.startsWith(t.slice(0, -1))).toBe(true);
  expect(t.slice(0, -1).endsWith(" ")).toBe(false);
});
