import { expect, test } from "bun:test";
import { joinAgents } from "./agents.ts";
import { classOf, optionFor, streamedInput } from "./external.ts";
import { splitCommand } from "../safety/shell.ts";

// Kimi Code asks permission for a call whose input it only streamed as text.
test("a permission request without input is judged by the input the agent streamed", () => {
  const announced = { toolCallId: "t", title: "Bash", kind: "execute", content: [{ type: "content", content: { type: "text", text: '{"command":"rm -rf build"}' } }] };
  expect(classOf({ ...announced, rawInput: streamedInput(announced) }, "/w")).toEqual({ kind: "shell", command: "rm -rf build" });
  expect(streamedInput({ content: [{ type: "content", content: { type: "text", text: '{"command":"rm -r' } }] })).toBeNull();
  expect(classOf({ kind: "edit", locations: [{ path: "a.txt" }] }, "/w")).toEqual({ kind: "edit", paths: ["/w/a.txt"] });
  // An argument list is quoted word by word: a word that holds a quote does not close another.
  const argv = classOf({ kind: "execute", rawInput: { command: ["find", ".", "'", "-delete", "-name", "'"] } }, "/w");
  expect(argv.kind === "shell" && splitCommand(argv.command)![0]!.words).toEqual(["find", ".", "'", "-delete", "-name", "'"]);
  expect(classOf({ kind: "execute", rawInput: { command: ["bash", "-lc", "git status"] } }, "/w")).toEqual({ kind: "shell", command: "git status" });
});

test("keel answers once, never with the agent's standing answer", () => {
  const options = [{ optionId: "a", kind: "allow_always" }, { optionId: "o", kind: "allow_once" }, { optionId: "r", kind: "reject_once" }];
  expect(optionFor(options, true)).toBe("o");
  expect(optionFor(options, false)).toBe("r");
  expect(optionFor([{ optionId: "a", kind: "allow_always" }], true)).toBe("a");
});

test("registry agents count when their program is installed; one program is one agent", () => {
  const bin = (cmd: string, args?: string[]) => ({ binary: { "linux-x86_64": { cmd, args }, "linux-aarch64": { cmd, args }, "darwin-aarch64": { cmd, args }, "darwin-x86_64": { cmd, args } } });
  const reg = { agents: [
    { id: "oc", name: "OC", distribution: bin("./oc", ["acp"]) },
    { id: "oc2", name: "OC v2", distribution: bin("./oc", ["acp"]) },
    { id: "gone", name: "Gone", distribution: bin("./gone") },
    { id: "np", name: "Np", distribution: { npx: { package: "np@1", args: ["--acp"] } } },
  ] };
  const which = (b: string) => (b === "oc" ? "/bin/oc" : b === "npx" ? "/bin/npx" : null);
  const a = joinAgents(reg, { mine: { command: "x", args: ["acp"] } }, which);
  expect(a.filter((x) => x.run).map((x) => x.id)).toEqual(["oc", "mine"]);
  expect(a.find((x) => x.id === "np")!.add).toEqual({ command: "npx", args: ["-y", "np@1", "--acp"] });
});
