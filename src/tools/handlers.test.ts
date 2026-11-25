// What a tool's run reads from its input against what its schema, its declared aliases and its declared extras
// (`inputAlias`, `inputAlso`, `inputOptional`; src/tools/validate.ts) say. The schema check refuses a call for a
// field the schema does not list (a closed schema) and for a required field that is missing, so a run that reads
// a name the declarations leave out, or defaults a field the schema requires, would have a call it accepts
// refused. This reads the source of every tool definition under src (no parser is at hand, so by text: the
// literal that holds an `input_schema`, its `run`, and the helpers the run passes its input to) and fails on it.
import { expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";

// Index of the bracket that closes the one at `open`, over strings, templates, comments and regular expressions.
function close(src: string, open: number): number {
  const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
  const stack: string[] = [];
  let prev = "";
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); if (i < 0) return -1; continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 1; continue; }
    if (c === '"' || c === "'") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
      prev = c; continue;
    }
    if (c === "`") {
      for (i++; i < src.length && src[i] !== "`"; i++) {
        if (src[i] === "\\") i++;
        else if (src[i] === "$" && src[i + 1] === "{") i = close(src, i + 1);
      }
      prev = c; continue;
    }
    if (c === "/" && /[(,=:[!&|?{};]/.test(prev || ";")) {
      for (i++; i < src.length && src[i] !== "/" && src[i] !== "\n"; i++) { if (src[i] === "\\") i++; else if (src[i] === "[") while (i < src.length && src[i] !== "]" && src[i] !== "\n") { if (src[i] === "\\") i++; i++; } }
      prev = "/"; continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === "}" || c === ")" || c === "]") { stack.pop(); if (!stack.length) return i; }
    if (!/\s/.test(c)) prev = c;
  }
  return -1;
}

// The source with its comments blanked (same length), so a quote in a comment opens no string.
function uncommented(src: string): string {
  const out = src.split("");
  let prev = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i); const to = e < 0 ? src.length : e; for (let k = i; k < to; k++) out[k] = " "; i = to; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i) + 2; for (let k = i; k < e; k++) if (src[k] !== "\n") out[k] = " "; i = e - 1; continue; }
    if (c === '"' || c === "'") { i = stringEnd(src, i); prev = c; continue; }
    if (c === "`") { i = templateEnd(src, i); prev = c; continue; }
    if (c === "/" && /[(,=:[!&|?{};]/.test(prev || ";")) {
      for (i++; i < src.length && src[i] !== "/" && src[i] !== "\n"; i++) { if (src[i] === "\\") i++; else if (src[i] === "[") while (i < src.length && src[i] !== "]" && src[i] !== "\n") { if (src[i] === "\\") i++; i++; } }
      prev = "/"; continue;
    }
    if (!/\s/.test(c)) prev = c;
  }
  return out.join("");
}

// The members of an object literal's text, by key: `{ a: 1, b, async c() {}, ...d }` gives a, b, c and "...".
function members(obj: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 1;
  const end = obj.length - 1;
  while (i < end) {
    while (i < end && /[\s,]/.test(obj[i]!)) i++;
    if (i >= end) break;
    const start = i;
    // The member runs to the next comma outside any bracket.
    let j = i;
    while (j < end) {
      const c = obj[j];
      if (c === "," ) break;
      if (c === "{" || c === "(" || c === "[" || c === "`" || c === '"' || c === "'") {
        j = c === '"' || c === "'" ? stringEnd(obj, j) + 1 : c === "`" ? templateEnd(obj, j) + 1 : close(obj, j) + 1;
        continue;
      }
      j++;
    }
    const text = obj.slice(start, j).trim();
    i = j + 1;
    if (text.startsWith("...")) { out.set("...", text); continue; }
    const m = /^(?:(?:async|get|set)\s+)?(?:\*\s*)?(["']?)(-?[A-Za-z_$][\w$-]*)\1\s*([:(,]|$)/.exec(text);
    if (!m) continue;
    const key = m[2]!;
    out.set(key, m[3] === ":" ? text.slice(text.indexOf(":") + 1).trim() : text);
  }
  return out;
}
const stringEnd = (s: string, i: number) => { const q = s[i]; for (i++; i < s.length && s[i] !== q; i++) if (s[i] === "\\") i++; return i; };
const templateEnd = (s: string, i: number) => { for (i++; i < s.length && s[i] !== "`"; i++) { if (s[i] === "\\") i++; else if (s[i] === "$" && s[i + 1] === "{") i = close(s, i + 1); } return i; };

const strings = (text: string | undefined) => [...(text ?? "").matchAll(/["']([^"'\n]+)["']/g)].map((m) => m[1]!);

// Keys of a text like `{ a: .., "b": .., ...c }`, and whether it spreads something it cannot name.
function keysOf(text: string): { keys: string[]; open: boolean } {
  const m = members(text);
  return { keys: [...m.keys()].filter((k) => k !== "..."), open: m.has("...") };
}

type Def = { file: string; name: string; props: string[]; open: boolean; required: string[]; closed: boolean; alias: string[]; also: string[]; optional: string[]; run: string; runOwner: string };

const root = new URL("../..", import.meta.url).pathname;
const files = [...new Glob("src/**/*.ts").scanSync({ cwd: root })].filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".d.ts")).sort();
const texts = new Map(files.map((f) => [f, uncommented(readFileSync(root + f, "utf8"))]));

// A name at the top of a file: `const NAME = value`, the value's text.
function constOf(src: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?const\\s+${name}\\b[^=\\n]*=\\s*`).exec(src);
  if (!m) return undefined;
  const at = m.index + m[0].length;
  if (src[at] === "{" || src[at] === "(" || src[at] === "[") return src.slice(at, close(src, at) + 1);
  const call = /^[\w$.]+\(/.exec(src.slice(at));
  if (call) return src.slice(at, close(src, at + call[0].length - 1) + 1);
  return undefined;
}

function schemaOf(src: string, file: string, text: string): { props: string[]; open: boolean; required: string[]; closed: boolean } | undefined {
  let t = text.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(t)) { const v = constOf(src, t); if (!v) return undefined; t = v; }
  const obj = /^obj\(/.exec(t);
  if (obj) {
    const args = t.slice(obj[0].length - 1);
    const first = args.indexOf("{");
    const body = first < 0 ? undefined : args.slice(first, close(args, first) + 1);
    const reqAt = body ? args.indexOf("[", first + body.length) : -1;
    const required = reqAt < 0 ? [] : strings(args.slice(reqAt, close(args, reqAt) + 1));
    const def = constOf(src, "obj") ?? "";
    const k = keysOf(body ?? "{}");
    return { props: k.keys, open: k.open, required, closed: /additionalProperties:\s*false/.test(def) || /additionalProperties:\s*false/.test(src.slice(src.indexOf("const obj"), src.indexOf("const obj") + 400)) };
  }
  if (!t.startsWith("{")) return undefined;
  const m = members(t);
  const props = m.get("properties");
  const k = props?.startsWith("{") ? keysOf(props) : { keys: [] as string[], open: true };
  return { props: k.keys, open: k.open || !!m.has("..."), required: strings(m.get("required")), closed: m.get("additionalProperties") === "false" };
}

// Every tool literal: an object with a name, an input_schema and a run.
const defs: Def[] = [];
for (const [file, src] of texts) {
  let at = -1;
  while ((at = src.indexOf("input_schema", at + 1)) >= 0) {
    // The literal holding this key: the innermost braces around it that also hold a run.
    let start = at;
    let lit: string | undefined;
    for (let depth = 0, floor = Math.max(0, at - 9000); start > floor; start--) {
      const c = src[start];
      if (c === "}") depth++;
      else if (c === "{") {
        if (depth > 0) { depth--; continue; }
        const e = close(src, start);
        if (e > at) { const t = src.slice(start, e + 1); if (/\n?\s*(?:async\s+)?run\b/.test(t) && /\bname\b/.test(t)) { lit = t; break; } }
      }
    }
    if (!lit) continue;
    const m = members(lit);
    const nameText = m.get("name")?.trim() ?? "";
    const name = /^["'`]([^"'`$]+)["'`]$/.exec(nameText)?.[1];
    const sch = m.get("input_schema");
    const run = m.get("run");
    if (!name || !sch || !run || defs.some((d) => d.file === file && d.name === name)) continue;
    const s = schemaOf(src, file, sch);
    if (!s) continue;
    const aliasText = m.get("inputAlias");
    defs.push({
      file, name, ...s,
      alias: aliasText?.startsWith("{") ? [...members(aliasText).values()].flatMap(strings) : [],
      also: strings(m.get("inputAlso")), optional: strings(m.get("inputOptional")),
      run, runOwner: src,
    });
  }
}

const NOT_FIELDS = new Set(["length", "map", "filter", "toString", "forEach", "slice", "join", "push", "some", "every", "find", "includes", "trim", "keys", "values", "entries", "hasOwnProperty"]);

// The names a function's text reads from its first parameter, the parameter's defaults for required ones, and the
// helpers (by name) it passes the parameter to.
function reads(fn: string): { names: Set<string>; defaulted: Set<string>; passed: { helper: string; at: number }[] } {
  const names = new Set<string>();
  const defaulted = new Set<string>();
  const passed: { helper: string; at: number }[] = [];
  const head = /^\s*(?:async\s+)?(?:function\s*[\w$]*\s*)?(?:[\w$]+\s*)?\(\s*(\{[^}]*\}|[\w$]+)/.exec(fn) ?? /^\s*(?:async\s+)?([\w$]+)\s*=>/.exec(fn);
  const first = head?.[1];
  if (!first) return { names, defaulted, passed };
  const ids = new Set<string>();
  const destructure = (pattern: string) => {
    for (const part of pattern.replace(/^\{|\}$/g, "").split(",")) {
      const p = part.trim();
      if (!p || p.startsWith("...")) continue;
      const key = /^["']?([\w$]+)["']?/.exec(p)?.[1];
      if (key) names.add(key);
      if (key && /=/.test(p.replace(/^[^=:]*:/, ""))) defaulted.add(key);
    }
  };
  if (first.startsWith("{")) destructure(first); else ids.add(first);
  // A name the parameter is copied to.
  for (let more = true; more;) {
    more = false;
    for (const id of [...ids]) for (const m of fn.matchAll(new RegExp(`(?:const|let)\\s+([\\w$]+)\\s*(?::[^=]+)?=\\s*\\(?\\s*${id.replace("$", "\\$")}\\b(?!\\s*[.[(?])`, "g"))) if (!ids.has(m[1]!)) { ids.add(m[1]!); more = true; }
  }
  for (const id of ids) {
    const x = id.replace("$", "\\$");
    for (const m of fn.matchAll(new RegExp(`\\(?\\b${x}\\b(?:\\s+as\\s+[^)]+\\))?\\s*\\??\\.([A-Za-z_$][\\w$]*)`, "g"))) if (!NOT_FIELDS.has(m[1]!)) names.add(m[1]!);
    for (const m of fn.matchAll(new RegExp(`\\b${x}\\s*\\??\\.?\\[\\s*["']([^"']+)["']\\s*\\]`, "g"))) names.add(m[1]!);
    for (const m of fn.matchAll(new RegExp(`["']([\\w$]+)["']\\s+in\\s+${x}\\b`, "g"))) names.add(m[1]!);
    for (const m of fn.matchAll(new RegExp(`\\{([^{}]*)\\}\\s*(?::[^=]+)?=\\s*${x}\\b`, "g"))) destructure(`{${m[1]!}}`);
    for (const m of fn.matchAll(new RegExp(`(?<![.\\w$])\\b${x}\\s*\\??\\.([A-Za-z_$][\\w$]*)\\s*(?:\\?\\?|\\|\\|)(?!=)\\s*(\\S{0,3})`, "g"))) {
      // What a default shows: a field kept in a variable that is never tested (the run goes on with nothing), or a
      // default that is a value (the run goes on with it). A field passed on as it is, with an empty default, is not
      // told from one the callee refuses: that is for the test of the tool.
      const line = fn.slice(fn.lastIndexOf("\n", m.index) + 1, m.index);
      const v = /(?:const|let)\s+([\w$]+)(?:\s*:[^=]+)?\s*=\s*[^;]*$/.exec(line)?.[1];
      // (`input.to ?? input.agent_id`: the other name, which the tool declares as an alias.)
      if (m[2]!.startsWith(id.slice(0, 3))) continue;
      const empty = /^(""|''|\[\]|\{\}|0\b|fal)/.test(m[2]!);
      const tested = v && new RegExp(`!\\s*${v.replace("$", "\\$")}\\b|\\b${v.replace("$", "\\$")}\\.(?:trim|length)\\b|\\b${v.replace("$", "\\$")}\\s*(?:===|!==|==|!=)|if\\s*\\(\\s*${v.replace("$", "\\$")}\\b`).test(fn);
      if (v ? !tested : !empty) defaulted.add(m[1]!);
    }
    // Handed to another function by name.
    for (const m of fn.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\(([^()]*)\)/g)) {
      const args = m[2]!.split(",").map((a) => a.trim().replace(/!$/, "").replace(/\s+as\s+.*$/, ""));
      const at = args.indexOf(id);
      if (at >= 0 && !/^(?:String|Number|Boolean|Object|Array|JSON|if|for|while|switch|typeof)$/.test(m[1]!)) passed.push({ helper: m[1]!, at });
    }
  }
  return { names, defaulted, passed };
}

// A function declared by name in a file: its text.
function helperText(src: string, name: string): string | undefined {
  const d = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`).exec(src);
  if (d) { const b = src.indexOf("{", src.indexOf(")", d.index + d[0].length)); return src.slice(d.index, close(src, b) + 1); }
  const a = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?const\\s+${name}\\s*(?::[^=]+)?=\\s*(async\\s*)?\\(`).exec(src);
  if (a) { const p = src.indexOf("(", a.index + a[0].length - 1); const e = close(src, p); const arrow = src.indexOf("=>", e); const b = src.slice(arrow + 2).search(/\S/) + arrow + 2; return src.slice(p, src[b] === "{" ? close(src, b) + 1 : src.indexOf("\n", b)); }
  return undefined;
}

// Everything a tool's run reads, one level of helpers in its own file and the shared ones deep.
function readsOf(d: Def): { names: Set<string>; defaulted: Set<string> } {
  const names = new Set<string>();
  const defaulted = new Set<string>();
  const seen = new Set<string>();
  const visit = (fn: string, depth: number) => {
    const r = reads(fn);
    for (const n of r.names) names.add(n);
    for (const n of r.defaulted) defaulted.add(n);
    if (depth >= 3) return;
    for (const p of r.passed) {
      const h = helperText(d.runOwner, p.helper) ?? [...texts.values()].map((s) => helperText(s, p.helper)).find(Boolean);
      if (!h || seen.has(p.helper)) continue;
      seen.add(p.helper);
      // The helper reads the argument at `at`: put it first for `reads`.
      const params = /\(([^)]*)\)/.exec(h.slice(0, h.indexOf("{") + 1 || 400))?.[1]?.split(",").map((s) => s.trim()) ?? [];
      const prm = params[p.at]?.replace(/[:=?].*$/, "").trim();
      if (!prm) continue;
      visit(`(${prm}) => ${h.slice(h.indexOf("{"))}`, depth + 1);
    }
  };
  visit(d.run.replace(/^\s*(async\s+)?run\s*(?=\()/, "$1"), 0);
  return { names, defaulted };
}

const closedDefs = defs.filter((d) => d.closed && !d.open);

test("the scan finds the tool definitions it is about", () => {
  // A scan that finds nothing proves nothing: the built-in families and the shared tools are in it.
  const found = new Set(defs.map((d) => d.name));
  for (const n of ["Bash", "Write", "Read", "Edit", "apply_patch", "write_file", "keel__session_send", "WebFetch", "Agent", "helper__memory_put"]) expect(found.has(n)).toBe(true);
  expect(closedDefs.length).toBeGreaterThan(20);
});

test("every field a closed tool's run reads is in its schema, its aliases or its declared extras", () => {
  const bad: string[] = [];
  for (const d of closedDefs) {
    const known = new Set([...d.props, ...d.alias, ...d.also]);
    const extra = [...readsOf(d).names].filter((n) => !known.has(n));
    if (extra.length) bad.push(`${d.name} (${d.file}) reads ${extra.join(", ")}`);
  }
  expect(bad).toEqual([]);
});

// Required fields a run defaults and then fails on (an empty name, a missing query: the tool's own failure is no
// better than the schema's answer), reviewed one by one. A new entry in the scan's result is a decision: declare
// the field optional (`inputOptional`) where the run does without it, or list it here with what the run does.
const FAILS_EMPTY: Record<string, string[]> = {
  keel__send_files: ["agent_id"], mail__read: ["id"], mcp_call: ["tool"], keel__verdict: ["commit"], request_secret: ["name"],
  Write: ["content"], Edit: ["old_string", "new_string"], WebFetch: ["url"], WebSearch: ["query"],
  replace: ["old_string", "new_string"], write_todos: ["todos"], google_web_search: ["query"], ask_user: ["questions"],
  websearch: ["query"], webfetch: ["url"], read_skill_file: ["skill", "path"],
};

test("every required field a tool's run defaults is declared optional or reviewed", () => {
  const bad: string[] = [];
  for (const d of defs) {
    const r = readsOf(d);
    const loose = [...r.defaulted].filter((n) => d.required.includes(n) && !d.optional.includes(n) && !FAILS_EMPTY[d.name]?.includes(n));
    if (loose.length) bad.push(`${d.name} (${d.file}) defaults required ${loose.join(", ")}`);
  }
  expect(bad).toEqual([]);
});
