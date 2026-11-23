// A server's tool definitions as the owner accepted them, against what it
// lists now. A server can rewrite a tool's description or widen its schema
// after it was added (a "rug pull": the text the model reads is the server's
// to change at any time), and a model follows what a description says. So the
// definitions are pinned when the owner accepts the server (its first listing
// after it was added), and a later listing that differs is held: the model is
// offered the pinned definition of a changed tool, and nothing of a new one,
// until the owner accepts the change. A tool the server no longer lists is
// simply gone: it can say nothing.
//
// What is pinned is what reaches the model or the gate: the name, the title,
// the description, the input schema and the annotations (a changed
// readOnlyHint or openWorldHint changes how a call is judged). The output
// schema and the execution hints are the client's business, not the model's.
import { createHash } from "node:crypto";
import type { McpTool } from "./client.ts";

export type ToolDef = Pick<McpTool, "name" | "title" | "description" | "inputSchema" | "annotations">;

// One field per thing a change can touch, as the owner is shown it.
export type ToolField = "title" | "description" | "input_schema" | "annotations";

// A tool the owner has not accepted: new, or changed in these fields.
// `was` is the accepted definition (none for a new tool), `now` the listed one.
export type ToolChange = { name: string; kind: "added" | "changed"; fields: ToolField[]; was?: ToolDef; now: ToolDef };

// The fields of a definition in one order: the same tool gives the same bytes.
export const defOf = (t: McpTool | ToolDef): ToolDef => ({
  name: t.name,
  ...(t.title !== undefined && { title: t.title }),
  ...(t.description !== undefined && { description: t.description }),
  ...(t.inputSchema !== undefined && { inputSchema: t.inputSchema }),
  ...(t.annotations !== undefined && { annotations: t.annotations }),
});

// JSON with object keys sorted, so a server that sends the same schema with
// its keys in another order has not changed it.
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

const FIELDS: [ToolField, keyof ToolDef][] = [["title", "title"], ["description", "description"], ["input_schema", "inputSchema"], ["annotations", "annotations"]];

// The fields in which two definitions of one tool differ.
export function fieldsChanged(was: ToolDef, now: ToolDef): ToolField[] {
  return FIELDS.filter(([, k]) => canon(was[k]) !== canon(now[k])).map(([f]) => f);
}

// What a listing holds that the pinned list does not: changed tools and new
// ones, in the order the server lists them; and the pinned tools it no longer lists.
export function diffTools(pinned: ToolDef[], listed: (McpTool | ToolDef)[]): { changes: ToolChange[]; removed: string[] } {
  const pin = new Map(pinned.map((t) => [t.name, t]));
  const changes: ToolChange[] = [];
  for (const t of listed) {
    const now = defOf(t);
    const was = pin.get(t.name);
    if (!was) changes.push({ name: t.name, kind: "added", fields: [], now });
    else {
      const fields = fieldsChanged(was, now);
      if (fields.length) changes.push({ name: t.name, kind: "changed", fields, was, now });
    }
  }
  const names = new Set(listed.map((t) => t.name));
  return { changes, removed: pinned.filter((t) => !names.has(t.name)).map((t) => t.name) };
}

// What the model is offered of a listing: each tool the owner accepted under
// its accepted definition (the call still goes to the server's tool of that
// name), none that is new. In the server's order.
export function offered(pinned: ToolDef[], listed: McpTool[]): McpTool[] {
  const pin = new Map(pinned.map((t) => [t.name, t]));
  return listed.flatMap((t) => {
    const was = pin.get(t.name);
    if (!was) return [];
    if (!fieldsChanged(was, defOf(t)).length) return [t];
    // Only the pinned fields are replaced; one the pin lacks is left out, not taken from the listing.
    const { title: _t, description: _d, inputSchema: _i, annotations: _a, ...rest } = t;
    return [{ ...rest, ...was }];
  });
}

// A server's instructions go into every session's system prompt beside its
// tools, and are the server's to rewrite as much as a description: they are
// pinned with the tools. `null` is a server that gives none.
export type InstructionsChange = { was: string | null; now: string | null };
export const instructionsChange = (was: string | null, now: string | null): InstructionsChange | undefined =>
  (was ?? "") === (now ?? "") ? undefined : { was, now };

// One change set as a short key: the owner is told of each once, and an
// acceptance names the one it was given (a server that changed again
// meanwhile is not accepted on the strength of what the owner saw before).
export const changeDigest = (changes: ToolChange[], instructions?: InstructionsChange): string =>
  createHash("sha256").update(canon([changes.map((c) => [c.name, c.now]), instructions ? instructions.now ?? "" : null])).digest("hex").slice(0, 16);

// What the state keeps of each server's pin: what the server is (`ident`, its
// endpoint's digest), when, its tools and instructions as accepted, the change
// the owner was last told of, and whether it was pinned as it was when this
// build first ran (`upgrade`: not looked at yet, told or not).
export type Pin = { ident: string; at: number; tools: ToolDef[]; instructions: string | null; told?: string; upgrade?: "untold" | "told" };
// `upgrade` names the servers that were set up before pins were kept and have not listed yet.
export type PinsFile = { version: 1; servers: Record<string, Pin>; upgrade?: string[] };

// The pins file's text, read whole or not at all: a file that does not parse,
// or holds anything but pins, throws (its servers are held, not pinned anew).
export function readPins(text: string): PinsFile {
  const f = JSON.parse(text);
  if (!f || typeof f !== "object" || f.version !== 1 || !f.servers || typeof f.servers !== "object" || Array.isArray(f.servers)) throw new Error("it is not a pins file of this build");
  for (const [name, p] of Object.entries(f.servers as Record<string, any>)) {
    const ok = p && typeof p.ident === "string" && typeof p.at === "number" && Array.isArray(p.tools) && p.tools.every((t: any) => t && typeof t.name === "string")
      && (p.instructions === null || typeof p.instructions === "string");
    if (!ok) throw new Error(`its pin of ${name} is damaged`);
  }
  if (f.upgrade !== undefined && !(Array.isArray(f.upgrade) && f.upgrade.every((n: unknown) => typeof n === "string"))) throw new Error("its list of servers set up before the upgrade is damaged");
  return f as PinsFile;
}
