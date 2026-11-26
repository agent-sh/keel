import { expect, test } from "bun:test";
import { matcher } from "./private-words.ts";

test("only the model in a provider:model id is exempt for short or common host terms", () => {
  const scan = matcher({ terms: ["pico", "garden", "buildbox"], projects: [], homes: [], sentences: [], common: (w) => w === "garden" });
  const lines = ['model: "scripted:pico"', "'acme-edge.2:garden'", "--model=scripted:pico", "pico:fixture", "vendor/garden", "garden/models",
    "Run on pico.", "Use: garden", "garden: ready", "deploy:buildbox", "-:pico", "scripted:pico/notes"];
  expect(scan([{ where: "fixture", first: 1, text: lines.join("\n") }]).map((f) => f.text)).toEqual(lines.slice(3));
});

test("short or common private project names still match in paths and colon-separated text", () => {
  const scan = matcher({ terms: ["pico", "garden"], projects: ["pico", "garden"], homes: [], sentences: [], common: (w) => w === "garden" });
  const lines = ["projects/pico/notes", "~/work/garden/x", "scripted:pico", "scripted:garden"];
  expect(scan([{ where: "fixture", first: 1, text: lines.join("\n") }]).filter((f) => f.kind === "project").map((f) => f.text)).toEqual(lines);
});

test("a short or common alias still matches as a remote host", () => {
  const scan = matcher({ terms: ["pico", "garden"], projects: [], homes: [], sentences: [], common: (w) => w === "garden" });
  for (const word of ["pico", "garden"]) {
    const lines = [`${word}:/srv/x`, `scp f ${word}:`, `ssh ${word}`, `git@${word}:repo`,
      `ssh://${word}/repo`, `ssh://git@${word}/repo`, `scp f "${word}:relative"`, `rsync f ${word}:relative`,
      `git@server:${word}`, `scp f server:${word}`, `ssh://server:22/user:${word}`];
    const text = [...lines, "scp f \\", `  server:${word}`].join("\n");
    expect(scan([{ where: "fixture", first: 1, text }]).map((f) => f.text)).toEqual([...lines, `server:${word}`]);
  }
});
