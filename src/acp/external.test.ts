import { expect, test } from "bun:test";
import { joinAgents } from "./agents.ts";
import { applyPlan, classOf, optionFor, streamedInput } from "./external.ts";
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

test("what an agent offered stays listed through a resume that states nothing and a probe that fails", async () => {
  const { AcpAgents } = await import("./agents.ts");
  const { listedOf } = await import("./choices.ts");
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const st = mkdtempSync(join(tmpdir(), "keel-acp-choices-"));
  const a = new AcpAgents(st);
  // A program that ends at once: a probe of it fails.
  const agent = { id: "ag", name: "Ag", source: "custom", run: { command: "/bin/false", args: [] } } as any;
  a.learn(agent, { sessionId: "s", configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "fast", options: [{ value: "fast", name: "Fast" }, { value: "deep", name: "Deep" }] }] });
  const ids = () => listedOf(agent, a.learned("ag")).map((m) => m.model);
  expect(ids()).toEqual(["ag", "ag/fast", "ag/deep"]);
  a.learn(agent, {});
  expect(ids()).toEqual(["ag", "ag/fast", "ag/deep"]);
  // The program changed under it (another key): it is probed again, and the probe fails.
  agent.run = { command: "/bin/false", args: ["again"] };
  a.ask([agent]);
  for (let i = 0; i < 100 && !a.learned("ag")?.error; i++) await Bun.sleep(20);
  expect(a.learned("ag")?.error).toBeTruthy();
  expect(ids()).toEqual(["ag", "ag/fast", "ag/deep"]);
  expect(JSON.parse(readFileSync(join(st, "acp-choices.json"), "utf8")).ag.models.options).toHaveLength(2);
});

test("an agent's plan updates, legacy or identified, leave the steps its plans show", () => {
  const plans = new Map<string, any[]>();
  const entries = (...c: string[]) => c.map((content, i) => ({ content, priority: "high", status: i ? "pending" : "completed" }));
  expect(applyPlan(plans, { sessionUpdate: "plan", entries: entries("a", "b") })).toEqual([{ step: "a", status: "completed" }, { step: "b", status: "pending" }]);
  // An identified plan beside it; a second update of it replaces it whole.
  expect(applyPlan(plans, { sessionUpdate: "plan_update", plan: { type: "items", planId: "p1", entries: entries("c") } })!.map((s) => s.step)).toEqual(["a", "b", "c"]);
  expect(applyPlan(plans, { sessionUpdate: "plan_update", plan: { type: "markdown", planId: "p1", content: "## Steps\n- [ ] one\n- [x] two", path: "/w/PLAN.md" } })).toEqual([{ step: "a", status: "completed" }, { step: "b", status: "pending" }, { step: "one", status: "pending" }, { step: "two", status: "completed" }]);
  expect(applyPlan(plans, { sessionUpdate: "plan_update", plan: { type: "markdown", planId: "p2", content: "Do the thing\nin two parts" } })!.at(-1)).toEqual({ step: "Do the thing", status: "pending" });
  // A removal of one it does not know changes nothing; of one it knows, drops it.
  expect(applyPlan(plans, { sessionUpdate: "plan_removed", planId: "nope" })).toBeNull();
  expect(applyPlan(plans, { sessionUpdate: "plan_removed", planId: "p2" })!.length).toBe(4);
  expect(applyPlan(plans, { sessionUpdate: "plan_removed", planId: "p1" })!.length).toBe(2);
  expect(applyPlan(plans, { sessionUpdate: "tool_call" })).toBeNull();
});
