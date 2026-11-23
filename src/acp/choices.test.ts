import { expect, test } from "bun:test";
import { choicesOf, listedOf, settle, splitModel, withOptions } from "./choices.ts";

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
