// A pinned tool definition against the build that runs: which changes keep it
// servable, and what a merged list carries.
import { expect, test } from "bun:test";
import { accepts, changedTools, mergeTools, pinOf } from "./pin.ts";
import type { Tool } from "./types.ts";

const obj = (properties: Record<string, unknown>, required: string[] = [], extra: Record<string, unknown> = {}) => ({ type: "object", properties, required, ...extra });
const tool = (name: string, description: string, schema: Record<string, unknown> = obj({ path: { type: "string" } }, ["path"]), extra: Partial<Tool> = {}): Tool =>
  ({ name, description, input_schema: schema, readOnly: true, run: async () => ({ content: `${name}: ${description}` }), ...extra });

test("a pinned schema is servable while the build takes every input it describes", () => {
  const pin = obj({ path: { type: "string", description: "The file" }, mode: { type: "string", enum: ["a", "b"] }, n: { type: "integer" } }, ["path"]);
  // Other words, a new optional property, a wider enum, an integer taken as a number, a property no longer required.
  expect(accepts(obj({ path: { type: "string", description: "A file path" }, mode: { type: "string", enum: ["a", "b", "c"] }, n: { type: "number" }, depth: { type: "number" } }, []), pin)).toBe(true);
  // A property gone or renamed: the model would still send it.
  expect(accepts(obj({ file: { type: "string" }, mode: { type: "string", enum: ["a", "b"] }, n: { type: "integer" } }, []), pin)).toBe(false);
  // A new required property: the model would never send it.
  expect(accepts(obj({ ...pin.properties, why: { type: "string" } }, ["path", "why"]), pin)).toBe(false);
  // A narrower enum or type.
  expect(accepts(obj({ ...pin.properties, mode: { type: "string", enum: ["a"] } }, ["path"]), pin)).toBe(false);
  expect(accepts(obj({ ...pin.properties, path: { type: "number" } }, ["path"]), pin)).toBe(false);
  // A keyword this does not weigh: not offered when it differs.
  expect(accepts(obj({ ...pin.properties, n: { type: "integer", minimum: 1 } }, ["path"]), pin)).toBe(false);
  // Closed where nothing was said: the declared properties decide.
  expect(accepts({ ...pin, additionalProperties: false }, pin)).toBe(true);
  // Closed where the pinned definition offered a map: its inputs are refused now.
  const env = (extra: unknown) => obj({ env: { type: "object", additionalProperties: extra } });
  expect(accepts(env(false), env({ type: "string" }))).toBe(false);
  expect(accepts(env(false), env(true))).toBe(false);
  expect(accepts(env({ type: "string" }), env({ type: "string", description: "A value" }))).toBe(true);
  // Nested: an array's items follow the same rule.
  expect(accepts(obj({ list: { type: "array", items: obj({ a: { type: "string" }, b: { type: "string" } }) } }), obj({ list: { type: "array", items: obj({ a: { type: "string" } }) } }))).toBe(true);
  expect(accepts(obj({ list: { type: "array", items: obj({ b: { type: "string" } }) } }), obj({ list: { type: "array", items: obj({ a: { type: "string" } }) } }))).toBe(false);
});

test("a merged list sends the pinned definitions and runs the build's tools", async () => {
  const pinned = [tool("Read", "Reads a file."), tool("Bash", "Runs a command.")].map((t) => pinOf(t));
  const now = [tool("Read", "Reads a file, in parts."), tool("Bash", "Runs a command."), tool("Plan", "Plans.")];
  const m = mergeTools(pinned, now);
  expect(m.urgent).toBeUndefined();
  expect(m.tools.map((t) => [t.name, t.description])).toEqual([["Read", "Reads a file."], ["Bash", "Runs a command."]]);
  expect(JSON.stringify(m.tools.map((t) => pinOf(t)))).toBe(JSON.stringify(pinned));
  // The reworded tool and the one new to the prompt wait; the call runs the build's implementation.
  expect(m.waiting).toEqual(["Read", "Plan"]);
  expect((await m.tools[0]!.run({}, {} as any)).content).toBe("Read: Reads a file, in parts.");
  // The gate reads the build's own schema, never the pinned one.
  expect(m.tools[0]!.built).toBe(now[0]!.input_schema);
  expect(m.pin).toBeUndefined();
  // The same tools in another order are another prefix.
  expect(mergeTools(pinned, [now[1]!, tool("Read", "Reads a file.")]).waiting).toEqual(["order"]);
  expect(changedTools(pinned, now.map((t) => pinOf(t)))).toEqual(["Read", "Plan"]);
});

test("a tool in the prompt that is gone, takes another input or is marked urgent is not offered", () => {
  const pinned = [tool("Read", "Reads."), tool("Bash", "Runs.")].map((t) => pinOf(t));
  expect(mergeTools(pinned, [tool("Read", "Reads.")])).toMatchObject({ urgent: "Bash is gone from this build", tools: [{ name: "Read" }] });
  expect(mergeTools(pinned, [tool("Read", "Reads.", obj({ file: { type: "string" } }, ["file"])), tool("Bash", "Runs.")]).urgent).toBe("Read takes another input in this build");
  // A mark the pinned copy does not carry; the same mark waits like any change.
  const reworded = [tool("Read", "Reads."), tool("Bash", "Runs. Never force push.")];
  expect(mergeTools(pinned, reworded, { Bash: "force-push" }).urgent).toBe("Bash has an urgent change");
  const marked = mergeTools(reworded.map((t) => pinOf(t, t.name === "Bash" ? "force-push" : undefined)), reworded, { Bash: "force-push" });
  expect([marked.urgent, marked.waiting]).toEqual([undefined, []]);
});

test("an urgent mark moves a session that has used the tool, and waits for one that has not", () => {
  const pinned = [tool("Read", "Reads."), tool("Bash", "Runs.")].map((t) => pinOf(t));
  const reworded = [tool("Read", "Reads."), tool("Bash", "Runs. Never force push.")];
  const marks = { Bash: "force-push" };
  expect(mergeTools(pinned, reworded, marks, (n) => n === "Bash").urgent).toBe("Bash has an urgent change");
  // Not used: no whole-context write for it. The change waits like any other, and the pin keeps the old mark.
  const idle = mergeTools(pinned, reworded, marks, (n) => n === "Read");
  expect([idle.urgent, idle.waiting]).toEqual([undefined, ["Bash"]]);
  expect(idle.tools.find((t) => t.name === "Bash")?.description).toBe("Runs.");
});

test("deferred tools follow the build: they are not in the cached prefix", () => {
  const pinned = [tool("Read", "Reads."), tool("Glob", "Finds.", undefined, { defer: true }), tool("Old", "Was.", undefined, { defer: true }), tool("Grep", "Searches.", undefined, { defer: true })].map((t) => pinOf(t));
  const now = [
    tool("Read", "Reads."),
    // Moved into the prompt by this build: still deferred for this session, with its pinned definition.
    tool("Glob", "Finds files."),
    // Another input: the build's definition, still deferred.
    tool("Grep", "Searches.", obj({ pattern: { type: "string" } }, ["pattern"]), { defer: true }),
    // New in this build.
    tool("Monitor", "Watches.", undefined, { defer: true }),
  ];
  const m = mergeTools(pinned, now);
  expect(m.urgent).toBeUndefined();
  expect(m.tools.map((t) => [t.name, !!t.defer, t.description])).toEqual([["Read", false, "Reads."], ["Glob", true, "Finds."], ["Grep", true, "Searches."], ["Monitor", true, "Watches."]]);
  expect(m.tools[2]!.input_schema).toEqual(now[2]!.input_schema);
  expect(m.pin?.map((t) => t.name)).toEqual(["Read", "Glob", "Grep", "Monitor"]);
  expect(m.waiting).toEqual(["Glob"]);
});
