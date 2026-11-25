// What the next request carries, part by part, for the context popup: the
// system prompt by its blocks, every tool definition by its source, and the
// messages by where they came from.
//
// A provider counts one number for a whole request. The parts are sized from
// their bytes at the model's learned bytes a token, then scaled so that they
// add up to the number the provider measured (`sizeParts`): the split is an
// estimate, the total is not. A context no reply has measured (a new one, a
// checkpoint just made) has only the estimate, and the parts say so.
import { originOf } from "../admin/timeline-rows.ts";

// Whole tokens for each weight, in proportion, adding up to `total` exactly
// (the largest remainders take the tokens the rounding left).
export function apportion(weights: readonly number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0) || !(total > 0)) return weights.map(() => 0);
  const exact = weights.map((w) => (w / sum) * total);
  const out = exact.map(Math.floor);
  let left = Math.round(total) - out.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0 && order.length; k = (k + 1) % order.length, left--) out[order[k]![1]]!++;
  return out;
}

// A part's tokens: scaled to the measured total when there is one, else the
// bytes at the model's bytes a token.
export function sizeParts(bytes: readonly number[], perToken: number, measuredTotal: number): number[] {
  return measuredTotal > 0 ? apportion(bytes, measuredTotal) : bytes.map((b) => Math.round(b / perToken));
}

// Where a message came from, in the classes the popup shows.
export type Origin = "owner" | "agent" | "session" | "harness" | "model";
export const ORIGINS: { key: Origin; label: string }[] = [
  { key: "owner", label: "Your messages" },
  { key: "agent", label: "Agent reports" },
  { key: "session", label: "Messages from other sessions" },
  { key: "harness", label: "Harness notes" },
  { key: "model", label: "Model replies" },
];

// The class of an input (src/admin/timeline-rows.ts names each input's origin, as the transcript does).
export function originClass(data: { origin?: unknown; kind?: unknown; agent_id?: unknown } | undefined): Origin {
  switch (originOf(data).key) {
    // A steer is the owner's words; a parent's message to its agent is stored the same way with the agent named.
    case "steer": return data?.agent_id ? "session" : "owner";
    case "owner": case "queued": case "continue": case "voice": return "owner";
    case "subagent": return "agent";
    case "parent": case "peer": case "task": case "task_start": case "review": case "review_fix": case "helper_digest": return "session";
    default: return "harness";
  }
}

// A source of tools: the built-ins, an MCP server, or a catalog of Keel's own.
// `tools`: what it offers; `carried`: how many of them the request carries
// (a deferred tool costs nothing until the model loads it).
export type ToolGroup = { key: string; label: string; kind: "builtin" | "mcp" | "catalog"; tools: number; carried: number; bytes: number };

// What a group's row says about saving its tokens, or nothing when there is nothing to save.
export function saving(g: Pick<ToolGroup, "kind" | "tools" | "carried">, native: boolean): string {
  if (g.kind === "builtin") return "";
  if (!native) return "Reached through search_tools and mcp_call: none of it is in the request.";
  if (!g.carried) return "";
  return g.kind === "mcp"
    ? `${g.carried} of ${g.tools} loaded by tool search and carried until the context is compacted or cleared. Turn the server off in Customize > MCP servers to drop them.`
    : `${g.carried} of ${g.tools} loaded by tool search and carried until the context is compacted or cleared.`;
}
