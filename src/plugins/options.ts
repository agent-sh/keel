// A plugin's settings: the `userConfig` of its manifest
// (code.claude.com/docs/en/plugins-reference, "User configuration", read
// 2026-11-21). Each key is an option the owner gives a value for; the value
// reaches the plugin as `${user_config.KEY}` in its MCP servers' configs, in
// a command hook's `args` and in its skills' and agents' text, and as
// CLAUDE_PLUGIN_OPTION_<KEY> in its hooks' environment. A field that runs
// through a shell (a hook's command, an MCP headers helper) never takes a
// reference: the shell would read the value again.
// Pure: nothing here reads a file, a keyring or the clock.

export type OptionType = "string" | "number" | "boolean" | "directory" | "file";
export type OptionValue = string | number | boolean | string[];
export type OptionSpec = {
  type: OptionType;
  title: string;
  description: string;
  required?: boolean;
  default?: OptionValue;
  options?: string[];
  multiple?: boolean;
  sensitive?: boolean;
  min?: number;
  max?: number;
};
export type Specs = Record<string, OptionSpec>;

const TYPES = new Set<OptionType>(["string", "number", "boolean", "directory", "file"]);
const FIELDS = new Set(["type", "title", "description", "required", "default", "options", "multiple", "sensitive", "min", "max"]);
export const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A plain label: no control or bidirectional-formatting characters.
const LABEL_BAD = /[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

// The manifest's userConfig read as the reference says: keys are identifiers,
// each option a strict object (an unknown field fails), type, title and
// description required, `options` only on a single plain string with a
// default among them or required set. A problem keeps the plugin from loading.
export function parseUserConfig(v: unknown, where = "userConfig"): { specs: Specs; problems: string[] } {
  const specs: Specs = {};
  const problems: string[] = [];
  if (v === undefined) return { specs, problems };
  if (!isObj(v)) return { specs, problems: [`${where} is not an object of options`] };
  for (const [key, o] of Object.entries(v)) {
    const at = `${where}.${key}`;
    const before = problems.length;
    if (!KEY.test(key)) { problems.push(`${at}: a key is letters, digits and underscores, and does not start with a digit`); continue; }
    if (!isObj(o)) { problems.push(`${at} is not an object`); continue; }
    for (const f of Object.keys(o)) if (!FIELDS.has(f)) problems.push(`${at}: ${f} is not a field of an option`);
    if (typeof o.type !== "string" || !TYPES.has(o.type as OptionType)) problems.push(`${at}: type must be one of string, number, boolean, directory or file`);
    if (typeof o.title !== "string" || !o.title.trim()) problems.push(`${at}: title is required, a string`);
    if (typeof o.description !== "string") problems.push(`${at}: description is required, a string`);
    for (const f of ["required", "multiple", "sensitive"]) if (o[f] !== undefined && typeof o[f] !== "boolean") problems.push(`${at}: ${f} must be true or false`);
    for (const f of ["min", "max"]) if (o[f] !== undefined && (typeof o[f] !== "number" || !Number.isFinite(o[f]))) problems.push(`${at}: ${f} must be a number`);
    if (typeof o.min === "number" && typeof o.max === "number" && o.min > o.max) problems.push(`${at}: min is above max`);
    if (o.default !== undefined && !["string", "number", "boolean"].includes(typeof o.default) && !isStrings(o.default)) problems.push(`${at}: default must be a string, a number, true or false, or a list of strings`);
    if (o.options !== undefined) {
      if (!isStrings(o.options) || !o.options.length) problems.push(`${at}: options must be a list of strings`);
      else {
        if (o.type !== "string" || o.multiple === true || o.sensitive === true) problems.push(`${at}: options are for a string that is not multiple or sensitive`);
        for (const x of o.options) if (!x.length || x.length > 64 || LABEL_BAD.test(x)) problems.push(`${at}: ${JSON.stringify(x.slice(0, 64))} is not an option: a plain label of 1 to 64 characters`);
        if (new Set(o.options).size !== o.options.length) problems.push(`${at}: an option is listed twice`);
        if (o.default === undefined && o.required !== true) problems.push(`${at}: with options, set a default among them or required: true`);
      }
    }
    if (problems.length > before) continue;
    const spec: OptionSpec = { type: o.type as OptionType, title: (o.title as string).trim(), description: o.description as string };
    for (const f of ["required", "multiple", "sensitive"] as const) if (o[f] === true) spec[f] = true;
    if (typeof o.min === "number") spec.min = o.min;
    if (typeof o.max === "number") spec.max = o.max;
    if (o.options) spec.options = o.options as string[];
    if (o.default !== undefined) {
      const d = checkValue(spec, o.default);
      if (d.error) { problems.push(`${at}: its default ${d.error}`); continue; }
      spec.default = d.value!;
    }
    specs[key] = spec;
  }
  return { specs, problems };
}

// A value for an option as the owner gives it (or as a default is written):
// the option's type, within its bounds, one of its options. A number may come
// as its text, true and false as theirs, a list as lines. Empty is no value.
// Whether a folder or a file is there is the caller's to check.
export function checkValue(spec: OptionSpec, v: unknown): { value?: OptionValue; empty?: true; error?: string } {
  if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) return { empty: true };
  if (spec.type === "number") {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.trim()) : NaN;
    if (!Number.isFinite(n)) return { error: `is not a number` };
    if (spec.min !== undefined && n < spec.min) return { error: `is below ${spec.min}` };
    if (spec.max !== undefined && n > spec.max) return { error: `is above ${spec.max}` };
    return { value: n };
  }
  if (spec.type === "boolean") {
    if (typeof v === "boolean") return { value: v };
    if (v === "true" || v === "false") return { value: v === "true" };
    return { error: "is not true or false" };
  }
  if (spec.multiple && spec.type === "string") {
    const list = typeof v === "string" ? v.split("\n") : isStrings(v) ? v : null;
    if (!list) return { error: "is not a list of strings" };
    const items = list.map((x) => x.trim()).filter(Boolean);
    return items.length ? { value: items } : { empty: true };
  }
  if (typeof v !== "string") return { error: `is not a ${spec.type === "string" ? "string" : `path to a ${spec.type === "directory" ? "folder" : "file"}`}` };
  if (spec.options && !spec.options.includes(v)) return { error: `is not one of ${spec.options.join(", ")}` };
  return { value: v };
}

// A value as text: a list is its items joined by commas.
export const asText = (v: OptionValue): string => (Array.isArray(v) ? v.join(",") : String(v));

const REF = /\$\{user_config\.([^}]*)\}/g;
// The keys every string of a value names as ${user_config.KEY}.
export function refsIn(v: unknown, out = new Set<string>()): Set<string> {
  if (typeof v === "string") for (const m of v.matchAll(REF)) out.add(m[1]!);
  else if (Array.isArray(v)) for (const x of v) refsIn(x, out);
  else if (isObj(v)) for (const x of Object.values(v)) refsIn(x, out);
  return out;
}

// ${user_config.KEY} filled in, in every string of a value, from `text` (the
// values as text); a key with no value there becomes empty.
export function substitute<T>(v: T, text: Record<string, string>): T {
  if (typeof v === "string") return v.replace(REF, (_all, k: string) => text[k] ?? "") as T;
  if (Array.isArray(v)) return v.map((x) => substitute(x, text)) as T;
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, text)])) as T;
  return v;
}

// The values as a config may be shown with them: a sensitive one stays the
// reference the plugin wrote (${user_config.KEY}), never its value.
export function shownValues(specs: Specs, text: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(text).map(([k, v]) => [k, specs[k]?.sensitive ? "${user_config." + k + "}" : v]));
}

// A skill's or an agent's text: a plain value is filled in; a sensitive one
// becomes a placeholder, never its value (the text goes to a model).
export function fillContent(body: string, specs: Specs, text: Record<string, string>): string {
  return body.replace(REF, (all, k: string) => {
    const s = specs[k];
    if (!s) return all;
    return s.sensitive ? `[${k}: a sensitive setting, not shown]` : text[k] ?? "";
  });
}

// What a plugin's hooks find in their environment: every option with a value,
// as CLAUDE_PLUGIN_OPTION_<KEY> with the key in capitals.
export function optionEnv(text: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(text).map(([k, v]) => [`CLAUDE_PLUGIN_OPTION_${k.toUpperCase()}`, v]));
}

// The values in force: the owner's, else the default. `missing`: the keys
// that are required and have neither.
export function resolve(specs: Specs, given: Record<string, OptionValue | undefined>): { text: Record<string, string>; missing: string[] } {
  const text: Record<string, string> = {};
  const missing: string[] = [];
  for (const [k, s] of Object.entries(specs)) {
    const v = given[k] ?? s.default;
    if (v === undefined) { if (s.required) missing.push(k); continue; }
    text[k] = asText(v);
  }
  return { text, missing };
}

// Why a hook may not run as written: a reference outside a command hook's
// `args`. A hook's command runs through a shell (or is the program itself),
// so a value put there would be read again as words.
export function hookRefusal(h: any): string | null {
  if (!refsIn(h).size) return null;
  if (h?.type === "command" && !refsIn(h.command).size && Object.entries(h).every(([k, x]) => k === "args" || !refsIn(x).size)) return null;
  if (h?.type === "command" && h.args === undefined) return "a shell-form hook command cannot take ${user_config.*}, since its shell would read the value again: the hook can read CLAUDE_PLUGIN_OPTION_<KEY> from its environment, or run with args";
  if (h?.type === "command") return "${user_config.*} is taken in a hook's args, not in the program it runs";
  return `${"${user_config.*}"} is taken only in a command hook's args, not in a${h?.type === "http" ? "n http" : h?.type === "mcp_tool" ? "n mcp_tool" : ""} hook`;
}

// Why an MCP server may not start as written: a headers helper is a command
// run through a shell, so it takes no reference.
export function serverRefusal(c: Record<string, unknown>): string | null {
  for (const f of ["headersHelper", "headers_helper"]) if (refsIn(c[f]).size) return `its ${f} runs through a shell and cannot take ${"${user_config.*}"}: the helper has to get the value on its own`;
  return null;
}
