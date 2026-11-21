// A session's pinned tool list against the tools of the build that runs now.
// A provider's prompt cache is keyed by the request's prefix, tools first, so
// one reworded description writes a live session's whole context to the cache
// again. A session therefore keeps the definitions it was last sent, byte for
// byte, and each call runs the current build's implementation under the
// pinned definition. That holds only while the implementation still takes
// what the pinned definition describes: this file decides that.
import type { ToolSpec } from "../providers/types.ts";
import type { Tool } from "./types.ts";

// A definition as a request carries it, and the build's urgent mark for the
// tool when it was pinned (src/core/build.ts; never sent).
export type PinnedTool = ToolSpec & { mark?: string };

// The fields a request sends, in one order: the same tool gives the same bytes.
export const pinOf = (t: ToolSpec, mark?: string): PinnedTool => ({
  name: t.name, description: t.description, input_schema: t.input_schema,
  ...(t.freeform && { freeform: t.freeform }), ...(t.defer && { defer: true as const }),
  ...(t.namespace && { namespace: t.namespace }), ...(t.search && { search: true as const }),
  ...(mark && { mark }),
});

const sent = (t: ToolSpec) => JSON.stringify(pinOf(t));

// Words for the reader, which change nothing a call may hold.
const DOC = new Set(["description", "title", "default", "examples", "$comment"]);
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const typesOf = (s: Record<string, any>): string[] | undefined => (s.type === undefined ? undefined : [s.type].flat());

// Whether every input the pinned schema describes is one the current schema
// takes. Compatible: other descriptions, a new optional property, a property
// no longer required, a wider type or enum. Not compatible: a property gone
// or renamed (the model would still send it), a new required property (it
// would never send it), a narrower type or enum, and any difference in a
// keyword this does not weigh (anyOf, bounds, patterns): when in doubt the
// pinned definition is not offered.
export function accepts(cur: unknown, pin: unknown): boolean {
  if (same(cur, pin)) return true;
  if (!isObj(cur) || !isObj(pin)) return false;
  for (const k of new Set([...Object.keys(cur), ...Object.keys(pin)])) {
    if (DOC.has(k) || same(cur[k], pin[k])) continue;
    if (k === "type") {
      const c = typesOf(cur), p = typesOf(pin);
      // Integers are numbers.
      if (c && !(p && p.every((t) => c.includes(t) || (t === "integer" && c.includes("number"))))) return false;
    } else if (k === "enum") {
      if (cur.enum && !(Array.isArray(pin.enum) && pin.enum.every((v: unknown) => cur.enum.some((x: unknown) => same(x, v))))) return false;
    } else if (k === "required") {
      const p = new Set<string>(pin.required ?? []);
      if (!(cur.required ?? []).every((r: string) => p.has(r))) return false;
    } else if (k === "properties") {
      const c = cur.properties ?? {};
      for (const [name, sub] of Object.entries(pin.properties ?? {})) if (!(name in c) || !accepts(c[name], sub)) return false;
    } else if (k === "items") {
      if (cur.items !== undefined && !accepts(cur.items, pin.items ?? {})) return false;
    } else if (k === "additionalProperties") {
      // Closed now where nothing was said: the declared properties are checked above, and a model sends no others.
      // Closed where the pinned definition offered a map (any key, or keys of one schema): its inputs are refused now.
      if (cur.additionalProperties === false && (pin.additionalProperties === true || isObj(pin.additionalProperties))) return false;
      if (isObj(cur.additionalProperties) && pin.additionalProperties !== false && !accepts(cur.additionalProperties, pin.additionalProperties)) return false;
    } else return false;
  }
  return true;
}

// Whether a call written for the pinned definition can run on the current tool.
export const servable = (pin: PinnedTool, cur: ToolSpec): boolean => same(pin.freeform, cur.freeform) && !!pin.search === !!cur.search && accepts(cur.input_schema, pin.input_schema);

export type Merged = {
  // What the request carries: the pinned definitions on the current tools.
  tools: Tool[];
  // Why the pinned list cannot be offered as it is (a tool in the prompt is
  // gone, takes another input, or carries an urgent mark): the session takes
  // this build's whole list now.
  urgent?: string;
  // What this build has that the session does not carry yet: tools whose
  // definition differs, and tools new to the prompt.
  waiting: string[];
  // The pinned list as it stands after this merge, when it changed: deferred
  // tools are not in the prompt, so they follow the build freely.
  pin?: PinnedTool[];
};

// The pinned list against the current build's tools (`marks`: its urgent
// marks by tool name).
// - A pinned tool the build still has keeps its pinned definition and runs
//   the build's implementation.
// - A pinned tool in the prompt that the build removed, or whose input it can
//   no longer take, makes the whole list urgent: offering it would end in a
//   failed call. So does an urgent mark the pinned copy does not carry.
// - Deferred tools are not part of the cached prefix: one the build removed is
//   dropped, one whose input changed takes the new definition, and one new in
//   this build is declared at once, where the tool search finds it.
// - A tool new to the prompt waits: adding it would rewrite the prefix.
export function mergeTools(pinned: PinnedTool[], current: Tool[], marks: Record<string, string> = {}): Merged {
  const now = new Map(current.map((t) => [t.name, t]));
  const tools: Tool[] = [];
  const pin: PinnedTool[] = [];
  const waiting: string[] = [];
  let moved = false;
  for (const p of pinned) {
    const c = now.get(p.name);
    const mark = marks[p.name];
    if (c && mark && mark !== p.mark) return { tools: current, urgent: `${p.name} has an urgent change`, waiting: [] };
    if (!c || !servable(p, c)) {
      if (!p.defer) return { tools: current, urgent: c ? `${p.name} takes another input in this build` : `${p.name} is gone from this build`, waiting: [] };
      moved = true;
      if (!c) continue;
      // Still deferred, or now in the prompt: either way it loads through the search until the list is adopted.
      const next = { ...pinOf(c, mark), defer: true as const };
      pin.push(next);
      tools.push({ ...c, defer: true });
      continue;
    }
    pin.push(p);
    const { mark: _, ...spec } = p;
    // The spec fields come from the pin alone: a flag the build set since is not carried over.
    // `built`: the build's own schema, for the gate.
    tools.push({ ...c, freeform: undefined, defer: undefined, namespace: undefined, search: undefined, ...spec, built: c.input_schema });
    if (sent(p) !== sent(c)) waiting.push(p.name);
  }
  const had = new Set(pinned.map((p) => p.name));
  for (const c of current) {
    if (had.has(c.name)) continue;
    if (!c.defer) { waiting.push(c.name); continue; }
    moved = true;
    pin.push(pinOf(c, marks[c.name]));
    tools.push(c);
  }
  // The same tools in another order are another prefix.
  const order = (list: { name: string; defer?: boolean }[]) => list.filter((t) => !t.defer && now.has(t.name) && had.has(t.name)).map((t) => t.name).join("\n");
  if (!waiting.length && order(pinned) !== order(current)) waiting.push("order");
  return { tools, waiting, ...(moved && { pin }) };
}

// The names whose definition differs between two lists: changed, added or gone.
export function changedTools(was: PinnedTool[], now: PinnedTool[]): string[] {
  const a = new Map(was.map((t) => [t.name, sent(t)])), b = new Map(now.map((t) => [t.name, sent(t)]));
  const out = [...b].filter(([n, s]) => a.get(n) !== s).map(([n]) => n);
  for (const n of a.keys()) if (!b.has(n)) out.push(n);
  if (!out.length && [...a.keys()].join("\n") !== [...b.keys()].join("\n")) out.push("order");
  return out;
}
