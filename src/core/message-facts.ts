// What the readers of every model request measure of each of its messages: its fingerprint (the
// secrets vault and the request's zones tell the part already sent by it), its size with an image
// counted as its tokens (the zones), and the UTF-8 bytes of its content (the request's trace).
//
// Each was a JSON text of the whole history made for every request, four in all, and a long
// session's requests are megabytes each: the daemon's memory rose by hundreds of MB of those texts
// between two collections. A message whose blocks are the stored ones (frozen: the store hands out
// bodies that cannot change) is worked out once and kept for as long as its blocks are; a message
// with a block made for this request is worked out again each time. What is kept is the same value
// a fresh reading gives, so a fingerprint stored before (telemetry's prefix) still matches.
import type { Message } from "./types.ts";

export type MessageFacts = { mark: string; size: number; contentBytes: number };

// An image or document counts as about 1,600 tokens (a 1.15 megapixel image
// on Anthropic's formula), not as the length of its base64.
export const BLOB_BYTES = 6_400;
export const blobSize = (v: unknown) =>
  JSON.stringify(v, (k, x) => (k === "data" && typeof x === "string" && x.length > BLOB_BYTES ? " ".repeat(BLOB_BYTES) : x))?.length ?? 0;
export const markOf = (m: unknown) => Bun.hash(JSON.stringify(m)).toString(36);

const reckon = (m: Message): MessageFacts => ({ mark: markOf(m), size: blobSize(m), contentBytes: Buffer.byteLength(JSON.stringify(m.content)) });

// A message made of stored blocks alone: plain role and content, every block frozen.
function stored(m: Message): boolean {
  const keys = Object.keys(m);
  if (keys.length !== 2 || keys[0] !== "role" || keys[1] !== "content" || !Array.isArray(m.content) || !m.content.length) return false;
  for (const b of m.content as unknown[]) if (!b || typeof b !== "object" || !Object.isFrozen(b)) return false;
  return true;
}

// By the message's first block: the messages that began with it (a projection may merge it with
// the blocks after it differently once), each with its blocks.
type Seen = { role: string; blocks: readonly object[]; facts: MessageFacts };
const SEEN_PER_BLOCK = 4;
const seen = new WeakMap<object, Seen[]>();
const same = (s: Seen, m: Message) => s.role === m.role && s.blocks.length === m.content.length && s.blocks.every((b, i) => b === m.content[i]);

export function messageFacts(m: Message): MessageFacts {
  if (!stored(m)) return reckon(m);
  const first = m.content[0] as object;
  const list = seen.get(first);
  const hit = list?.find((s) => same(s, m));
  if (hit) return hit.facts;
  const facts = reckon(m);
  const entry: Seen = { role: m.role, blocks: [...m.content] as object[], facts };
  if (!list) seen.set(first, [entry]);
  else { list.push(entry); if (list.length > SEEN_PER_BLOCK) list.shift(); }
  return facts;
}
