// What an MCP server says its tool does (2025-11-25 server/tools, ToolAnnotations),
// as Keel reads it. Annotations are the server's word, and a client must treat
// them as untrusted unless the server is trusted, so a hint only ever makes Keel
// more careful; the owner's own marks (read_tools) are what make a call ask less.
//
// - destructiveHint true: the call is high risk at the gate (src/safety/policy.ts).
//   The spec's default is true, but Keel already asks before every tool the owner
//   did not mark: only a server that says so outright raises the risk.
// - openWorldHint true: the tool reaches services outside this machine; its card
//   says so. Taken outright only, for the same reason.
// - idempotentHint true: a second call with the same arguments has no further
//   effect. It changes no decision; a call that failed midway says what the
//   server claims, so the model can weigh a retry.
// - readOnlyHint true: offered to the owner to mark (hinted_reads), never taken.
//   Per the spec, destructiveHint and idempotentHint mean nothing beside it.
export type McpHints = { destructive?: true; openWorld?: true; idempotent?: true };

export function hintsOf(annotations: unknown): McpHints | undefined {
  if (!annotations || typeof annotations !== "object") return;
  const a = annotations as Record<string, unknown>;
  const writes = a.readOnlyHint !== true;
  const h: McpHints = {
    ...(writes && a.destructiveHint === true ? { destructive: true as const } : {}),
    ...(a.openWorldHint === true ? { openWorld: true as const } : {}),
    ...(writes && a.idempotentHint === true ? { idempotent: true as const } : {}),
  };
  return Object.keys(h).length ? h : undefined;
}

// The marks the MCP panel shows beside a tool's name.
export const hintWords = (h: McpHints | undefined): ("destructive" | "open_world" | "idempotent")[] =>
  h ? [...(h.destructive ? ["destructive" as const] : []), ...(h.openWorld ? ["open_world" as const] : []), ...(h.idempotent ? ["idempotent" as const] : [])] : [];
