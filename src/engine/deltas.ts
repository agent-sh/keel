// A reply's streamed text, joined before it is sent on. A model streams a few
// characters at a time, hundreds of pieces a second, and each piece was a
// frame of its own: redacted, numbered, handed to every listener, written to
// every socket. Here the pieces of one session are joined for JOIN_MS and go
// on as one frame a block: what a page shows is the same text, arriving in
// steps of that length.
//
// The first piece after a pause goes on at once (the time to the first word is
// what it was); the ones that follow within JOIN_MS wait for its end. The
// stream's end sends what waits, before whatever follows the stream (the
// stored reply's own frame).
//
// `scan` is what may be shown of a block's text: set by the secrets module,
// it holds back the end of a piece that may still grow into a secret and
// gives it with the next piece or at the end (src/safety/secrets.ts,
// StreamScan). Text is never sent on unscanned.
export type Delta = { index: number; kind: "text" | "thinking" | "tool_input"; text: string; name?: string };
export type DeltaScan = {
  // What may be shown now of the next piece of a block.
  piece(session: string, index: number, text: string): string;
  // The block ended (or the stream did): what was held of it.
  end(session: string, index: number): string;
};

export const JOIN_MS = 40;
const plain: DeltaScan = { piece: (_s, _i, text) => text, end: () => "" };

type Open = { parts: Delta[]; timer?: ReturnType<typeof setTimeout>; sent: number; blocks: Map<number, Delta> };

export class DeltaJoin {
  private open = new Map<string, Open>();
  scan: DeltaScan = plain;

  constructor(private emit: (session: string, d: Delta) => void, private ms = JOIN_MS, private now: () => number = () => performance.now()) {}

  push(session: string, d: Delta) {
    let o = this.open.get(session);
    if (!o) this.open.set(session, (o = { parts: [], sent: -Infinity, blocks: new Map() }));
    const last = o.parts.at(-1);
    if (last && last.index === d.index && last.kind === d.kind && last.name === d.name) last.text += d.text;
    else o.parts.push({ ...d });
    const waited = this.now() - o.sent;
    if (waited >= this.ms) return this.flush(session);
    o.timer ??= setTimeout(() => this.flush(session), Math.max(1, this.ms - waited));
  }

  // What waits goes on now.
  flush(session: string) {
    const o = this.open.get(session);
    if (!o) return;
    clearTimeout(o.timer);
    o.timer = undefined;
    if (!o.parts.length) return;
    o.sent = this.now();
    const parts = o.parts;
    o.parts = [];
    for (const p of parts) {
      // A block the stream has moved on from is whole: what was held of it goes first.
      for (const [index, b] of o.blocks) if (index !== p.index) { o.blocks.delete(index); this.send(session, b, this.scan.end(session, index)); }
      o.blocks.set(p.index, { index: p.index, kind: p.kind, name: p.name, text: "" });
      this.send(session, p, this.scan.piece(session, p.index, p.text));
    }
  }

  // The stream ended: everything that waits or was held goes on, and the session's place here is given up.
  end(session: string) {
    const o = this.open.get(session);
    if (!o) return;
    this.flush(session);
    for (const [index, b] of o.blocks) this.send(session, b, this.scan.end(session, index));
    this.open.delete(session);
  }

  private send(session: string, d: Delta, text: string) {
    if (text) this.emit(session, { index: d.index, kind: d.kind, ...(d.name !== undefined ? { name: d.name } : {}), text });
  }
}
