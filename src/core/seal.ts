// The sealed record: a session's events, its approval cards and its outward
// rows are each a chain of hashes. A row's link covers its content and the
// link before it, so a row that was edited, taken out, put in or moved shows
// as a link that no longer fits. Pure: it reads no store and imports nothing
// of the daemon, so the read thread, the command line and a bundle on a
// machine that has no daemon all verify with the same code.
//
// Algorithm (named `ALGO`, written in every bundle so another tool can redo it):
//   link   = SHA-256( prev (32 bytes) || head || "\n" || body )
//   head   = a JSON array of the row's fields (the text of the row but its body)
//   body   = the row's long text, as stored: an event's data, a card's record, an outward row's reason
//   prev   = the link before it in its chain; 32 zero bytes for the first
// A row keeps its prev. Its own link is not stored: the next row's prev is it,
// and the session's head (the last link) is kept beside the session. A session
// is a leaf of a day's Merkle tree (`leaf`), and a day's root also covers the
// day's before it (`dayRoot`), so a root that is kept elsewhere vouches for
// every head the day held and for the days before.
import { createHash } from "node:crypto";

export const ALGO = "keel-seal-1 sha256";
export const BUNDLE_FORMAT = "keel-seal-bundle-1";
export const ZERO: Uint8Array = new Uint8Array(32);
export type ChainKind = "events" | "cards" | "egress";

export const hex = (b: Uint8Array | null | undefined): string | null => (b ? Buffer.from(b).toString("hex") : null);
export const unhex = (s: string | null | undefined): Uint8Array | null => (typeof s === "string" && /^[0-9a-f]{64}$/.test(s) ? new Uint8Array(Buffer.from(s, "hex")) : null);
export const same = (a: Uint8Array | null | undefined, b: Uint8Array | null | undefined): boolean => !!a && !!b && a.length === b.length && Buffer.compare(a, b) === 0;

// The link a row makes: Bun's hasher where there is one (about 1 microsecond for an ordinary event).
export function link(prev: Uint8Array | null, head: string, body: string): Uint8Array {
  const h = typeof Bun !== "undefined" ? new Bun.CryptoHasher("sha256") : createHash("sha256");
  h.update(prev ?? ZERO);
  h.update(`${head}\n`);
  h.update(body);
  return new Uint8Array(h.digest() as Uint8Array);
}

export type EventRow = { id: string; session_id: string; seq: number; parent: string | null; kind: string; data: string; ts: number; prev: Uint8Array | null };
export type CardRow = { id: number; session_id: string; ts: number; data: string; prev: Uint8Array | null };
export type EgressRow = { id: number; ts: number; session_id: string | null; turn_event: string | null; call_id: string | null; tool: string; via: string | null; host: string; port: number | null; bytes_out: number | null; outcome: string; status: number | null; why: string | null; prev: Uint8Array | null };

// What a row's link covers: its fields (never its prev and, for an outward row, never its rowid, which is not known before it is stored).
export const eventHead = (r: Pick<EventRow, "id" | "session_id" | "seq" | "parent" | "kind" | "ts">) => JSON.stringify([r.id, r.session_id, r.seq, r.parent ?? null, r.kind, r.ts]);
export const cardHead = (session: string, ts: number) => JSON.stringify([session, ts]);
export const egressHead = (r: Omit<EgressRow, "id" | "why" | "prev">) => JSON.stringify([r.ts, r.session_id ?? null, r.turn_event ?? null, r.call_id ?? null, r.tool, r.via ?? null, r.host, r.port ?? null, r.bytes_out ?? null, r.outcome, r.status ?? null]);
export const eventLink = (r: EventRow) => link(r.prev, eventHead(r), r.data);
export const cardLink = (r: CardRow) => link(r.prev, cardHead(r.session_id, r.ts), r.data);
export const egressLink = (r: EgressRow) => link(r.prev, egressHead(r), r.why ?? "");

export type Break = { at: string; why: string };
export type ChainResult = {
  kind: ChainKind;
  rows: number;
  // Rows that carry a link. Rows before the first one are from before the seal and are not covered.
  sealed: number;
  // Where the sealed part begins ("event 14", "row 3"), and how many rows came before it.
  from: string | null;
  unsealed: number;
  // Rows no longer in the store whose links the first one still names (the outward ledger's retention).
  trimmed: boolean;
  break: Break | null;
  head: Uint8Array | null;
  // Every link of the chain, in order: what a day's root is looked for in.
  links: Uint8Array[];
};

type Row = { prev: Uint8Array | null };
// One chain, its rows in order. `label` says where a row is ("event 7"); `gap` tells that rows between two are missing from their
// numbers (events are numbered one after another; an outward row's number is not kept after retention, so it tells nothing).
// `kept`: the head the store holds for the chain.
export function verifyChain<T extends Row>(kind: ChainKind, rows: readonly T[], make: (r: T) => Uint8Array, label: (r: T) => string, kept: Uint8Array | null, gap?: (a: T, b: T) => boolean): ChainResult {
  const out: ChainResult = { kind, rows: rows.length, sealed: 0, from: null, unsealed: 0, trimmed: false, break: null, head: null, links: [] };
  const first = rows.findIndex((r) => r.prev);
  if (first < 0) {
    // No row has a link. A store that holds a head for it lost them.
    if (kept && rows.length) out.break = { at: label(rows[rows.length - 1]!), why: "the store holds a head for this chain but no row has a link" };
    out.unsealed = rows.length;
    return out;
  }
  out.unsealed = first;
  out.from = label(rows[first]!);
  out.sealed = rows.length - first;
  // The first row's prev: zero when the chain began there. Anything else names a row that is not here: rows before it were removed
  // (an outward row's retention does that on purpose, and an unsealed row before it is a store from before the seal).
  if (!same(rows[first]!.prev, ZERO)) {
    if (kind === "egress") out.trimmed = true;
    else out.break = { at: label(rows[first]!), why: "the row before the first linked one is missing from the store" };
  }
  let prevHash: Uint8Array | null = null;
  for (let i = first; i < rows.length && !out.break; i++) {
    const r = rows[i]!;
    if (!r.prev) { out.break = { at: label(r), why: "a row after the sealed part has no link (it was written without one, or its link was cleared)" }; break; }
    if (prevHash && !same(r.prev, prevHash)) {
      const before = rows[i - 1]!;
      const at = label(before);
      // A row that names the link of a row that is still here, further on or earlier, was moved.
      const known = rows.slice(first).findIndex((x) => same(make(x), r.prev));
      out.break = known >= 0
        ? { at: label(r), why: `${label(r)} follows ${label(rows[first + known]!)} in the chain, not ${at}: rows were moved` }
        : gap?.(before, r)
          ? { at: label(r), why: `a row between ${at} and ${label(r)} was taken out` }
          : { at, why: `${at} was changed, or a row was put in or taken out between ${at} and ${label(r)}` };
      break;
    }
    const h = make(r);
    out.links.push(h);
    prevHash = h;
  }
  out.head = out.links.length ? out.links[out.links.length - 1]! : null;
  if (!out.break) {
    if (!kept) out.break = { at: label(rows[rows.length - 1]!), why: "the store holds no head for a chain that has linked rows" };
    else if (!same(kept, out.head)) {
      out.break = { at: label(rows[rows.length - 1]!), why: "the head the store holds is not the last row's link: rows after it were taken out, or the head was changed" };
    }
  }
  return out;
}

export const verifyEvents = (rows: readonly EventRow[], kept: Uint8Array | null) =>
  verifyChain("events", rows, eventLink, (r) => `event ${r.seq}`, kept, (a, b) => b.seq !== a.seq + 1);
export const verifyCards = (rows: readonly CardRow[], kept: Uint8Array | null) =>
  verifyChain("cards", rows, cardLink, (r) => `card version ${r.id}`, kept);
export const verifyEgress = (rows: readonly EgressRow[], kept: Uint8Array | null) =>
  verifyChain("egress", rows, egressLink, (r) => `outward row ${r.id}`, kept);

// ---- Days -----------------------------------------------------------------------------------

export type Leaf = { session: string; events: Uint8Array | null; cards: Uint8Array | null; egress: Uint8Array | null };
const sha = (...parts: (string | Uint8Array)[]): Uint8Array => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};
// A session's head of the day: its three heads (zero where it has no chain).
export const leaf = (l: Leaf): Uint8Array => sha("L\0", l.session, "\0", l.events ?? ZERO, l.cards ?? ZERO, l.egress ?? ZERO);
const node = (a: Uint8Array, b: Uint8Array) => sha("N\0", a, b);

export type Step = { left: boolean; hash: string };
// The Merkle root of the leaves in the order given (sorted by session by the caller), and the path of leaf `at` to it.
// A node with no partner goes up as it is.
export function merkle(leaves: readonly Uint8Array[], at?: number): { root: Uint8Array; proof: Step[] } {
  if (!leaves.length) return { root: ZERO, proof: [] };
  let level = [...leaves];
  let i = at ?? -1;
  const proof: Step[] = [];
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let j = 0; j < level.length; j += 2) {
      const a = level[j]!, b = level[j + 1];
      if (b) {
        if (i === j) proof.push({ left: false, hash: hex(b)! });
        else if (i === j + 1) proof.push({ left: true, hash: hex(a)! });
        next.push(node(a, b));
      } else next.push(a);
    }
    i = i >= 0 ? Math.floor(i / 2) : i;
    level = next;
  }
  return { root: level[0]!, proof };
}
export function climb(start: Uint8Array, proof: readonly Step[]): Uint8Array | null {
  let h = start;
  for (const s of proof) {
    const o = unhex(s.hash);
    if (!o) return null;
    h = s.left ? node(o, h) : node(h, o);
  }
  return h;
}
// A day's root: the tree of its leaves, and the root of the day before it.
export const dayRoot = (day: string, prev: Uint8Array | null, tree: Uint8Array): Uint8Array => sha("keel-seal-day-1\0", day, "\0", prev ?? ZERO, tree);

// ---- Bundle ---------------------------------------------------------------------------------

export type Anchor = { day: string; at: number; root: string; prev_root: string | null; sessions: number; leaf: { events: string | null; cards: string | null; egress: string | null }; proof: Step[] };
export type Bundle = {
  format: typeof BUNDLE_FORMAT;
  algorithm: typeof ALGO;
  session: string;
  made_at: number;
  events: { head: string | null; rows: (Omit<EventRow, "prev"> & { prev: string | null })[] };
  cards: { head: string | null; rows: (Omit<CardRow, "prev"> & { prev: string | null })[] };
  egress: { head: string | null; rows: (Omit<EgressRow, "prev"> & { prev: string | null })[] };
  anchors: Anchor[];
};

const bytes = (s: string | null) => unhex(s);
export type AnchorResult = { day: string; ok: boolean; root: string; found: string | null; why?: string };
// `notes`: what the check can say and what it cannot (a bundle or a store checked alone has no root of its own to compare with).
export type Checked = { ok: boolean; session: string; chains: (Omit<ChainResult, "links" | "head"> & { head: string | null })[]; anchors: AnchorResult[]; notes: string[] };

// What the chains and the anchors of one session say. `keptRoots`: the roots a place outside the store holds, by day (a roots file); the
// store's own anchors are checked against it when it is given.
export function judge(session: string, parts: { events: ChainResult; cards: ChainResult; egress: ChainResult }, anchors: Anchor[], keptRoots?: ReadonlyMap<string, string>): Checked {
  const chains = [parts.events, parts.cards, parts.egress];
  const notes: string[] = [];
  const checked: AnchorResult[] = [];
  for (const a of anchors) {
    const l = { session, events: bytes(a.leaf.events), cards: bytes(a.leaf.cards), egress: bytes(a.leaf.egress) };
    const top = climb(leaf(l), a.proof);
    const want = top ? hex(dayRoot(a.day, bytes(a.prev_root), top)) : null;
    let why: string | undefined;
    if (want !== a.root) why = "the day's root is not what its heads and path make";
    else if (keptRoots && keptRoots.get(a.day) !== a.root) why = keptRoots.has(a.day) ? "the day's root differs from the one kept outside the store" : "the day's root is not in the roots file";
    else {
      // Each head the day held is one of the chain's links now (the chain grew from it), or the chain's head.
      const lost = (["events", "cards", "egress"] as const).find((k) => {
        const h = bytes(a.leaf[k]);
        const c = parts[k];
        return !!h && !c.links.some((x) => same(x, h)) && !(c.trimmed && k === "egress");
      });
      if (lost) why = `the ${lost} chain no longer holds the head it had that day: rows up to it were changed or taken out`;
    }
    checked.push({ day: a.day, ok: !why, root: a.root, found: keptRoots ? (keptRoots.get(a.day) ?? null) : null, ...(why ? { why } : {}) });
  }
  if (!anchors.length) notes.push("no day's root covers this session yet: the chains are checked against each other only");
  else if (!keptRoots) notes.push("the roots were not compared with a copy kept outside the store: give the roots file (--roots) or read it where it is kept");
  const broken = chains.some((c) => c.break) || checked.some((a) => !a.ok);
  return {
    ok: !broken,
    session,
    chains: chains.map(({ links: _links, head, ...c }) => ({ ...c, head: hex(head) })),
    anchors: checked,
    notes,
  };
}

// A bundle alone: its rows' links, its heads, its anchors. Any change to a row, its order or the heads is found.
export function verifyBundle(b: unknown, keptRoots?: ReadonlyMap<string, string>): Checked {
  const bad = (why: string): Checked => ({ ok: false, session: typeof (b as any)?.session === "string" ? (b as any).session : "", chains: [], anchors: [], notes: [why] });
  const x = b as Bundle;
  if (!x || typeof x !== "object" || x.format !== BUNDLE_FORMAT) return bad("not a keel seal bundle");
  if (x.algorithm !== ALGO) return bad(`the bundle uses ${String(x.algorithm)}; this verifier knows ${ALGO}`);
  if (typeof x.session !== "string" || !Array.isArray(x.events?.rows) || !Array.isArray(x.cards?.rows) || !Array.isArray(x.egress?.rows) || !Array.isArray(x.anchors)) return bad("the bundle is cut or malformed");
  try {
    const rows = <T extends { prev: string | null }>(r: T[]) => r.map((e) => ({ ...e, prev: bytes(e.prev) }));
    const events = verifyEvents(rows(x.events.rows) as unknown as EventRow[], bytes(x.events.head));
    const cards = verifyCards(rows(x.cards.rows) as unknown as CardRow[], bytes(x.cards.head));
    const egress = verifyEgress(rows(x.egress.rows) as unknown as EgressRow[], bytes(x.egress.head));
    return judge(x.session, { events, cards, egress }, x.anchors, keptRoots);
  } catch (e) {
    return bad(`the bundle is malformed: ${(e as Error).message}`);
  }
}
