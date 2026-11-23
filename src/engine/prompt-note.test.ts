// What a session is told at the tail when the owner's side of its prompt
// changed while the kept prompt stays sent. The e2e (test/e2e/build-pin.spec.ts)
// covers the requests; these are the decisions about what the note says.
import { expect, test } from "bun:test";
import type { StoredEvent } from "../core/types.ts";
import { blockDiff, blockTexts, NOTE_KIND, promptNote, toldOf, type Rendered } from "./prompt-note.ts";
import { blocksOf, type PromptPart } from "./prompt-store.ts";

const rules = (lines: string[]) => lines.map((l, i) => `${i + 1}. ${l}`).join("\n") + "\n";
const RULES = rules(["Read first.", "Keep it lean.", "No em dashes.", "Tests prove things.", "Short reports.", "Ask for spend.", "Use the scratch folder.", "Name the files."]);
const render = (core: string, files: string, skills = "a, b"): Rendered => {
  const parts: PromptPart[] = [
    { name: "core", text: `${core}\n\n` },
    { name: "Skills you can load", text: `Skills: ${skills}\n\n`, data: skills },
    { name: "instruction files", text: `\nInstructions:\n\n${files}`, data: files },
  ];
  return { text: parts.map((p) => p.text).join(""), blocks: blocksOf(parts) };
};
const note = (blocks: Record<string, unknown>) => ({ id: "n", kind: "note", ts: 1, data: { kind: NOTE_KIND, model: true, blocks } }) as unknown as StoredEvent;

test("each block's text is cut from the prompt by its bytes", () => {
  const r = render("Core é", "rules ü");
  expect(blockTexts(r)?.get("instruction files")).toBe("\nInstructions:\n\nrules ü");
  expect(blockTexts(r)?.get("core")).toBe("Core é\n\n");
  expect(blockTexts({ ...r, text: r.text + "x" })).toBeUndefined();
});

test("an edited instruction file is told as its changed lines, once", () => {
  const sent = render("core", RULES);
  const edited = RULES.replace("3. No em dashes.", "3. No em dashes, ever.");
  const latest = render("core", edited);
  const n = promptNote(sent, latest, new Map())!;
  expect(n.names).toEqual(["instruction files"]);
  expect(n.text).toStartWith("[harness] Part of your system prompt changed during this session: instruction files.");
  expect(n.text).toContain("-3. No em dashes.\n+3. No em dashes, ever.");
  // The lines around the change, not the whole file.
  expect(n.text).not.toContain("8. Name the files.");
  expect(n.short).toBe("Told the model what changed in its prompt (instruction files)");
  // Told already (a restart compares again): nothing more.
  expect(promptNote(sent, latest, toldOf([note(n.blocks)]))).toBeUndefined();
  // Taken back: the model is told the earlier text is in force again.
  const back = promptNote(sent, sent, toldOf([note(n.blocks)]))!;
  expect(back.text).toContain("-3. No em dashes, ever.\n+3. No em dashes.");
  // A note before the context's checkpoint is not in what the model reads.
  expect(promptNote(sent, sent, toldOf([note(n.blocks)], 1))).toBeUndefined();
});

test("the build's own words are not told, and a whole rewrite comes whole", () => {
  const sent = render("core", RULES);
  expect(promptNote(sent, render("core, reworded", RULES), new Map())).toBeUndefined();
  const all = promptNote(sent, render("core", "Only one rule now.\n", "a, b, c"), new Map())!;
  expect(all.names).toEqual(["Skills you can load", "instruction files"]);
  expect(all.text).toContain('<changed block="instruction files">\nIt reads in full:\n\nInstructions:\n\nOnly one rule now.\n</changed>');
  // A short block reads shorter whole than as a diff.
  expect(all.text).toContain('<changed block="Skills you can load">\nIt reads in full:\nSkills: a, b, c\n</changed>');
});

test("a block's diff", () => {
  expect(blockDiff("a\nb\n", "")).toStartWith("It is empty now");
  expect(blockDiff("", "a\n")).toBe("It reads:\na");
  const long = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  const changed = [...long];
  changed[2] = "line two";
  changed[17] = "line seventeen";
  expect(blockDiff(long.join("\n"), changed.join("\n"))).toBe(
    "Changed lines (- before, + now, the rest as it was):\n line 0\n line 1\n-line 2\n+line two\n line 3\n line 4\n line 5\n@@\n line 14\n line 15\n line 16\n-line 17\n+line seventeen\n line 18\n line 19",
  );
  // A first change deep in: one mark for the lines left out, with the file the change is in.
  const files = ["# /a/AGENTS.md", ...long.slice(0, 10), "# /b/AGENTS.md", ...long.slice(10)];
  const edited = [...files];
  edited[18] = "line sixteen";
  expect(blockDiff(files.join("\n"), edited.join("\n"))).toBe(
    "Changed lines (- before, + now, the rest as it was):\n@@ # /b/AGENTS.md\n line 13\n line 14\n line 15\n-line 16\n+line sixteen\n line 17\n line 18\n line 19",
  );
});
