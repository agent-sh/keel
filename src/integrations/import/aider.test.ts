// Aider's history files, written in the layout Aider's own input/output class writes
// (`.aider.chat.history.md` and `.aider.input.history` in a project folder), with invented content.
// A history file holds many runs, each begun by "# aider chat started at <time>"; a run is a session.
import { expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownEnv, tempTree } from "../../../test/env.ts";
import { aiderStore } from "./aider.ts";

const root = tempTree("keel-aider-");
ownEnv({ KEEL_IMPORT_AIDER_DIR: root });

const user = (text: string) => "\n" + text.split("\n").map((l) => `#### ${l}  `).join("\n") + "\n";
const tool = (...lines: string[]) => lines.map((l) => `> ${l}  `).join("\n") + "\n";
const header = (t: string) => `\n# aider chat started at ${t}\n\n`;
const input = (entries: [string, string][]) => entries.map(([t, text]) => `\n# ${t}\n${text.split("\n").map((l) => `+${l}`).join("\n")}\n`).join("");

const fruit = join(root, "fruit-stand");
mkdirSync(fruit, { recursive: true });
const FIRST = "2026-11-02 09:30:00", SECOND = "2026-11-03 18:00:00", EMPTY = "2026-11-04 08:00:00";
const announce = (model: string) => tool("Aider v0.86.2", `Main model: ${model} with diff edit format`, "Git repo: .git with 3 files", "Repo-map: using 1024 tokens, auto refresh");
writeFileSync(join(fruit, ".aider.chat.history.md"), [
  header(FIRST) + announce("fruit-model") + user("Rename the mango function\nand add a test") +
    "\nI will rename it.\n\n# A heading the model wrote\nmango.py\n```python\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n```\n\n" +
    tool("Applied edit to mango.py", "Commit abc1234 rename mango") +
    user("/run pytest") + tool("Run shell command? (Y)es/(N)o [Yes]: y", "Warning: one test failed") +
    "\nThe test failed because of the fixture.\n",
  header(SECOND) + announce("papaya-model") + user("<blank>") + user("Why is the papaya green?") + "\nIt is unripe.\n\n" + tool("Tokens: 1.2k sent, 40 received.") + user("Thanks"),
  header(EMPTY) + announce("papaya-model"),
].join(""));
writeFileSync(join(fruit, ".aider.input.history"), input([
  [FIRST + ".100000", "Rename the mango function\nand add a test"],
  ["2026-11-02 09:41:00.000000", "/run pytest"],
  [SECOND + ".000000", "Why is the papaya green?"],
  ["2026-11-03 18:05:00.000000", "Thanks"],
]));
// An older file: output before any header, and a nested project two folders down.
const deep = join(root, "orchard", "pears");
mkdirSync(deep, { recursive: true });
writeFileSync(join(deep, ".aider.chat.history.md"), user("Is a pear a fruit?") + "\nYes.\n");
utimesSync(join(deep, ".aider.chat.history.md"), new Date("2026-10-01T10:00:00Z"), new Date("2026-10-01T10:00:00Z"));
// Four folders down is past what is scanned.
const tooDeep = join(root, "a", "b", "c", "d");
mkdirSync(tooDeep, { recursive: true });
writeFileSync(join(tooDeep, ".aider.chat.history.md"), header(FIRST) + user("Hidden by depth") + "\nok\n");
// A hidden folder and node_modules are not walked.
mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
writeFileSync(join(root, "node_modules", "pkg", ".aider.chat.history.md"), header(FIRST) + user("Inside a package") + "\nok\n");

const found = () => { for (let i = 0; i < 1000; i++) { const r = aiderStore.list(); if (!aiderStore.pending?.()) return r; } throw new Error("never settled"); };
const local = (t: string) => new Date(t.replace(" ", "T")).getTime();

test("the store is the folder named by the environment", () => {
  expect(aiderStore.store()).toBe(root);
});

test("lists a run of a history file as a session, within three folders, newest first", () => {
  const rows = found();
  expect(rows.map((r) => r.first_prompt)).toEqual(["Why is the papaya green?", "Rename the mango function and add a test", "Is a pear a fruit?"]);
  const [second, first, pear] = rows;
  expect(second).toMatchObject({ harness: "aider", cwd: fruit, title: "Why is the papaya green?", last_prompt: "Thanks", model: "papaya-model", kind: "interactive" });
  expect(second!.path).toBe(`${join(fruit, ".aider.chat.history.md")}#${SECOND.replace(" ", "T").replaceAll(":", "-")}`);
  expect(first).toMatchObject({ cwd: fruit, last_prompt: "/run pytest", model: "fruit-model" });
  expect(first!.path).not.toBe(second!.path);
  expect(new Set(rows.map((r) => r.id)).size).toBe(3);
  // The older run ends where the next begins.
  expect(first!.updated_ms).toBe(local(SECOND));
  expect(pear).toMatchObject({ cwd: deep, id: expect.stringMatching(/^start-/) });
  expect(pear!.model).toBeUndefined();
  expect(pear!.updated_ms).toBe(Date.parse("2026-10-01T10:00:00Z"));
});

test("a repeat listing gives the same rows without reading again", () => {
  const a = found();
  expect(found()[0]).toBe(a[0]);
  expect(aiderStore.pending?.()).toBe(0);
});

test("reads a run: prompts, replies and Aider's own lines in order, with the times of the input history", async () => {
  const f = found().find((r) => r.first_prompt?.startsWith("Rename"))!;
  const r = await aiderStore.read(f);
  expect(r.events.map((e) => e.kind)).toEqual(["user", "assistant", "note", "user", "note", "assistant"]);
  expect(r.events[0]!.data.text).toBe("Rename the mango function\nand add a test");
  expect(r.events[1]!.data.blocks[0].text).toContain("# A heading the model wrote");
  expect(r.events[1]!.data.blocks[0].text).toContain(">>>>>>> REPLACE");
  expect(r.events[2]!.data).toMatchObject({ text: "Applied edit to mango.py\nCommit abc1234 rename mango", imported: true });
  expect(r.events[2]!.data.model).toBeUndefined();
  expect(r.events[3]!.data.text).toBe("/run pytest");
  expect(r.events[4]!.data.text).toContain("Warning: one test failed");
  expect(r.events[5]!.data.blocks[0].text).toBe("The test failed because of the fixture.");
  expect(r.events[0]!.ts).toBe(local("2026-11-02 09:30:00") + 100);
  expect(r.events[3]!.ts).toBe(local("2026-11-02 09:41:00"));
  expect(r.events.map((e) => e.ts)).toEqual([...r.events.map((e) => e.ts)].sort((a, b) => a - b));
  expect(r.found.model).toBe("fruit-model");
  expect(r.counts).toMatchObject({ prompts: 2, assistant_messages: 2, tool_calls: 0, thoughts_dropped: 0 });
  expect(r.notes.join("\n")).toContain("start-up lines");
});

test("a run with a blank prompt and a later one keeps the words as typed, and the last run's tool lines", async () => {
  const f = found().find((r) => r.first_prompt?.startsWith("Why"))!;
  const r = await aiderStore.read(f);
  expect(r.events.map((e) => e.kind)).toEqual(["user", "assistant", "note", "user"]);
  expect(r.counts.prompts).toBe(2);
  expect(r.events[3]!.data.text).toBe("Thanks");
});

test("a file with no header reads as one run from its first prompt", async () => {
  const f = found().find((r) => r.cwd === deep)!;
  const r = await aiderStore.read(f);
  expect(r.events.map((e) => e.kind)).toEqual(["user", "assistant"]);
  expect(r.events[0]!.data.text).toBe("Is a pear a fruit?");
});
