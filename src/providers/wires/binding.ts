// Preserved thinking on the Anthropic wire: a thinking block is bound to
// everything sent before it (system, tools, earlier messages, the text before
// it in its own message). When any of that changed since the model wrote the
// block, the block fails the provider's prefix check: the request is refused,
// or the model reads reasoning about content that is gone. Anthropic's rules
// (platform.claude.com, preserved-thinking/change-tools-or-instructions and
// prefix-checks):
// - a summary written by the harness replaces messages the kept turns' thinking
//   came after: that thinking is invalid;
// - any change to `tools` invalidates all thinking after it, except a deferred
//   tool nothing has referenced yet: once a message names it, its definition counts;
// - thinking may be left out only as a run: the oldest, the newest or all,
//   never one in between, and a left-out block stays out.
// So each block stored keeps a fingerprint of its prefix as sent (`bind`),
// leaving out thinking content and cache marks (the check does not compare
// thinking as content, and the rolling cache mark moves every request). Each
// request computes the same fingerprint at every stored block; the last block
// whose fingerprint differs and every thinking block before it are left out.
// Pure: the same history, system and tools give the same request.

type WireBlock = Record<string, any>;
type WireMessage = { role: string; content: WireBlock[] };

const hash = (s: string) => Bun.hash(s).toString(36);
const THINKING = new Set(["thinking", "redacted_thinking"]);
const plain = (b: WireBlock) => {
  const { cache_control: _c, ...rest } = b;
  return rest;
};

// The fingerprint a stored block carries, read where the wire block was made.
const stored = new WeakMap<WireBlock, string>();
export const carry = <T extends WireBlock>(wire: T, bind: string | undefined): T => {
  if (bind) stored.set(wire, bind);
  return wire;
};

export type Binder = { block(role: string, b: WireBlock): string | undefined };

// Walks one request in order; `block` gives a thinking block's fingerprint
// and advances past any other block.
export function binder(system: WireBlock[], tools: WireBlock[]): Binder {
  const deferred = new Map<string, WireBlock>();
  const eager: WireBlock[] = [];
  for (const t of tools) {
    if (t.defer_loading) deferred.set(t.name, { name: t.name, description: t.description, input_schema: t.input_schema });
    else eager.push(plain(t));
  }
  let state = hash(JSON.stringify([system.map(plain), eager]));
  let role = "";
  const refs = new Set<string>();
  let loaded = hash("");
  return {
    block(r, b) {
      if (r !== role) { role = r; state = hash(`${state}\u0000${r}`); }
      if (THINKING.has(b.type)) return hash(`${state}\u0001${loaded}`);
      state = hash(`${state}\u0002${JSON.stringify(plain(b))}`);
      if (b.type === "tool_result" && Array.isArray(b.content)) {
        let grew = false;
        for (const c of b.content) if (c?.type === "tool_reference" && !refs.has(c.tool_name)) { refs.add(c.tool_name); grew = true; }
        // A referenced deferred tool counts from here on, as it is declared now (or as gone).
        if (grew) loaded = hash(JSON.stringify([...refs].sort().map((n) => deferred.get(n) ?? { name: n, gone: true })));
      }
      return undefined;
    },
  };
}

// Leaves out the thinking whose prefix changed, and every thinking block
// before it. Returns the binder positioned after the last message, for the
// fingerprints of the reply this request gets.
export function unbind(messages: WireMessage[], system: WireBlock[], tools: WireBlock[]): { messages: WireMessage[]; binder: Binder; dropped: number } {
  const b = binder(system, tools);
  const seen: WireBlock[] = [];
  let last = -1;
  for (const m of messages) {
    for (const blk of m.content) {
      const now = b.block(m.role, blk);
      if (now === undefined) continue;
      seen.push(blk);
      const was = stored.get(blk);
      if (was && was !== now) last = seen.length - 1;
    }
  }
  if (last < 0) return { messages, binder: b, dropped: 0 };
  const out = new Set(seen.slice(0, last + 1));
  const kept: WireMessage[] = [];
  for (const m of messages) {
    const content = m.content.filter((x) => !out.has(x));
    if (!content.length) continue;
    const prev = kept.at(-1);
    if (prev && prev.role === m.role) prev.content.push(...content);
    else kept.push({ ...m, content });
  }
  return { messages: kept, binder: b, dropped: out.size };
}

// The response's blocks in their wire form: each thinking block gets the
// fingerprint of what came before it.
export function bindReply(b: Binder, reply: WireBlock[]): (string | undefined)[] {
  return reply.map((x) => b.block("assistant", x));
}
