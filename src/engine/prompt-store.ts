// A session's system prompt, kept with the session, as the model is sent it
// (secrets are placeholders before it is stored or hashed): the text a request sends
// and the blocks it was made of (the core lines, each hook's text, the place,
// the instruction files), each with a fingerprint. A daemon restart or a
// session dropping out of memory reads the same bytes back; the prompt is
// made again only when one of its blocks really differs, and the row then
// says which, so a cache break can be traced to its block.
import type { Store } from "../core/store.ts";

export type PromptBlock = { name: string; hash: string; bytes: number };
export type PromptPart = { name: string; text: string };
export type StoredPrompt = {
  text: string;
  split: number;
  blocks: PromptBlock[];
  // The model the blocks were rendered for (a listing is cut to its window).
  model: string | null;
  rendered: number;
  // The last time the text changed: when, and the blocks that differed.
  changed: { ts: number; blocks: string[] } | null;
};

const SCHEMA = `CREATE TABLE IF NOT EXISTS session_prompts (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  text TEXT NOT NULL, split INTEGER NOT NULL, blocks TEXT NOT NULL, model TEXT,
  rendered INTEGER NOT NULL, changed_ts INTEGER, changed TEXT)`;

export const textHash = (s: string) => Bun.hash(s).toString(36);

// A hook's block is named by its first words, up to the first punctuation:
// enough to tell the blocks apart in a report, and stable while the block's
// subject is.
export const blockName = (text: string) => text.trimStart().split("\n", 1)[0]!.split(/[:;.,(]/, 1)[0]!.slice(0, 48).trim() || "block";

export const blocksOf = (parts: PromptPart[]): PromptBlock[] => parts.map((p) => ({ name: p.name, hash: textHash(p.text), bytes: Buffer.byteLength(p.text) }));

// The names of the blocks that differ between two renders: changed, added or
// gone. Two blocks of one name are told apart by their order.
export function changedBlocks(was: PromptBlock[], now: PromptBlock[]): string[] {
  const key = (list: PromptBlock[]) => {
    const n = new Map<string, number>();
    return list.map((b) => {
      const i = n.get(b.name) ?? 0;
      n.set(b.name, i + 1);
      return { id: `${b.name}\u0000${i}`, b };
    });
  };
  const a = key(was), b = key(now);
  const old = new Map(a.map((x) => [x.id, x.b.hash]));
  const cur = new Map(b.map((x) => [x.id, x.b.hash]));
  const out = new Set<string>();
  for (const x of b) if (old.get(x.id) !== x.b.hash) out.add(x.b.name);
  for (const x of a) if (!cur.has(x.id)) out.add(x.b.name);
  // Same blocks in another order is a change too.
  if (!out.size && a.some((x, i) => b[i]?.id !== x.id)) out.add("order");
  return [...out];
}

function readPrompt(store: Store, id: string): StoredPrompt | undefined {
  const r = store.db
    .query<{ text: string; split: number; blocks: string; model: string | null; rendered: number; changed_ts: number | null; changed: string | null }, [string]>(
      "SELECT text, split, blocks, model, rendered, changed_ts, changed FROM session_prompts WHERE session_id = ?")
    .get(id);
  if (!r) return undefined;
  return { text: r.text, split: r.split, blocks: JSON.parse(r.blocks), model: r.model, rendered: r.rendered, changed: r.changed_ts === null ? null : { ts: r.changed_ts, blocks: JSON.parse(r.changed ?? "[]") } };
}

export class PromptStore {
  constructor(private store: Store) {
    store.migrate(SCHEMA);
  }

  get(id: string): StoredPrompt | undefined {
    return readPrompt(this.store, id);
  }

  // `changed`: the blocks that differ from the row this one replaces (none for a first render).
  put(id: string, p: { text: string; split: number; blocks: PromptBlock[]; model: string | null }, changed?: string[]) {
    const now = Date.now();
    this.store.db
      .query(`INSERT INTO session_prompts (session_id, text, split, blocks, model, rendered, changed_ts, changed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(session_id) DO UPDATE SET text = excluded.text, split = excluded.split, blocks = excluded.blocks, model = excluded.model, rendered = excluded.rendered,
                changed_ts = COALESCE(excluded.changed_ts, changed_ts), changed = COALESCE(excluded.changed, changed)`)
      .run(id, p.text, p.split, JSON.stringify(p.blocks), p.model, now, changed?.length ? now : null, changed?.length ? JSON.stringify(changed) : null);
  }
}

// The prompt a session's requests carry: its own, or for a subagent on this
// machine its parent's (it runs on the parent's prompt byte for byte).
export function promptOf(store: Store, id: string): StoredPrompt | undefined {
  for (let s = store.session(id), hops = 0; s && hops < 32; s = s.parent_id && !s.machine ? store.session(s.parent_id) : undefined, hops++) {
    const p = readPrompt(store, s.id);
    if (p) return p;
  }
  return undefined;
}
