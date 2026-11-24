// A remote MCP server that failed on the network is tried again in the background, so its tools come
// back when the network or the server does, with nobody at the keyboard. Claude Code and Claude Desktop
// retry a failed remote server for about a day; so does Keel: the first retry after `first`, each wait
// twice the one before, never past `cap`, and no retry once `giveUp` has passed since the first failure.
// (An object so a test can shorten the waits.)
import { neverSent } from "../providers/unreachable.ts";

export const RETRY = { first: 5_000, cap: 300_000, giveUp: 24 * 3600_000 };

// The wait before retry number `attempt` (the first is 1).
export function retryDelay(attempt: number, t = RETRY): number {
  return Math.min(t.cap, t.first * 2 ** Math.max(0, attempt - 1));
}

// A failure of the road to the server, not of the server's answer: a connection that could not be made
// or was lost, a request that timed out, a gateway that was down. A sign-in, a 4xx, a refused schema or a
// bad reply is not one: retrying it changes nothing.
const WORDS = /\b(timed out|ETIMEDOUT|ECONNRESET|ECONNABORTED|EPIPE|socket (?:hang up|connection was closed)|fetch failed|unable to connect|the connection (?:ended|was closed)|closed the response|HTTP 50[234])\b/i;
export function networkFailure(e: unknown): boolean {
  return neverSent(e) || WORDS.test((e as Error | undefined)?.message ?? "");
}
