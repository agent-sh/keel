// A small JSON Schema check for agent reports: the keywords a report schema
// uses (type, properties, required, additionalProperties, items, enum, const,
// minItems, maxItems, minLength, maxLength, minimum, maximum, anyOf, oneOf).
// Unknown keywords are ignored. Returns the first mismatch, or nothing.

type Schema = Record<string, any>;

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);

export function check(schema: Schema, v: unknown, at = "$"): string | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  if (schema.anyOf || schema.oneOf) {
    const alts: Schema[] = schema.anyOf ?? schema.oneOf;
    const errs = alts.map((s) => check(s, v, at));
    if (!errs.some((e) => e === undefined)) return `${at}: matches none of the allowed shapes (${errs[0]})`;
  }
  if (schema.type) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(v);
    if (!types.some((x) => x === t || (x === "number" && t === "integer"))) return `${at}: expected ${types.join(" or ")}, got ${t}`;
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(v)) return `${at}: must be ${JSON.stringify(schema.const)}`;
  if (schema.enum && !schema.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(v))) return `${at}: must be one of ${JSON.stringify(schema.enum)}`;
  if (typeof v === "string") {
    if (schema.minLength !== undefined && v.length < schema.minLength) return `${at}: shorter than ${schema.minLength}`;
    if (schema.maxLength !== undefined && v.length > schema.maxLength) return `${at}: longer than ${schema.maxLength}`;
  }
  if (typeof v === "number") {
    if (schema.minimum !== undefined && v < schema.minimum) return `${at}: below ${schema.minimum}`;
    if (schema.maximum !== undefined && v > schema.maximum) return `${at}: above ${schema.maximum}`;
  }
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) return `${at}: fewer than ${schema.minItems} items`;
    if (schema.maxItems !== undefined && v.length > schema.maxItems) return `${at}: more than ${schema.maxItems} items`;
    if (schema.items) for (let i = 0; i < v.length; i++) { const e = check(schema.items, v[i], `${at}[${i}]`); if (e) return e; }
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in o)) return `${at}: missing "${k}"`;
    const props: Record<string, Schema> = schema.properties ?? {};
    for (const [k, val] of Object.entries(o)) {
      if (props[k]) { const e = check(props[k]!, val, `${at}.${k}`); if (e) return e; }
      else if (schema.additionalProperties === false) return `${at}: "${k}" is not allowed`;
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") { const e = check(schema.additionalProperties, val, `${at}.${k}`); if (e) return e; }
    }
  }
  return undefined;
}

// The JSON value a report holds: the whole text, else the last fenced block,
// else the outermost braces or brackets.
export function extractJson(text: string): { value: unknown } | { error: string } {
  const tries = [text.trim()];
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]!.trim());
  if (fences.length) tries.push(fences.at(-1)!);
  const a = text.search(/[[{]/);
  const b = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
  for (const t of tries) {
    try { return { value: JSON.parse(t) }; } catch {}
  }
  return { error: "the report is not JSON" };
}

// A schema the model passed is checked to be one before anything runs.
export function validSchema(s: unknown): string | undefined {
  if (!s || typeof s !== "object" || Array.isArray(s)) return "output_schema is a JSON schema object";
  const text = JSON.stringify(s);
  if (text.length > 16_000) return "output_schema is at most 16,000 characters";
  return undefined;
}
