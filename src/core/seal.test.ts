// The pure rules of the sealed record: a chain finds a row that was edited, taken out, put in or moved; a
// bundle is checked alone; a day's path ends in its root.
import { expect, test } from "bun:test";
import { ALGO, BUNDLE_FORMAT, climb, dayRoot, eventHead, hex, leaf, link, merkle, verifyBundle, verifyEvents, ZERO, type Bundle, type EventRow } from "./seal.ts";

function chain(n: number, from = 1): { rows: EventRow[]; head: Uint8Array } {
  const rows: EventRow[] = [];
  let prev: Uint8Array = ZERO;
  for (let seq = from; seq < from + n; seq++) {
    const r = { id: `e${seq}`, session_id: "s", seq, parent: seq > from ? `e${seq - 1}` : null, kind: "user", data: JSON.stringify({ text: `t${seq}` }), ts: 1000 + seq, prev };
    rows.push(r);
    prev = link(prev, eventHead(r), r.data);
  }
  return { rows, head: prev };
}
const copy = (rows: EventRow[]) => rows.map((r) => ({ ...r }));

test("a whole chain verifies, and says where the sealed part begins", () => {
  const { rows, head } = chain(5);
  const r = verifyEvents(rows, head);
  expect([r.break, r.sealed, r.unsealed, r.from]).toEqual([null, 5, 0, "event 1"]);
  // A store from before the seal: the first four events have no link, the chain starts at the fifth.
  const old = chain(3, 5).rows;
  const mixed = [...[1, 2, 3, 4].map((seq) => ({ ...rows[0]!, id: `o${seq}`, seq, prev: null })), ...old];
  const m = verifyEvents(mixed, hexless(old));
  expect([m.break, m.sealed, m.unsealed, m.from]).toEqual([null, 3, 4, "event 5"]);
});
const hexless = (rows: EventRow[]) => { let p: Uint8Array = ZERO; for (const r of rows) p = link(r.prev, eventHead(r), r.data); return p; };

test("an edited, removed, inserted or reordered event is found, and named", () => {
  const { rows, head } = chain(6);
  const edited = copy(rows); edited[2]!.data = JSON.stringify({ text: "changed" });
  expect(verifyEvents(edited, head).break?.at).toBe("event 3");
  const lastEdited = copy(rows); lastEdited[5]!.data = "{}";
  expect(verifyEvents(lastEdited, head).break?.at).toBe("event 6");
  const removed = copy(rows); removed.splice(3, 1);
  expect(verifyEvents(removed, head).break?.why).toContain("taken out");
  const tail = rows.slice(0, 4);
  expect(verifyEvents(tail, head).break?.why).toContain("rows after it were taken out");
  const swapped = copy(rows); [swapped[1], swapped[2]] = [swapped[2]!, swapped[1]!];
  expect(verifyEvents(swapped, head).break).not.toBeNull();
  const put = copy(rows); put.splice(3, 0, { ...rows[3]!, id: "x", data: "{}" });
  expect(verifyEvents(put, head).break).not.toBeNull();
  const cleared = copy(rows); cleared[4]!.prev = null;
  expect(verifyEvents(cleared, head).break?.at).toBe("event 5");
  const headChanged = verifyEvents(rows, link(ZERO, "x", "y"));
  expect(headChanged.break?.at).toBe("event 6");
});

test("a day's path ends in the day's root, and a bundle verifies alone and fails when changed", () => {
  const { rows, head } = chain(4);
  const leaves = ["a", "b", "s", "t", "u"].map((session) => leaf({ session, events: session === "s" ? head : link(ZERO, session, ""), cards: null, egress: null }));
  const at = 2;
  const { root, proof } = merkle(leaves, at);
  expect(hex(climb(leaves[at]!, proof))).toBe(hex(root));
  for (let i = 0; i < leaves.length; i++) expect(hex(climb(leaves[i]!, merkle(leaves, i).proof))).toBe(hex(root));
  const day = dayRoot("2026-11-20", null, root);
  const b: Bundle = {
    format: BUNDLE_FORMAT, algorithm: ALGO, session: "s", made_at: 1,
    events: { head: hex(head), rows: rows.map((r) => ({ ...r, prev: hex(r.prev) })) },
    cards: { head: null, rows: [] }, egress: { head: null, rows: [] },
    anchors: [{ day: "2026-11-20", at: 5, root: hex(day)!, prev_root: null, sessions: 5, leaf: { events: hex(head), cards: null, egress: null }, proof }],
  };
  const text = JSON.stringify(b);
  const ok = verifyBundle(JSON.parse(text), new Map([["2026-11-20", hex(day)!]]));
  expect(ok.ok).toBe(true);
  // Alone, with no root of its own to compare with, it says so.
  expect(verifyBundle(JSON.parse(text)).notes.join(" ")).toContain("not compared");
  const bad = (f: (x: any) => void) => { const x = JSON.parse(text); f(x); return verifyBundle(x, new Map([["2026-11-20", hex(day)!]])); };
  expect(bad((x) => { x.events.rows[1].data = "{}"; }).ok).toBe(false);
  expect(bad((x) => { x.events.rows.splice(1, 1); }).ok).toBe(false);
  expect(bad((x) => { x.events.rows.reverse(); }).ok).toBe(false);
  expect(bad((x) => { x.events.rows.pop(); }).ok).toBe(false);
  expect(bad((x) => { x.anchors[0].root = "00".repeat(32); }).ok).toBe(false);
  expect(bad((x) => { x.session = "t"; }).ok).toBe(false);
  expect(verifyBundle({ format: "other" }).ok).toBe(false);
  // Every row and the head made again by someone who changed it: the root of the day the bundle names no longer holds it.
  const forged = chain(4); forged.rows[1]!.data = "{}";
  let p: Uint8Array = ZERO; const fr = forged.rows.map((r) => { const o = { ...r, prev: p }; p = link(p, eventHead(o), o.data); return { ...o, prev: hex(o.prev) }; });
  const f = verifyBundle({ ...b, events: { head: hex(p), rows: fr } }, new Map([["2026-11-20", hex(day)!]]));
  expect(f.ok).toBe(false);
});
