// A tool's input schema made to fit what a wire accepts. MCP servers declare
// their tools' input schemas as they like, and one schema a provider refuses
// fails every request that offers the tool, in every session that offers it.
// So each wire gets the schema in a form it takes: a root combinator is
// flattened into one object, a draft-04 or draft-07 form is written as its
// 2020-12 equal, what still cannot be sent is renamed or left out and said in
// the tool's description, and a tool that cannot be made to fit is left out
// (its caller names it). Pure: nothing here is sent, and a schema that already
// fits comes back as the same object, so the bytes of Keel's own tools never
// change. A fit is computed once per schema object and wire (`fitted`).
//
// What each wire refuses, and where that is stated (read 2026-11-24):
//
// Anthropic Messages (code.claude.com/docs/en/mcp, "Tool input schemas with a
// root-level combinator" and "Tools with invalid input schemas"; errors.md,
// "Tool input schema is invalid"):
//   - "The Claude API doesn't accept those keywords [anyOf, oneOf, allOf] at
//     the schema root. It does accept combinators nested inside properties."
//   - "Top-level property names must be 1 to 64 characters long and use only
//     ASCII letters and digits, _, ., and -" (the API's answer:
//     "tools.N.custom.input_schema.properties: Property keys should match
//     pattern '^[a-zA-Z0-9_.-]{1,64}$'").
//   - "The schema must be valid against the JSON Schema draft 2020-12
//     meta-schema" ("tools.N.custom.input_schema: JSON schema is invalid").
// OpenAI Responses and Chat Completions (the API's answers, quoted in
// openai/codex#27877 and community.openai.com/t/580803; the function's
// `parameters` are "described as a JSON Schema object"):
//   - "schema must have type 'object' and not have
//     'oneOf'/'anyOf'/'allOf'/'enum'/'const'/'not' at the top level", and
//     "schema must be a JSON Schema of 'type: "object"', got 'type: "None"'"
//     for a root with no type.
//   - "In context=('properties', 'x'), array schema missing items".
//   The OpenAI-compatible servers behind a Chat Completions route (vLLM,
//   llama.cpp, Ollama) document no rules of their own; they get OpenAI's.
// Gemini generateContent (googleapis, generativelanguage/v1beta: content.proto
// FunctionDeclaration.parameters_json_schema, "The schema must describe an
// object where the properties are the parameters to the function";
// generative_service.proto responseJsonSchema, the JSON Schema Gemini reads):
//   - `enum` "(for strings and numbers)".
//   - "If `$ref` is set on a sub-schema, no other properties, except for than
//     those starting as a `$`, may be set."
//   - "Cyclic references are unrolled to a limited degree and, as such, may
//     only be used within non-required properties": not fitted here (a schema
//     that breaks it is left to the refusal path, src/engine/turn.ts).
// MCP (2025-11-25 server/tools, for the tools Keel serves an ACP agent, whose
// own provider Keel does not know): inputSchema "MUST be a valid JSON Schema
// object", 2020-12 when it names no `$schema`. Such a tool gets every wire's
// rules ("portable").
//
// Besides the wires' rules, two of Keel's own: a `$ref` Keel cannot resolve
// inside the schema (another document, a name that is not there) is sent as
// "any value", since a model cannot read a shape it is not given; and the
// root `$schema` of a schema Keel changed is not sent (it is 2020-12 once
// fitted). A schema that fits as it is keeps its `$schema` when that names
// draft-07 or 2020-12 (`KEPT_DIALECT`): the official TypeScript SDK's servers
// write draft-07, the wires take it, and the bytes stay the ones a session's
// pin and cache hold.
import type { Wire } from "../types.ts";

export type FitTarget = Wire | "portable";
export type Fitted =
  | { schema: Record<string, unknown>; notes: string[]; renames?: Record<string, string> }
  | { left: string };

type Rules = {
  label: string;
  rootBanned: readonly string[];  // keywords refused at the root besides the combinators (dropped there)
  names?: RegExp;                 // the top-level property names the wire takes (others are renamed)
  meta: boolean;                  // a schema not valid 2020-12 once repaired is left out
  arrayItems: boolean;            // an array schema needs `items`
  enumScalars: boolean;           // enum values only strings and numbers
  refAlone: boolean;              // a $ref takes no sibling but `$` keywords
};

// Anthropic's property-name pattern, as its answer quotes it.
export const PROPERTY_NAME = /^[a-zA-Z0-9_.-]{1,64}$/;
const OPENAI = { rootBanned: ["enum", "const", "not"], meta: false, arrayItems: true, enumScalars: false, refAlone: false } as const;
export const SCHEMA_RULES: Record<FitTarget, Rules> = {
  anthropic_messages: { label: "Anthropic", rootBanned: [], names: PROPERTY_NAME, meta: true, arrayItems: false, enumScalars: false, refAlone: false },
  openai_responses: { label: "OpenAI Responses", ...OPENAI },
  chat_completions: { label: "Chat Completions", ...OPENAI },
  gemini_generate_content: { label: "Gemini", rootBanned: [], meta: false, arrayItems: false, enumScalars: true, refAlone: true },
  portable: { label: "any provider", rootBanned: OPENAI.rootBanned, names: PROPERTY_NAME, meta: true, arrayItems: true, enumScalars: true, refAlone: true },
};

// The root `$schema` values a schema that otherwise fits is sent with.
const KEPT_DIALECT = /^https?:\/\/json-schema\.org\/(draft-07\/schema|draft\/2020-12\/schema)#?$/;
const COMBINATORS = ["allOf", "anyOf", "oneOf"] as const;
const TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);
// Type names servers write that are not JSON Schema's (Python's, OpenAPI's upper case): the same type.
const TYPE_ALIASES: Record<string, string> = { int: "integer", long: "integer", float: "number", double: "number", decimal: "number", bool: "boolean", str: "string", text: "string", dict: "object", map: "object", list: "array", tuple: "array" };
// Where a schema holds schemas (2020-12 core and applicator vocabularies, and the
// draft-07 `definitions`, `additionalItems` and `dependencies` the 2020-12 meta-schema still reads).
const MAP_OF = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"] as const;
const ONE = ["additionalProperties", "propertyNames", "items", "contains", "not", "if", "then", "else", "unevaluatedItems", "unevaluatedProperties", "additionalItems", "contentSchema"] as const;
const LIST_OF = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;
const COUNTS = ["maxLength", "minLength", "maxItems", "minItems", "maxContains", "minContains", "maxProperties", "minProperties"] as const;
const NUMBERS = ["maximum", "minimum", "exclusiveMaximum", "exclusiveMinimum", "multipleOf"] as const;
const STRINGS = ["title", "description", "$comment", "format", "pattern", "contentEncoding", "contentMediaType", "$ref", "$id", "$anchor", "$dynamicRef", "$dynamicAnchor"] as const;
const BOOLEANS = ["uniqueItems", "deprecated", "readOnly", "writeOnly"] as const;
// Schema nodes one fit visits at most: past it the rest is sent as it is (a tool's schema is a few hundred).
const VISITS_MAX = 20_000;
// How many changes the description lists by name; the rest are counted.
const NOTES_MAX = 8;
const DEPTH_MAX = 64;

type Json = Record<string, any>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const isSchema = (v: unknown) => isObj(v) || typeof v === "boolean";
const shown = (v: unknown) => {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
};
const at = (path: string) => (path ? `\`${path}\`` : "the input");

type Ctx = { root: Json; rules: Rules; notes: string[]; changed: boolean; visits: number };
const note = (c: Ctx, s: string) => {
  c.changed = true;
  if (!c.notes.includes(s)) c.notes.push(s);
};
const spent = (c: Ctx) => ++c.visits > VISITS_MAX;

// Each sub-schema of a node, with the path a note names it by (a property by
// its name, an item as `name[]`).
function* children(node: Json, path: string): Generator<{ get: () => unknown; set: (v: unknown) => void; drop: () => void; path: string }> {
  for (const k of MAP_OF) {
    const m = node[k];
    if (!isObj(m)) continue;
    for (const name of Object.keys(m)) {
      const p = k === "properties" ? (path ? `${path}.${name}` : name) : `${path ? `${path}.` : ""}${k}.${name}`;
      yield { get: () => m[name], set: (v) => void (m[name] = v), drop: () => void delete m[name], path: p };
    }
  }
  for (const k of ONE) {
    if (!(k in node)) continue;
    const p = k === "items" || k === "additionalItems" ? `${path || "input"}[]` : path;
    yield { get: () => node[k], set: (v) => void (node[k] = v), drop: () => void delete node[k], path: p };
  }
  for (const k of LIST_OF) {
    const l = node[k];
    if (!Array.isArray(l)) continue;
    for (let i = 0; i < l.length; i++) {
      const p = k === "prefixItems" ? `${path || "input"}[${i}]` : path;
      yield { get: () => l[i], set: (v) => void (l[i] = v), drop: () => void l.splice(i, 1), path: p };
    }
  }
  // draft-07 `dependencies`: a schema or a list of names per property.
  if (isObj(node.dependencies)) for (const name of Object.keys(node.dependencies)) {
    if (Array.isArray(node.dependencies[name])) continue;
    yield { get: () => node.dependencies[name], set: (v) => void (node.dependencies[name] = v), drop: () => void delete node.dependencies[name], path };
  }
}

// ---- References ------------------------------------------------------------

// A reference within the schema: "#", a JSON pointer ("#/$defs/A"), or a plain
// name an `$anchor` gives ("#A"). Anything else (another document) is not
// resolved: Keel fetches nothing a schema names.
function lookup(root: Json, ref: string): unknown {
  if (ref === "#") return root;
  if (ref.startsWith("#/")) {
    let node: unknown = root;
    for (const raw of ref.slice(2).split("/")) {
      let part: string;
      try { part = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~"); } catch { return undefined; }
      if (Array.isArray(node) && /^\d+$/.test(part)) node = node[Number(part)];
      else if (isObj(node) && Object.hasOwn(node, part)) node = node[part];
      else return undefined;
    }
    return node;
  }
  const anchor = /^#([A-Za-z_][-A-Za-z0-9._]*)$/.exec(ref)?.[1];
  if (!anchor) return undefined;
  let found: unknown;
  let visits = 0;
  const walk = (n: unknown) => {
    if (found !== undefined || !isObj(n) || ++visits > VISITS_MAX) return;
    if (n.$anchor === anchor) { found = n; return; }
    for (const ch of children(n, "")) walk(ch.get());
  };
  walk(root);
  return found;
}

// A pointer into the definitions stays a reference: the root keeps them however
// it is flattened. One into any other part of the root is written out where it
// stands, since flattening and renaming change those parts.
const defsRef = (ref: string) => ref === "#" || /^#\/(\$defs|definitions)\//.test(ref) || /^#[A-Za-z_]/.test(ref);

// Whether resolving `ref` reaches `ref` again (a recursive shape).
function cyclic(root: Json, ref: string): boolean {
  const seen = new Set<string>();
  let visits = 0;
  const reach = (n: unknown, depth: number): boolean => {
    if (!isObj(n) || depth > DEPTH_MAX || ++visits > VISITS_MAX) return false;
    if (typeof n.$ref === "string") {
      if (n.$ref === ref) return true;
      if (!seen.has(n.$ref)) {
        seen.add(n.$ref);
        if (reach(lookup(root, n.$ref), depth + 1)) return true;
      }
    }
    for (const ch of children(n, "")) if (reach(ch.get(), depth + 1)) return true;
    return false;
  };
  return reach(lookup(root, ref), 0);
}

function refs(c: Ctx, node: unknown, path: string, stack: string[]): unknown {
  if (!isObj(node) || spent(c) || stack.length > DEPTH_MAX) return node;
  for (const ch of children(node, path)) {
    const next = refs(c, ch.get(), ch.path, stack);
    if (next !== ch.get()) ch.set(next);
  }
  const ref = node.$ref;
  if (ref === undefined) return node;
  if (typeof ref !== "string") return node; // the meta-schema repair drops it
  const target = lookup(c.root, ref);
  if (target === undefined || (!isSchema(target))) {
    delete node.$ref;
    note(c, `${at(path)} refers to ${shown(ref)}, which is not part of the schema: any value is taken there`);
    return node;
  }
  const siblings = Object.keys(node).filter((k) => k !== "$ref" && !k.startsWith("$"));
  const alone = c.rules.refAlone && siblings.length > 0;
  if (defsRef(ref) && !alone) return node;
  // Written out where it stands: a copy of its target, whose own references are resolved the same way.
  if (stack.includes(ref) || cyclic(c.root, ref)) {
    if (alone) {
      for (const k of siblings) delete node[k];
      note(c, `${at(path)} is a recursive shape, sent without what the schema says beside its reference`);
    } else if (!defsRef(ref)) {
      delete node.$ref;
      note(c, `${at(path)} refers to ${shown(ref)} inside itself, which cannot be sent: any value is taken there`);
    }
    return node;
  }
  const copy = refs(c, structuredClone(target), path, [...stack, ref]);
  c.changed = true;
  const { $ref: _, ...rest } = node;
  if (typeof copy === "boolean") return Object.keys(rest).length ? (copy ? rest : { not: {} }) : copy;
  return { ...(copy as Json), ...rest };
}

// ---- Repairs toward 2020-12 ------------------------------------------------

function typeOf(c: Ctx, t: unknown, path: string): string | string[] | undefined {
  const one = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    const low = v.toLowerCase();
    return TYPES.has(low) ? low : TYPE_ALIASES[low];
  };
  if (Array.isArray(t)) {
    const kept = [...new Set(t.map(one).filter((v): v is string => !!v))];
    const lost = t.filter((v) => typeof v === "string" && v.toLowerCase() !== "any" && !one(v));
    if (lost.length) note(c, `${at(path)}: the type ${lost.map(shown).join(", ")} is not a JSON Schema type and is not sent`);
    return kept.length ? (kept.length === 1 ? kept[0] : kept) : undefined;
  }
  const v = one(t);
  if (!v && !(typeof t === "string" && t.toLowerCase() === "any")) note(c, `${at(path)}: the type ${shown(t)} is not a JSON Schema type and is not sent`);
  return v;
}

function repair(c: Ctx, node: unknown, path: string, depth = 0): unknown {
  if (typeof node === "boolean") return node;
  if (!isObj(node)) {
    // A bare type name for a schema ("string"), as some servers write a property.
    if (typeof node === "string" && typeOf({ ...c, notes: [] }, node, path)) { c.changed = true; return { type: typeOf(c, node, path) }; }
    note(c, `${at(path)} has no schema the provider reads (${shown(node)}): any value is taken there`);
    return {};
  }
  if (spent(c) || depth > DEPTH_MAX) return node;
  const fix = (k: string, v: unknown) => { node[k] = v; c.changed = true; };
  const drop = (k: string, why?: string) => {
    delete node[k];
    if (why) note(c, why);
    else c.changed = true;
  };
  if ("$schema" in node) {
    // (Taken off the working copy only: a schema nothing else changes is sent as written.)
    if (path === "" && KEPT_DIALECT.test(String(node.$schema))) delete node.$schema;
    else drop("$schema");
  }
  if ("type" in node) {
    const t = typeOf(c, node.type, path);
    if (t === undefined) drop("type");
    else if (JSON.stringify(t) !== JSON.stringify(node.type)) fix("type", t);
  }
  // draft-04: a boolean `exclusiveMinimum` says whether `minimum` itself is out.
  for (const [ex, bound] of [["exclusiveMinimum", "minimum"], ["exclusiveMaximum", "maximum"]] as const) {
    if (typeof node[ex] !== "boolean") continue;
    if (node[ex] && typeof node[bound] === "number") { fix(ex, node[bound]); delete node[bound]; }
    else drop(ex);
  }
  // draft-07: `items` as a list is a tuple; `additionalItems` what follows it.
  if (Array.isArray(node.items)) {
    const tuple = node.items;
    delete node.items;
    if (tuple.length) node.prefixItems = tuple;
    if ("additionalItems" in node) { node.items = node.additionalItems; delete node.additionalItems; }
    c.changed = true;
  }
  for (const k of COUNTS) {
    if (!(k in node)) continue;
    const n = typeof node[k] === "string" && node[k].trim() !== "" ? Number(node[k]) : node[k];
    if (Number.isInteger(n) && n >= 0) { if (n !== node[k]) fix(k, n); }
    else drop(k, `${at(path)}: ${k} ${shown(node[k])} is not a count and is not sent`);
  }
  for (const k of NUMBERS) {
    if (!(k in node)) continue;
    const n = typeof node[k] === "string" && node[k].trim() !== "" ? Number(node[k]) : node[k];
    if (typeof n === "number" && Number.isFinite(n) && !(k === "multipleOf" && n <= 0)) { if (n !== node[k]) fix(k, n); }
    else drop(k, `${at(path)}: ${k} ${shown(node[k])} is not a number the schema takes and is not sent`);
  }
  for (const k of STRINGS) {
    if (!(k in node) || typeof node[k] === "string") continue;
    if (k === "title" || k === "description") fix(k, typeof node[k] === "object" ? JSON.stringify(node[k]) : String(node[k]));
    else drop(k, `${at(path)}: ${k} ${shown(node[k])} is not text and is not sent`);
  }
  if (typeof node.$id === "string" && !/^[^#]*#?$/.test(node.$id)) drop("$id");
  if (typeof node.$anchor === "string" && !/^[A-Za-z_][-A-Za-z0-9._]*$/.test(node.$anchor)) drop("$anchor");
  for (const k of BOOLEANS) {
    if (!(k in node) || typeof node[k] === "boolean") continue;
    if (node[k] === "true" || node[k] === "false") fix(k, node[k] === "true");
    else drop(k);
  }
  if ("examples" in node && !Array.isArray(node.examples)) fix("examples", [node.examples]);
  if ("enum" in node && !Array.isArray(node.enum)) fix("enum", [node.enum]);
  if ("required" in node && !(Array.isArray(node.required) && node.required.every((r: unknown) => typeof r === "string") && new Set(node.required).size === node.required.length)) {
    // A `required: true` on a property is draft-03's, which its parent took into its own list
    // before it came here (below); anywhere else it means nothing.
    if (typeof node.required === "boolean") drop("required");
    else {
      const list = typeof node.required === "string" ? [node.required] : Array.isArray(node.required) ? node.required : [];
      const kept = [...new Set(list.filter((r: unknown) => typeof r === "string"))];
      if (kept.length) fix("required", kept);
      else drop("required");
    }
  }
  if (isObj(node.dependentRequired)) for (const [k, v] of Object.entries(node.dependentRequired)) {
    if (Array.isArray(v) && v.every((r) => typeof r === "string")) continue;
    delete node.dependentRequired[k];
    c.changed = true;
  } else if ("dependentRequired" in node) drop("dependentRequired");
  for (const k of LIST_OF) {
    if (!(k in node)) continue;
    if (isObj(node[k])) fix(k, [node[k]]);
    else if (!Array.isArray(node[k]) || !node[k].length) drop(k);
  }
  for (const k of MAP_OF) if (k in node && !isObj(node[k])) drop(k, k === "properties" ? `${at(path)}: its properties ${shown(node[k])} are not a map of schemas and are not sent` : undefined);
  if ("dependencies" in node && !isObj(node.dependencies)) drop("dependencies");
  else if (isObj(node.dependencies)) for (const [k, v] of Object.entries(node.dependencies)) {
    if (Array.isArray(v) ? v.every((r) => typeof r === "string") : isSchema(v)) continue;
    delete node.dependencies[k];
    c.changed = true;
  }
  if ("$vocabulary" in node && !(isObj(node.$vocabulary) && Object.values(node.$vocabulary).every((v) => typeof v === "boolean"))) drop("$vocabulary");
  // draft-03 `required: true` on properties: the object's own list.
  if (isObj(node.properties)) {
    const hoisted: string[] = [];
    for (const [name, sub] of Object.entries(node.properties)) {
      if (!isObj(sub) || typeof sub.required !== "boolean") continue;
      if (sub.required) hoisted.push(name);
      delete sub.required;
      c.changed = true;
    }
    if (hoisted.length) node.required = [...new Set([...(Array.isArray(node.required) ? node.required : []), ...hoisted])];
  }
  for (const ch of children(node, path)) {
    const before = ch.get();
    const after = repair(c, before, ch.path, depth + 1);
    if (after !== before) ch.set(after);
  }
  return node;
}

// ---- The root --------------------------------------------------------------

const isObjectSchema = (s: unknown) => s === true || (isObj(s) && (s.type === "object" || (Array.isArray(s.type) && s.type.includes("object")) || (s.type === undefined && !("enum" in s) && !("const" in s))));
const names = (l: string[]) => l.map((n) => `\`${n}\``).join(", ");

// A branch of a root combinator as an object of its own: a reference is read
// from the definitions, and a branch that is itself a combinator is flattened.
function branchOf(c: Ctx, b: unknown, depth: number): Json | null | "any" {
  if (b === true) return "any";
  if (!isObj(b)) return null;
  let s: Json = b;
  if (typeof s.$ref === "string") {
    const t = lookup(c.root, s.$ref);
    if (!isSchema(t)) return null;
    const { $ref: _, ...rest } = s;
    s = t === true ? rest : isObj(t) ? { ...structuredClone(t), ...rest } : { not: {} };
  }
  if (depth < 8 && COMBINATORS.some((k) => Array.isArray(s[k]))) {
    const inner = flatten(c, structuredClone(s), depth + 1);
    if (!inner) return null;
    s = inner;
  }
  return isObjectSchema(s) ? s : null;
}

// One property's schema from several branches: the same one, else any of them
// (oneOf and anyOf) or all of them (allOf), nested where the wire takes it.
function mergeProp(all: unknown[], how: "anyOf" | "allOf"): unknown {
  const uniq: unknown[] = [];
  for (const s of all) if (!uniq.some((u) => JSON.stringify(u) === JSON.stringify(s))) uniq.push(s);
  return uniq.length === 1 ? uniq[0] : { [how]: uniq };
}

// The root's combinators as one object (Claude Code's rule): allOf merges every
// branch with each branch's required list kept; anyOf and oneOf merge every
// branch's properties, require only what every branch requires, and say the
// groups in a sentence of the description.
function flatten(c: Ctx, root: Json, depth = 0): Json | null {
  for (const k of COMBINATORS) {
    const list = root[k];
    if (!Array.isArray(list)) continue;
    delete root[k];
    const branches = list.map((b) => branchOf(c, b, depth));
    const kept = branches.filter((b): b is Json => !!b && b !== "any");
    const other = branches.filter((b) => b === null).length;
    const props = new Map<string, unknown[]>();
    const add = (p: unknown) => {
      if (!isObj(p)) return;
      for (const [n, s] of Object.entries(p)) props.set(n, [...(props.get(n) ?? []), s]);
    };
    add(root.properties);
    for (const b of kept) add(b.properties);
    const required = (s: Json) => (Array.isArray(s.required) ? s.required.filter((r: unknown) => typeof r === "string") : []) as string[];
    let req: string[] = required(root);
    if (k === "allOf") {
      if (other && !kept.length) return null;
      for (const b of kept) req = [...new Set([...req, ...required(b)])];
    } else {
      if (!kept.length && branches.every((b) => b === null)) return null;
      // A branch that takes any object asks for nothing: only the root's own list holds then.
      const any = branches.some((b) => b === "any");
      if (!any && kept.length) {
        const common = kept.map(required).reduce((a, b) => a.filter((n) => b.includes(n)));
        req = [...new Set([...req, ...common])];
      }
      const groups = kept.map((b, i) => {
        const r = required(b).filter((n) => !req.includes(n));
        const own = r.length ? r : isObj(b.properties) ? Object.keys(b.properties).filter((n) => !req.includes(n)) : [];
        const label = typeof b.title === "string" ? `${b.title}: ` : "";
        return `(${i + 1}) ${label}${own.length ? names(own) : "no other parameters"}`;
      });
      const which = k === "oneOf" ? "exactly one" : "at least one";
      if (kept.length > 1) note(c, `Its parameters come in groups; give ${which} of: ${groups.join("; ")}`);
      const lost = list.filter((b, i) => branches[i] === null && !(isObj(b) && b.type === "null"));
      if (lost.length) note(c, `It also takes ${lost.length === 1 ? "a form" : "forms"} other than an object, which cannot be sent here`);
    }
    // What a branch says of the whole object beyond its properties is kept when every branch agrees on it.
    if (props.size) root.properties = Object.fromEntries([...props].map(([n, all]) => [n, mergeProp(all, k === "allOf" ? "allOf" : "anyOf")]));
    if (req.length) root.required = req;
    else delete root.required;
    if (!("description" in root)) {
      const said = kept.map((b) => b.description).filter((d): d is string => typeof d === "string");
      if (k === "allOf" && said.length) root.description = said.join(" ");
    }
    for (const b of kept) if (isObj(b.$defs) || isObj(b.definitions)) {
      for (const d of ["$defs", "definitions"] as const) if (isObj(b[d])) root[d] = { ...b[d], ...(isObj(root[d]) ? root[d] : {}) };
    }
    c.changed = true;
  }
  return root;
}

// ---- Wire rules on the fitted schema ---------------------------------------

function arrays(c: Ctx, node: unknown, path: string, depth = 0) {
  if (!isObj(node) || spent(c) || depth > DEPTH_MAX) return;
  const array = node.type === "array" || (Array.isArray(node.type) && node.type.includes("array"));
  if (array && !("items" in node)) { node.items = {}; c.changed = true; }
  for (const ch of children(node, path)) arrays(c, ch.get(), ch.path, depth + 1);
}

function enums(c: Ctx, node: unknown, path: string, depth = 0) {
  if (!isObj(node) || spent(c) || depth > DEPTH_MAX) return;
  if (Array.isArray(node.enum)) {
    const kept = node.enum.filter((v: unknown) => typeof v === "string" || (typeof v === "number" && Number.isFinite(v)));
    if (kept.length !== node.enum.length) {
      const lost = node.enum.filter((v: unknown) => !kept.includes(v));
      if (kept.length) node.enum = kept;
      else delete node.enum;
      note(c, `${at(path)}: the choices ${lost.map(shown).join(", ")} are not sent (the provider takes text and number choices)`);
    }
  }
  for (const ch of children(node, path)) enums(c, ch.get(), ch.path, depth + 1);
}

// A name as a rename map gives it, by the map's own keys only.
const renamedTo = (map: Record<string, string>, k: string) => (Object.hasOwn(map, k) ? map[k]! : k);

function rename(c: Ctx, root: Json, pattern: RegExp): Record<string, string> | undefined {
  if (!isObj(root.properties)) return undefined;
  const keys = Object.keys(root.properties);
  const bad = keys.filter((k) => !pattern.test(k));
  if (!bad.length) return undefined;
  const taken = new Set(keys.filter((k) => pattern.test(k)));
  // (No prototype: a property may be named `constructor` or `toString`.)
  const map: Record<string, string> = Object.create(null);
  const back: Record<string, string> = Object.create(null);
  for (const k of bad) {
    const base = (k.replace(/[^a-zA-Z0-9_.-]/g, "_") || "_").slice(0, 64);
    let n = base;
    for (let i = 2; taken.has(n); i++) n = `${base.slice(0, 64 - String(i).length - 1)}_${i}`;
    taken.add(n);
    map[k] = n;
    back[n] = k;
  }
  root.properties = Object.fromEntries(keys.map((k) => [renamedTo(map, k), root.properties[k]]));
  if (Array.isArray(root.required)) root.required = root.required.map((r: string) => renamedTo(map, r));
  const shownRenames = bad.map((k) => `${shown(k)} is \`${map[k]}\``);
  note(c, `Some parameter names are changed to ones the provider takes, and given back to the tool as the server names them: ${shownRenames.join(", ")}`);
  return back;
}

// ---- The 2020-12 meta-schema -----------------------------------------------

// The first way a schema is not valid against the 2020-12 meta-schema, or
// undefined: each keyword's value checked as the meta-schema types it (a
// keyword it does not know is valid, as in the meta-schema).
export function metaProblem(s: unknown, path = "", budget = { n: 0 }, depth = 0): string | undefined {
  if (typeof s === "boolean") return undefined;
  if (!isObj(s)) return `${at(path)} is ${shown(s)}, not a schema`;
  if (++budget.n > VISITS_MAX || depth > DEPTH_MAX) return undefined;
  const bad = (k: string, what: string) => `${at(path)}: ${k} ${shown(s[k])} is not ${what}`;
  if ("type" in s) {
    const t = s.type;
    const ok = typeof t === "string" ? TYPES.has(t) : Array.isArray(t) && t.length > 0 && t.every((x) => TYPES.has(x)) && new Set(t).size === t.length;
    if (!ok) return bad("type", "a JSON Schema type");
  }
  if ("enum" in s && !Array.isArray(s.enum)) return bad("enum", "a list");
  for (const k of COUNTS) if (k in s && !(Number.isInteger(s[k]) && s[k] >= 0)) return bad(k, "a count");
  for (const k of NUMBERS) if (k in s && !(typeof s[k] === "number" && Number.isFinite(s[k]))) return bad(k, "a number");
  if ("multipleOf" in s && !(s.multipleOf > 0)) return bad("multipleOf", "above 0");
  for (const k of STRINGS) if (k in s && typeof s[k] !== "string") return bad(k, "text");
  for (const k of BOOLEANS) if (k in s && typeof s[k] !== "boolean") return bad(k, "true or false");
  if ("examples" in s && !Array.isArray(s.examples)) return bad("examples", "a list");
  if ("required" in s && !(Array.isArray(s.required) && s.required.every((r: unknown) => typeof r === "string") && new Set(s.required).size === s.required.length)) return bad("required", "a list of distinct names");
  if ("dependentRequired" in s && !(isObj(s.dependentRequired) && Object.values(s.dependentRequired).every((v) => Array.isArray(v) && v.every((r) => typeof r === "string")))) return bad("dependentRequired", "a map of name lists");
  if (typeof s.$id === "string" && !/^[^#]*#?$/.test(s.$id)) return bad("$id", "a URI without a fragment");
  if (typeof s.$anchor === "string" && !/^[A-Za-z_][-A-Za-z0-9._]*$/.test(s.$anchor)) return bad("$anchor", "an anchor name");
  for (const k of LIST_OF) if (k in s && !(Array.isArray(s[k]) && s[k].length > 0)) return bad(k, "a list of schemas");
  for (const k of MAP_OF) if (k in s && !isObj(s[k])) return bad(k, "a map of schemas");
  for (const k of ONE) if (k in s && !isSchema(s[k])) return bad(k, "a schema");
  if ("dependencies" in s && !isObj(s.dependencies)) return bad("dependencies", "a map");
  for (const ch of children(s, path)) {
    const p = metaProblem(ch.get(), ch.path, budget, depth + 1);
    if (p) return p;
  }
  return undefined;
}

// What the wire refuses in a schema as it would be sent, each problem once: the
// check of a built body (valid.ts) and the scripted stand-in's refusal.
export function schemaRefusals(schema: unknown, target: FitTarget): string[] {
  const r = SCHEMA_RULES[target];
  const out: string[] = [];
  if (!isObj(schema)) return ["the input schema is not an object"];
  if (schema.type !== "object") out.push(`the input schema's type is ${shown(schema.type)}, not "object"`);
  for (const k of [...COMBINATORS, ...r.rootBanned]) if (k in schema) out.push(`the input schema has ${k} at the top level`);
  if (r.names && isObj(schema.properties)) for (const k of Object.keys(schema.properties)) if (!r.names.test(k)) out.push(`the property name ${shown(k)} is outside ${r.names.source}`);
  if (r.meta) {
    const p = metaProblem(schema);
    if (p) out.push(`the input schema is not valid JSON Schema 2020-12: ${p}`);
  }
  let visits = 0;
  const walk = (n: unknown, path: string, depth: number) => {
    if (!isObj(n) || ++visits > VISITS_MAX || depth > DEPTH_MAX) return;
    const array = n.type === "array" || (Array.isArray(n.type) && n.type.includes("array"));
    if (r.arrayItems && array && !("items" in n)) out.push(`${at(path)}: array schema missing items`);
    if (r.enumScalars && Array.isArray(n.enum) && n.enum.some((v: unknown) => typeof v !== "string" && typeof v !== "number")) out.push(`${at(path)}: an enum value that is not text or a number`);
    if (r.refAlone && typeof n.$ref === "string" && Object.keys(n).some((k) => k !== "$ref" && !k.startsWith("$"))) out.push(`${at(path)}: a $ref with other keywords beside it`);
    for (const ch of children(n, path)) walk(ch.get(), ch.path, depth + 1);
  };
  walk(schema, "", 0);
  return out;
}

// ---- The fit ---------------------------------------------------------------

const replace = (to: Json, from: Json) => {
  for (const k of Object.keys(to)) delete to[k];
  Object.assign(to, from);
};

export function fitSchema(input: unknown, target: FitTarget): Fitted {
  const rules = SCHEMA_RULES[target];
  if (input === undefined || input === null || input === true) return { schema: { type: "object" }, notes: [] };
  if (!isObj(input)) return { left: `its input schema is ${shown(input)}, not a JSON Schema object` };
  const root = structuredClone(input) as Json;
  const c: Ctx = { root, rules, notes: [], changed: false, visits: 0 };
  repair(c, root, "");
  // A root that is a reference (zod and pydantic write one): its target is the root, the definitions kept beside it.
  for (let i = 0; i < 4 && typeof root.$ref === "string"; i++) {
    const t = lookup(root, root.$ref);
    if (!isObj(t) || t === root) break;
    const { $ref: _, ...rest } = root;
    replace(root, { ...structuredClone(t), ...rest });
    c.changed = true;
  }
  // (Resolved against the schema as repaired: a reference names what the server wrote.)
  const resolved = refs(c, root, "", []);
  if (resolved !== root) replace(root, isObj(resolved) ? resolved : {});
  if (COMBINATORS.some((k) => Array.isArray(root[k]))) {
    if (!flatten(c, root)) return { left: "its input is not an object in any of the forms its schema offers" };
  }
  if (root.type === undefined) { root.type = "object"; c.changed = true; }
  else if (Array.isArray(root.type) && root.type.includes("object")) { root.type = "object"; c.changed = true; }
  if (root.type !== "object") return { left: `its input is ${shown(root.type)}, and a tool's input is an object` };
  for (const k of rules.rootBanned) if (k in root) {
    delete root[k];
    note(c, `What its schema says of the whole input with \`${k}\` is not sent`);
  }
  const renames = rules.names ? rename(c, root, rules.names) : undefined;
  if (rules.arrayItems) arrays(c, root, "");
  if (rules.enumScalars) enums(c, root, "");
  if (rules.meta) {
    const p = metaProblem(root);
    if (p) return { left: `its input schema is not valid JSON Schema 2020-12, which ${rules.label} requires (${p})` };
  }
  if (!c.changed) return { schema: input, notes: [] };
  return { schema: root, notes: c.notes, ...(renames ? { renames } : {}) };
}

// Once per schema object and wire: a listing's tools are the same objects from
// one request to the next, so a fit is computed once and sent as the same bytes.
const cache = new WeakMap<object, Map<FitTarget, Fitted>>();
export function fitted(schema: unknown, target: FitTarget): Fitted {
  if (!isObj(schema)) return fitSchema(schema, target);
  let m = cache.get(schema);
  if (!m) cache.set(schema, (m = new Map()));
  let f = m.get(target);
  if (!f) m.set(target, (f = fitSchema(schema, target)));
  return f;
}

// The description a fitted tool is sent with: its own, then what was changed.
export function noted(description: string, notes: string[]): string {
  if (!notes.length) return description;
  const listed = notes.slice(0, NOTES_MAX).map((n) => n.replace(/[.\s]+$/, ""));
  const more = notes.length > NOTES_MAX ? `; and ${notes.length - NOTES_MAX} more change${notes.length - NOTES_MAX === 1 ? "" : "s"}` : "";
  return `${description.trimEnd()}${description.trim() ? "\n\n" : ""}Keel changed this tool's input schema to one the provider takes. ${listed.join(". ")}${more}.`;
}

// An input the model wrote under renamed parameters, as the server names them.
// One input is given back as one object, whoever asks (the gate's target and
// the run read the same object: what was judged is keyed on it).
const unrenamed = new WeakMap<Record<string, string>, WeakMap<object, unknown>>();
export function unrename(input: unknown, back: Record<string, string> | undefined): unknown {
  if (!back || !isObj(input)) return input;
  let by = unrenamed.get(back);
  if (!by) unrenamed.set(back, (by = new WeakMap()));
  let out = by.get(input);
  if (out === undefined) by.set(input, (out = Object.fromEntries(Object.entries(input).map(([k, v]) => [renamedTo(back, k), v]))));
  return out;
}

// A tool's schema the provider refused in a request: what it is sent as for
// the rest of the session, a tool the model can still call without seeing its
// parameters (Claude Code's answer to the same refusal).
export const BARE_SCHEMA: Record<string, unknown> = Object.freeze({ type: "object" }) as Record<string, unknown>;
export const bareNote = (description: string) =>
  `${description.trimEnd()}${description.trim() ? "\n\n" : ""}The provider refused this tool's input schema, so its parameters are not shown: call it with the arguments its description names.`;

type FitTool = { name: string; description: string; input_schema: Record<string, unknown>; freeform?: unknown; run?: (input: any, ctx: any) => any; target?: (input: any, session?: string) => any; judge?: (input: any) => any };

// A request's tools fitted to a wire: each as it fits, a tool that cannot be
// made to fit left out and named in `left`, and one in `bare` sent without its
// parameters. A tool that already fits is the same object.
export function fitTools<T extends FitTool>(tools: T[], target: FitTarget, bare?: ReadonlySet<string>): { tools: T[]; left: { name: string; why: string }[] } {
  const out: T[] = [];
  const left: { name: string; why: string }[] = [];
  for (const t of tools) {
    if (bare?.has(t.name)) {
      out.push({ ...t, description: bareNote(t.description), input_schema: BARE_SCHEMA });
      continue;
    }
    if (t.freeform) { out.push(t); continue; }
    const f = fitted(t.input_schema, target);
    if ("left" in f) { left.push({ name: t.name, why: f.left }); continue; }
    if (f.schema === t.input_schema && !f.notes.length) { out.push(t); continue; }
    const back = f.renames;
    out.push({
      ...t,
      description: noted(t.description, f.notes),
      input_schema: f.schema,
      ...(back && t.run ? { run: (input: any, ctx: any) => t.run!(unrename(input, back), ctx) } : {}),
      // The gate judges the call as the server will get it (src/tools/defer.ts keys what it judged on that input).
      ...(back && t.target ? { target: (input: any, session?: string) => t.target!(unrename(input, back), session) } : {}),
      ...(back && t.judge ? { judge: (input: any) => t.judge!(unrename(input, back)) } : {}),
    });
  }
  return { tools: out, left };
}

// The tool a provider's 400 names as the one whose schema it refused, by its
// position in the request as the wire sends it or by its name, or undefined.
// Anthropic: "tools.N.custom.input_schema: JSON schema is invalid" (the
// position counts the tools as sent: in the prompt first, then the deferred).
// OpenAI: "Invalid schema for function 'NAME': ...". Gemini:
// "...tools[0].function_declarations[N].parameters...".
export function refusedTool(message: string, tools: { name: string; defer?: boolean; namespace?: string }[], wire: Wire | undefined): string | undefined {
  const named = /Invalid schema for function '([^']+)'/.exec(message)?.[1];
  if (named) {
    const t = tools.find((x) => x.name === named) ?? tools.find((x) => x.name === `keel_${named}` || x.name.endsWith(`__${named}`) || (x.namespace && x.name.endsWith(named)));
    return t?.name;
  }
  if (wire === "anthropic_messages" || wire === undefined) {
    const i = /tools\.(\d+)\.(?:custom\.)?input_schema/.exec(message)?.[1];
    if (i !== undefined) {
      const sent = [...tools.filter((t) => !t.defer), ...tools.filter((t) => t.defer)];
      return sent[Number(i)]?.name;
    }
  }
  if (wire === "gemini_generate_content" || wire === undefined) {
    const i = /function_declarations\[(\d+)\]\.parameters/.exec(message)?.[1];
    if (i !== undefined) return tools[Number(i)]?.name;
  }
  return undefined;
}

// What became of each of a server's tools on each wire, for Settings > MCP
// servers: the tools left out (where, and why) and the ones changed to fit
// (where, and what changed). A tool that fits every wire as it is is not named.
export type SchemaFitRow = { tool: string; left: { on: string[]; why: string }[]; changed: { on: string[]; notes: string[] }[] };
const SHOWN: [FitTarget, string][] = [
  ["anthropic_messages", "Anthropic"], ["openai_responses", "OpenAI Responses"], ["chat_completions", "Chat Completions"],
  ["gemini_generate_content", "Gemini"], ["portable", "ACP agents"],
];
export function fitReport(tools: { name: string; inputSchema?: unknown }[]): SchemaFitRow[] {
  const rows: SchemaFitRow[] = [];
  for (const t of tools) {
    const row: SchemaFitRow = { tool: t.name, left: [], changed: [] };
    for (const [target, label] of SHOWN) {
      const f = fitted(t.inputSchema ?? { type: "object" }, target);
      if ("left" in f) {
        const same = row.left.find((l) => l.why === f.left);
        if (same) same.on.push(label);
        else row.left.push({ on: [label], why: f.left });
      } else if (f.notes.length) {
        const key = JSON.stringify(f.notes);
        const same = row.changed.find((c) => JSON.stringify(c.notes) === key);
        if (same) same.on.push(label);
        else row.changed.push({ on: [label], notes: f.notes });
      }
    }
    if (row.left.length || row.changed.length) rows.push(row);
  }
  return rows;
}
