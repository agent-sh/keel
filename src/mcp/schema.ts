// Whether a value conforms to a JSON Schema, for the output schema an MCP
// tool declares (2025-11-25 server/tools, Output Schema: servers MUST return
// structured content that conforms, clients SHOULD validate). The keywords
// servers use are checked: type, enum, const, properties, required,
// additionalProperties, patternProperties, items, prefixItems, the length,
// count and range bounds, pattern, allOf, anyOf, oneOf, not, and a $ref within
// the schema. A keyword not checked here passes: the check never calls a
// result wrong for a rule it does not know, so a server is held only to what
// is checked.
//
// It runs on the daemon's loop after a result, so its work is bounded: a
// budget of schema nodes a check visits (past it the result is not checked),
// a $ref met again for the same value inside its own check passes (a schema
// that refers to itself), and a pattern that can take time exponential in its
// input (a quantified group that holds a quantifier, a back reference) is not
// run, nor a pattern on a string longer than PATTERN_INPUT_MAX.

// The most problems one check names: past it the model has enough to go on.
const PROBLEMS_MAX = 5;
// How deep schemas may nest through $ref and the combining keywords: a
// schema that refers to itself with no value under it would never end.
const DEPTH_MAX = 64;
// Schema nodes one check visits at most: a valid result of tens of thousands of values is checked in milliseconds.
const VISITS_MAX = 10_000;
const PATTERN_INPUT_MAX = 10_000;

class OverBudget extends Error {}
type Run = { visits: number; active: Map<string, Set<unknown>> };

type Schema = boolean | Record<string, any>;

const typeOf = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v;

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && equal((a as any)[k], (b as any)[k]));
}

const at = (path: string, key: string | number) => (typeof key === "number" ? `${path}[${key}]` : /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`);
const shown = (v: unknown) => {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

// A pattern whose matching can take time exponential in its input: a group that holds a quantifier and is
// quantified itself ((a+)+, (a|aa)*, (\w+\s?){2,}), or a back reference. Read on the pattern's text, cautiously:
// a pattern it takes for one is only not run.
export function slowPattern(p: string): boolean {
  if (/\\[1-9]|\\k</.test(p)) return true;
  const stack: { quantified: boolean; alternates: boolean }[] = [];
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "\\") { i++; continue; }
    if (c === "[") { // a class: its characters are not quantifiers
      for (i++; i < p.length && p[i] !== "]"; i++) if (p[i] === "\\") i++;
      continue;
    }
    if (c === "(") { stack.push({ quantified: false, alternates: false }); continue; }
    if (c === "|" && stack.length) { stack[stack.length - 1]!.alternates = true; continue; }
    const quantifier = c === "+" || c === "*" || c === "?" || (c === "{" && /^\{\d+(,\d*)?\}/.test(p.slice(i)));
    if (c === ")") {
      const g = stack.pop();
      const next = p[i + 1];
      const outer = next === "+" || next === "*" || (next === "{" && /^\{\d+,/.test(p.slice(i + 1)));
      if (g && outer && (g.quantified || g.alternates)) return true;
      if (g?.quantified && stack.length) stack[stack.length - 1]!.quantified = true;
      continue;
    }
    if (quantifier && stack.length && c !== "?") stack[stack.length - 1]!.quantified = true;
  }
  return false;
}

function regex(p: unknown): RegExp | undefined {
  if (typeof p !== "string" || slowPattern(p)) return;
  try { return new RegExp(p, "u"); } catch { return; }
}

// A local reference: "#", "#/$defs/name", "#/definitions/name", any JSON pointer from the root.
function resolve(root: Schema, ref: string): Schema | undefined {
  if (!ref.startsWith("#")) return;
  let s: any = root;
  for (const raw of ref.slice(1).split("/").slice(1)) {
    const k = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (s === null || typeof s !== "object" || !Object.hasOwn(s, k)) return;
    s = s[k];
  }
  return typeof s === "boolean" || (s && typeof s === "object") ? s : undefined;
}

// What is wrong with `value` against `schema`, each as a path and a reason
// ("$.temperature: expected number, got string"); empty when it conforms.
// A check past its budget names nothing: the result is not checked (schemaCheck says so).
export function schemaProblems(value: unknown, schema: Schema): string[] {
  return schemaCheck(value, schema).problems;
}
export function schemaCheck(value: unknown, schema: Schema): { problems: string[]; checked: boolean } {
  const out: string[] = [];
  try { check(value, schema, "$", schema, out, 0, { visits: 0, active: new Map() }); } catch (e) {
    if (e instanceof OverBudget) return { problems: [], checked: false };
    throw e;
  }
  return { problems: out.slice(0, PROBLEMS_MAX), checked: true };
}

// A branch's first problem, without the path all branches share.
const first = (p: string[], path: string) => (p[0]!.startsWith(`${path}: `) ? p[0]!.slice(path.length + 2) : p[0]!);

// Whether `value` passes, with its problems kept apart (anyOf and oneOf try each branch).
const passes = (value: unknown, s: Schema, path: string, root: Schema, depth: number, run: Run) => {
  const sub: string[] = [];
  check(value, s, path, root, sub, depth, run);
  return sub;
};

function check(v: unknown, s: Schema, path: string, root: Schema, out: string[], depth: number, run: Run): void {
  if (out.length >= PROBLEMS_MAX) return;
  if (s === true || s === undefined || s === null) return;
  if (s === false) return void out.push(`${path}: no value is allowed here`);
  if (typeof s !== "object") return;
  if (depth > DEPTH_MAX) return;
  if (++run.visits > VISITS_MAX) throw new OverBudget();
  const bad = (why: string) => void out.push(`${path}: ${why}`);
  if (typeof s.$ref === "string") {
    const to = resolve(root, s.$ref);
    // (The same reference for the same value inside its own check: a loop, which passes.)
    const seen = run.active.get(s.$ref) ?? new Set<unknown>();
    if (to !== undefined && !seen.has(v)) {
      run.active.set(s.$ref, seen.add(v));
      try { check(v, to, path, root, out, depth + 1, run); } finally { seen.delete(v); }
    }
  }
  const t = typeOf(v);
  if (s.type !== undefined) {
    const want: string[] = (Array.isArray(s.type) ? s.type : [s.type]).filter((x: unknown) => typeof x === "string");
    if (want.length && !want.some((w) => w === t || (w === "number" && t === "integer"))) return bad(`expected ${want.join(" or ")}, got ${t === "integer" ? "number" : t}`);
  }
  if (Array.isArray(s.enum) && !s.enum.some((e: unknown) => equal(e, v))) bad(`${shown(v)} is not one of ${s.enum.map(shown).join(", ")}`);
  if (Object.hasOwn(s, "const") && !equal(s.const, v)) bad(`expected ${shown(s.const)}, got ${shown(v)}`);
  if (t === "string") {
    const n = [...(v as string)].length;
    if (typeof s.minLength === "number" && n < s.minLength) bad(`shorter than ${s.minLength} characters`);
    if (typeof s.maxLength === "number" && n > s.maxLength) bad(`longer than ${s.maxLength} characters`);
    const re = n <= PATTERN_INPUT_MAX ? regex(s.pattern) : undefined;
    if (re && !re.test(v as string)) bad(`${shown(v)} does not match the pattern ${s.pattern}`);
  }
  if (t === "number" || t === "integer") {
    const n = v as number;
    if (typeof s.minimum === "number" && n < s.minimum) bad(`${n} is less than ${s.minimum}`);
    if (typeof s.maximum === "number" && n > s.maximum) bad(`${n} is more than ${s.maximum}`);
    if (typeof s.exclusiveMinimum === "number" && n <= s.exclusiveMinimum) bad(`${n} is not more than ${s.exclusiveMinimum}`);
    if (typeof s.exclusiveMaximum === "number" && n >= s.exclusiveMaximum) bad(`${n} is not less than ${s.exclusiveMaximum}`);
  }
  if (t === "array") {
    const a = v as unknown[];
    if (typeof s.minItems === "number" && a.length < s.minItems) bad(`fewer than ${s.minItems} items`);
    if (typeof s.maxItems === "number" && a.length > s.maxItems) bad(`more than ${s.maxItems} items`);
    const prefix: Schema[] = Array.isArray(s.prefixItems) ? s.prefixItems : [];
    // (An array of schemas under items is the older form of prefixItems.)
    const fixed = prefix.length ? prefix : Array.isArray(s.items) ? s.items : [];
    const rest = Array.isArray(s.items) ? (s.additionalItems ?? true) : (s.items ?? true);
    a.forEach((item, i) => check(item, i < fixed.length ? fixed[i]! : rest, at(path, i), root, out, depth + 1, run));
  }
  if (t === "object") {
    const o = v as Record<string, unknown>;
    for (const k of Array.isArray(s.required) ? s.required : []) if (typeof k === "string" && !Object.hasOwn(o, k)) bad(`${shown(k)} is required and missing`);
    const props = s.properties && typeof s.properties === "object" ? s.properties : {};
    const patterns = Object.entries(s.patternProperties && typeof s.patternProperties === "object" ? s.patternProperties : {})
      .map(([p, sub]) => [regex(p), sub] as const).filter(([re]) => re);
    // (A key longer than a pattern is run on is held to no pattern.)
    for (const [k, item] of Object.entries(o)) {
      let known = false;
      if (Object.hasOwn(props, k)) { known = true; check(item, props[k], at(path, k), root, out, depth + 1, run); }
      for (const [re, sub] of patterns) if (k.length <= PATTERN_INPUT_MAX && re!.test(k)) { known = true; check(item, sub as Schema, at(path, k), root, out, depth + 1, run); }
      if (!known && s.additionalProperties !== undefined) {
        if (s.additionalProperties === false) bad(`${shown(k)} is not a property this schema allows`);
        else check(item, s.additionalProperties, at(path, k), root, out, depth + 1, run);
      }
    }
  }
  if (Array.isArray(s.allOf)) for (const sub of s.allOf) check(v, sub, path, root, out, depth + 1, run);
  if (Array.isArray(s.anyOf) && s.anyOf.length) {
    const tries: string[][] = s.anyOf.map((sub: Schema) => passes(v, sub, path, root, depth + 1, run));
    if (!tries.some((p: string[]) => !p.length)) out.push(...(s.anyOf.length === 1 ? tries[0]! : [`${path}: matches none of the ${s.anyOf.length} schemas it may take (${tries.map((p: string[]) => first(p, path)).join("; ")})`]));
  }
  if (Array.isArray(s.oneOf) && s.oneOf.length) {
    const tries: string[][] = s.oneOf.map((sub: Schema) => passes(v, sub, path, root, depth + 1, run));
    const ok = tries.filter((p: string[]) => !p.length).length;
    if (ok === 0) out.push(...(s.oneOf.length === 1 ? tries[0]! : [`${path}: matches none of the ${s.oneOf.length} schemas it must take one of (${tries.map((p: string[]) => first(p, path)).join("; ")})`]));
    else if (ok > 1) bad(`matches ${ok} of the schemas it must take exactly one of`);
  }
  if (s.not !== undefined && !passes(v, s.not, path, root, depth + 1, run).length) bad("matches a schema it must not");
}
