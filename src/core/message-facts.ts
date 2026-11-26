// What the readers of every model request measure of each of its messages: its fingerprint (the
// secrets vault and the request's zones tell the part already sent by it), its size with an image
// counted as its tokens (the zones), and the UTF-8 bytes of its content (the request's trace).
//
// Each was a JSON text of the whole history made for every request, four in all, and a long
// session's requests are megabytes each: the daemon's memory rose by hundreds of MB of those texts
// between two collections. A message whose blocks are the stored ones (frozen: the store hands out
// bodies that cannot change) is worked out once and kept, also when its run is read again from the
// table (its blocks are known by the text they were read from); a message with a block made for this
// request is worked out again each time. What is kept is the same value
// a fresh reading gives, so a fingerprint stored before (telemetry's prefix) still matches.
import type { Message } from "./types.ts";

export type MessageFacts = { mark: string; size: number; contentBytes: number };

// An image or document counts as about 1,600 tokens (a 1.15 megapixel image
// on Anthropic's formula), not as the length of its base64.
export const BLOB_BYTES = 6_400;
export const blobSize = (v: unknown) =>
  JSON.stringify(v, (k, x) => (k === "data" && typeof x === "string" && x.length > BLOB_BYTES ? " ".repeat(BLOB_BYTES) : x))?.length ?? 0;
export const markOf = (m: unknown) => Bun.hash(JSON.stringify(m)).toString(36);

// The three facts from one JSON text of the message: the text is its mark's input; its size is that
// text with each long `data` string counted as BLOB_BYTES (as blobSize writes it); its content's bytes
// are the text less the `{"role":..,"content":` around it. Each is the value blobSize and the content's
// own text give. A message after a start is measured cold, all of it, and three texts of every long
// history were hundreds of MB the collector had not yet taken.
export const reckon = (m: Message): MessageFacts => {
  const text = JSON.stringify(m);
  return { mark: Bun.hash(text).toString(36), size: text.length - blobSaved(m), contentBytes: contentBytesOf(m, text) };
};

// What blobSize's replacer takes off the text: for each long `data` string, its JSON length less that of
// BLOB_BYTES spaces. A base64 string is its length and two quotes; any other is measured as JSON writes it.
const PLAIN = /^[A-Za-z0-9+/=_-]*$/;
function blobSaved(v: unknown): number {
  if (!v || typeof v !== "object") return 0;
  let n = 0;
  if (Array.isArray(v)) { for (const x of v) n += blobSaved(x); return n; }
  for (const [k, x] of Object.entries(v)) {
    if (k === "data" && typeof x === "string" && x.length > BLOB_BYTES) n += (PLAIN.test(x) ? x.length + 2 : JSON.stringify(x).length) - (BLOB_BYTES + 2);
    else n += blobSaved(x);
  }
  return n;
}

// The UTF-8 bytes of `JSON.stringify(m.content)`, read off the message's own text when the message is
// a role and a content and nothing else, in that order (the text is then that prefix, the content, `}`).
function contentBytesOf(m: Message, text: string): number {
  const keys = Object.keys(m);
  if (keys.length !== 2 || keys[0] !== "role" || keys[1] !== "content" || typeof m.role !== "string" || m.content === undefined) return Buffer.byteLength(JSON.stringify(m.content) ?? "");
  return Buffer.byteLength(text) - Buffer.byteLength(`{"role":${JSON.stringify(m.role)},"content":`) - 1;
}

// A message made of stored blocks alone: plain role and content, every block frozen.
function stored(m: Message): boolean {
  const keys = Object.keys(m);
  if (keys.length !== 2 || keys[0] !== "role" || keys[1] !== "content" || !Array.isArray(m.content) || !m.content.length) return false;
  for (const b of m.content as unknown[]) if (!b || typeof b !== "object" || !Object.isFrozen(b)) return false;
  return true;
}

// The blocks of a stored body, by the text the body was read from: the same text read again (its
// run was given back and read once more) gives new objects with the same keys, so a message made of
// them is still known. Set by the store as it parses a body (keyBlocks).
const keys = new WeakMap<object, string>();
export function keyBlocks(body: unknown, text: string): void {
  if (!body || typeof body !== "object") return;
  const h = `${Bun.hash(text).toString(36)}.${text.length.toString(36)}`;
  keys.set(body, h);
  const b = body as { blocks?: unknown; results?: unknown; images?: unknown };
  // (Each list its own prefix: a body with blocks and results has a block 0 of each, two blocks.)
  for (const [name, list] of [["", b.blocks], ["r", b.results], ["i", b.images]] as const) {
    if (!Array.isArray(list)) continue;
    list.forEach((x, i) => { if (x && typeof x === "object") keys.set(x, `${h}.${name}${i}`); });
  }
}

// What a projection makes of a stored body (a prompt's text block, a note's, a checkpoint's summary
// message), made once per body and frozen, its blocks keyed by the body's key and `tag`: the same
// request after request, so a message of them is known like one of stored blocks.
const made = new WeakMap<object, Map<string, object>>();
export function derived<T extends object>(body: object, tag: string, make: () => T): T {
  let m = made.get(body);
  if (!m) made.set(body, (m = new Map()));
  const had = m.get(tag) as T | undefined;
  if (had) return had;
  const v = make();
  const key = keys.get(body);
  const blocks = (v as { content?: unknown }).content;
  const each = Array.isArray(blocks) ? blocks : [v];
  each.forEach((b, i) => {
    if (!b || typeof b !== "object") return;
    if (key !== undefined && !keys.has(b)) keys.set(b, `${key}:${tag}.${i}`);
    Object.freeze(b);
  });
  m.set(tag, v);
  return v;
}

// Facts of messages whose blocks all have keys, by the role and the keys; bounded, the oldest read go first.
const KEPT = 8192;
const byKey = new Map<string, MessageFacts>();
// And of messages of frozen blocks without keys, by the message's first block: the messages that began
// with it (a projection may merge it with the blocks after it differently once), each with its blocks.
type Seen = { role: string; blocks: readonly object[]; facts: MessageFacts };
const SEEN_PER_BLOCK = 4;
const seen = new WeakMap<object, Seen[]>();
const same = (s: Seen, m: Message) => s.role === m.role && s.blocks.length === m.content.length && s.blocks.every((b, i) => b === m.content[i]);

function keyOf(m: Message): string | undefined {
  let k = m.role;
  for (const b of m.content as object[]) {
    const x = keys.get(b);
    if (x === undefined) return undefined;
    k += ` ${x}`;
  }
  return k;
}

export function messageFacts(m: Message): MessageFacts {
  if (!stored(m)) return reckon(m);
  const key = keyOf(m);
  if (key !== undefined) {
    const had = byKey.get(key);
    if (had) { byKey.delete(key); byKey.set(key, had); return had; }
    const facts = reckon(m);
    byKey.set(key, facts);
    if (byKey.size > KEPT) byKey.delete(byKey.keys().next().value!);
    return facts;
  }
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
