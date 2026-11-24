// What a request's stream reported of its usage before it failed or was
// stopped. A stream counts its prompt at its start (Anthropic's message_start,
// a Responses stream's response.created, a chat stream's usage chunk), so a
// request cut after that point was billed for what it read: the error it ends
// with carries those counts, and the registry prices them as it prices an
// answer (src/providers/registry.ts). Kept beside the error, never in it: a
// thrown value of any kind (an abort's DOMException too) can carry them, and
// nothing that prints an error shows them.
import type { Usage } from "../core/types.ts";

const reported = new WeakMap<object, Usage>();

// Any token counted: a failure before the stream began reported nothing.
export const counted = (u: Partial<Usage> | undefined): u is Usage =>
  !!u && (u.input ?? 0) + (u.output ?? 0) + (u.cache_read ?? 0) + (u.cache_write ?? 0) > 0;

// The error a request failed with carries what its stream reported (a copy: the driver's own
// object goes on changing until it is dropped). Nothing is kept for a failure that reported nothing.
export function reportUsage<E>(err: E, u: Usage | undefined): E {
  if (err && (typeof err === "object" || typeof err === "function") && counted(u)) reported.set(err as object, { ...u });
  return err;
}

// What the request's stream reported before it ended with this error, priced when it went through
// the registry; undefined when it reported nothing.
export function reportedUsage(err: unknown): Usage | undefined {
  return err && (typeof err === "object" || typeof err === "function") ? reported.get(err as object) : undefined;
}
