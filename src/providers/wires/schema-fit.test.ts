import { describe, expect, test } from "bun:test";
import { BARE_SCHEMA, fitSchema, fitTools, fitted, metaProblem, refusedTool, schemaRefusals, unrename, type FitTarget } from "./schema-fit.ts";

// Input schemas of the shapes public MCP servers list, each one that a wire
// refuses as it is. `left`: the wires where it cannot be made to fit at all.
const CORPUS: { name: string; schema: any; left?: FitTarget[]; control?: true }[] = [
  // A browser server's click: one of two ways to name the element, no root type (openai/codex#27877).
  { name: "root oneOf, no type", schema: { oneOf: [{ type: "object", properties: { ref: { type: "string" }, element: { type: "string" } }, required: ["ref"] }, { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] }] } },
  // zod's discriminated union with z.object around it.
  { name: "root anyOf beside type object", schema: { type: "object", anyOf: [{ properties: { kind: { const: "file" }, path: { type: "string" } }, required: ["kind", "path"] }, { properties: { kind: { const: "url" }, url: { type: "string" } }, required: ["kind", "url"] }] } },
  // pydantic's model inheritance: allOf over two definitions.
  { name: "root allOf of $refs", schema: { $defs: { Base: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, Extra: { type: "object", properties: { note: { type: "string" } } } }, allOf: [{ $ref: "#/$defs/Base" }, { $ref: "#/$defs/Extra" }] } },
  // A spreadsheet server keyed by column titles.
  { name: "property name with a space", schema: { type: "object", properties: { "a b": { type: "string" }, ok: { type: "number" } }, required: ["a b"] } },
  // OData-style query names and JSON-LD keys.
  { name: "property names with $, @ and :", schema: { type: "object", properties: { $filter: { type: "string" }, "@type": { type: "string" }, "ns:key": { type: "string" } } } },
  { name: "property name over 64 characters", schema: { type: "object", properties: { ["x".repeat(80)]: { type: "string" } } } },
  // zod-to-json-schema with a name: a root reference into draft-07 definitions.
  { name: "root $ref into definitions, draft-07", schema: { $schema: "http://json-schema.org/draft-07/schema#", $ref: "#/definitions/Args", definitions: { Args: { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false } } } },
  // draft-04's boolean exclusiveMinimum.
  { name: "draft-04 exclusiveMinimum", schema: { type: "object", properties: { n: { type: "number", minimum: 0, exclusiveMinimum: true } } } },
  // A map server's coordinates as a draft-07 tuple.
  { name: "draft-07 tuple items", schema: { type: "object", properties: { at: { type: "array", items: [{ type: "number" }, { type: "number" }], additionalItems: false } } } },
  // Hand-written Python servers.
  { name: "Python type names", schema: { type: "object", properties: { count: { type: "int" }, name: { type: "str" }, on: { type: "bool" } } } },
  // A server converted from Gemini's OpenAPI schema.
  { name: "upper-case OpenAPI types", schema: { type: "OBJECT", properties: { q: { type: "STRING" } } } },
  // draft-03's required on the property.
  { name: "draft-03 required: true", schema: { type: "object", properties: { id: { type: "string", required: true }, opt: { type: "string", required: false } } } },
  { name: "required as one name", schema: { type: "object", properties: { id: { type: "string" } }, required: "id" } },
  // An array with no items (community.openai.com/t/580803).
  { name: "array without items", schema: { type: "object", properties: { tags: { type: "array", description: "Labels." } } } },
  // A sort order that may be left out, written as an enum with null.
  { name: "enum with null and true", schema: { type: "object", properties: { order: { enum: ["asc", "desc", null] }, flag: { enum: [true, "auto"] } } } },
  // pydantic v2: a reference with its field's description beside it.
  { name: "$ref with a description beside it", schema: { type: "object", $defs: { Mode: { type: "string", enum: ["fast", "slow"] } }, properties: { mode: { $ref: "#/$defs/Mode", description: "How fast." } } } },
  { name: "remote $ref", schema: { type: "object", properties: { cfg: { $ref: "https://json.schemastore.org/package.json" } } } },
  { name: "$ref to a missing definition", schema: { type: "object", properties: { x: { $ref: "#/$defs/Missing" } } } },
  { name: "root type list with null", schema: { type: ["object", "null"], properties: { q: { type: "string" } } } },
  // A root with properties and no type ("got 'type: \"None\"'").
  { name: "root without type", schema: { properties: { q: { type: "string" } }, required: ["q"] } },
  { name: "root not and enum", schema: { type: "object", properties: { a: { type: "string" } }, not: { required: ["b"] } } },
  { name: "counts and bounds as text", schema: { type: "object", properties: { s: { type: "string", minLength: -1, maxLength: "10" }, n: { type: "number", maximum: "big" } } } },
  { name: "root anyOf with a string form", schema: { anyOf: [{ type: "object", properties: { id: { type: "string" } }, required: ["id"] }, { type: "string" }] } },
  // A tree whose nodes are the input again: every wire takes it, and it is sent as it is.
  { name: "recursive through #", control: true, schema: { type: "object", properties: { name: { type: "string" }, children: { type: "array", items: { $ref: "#" } } } } },
  // What cannot be made to fit: the input is not an object at all.
  { name: "input is a string", schema: { type: "string" }, left: ["anthropic_messages", "openai_responses", "chat_completions", "gemini_generate_content", "portable"] },
];
const WIRES: FitTarget[] = ["anthropic_messages", "openai_responses", "chat_completions", "gemini_generate_content", "portable"];

describe("each schema of the corpus", () => {
  test("is refused by some wire as it is", () => {
    for (const c of CORPUS) {
      const refused = WIRES.some((w) => schemaRefusals(c.schema, w).length > 0);
      // (A reference Keel cannot resolve is Keel's own rule: no wire's refusal of one is established.)
      if (c.control) expect(WIRES.map((w) => (fitSchema(c.schema, w) as any).schema === c.schema), c.name).toEqual(WIRES.map(() => true));
      else if (!refused && !/remote|missing/.test(c.name)) throw new Error(`${c.name}: no wire refuses it, so it proves nothing`);
    }
  });
  for (const w of WIRES) test(`fits ${w} or is left out with a reason`, () => {
    for (const c of CORPUS) {
      const f = fitSchema(c.schema, w);
      if (c.left?.includes(w)) {
        expect("left" in f, c.name).toBe(true);
        expect((f as { left: string }).left.length).toBeGreaterThan(10);
        continue;
      }
      if ("left" in f) throw new Error(`${c.name} left out on ${w}: ${f.left}`);
      expect(schemaRefusals(f.schema, w), `${c.name} on ${w}`).toEqual([]);
      // Fitting what fits changes nothing: the bytes of a fitted tool are its fixed point.
      const again = fitSchema(f.schema, w);
      expect("left" in again ? again : again.schema, `${c.name} again on ${w}`).toBe(f.schema);
      // The server's schema itself is never changed.
      expect(JSON.stringify(c.schema)).toBe(JSON.stringify(CORPUS.find((x) => x.name === c.name)!.schema));
    }
  });
});

test("a root oneOf becomes one object whose groups the description names", () => {
  const f = fitSchema(CORPUS[0]!.schema, "anthropic_messages") as any;
  expect(f.schema).toEqual({ properties: { ref: { type: "string" }, element: { type: "string" }, selector: { type: "string" } }, type: "object" });
  expect(f.notes[0]).toBe("Its parameters come in groups; give exactly one of: (1) `ref`; (2) `selector`");
});

test("allOf keeps every branch's required list", () => {
  const f = fitSchema(CORPUS[2]!.schema, "openai_responses") as any;
  expect(f.schema.properties).toEqual({ id: { type: "string" }, note: { type: "string" } });
  expect(f.schema.required).toEqual(["id"]);
});

test("a property name the wire refuses is renamed, and given back as the server names it", () => {
  const f = fitSchema(CORPUS[3]!.schema, "anthropic_messages") as any;
  expect(Object.keys(f.schema.properties)).toEqual(["a_b", "ok"]);
  expect(f.schema.required).toEqual(["a_b"]);
  expect(unrename({ a_b: "x", ok: 1 }, f.renames)).toEqual({ "a b": "x", ok: 1 });
  // Gemini and OpenAI take the name as it is.
  expect(fitSchema(CORPUS[3]!.schema, "gemini_generate_content")).toEqual({ schema: CORPUS[3]!.schema, notes: [] });
});

test("a schema that already fits is the same object, on every wire", () => {
  const s = { type: "object", properties: { path: { type: "string", description: "A file." }, lines: { type: "array", items: { type: "integer" } } }, required: ["path"], additionalProperties: false };
  for (const w of WIRES) expect((fitSchema(s, w) as any).schema).toBe(s);
});

test("Keel's own tools fit every wire unchanged", async () => {
  const { toolsFor } = await import("../../tools/registry.ts");
  for (const family of ["claude", "gpt", "gemini"] as const) for (const native of [false, true]) {
    for (const t of toolsFor(family, native)) for (const w of WIRES) {
      if (t.freeform) continue;
      const f = fitted(t.input_schema, w);
      expect("left" in f ? f.left : f.schema === t.input_schema && !f.notes.length, `${family} ${t.name} on ${w}`).toBe(true);
    }
  }
});

test("a fit is computed once per schema object and wire", () => {
  const s = { oneOf: [{ type: "object", properties: { a: { type: "string" } } }] };
  expect(fitted(s, "anthropic_messages")).toBe(fitted(s, "anthropic_messages"));
});

test("fitTools leaves out what cannot fit, wraps a renamed tool's call, and sends a refused one bare", async () => {
  const seen: unknown[] = [];
  const tools = [
    { name: "good", description: "Good.", input_schema: { type: "object", properties: { q: { type: "string" } } }, run: async (i: unknown, _ctx?: unknown) => void seen.push(i) },
    { name: "odd", description: "Odd.", input_schema: CORPUS[3]!.schema, run: async (i: unknown, _ctx?: unknown) => void seen.push(i) },
    { name: "text", description: "Text.", input_schema: { type: "string" } as any },
    { name: "refused", description: "Refused.", input_schema: { type: "object", properties: { x: { type: "string" } } } },
  ];
  const { tools: out, left } = fitTools(tools, "anthropic_messages", new Set(["refused"]));
  expect(out.map((t) => t.name)).toEqual(["good", "odd", "refused"]);
  expect(out[0]).toBe(tools[0]!);
  expect(left).toEqual([{ name: "text", why: 'its input is "string", and a tool\'s input is an object' }]);
  expect(out[1]!.description).toContain("`a_b`");
  await out[1]!.run!({ a_b: "v" }, {});
  expect(seen).toEqual([{ "a b": "v" }]);
  expect(out[2]!.input_schema).toBe(BARE_SCHEMA);
  expect(out[2]!.description).toContain("its parameters are not shown");
});

test("the tool a 400 names, on each wire", () => {
  const tools = [{ name: "Bash" }, { name: "mcp__s__late", defer: true }, { name: "Read" }];
  // The Anthropic wire sends the tools in the prompt first, then the deferred.
  expect(refusedTool("Anthropic: HTTP 400: tools.2.custom.input_schema: JSON schema is invalid. It must match JSON Schema draft 2020-12", tools, "anthropic_messages")).toBe("mcp__s__late");
  expect(refusedTool("tools.0.custom.input_schema.properties: Property keys should match pattern '^[a-zA-Z0-9_.-]{1,64}$'", tools, "anthropic_messages")).toBe("Bash");
  expect(refusedTool("OpenAI: HTTP 400: Invalid schema for function 'Read': schema must have type 'object'", tools, "openai_responses")).toBe("Read");
  expect(refusedTool("Gemini: HTTP 400: * GenerateContentRequest.tools[0].function_declarations[1].parameters_json_schema: bad", tools, "gemini_generate_content")).toBe("mcp__s__late");
  expect(refusedTool("messages.0.content: something else", tools, "anthropic_messages")).toBeUndefined();
});

test("the 2020-12 meta-schema check names what is wrong", () => {
  expect(metaProblem({ type: "object", properties: { a: { minLength: -1 } } })).toBe("`a`: minLength -1 is not a count");
  expect(metaProblem({ type: "object", properties: { a: { type: "date" } } })).toBe('`a`: type "date" is not a JSON Schema type');
  expect(metaProblem({ type: "object", allOf: [] })).toBe("the input: allOf [] is not a list of schemas");
  expect(metaProblem({ type: "object", properties: { a: { type: ["string", "null"] } } })).toBeUndefined();
});
