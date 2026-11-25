import { expect, test } from "bun:test";
import { choicesOf, heldSwitch, listedOf, mergeChoices, settle, splitModel, unknownCurrent, withOptions } from "./choices.ts";

const model = { id: "model", name: "Model", category: "model", type: "select", currentValue: "a", options: [{ group: "g", name: "G", options: [{ value: "a", name: "A" }, { value: "x/b", name: "B" }] }] };
const level = { id: "think", name: "Thinking", category: "thought_level", type: "select", currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] };

test("an agent's models come from its model option, grouped values flattened; a boolean or empty select is no choice", () => {
  const c = choicesOf({ configOptions: [{ id: "brave", category: "model", type: "boolean", currentValue: true }, { id: "none", category: "model", type: "select", options: [] }, model, level] });
  expect(c.models).toEqual({ via: "config", configId: "model", name: "Model", current: "a", options: [{ value: "a", name: "A" }, { value: "x/b", name: "B" }] });
  expect(c.efforts?.options.map((o) => o.value)).toEqual(["low", "high"]);
  const listed = listedOf({ id: "ag", name: "Ag" }, c);
  expect(listed.map((m) => [m.model, m.name])).toEqual([["ag", "Ag"], ["ag/a", "Ag: A"], ["ag/x/b", "Ag: B"]]);
  expect(listed.every((m) => m.efforts?.join() === "low,high")).toBe(true);
  // A value with a slash is still one choice of one agent.
  expect(splitModel("ag/x/b")).toEqual({ agent: "ag", choice: "x/b" });
});

test("an agent with no model choice offers its modes: config option first, else the older session modes", () => {
  const legacy = { modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }, { id: "code", name: "Code" }] } };
  const c = choicesOf(legacy);
  expect(listedOf({ id: "ag", name: "Ag" }, c).map((m) => m.model)).toEqual(["ag", "ag/ask", "ag/code"]);
  expect(settle(c, { choice: "code" })).toEqual([{ method: "session/set_mode", params: { modeId: "code" } }]);
  // A config list sent again keeps the older modes when it has no mode option of its own.
  expect(withOptions(c, [level]).modes?.via).toBe("mode");
  const viaConfig = choicesOf({ ...legacy, configOptions: [{ id: "m", name: "Mode", category: "mode", type: "select", currentValue: "plan", options: [{ value: "plan", name: "Plan" }] }] });
  expect(viaConfig.modes).toMatchObject({ via: "config", configId: "m" });
});

test("a session is brought to its model and effort, and nothing is sent for what is current or not offered", () => {
  const c = choicesOf({ configOptions: [model, level] });
  expect(settle(c, { choice: "a", effort: "low" })).toEqual([]);
  expect(settle(c, { choice: "x/b", effort: "high" })).toEqual([
    { method: "session/set_config_option", params: { configId: "model", value: "x/b" } },
    { method: "session/set_config_option", params: { configId: "think", value: "high" } },
  ]);
  expect(settle(c, { choice: "gone", effort: "max" })).toEqual([]);
  expect(listedOf({ id: "ag", name: "Ag" }, undefined).map((m) => m.model)).toEqual(["ag"]);
});

test("a result that states no options keeps what was known; one that states them is the agent's whole state", () => {
  const known = choicesOf({ configOptions: [model, level] });
  expect(mergeChoices(known, {})).toEqual(known); // a resume or load with no options
  expect(mergeChoices(known, { modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }] } }).models).toEqual(known.models);
  const now = mergeChoices(known, { configOptions: [{ ...model, currentValue: "x/b" }] });
  expect(now.models?.current).toBe("x/b");
  expect(now.efforts).toBeUndefined(); // the list no longer has a reasoning level
  // A fresh connection to a resumed session knows the sets, not what is current: the session's choice is sent.
  expect(settle(unknownCurrent(known), { choice: "a", effort: "low" })).toEqual([
    { method: "session/set_config_option", params: { configId: "model", value: "a" } },
    { method: "session/set_config_option", params: { configId: "think", value: "low" } },
  ]);
});

test("modes that skip the agent's permission checks are not offered as models", () => {
  const c = choicesOf({ modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }, { id: "bypassPermissions", name: "Bypass Permissions" }, { id: "yolo", name: "Auto", description: "Run everything without asking" }] } });
  expect(listedOf({ id: "ag", name: "Ag" }, c).map((m) => m.model)).toEqual(["ag", "ag/default", "ag/plan"]);
});

test("an agent's switches are its boolean options; one that loosens what it may do is never sent", () => {
  const c = choicesOf({ configOptions: [
    { id: "brief", name: "Brief", type: "boolean", currentValue: false },
    { id: "brave_mode", name: "Brave Mode", description: "Skip confirmation prompts", type: "boolean", currentValue: false },
    { id: "odd", type: "boolean", currentValue: "yes" },
  ] });
  expect(c.switches?.map((s) => s.id)).toEqual(["brief", "brave_mode"]);
  expect(settle(c, { switches: { brief: true, brave_mode: true } })).toEqual([{ method: "session/set_config_option", params: { configId: "brief", type: "boolean", value: true } }]);
  // A held switch the agent has on is turned off before the prompt, whatever was asked.
  expect(settle({ switches: [{ id: "yolo", name: "YOLO", current: true }] }, { switches: { yolo: true } })).toEqual([{ method: "session/set_config_option", params: { configId: "yolo", type: "boolean", value: false } }]);
  expect(settle({ switches: [{ id: "yolo", name: "YOLO", current: false }] }, {})).toEqual([]);
  // Held in either direction: anything about asking, approving, trust, the sandbox, the network or acting alone.
  const held = ["Bypass permissions", "YOLO", "Auto-run commands", "Allow all tools", "Trust this folder", "Accept edits automatically", "Autonomous mode", "Disable sandbox",
    "Network access", "Execute without prompting", "auto_execute", "Unattended", "Run shell commands freely", "autoApprove", "Skip confirmations", "Ask before running commands"];
  expect(held.filter((n) => !heldSwitch({ id: n.toLowerCase().replace(/\W+/g, "_"), name: n }))).toEqual([]);
  expect(["Brief replies", "Show thinking", "Use emoji", "Verbose logs", "Task list"].filter((n) => heldSwitch({ id: n.toLowerCase().replace(/\W+/g, "_"), name: n }))).toEqual([]);
  expect(settle(c, { switches: { brief: false } })).toEqual([]);
  // After a resume that stated nothing the agent's value is not known: the owner's is sent, and a held one is turned off.
  expect(settle(unknownCurrent(c), { switches: { brief: false } }).map((x) => [x.params.configId, x.params.value])).toEqual([["brief", false], ["brave_mode", false]]);
});

test("a value an agent states twice is one choice and one listed model", () => {
  const twice = { id: "model", name: "Model", category: "model", type: "select", currentValue: "auto", options: [{ value: "auto", name: "Auto", description: "Let it pick" }, { value: "a", name: "A" }, { value: "auto", name: "Auto" }] };
  const c = choicesOf({ configOptions: [twice] });
  expect(c.models?.options).toEqual([{ value: "auto", name: "Auto", description: "Let it pick" }, { value: "a", name: "A" }]);
  // What was learned before is listed once too.
  const old = { models: { via: "config" as const, configId: "model", name: "Model", current: "auto", options: [{ value: "auto", name: "Auto" }, { value: "auto", name: "Auto" }] } };
  expect(listedOf({ id: "ag", name: "Ag" }, old).map((m) => m.model)).toEqual(["ag", "ag/auto"]);
});
