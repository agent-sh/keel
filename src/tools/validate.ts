// A call's input checked against the tool's own input schema before the tool
// runs, so a call with a field missing, a field the tool does not have or a
// value of the wrong kind is answered with one line that names what is wrong
// and the right field, instead of the tool's own failure (or its silent use
// of an empty string). Claude Code answers such a call with an
// InputValidationError and Codex with a parse error naming the field; the
// answer here is the same fact in one line.
//
// What is checked, at the top level of the input only: the required fields,
// the fields the schema does not list (only where it says
// `additionalProperties: false`, which is what JSON Schema means by it: a
// schema that does not say it allows them, an MCP tool's usually), and the
// kind of each listed field's value. Nothing the tool accepts is refused:
// the names a tool reads in a field's place (`inputAlias`) count as the field,
// a null is a field not given, a number or a boolean is accepted where text
// is asked for and a numeric string where a number is (the tools read them
// with String and Number), and a required field the tool does without
// (`inputOptional`) is not required. A schema this does not understand (no
// object with properties at its root, a root anyOf, oneOf, allOf, $ref or
// patternProperties) is not checked, and neither is a property whose own
// schema is a union or a reference.
import { similar } from "./missing.ts";

type Schema = Record<string, any>;

// What a check needs of a tool: its name, schema and the names it reads that its schema does not list.
export type Checked = {
  name: string;
  input_schema?: unknown;
  // Names the tool reads in a field's place, by field: `{ file_path: ["path"] }`.
  inputAlias?: Record<string, string[]>;
  // Fields its schema requires that the tool does without.
  inputOptional?: string[];
  // Names it accepts that its schema does not list and that stand for no field.
  inputAlso?: string[];
};

type Plan = {
  sig: string;
  props: Map<string, Schema>;
  required: string[];
  closed: boolean;
  alias: Map<string, string>;
  also: Set<string>;
};

// By the schema object: a tool copied for a request (a deferred or pinned one) shares it.
const plans = new WeakMap<object, Plan | null>();

const UNDERSTOOD_AWAY = ["anyOf", "oneOf", "allOf", "$ref", "not", "patternProperties", "if", "then", "else", "propertyNames"];

const sigOf = (tool: Checked) => JSON.stringify([tool.inputAlias, tool.inputOptional, tool.inputAlso]);

function compile(tool: Checked): Plan | null {
  const s = tool.input_schema as Schema | undefined;
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  if (s.type !== undefined && s.type !== "object") return null;
  if (!s.properties || typeof s.properties !== "object" || Array.isArray(s.properties)) return null;
  if (UNDERSTOOD_AWAY.some((k) => k in s)) return null;
  const props = new Map<string, Schema>();
  for (const [k, v] of Object.entries(s.properties)) props.set(k, v && typeof v === "object" ? (v as Schema) : {});
  const optional = new Set(tool.inputOptional ?? []);
  const required = (Array.isArray(s.required) ? s.required : []).filter((k: unknown): k is string => typeof k === "string" && !optional.has(k));
  const alias = new Map<string, string>();
  for (const [field, names] of Object.entries(tool.inputAlias ?? {})) for (const n of names) alias.set(n, field);
  return { sig: sigOf(tool), props, required, closed: s.additionalProperties === false, alias, also: new Set(tool.inputAlso) };
}

const planOf = (tool: Checked): Plan | null => {
  const key = tool.input_schema;
  if (!key || typeof key !== "object") return null;
  const had = plans.get(key);
  if (had !== undefined && (had === null || had.sig === sigOf(tool))) return had;
  const p = compile(tool);
  plans.set(key, p);
  return p;
};

const NUMERIC = /^\s*-?\d+(\.\d+)?\s*$/;
const kind = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "a list" : typeof v === "object" ? "an object" : typeof v === "string" ? "a string" : typeof v === "number" ? "a number" : "a boolean");

// What is wrong with a value for a property schema, or nothing.
function wrongKind(schema: Schema, v: unknown): string | undefined {
  if (UNDERSTOOD_AWAY.some((k) => k in schema)) return undefined;
  const t = schema.type;
  const types: string[] = typeof t === "string" ? [t] : Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [];
  if (!types.length) return undefined;
  const fits = (x: string): boolean => {
    switch (x) {
      case "string": return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
      case "number": case "integer": return (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && NUMERIC.test(v));
      case "boolean": return typeof v === "boolean";
      case "array": return Array.isArray(v);
      case "object": return !!v && typeof v === "object" && !Array.isArray(v);
      case "null": return v === null;
      default: return true;
    }
  };
  if (types.some(fits)) return undefined;
  const want = types.map((x) => (x === "integer" ? "a whole number" : x === "array" ? "a list" : x === "object" ? "an object" : x === "boolean" ? "true or false" : `a ${x}`));
  return `must be ${want.join(" or ")}, not ${kind(v)}`;
}

// Another harness's name for the same field, by the name a model wrote.
const SAME: readonly (readonly string[])[] = [
  ["command", "cmd", "script", "bash_command", "shell_command"],
  ["file_path", "path", "filepath", "file", "filename", "file_name", "absolute_path", "target_file"],
  ["dir_path", "directory", "dir", "folder", "path"],
  ["old_string", "old_str", "old_text", "oldstring", "search", "find"],
  ["new_string", "new_str", "new_text", "newstring", "replace", "replacement"],
  ["content", "contents", "text", "file_text", "body"],
  ["pattern", "regex", "query", "search"],
  ["url", "uri", "link", "address"],
  ["timeout", "timeout_ms", "timeout_seconds"],
  ["message", "prompt", "text", "task"],
];
const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// The listed field a field the tool does not have is most likely meant to be.
function closest(unknown: string, known: readonly string[]): string | undefined {
  const flat = plain(unknown);
  const same = known.find((k) => plain(k) === flat);
  if (same) return same;
  for (const g of SAME) {
    if (!g.includes(unknown.toLowerCase())) continue;
    const hit = known.find((k) => g.includes(k));
    if (hit) return hit;
  }
  return similar(known, unknown)[0];
}

// One line naming what is wrong with a call's input and the fields the tool has, or undefined when it holds.
export function inputProblem(tool: Checked, input: unknown): string | undefined {
  const plan = planOf(tool);
  if (!plan) return undefined;
  // Not an object (a patch sent as bare text): the tool reads it as it is.
  if (input !== undefined && input !== null && (typeof input !== "object" || Array.isArray(input))) return undefined;
  const have = (input ?? {}) as Record<string, unknown>;
  const given = (k: string) => have[k] !== undefined && have[k] !== null;
  const aliasesOf = (field: string) => [...plan.alias].filter(([, f]) => f === field).map(([n]) => n);
  const problems: string[] = [];
  const missing = plan.required.filter((k) => !given(k) && !aliasesOf(k).some(given));
  const known = [...plan.props.keys()];
  const unknown = plan.closed ? Object.keys(have).filter((k) => !plan.props.has(k) && !plan.alias.has(k) && !plan.also.has(k)) : [];
  // A lone stray field beside a lone missing one is that field under another name.
  const lone = missing.length === 1 && unknown.length === 1;
  for (const k of missing) problems.push(`the required field \`${k}\` is missing`);
  for (const k of unknown) {
    const near = closest(k, known.filter((f) => !given(f))) ?? (lone ? missing[0] : undefined);
    problems.push(`\`${k}\` is not a field of ${tool.name}${near ? ` (did you mean \`${near}\`?)` : ""}`);
  }
  for (const [k, schema] of plan.props) {
    if (!given(k)) continue;
    const why = wrongKind(schema, have[k]);
    if (why) problems.push(`\`${k}\` ${why}`);
  }
  if (!problems.length) return undefined;
  const fields = known.slice(0, 14).map((k) => (plan.required.includes(k) ? `${k} (required)` : k)).join(", ") + (known.length > 14 ? ", ..." : "");
  return `${tool.name} did not run, its input is invalid: ${problems.join("; ")}. Its fields: ${fields || "none"}. Send the call again with the right fields.`;
}
