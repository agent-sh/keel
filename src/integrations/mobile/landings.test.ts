// Landings decided on the phone: which branches are cards, and a decision refused when the facts it was
// taken on are no longer the card's. The board and the queue are stand-ins: their own tests cover them.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownEnv } from "../../../test/env.ts";
import { Store } from "../../core/store.ts";
import type { BoardRow } from "../../board/rules.ts";
import { landings } from "./landings.ts";

const dir = mkdtempSync(join(tmpdir(), "keel-landings-"));
ownEnv({ KEEL_CONFIG_DIR: join(dir, "config") });
mkdirSync(process.env.KEEL_CONFIG_DIR!);
const store = new Store(dir);
store.db.exec("CREATE TABLE IF NOT EXISTS agents (id TEXT, parent_id TEXT, session_id TEXT, branch TEXT, created INTEGER)");

const HEAD = "a".repeat(40);
const row = (id: string, o: Partial<BoardRow> = {}): BoardRow => ({
  id, session_id: `s-${id}`, parent_id: "", depth: 1, title: `Agent ${id}`, type: "general-purpose", model: "m", state: "completed",
  created: 1000, ended: 2000, machine: null, branch: `keel/${id}`, repo: dir, base: "main", head: HEAD, ahead: 1, behind: 0, worktree: "here",
  checks: { state: "known", passed: ["unit"], failed: [], notRun: [] },
  review: { by: "rv", title: "Review", how: "named", state: "completed", verdict: "approved", source: "verdict", line: "fine", tip: HEAD, of: HEAD, current: true, at: 1 },
  reviews: [], landed: { state: "no", missing: 1 }, queue: null, live: null, ...o,
});

function setup() {
  const root = store.createSession({ model: "m", workspace: dir, title: "Coordinator" });
  const old = store.createSession({ model: "m", workspace: dir, title: "Archived" });
  store.updateSession(old.id, { archived: true } as any);
  const add = store.db.query("INSERT INTO agents (id, parent_id, session_id, branch, created) VALUES (?, ?, ?, ?, ?)");
  add.run("ag1", root.id, "s-ag1", "keel/ag1", Date.now());
  add.run("ag9", old.id, "s-ag9", "keel/ag9", Date.now());
  let rows: BoardRow[] = [row("ag1", { parent_id: root.id }), row("ag2", { parent_id: root.id, state: "running" }), row("ag3", { parent_id: root.id, review: null, ended: 3000 })];
  const queued: { repo: string; branches: string[]; by: string | null }[] = [];
  const removed: string[] = [];
  let tip = HEAD;
  const sent: { id: string; text: string; key: string }[] = [];
  const L = landings({
    store,
    board: () => ({ read: async (r: string) => ({ rows: r === root.id ? rows : r === old.id ? [row("ag9")] : [] }) }) as any,
    landing: () => ({
      add: async (repo: string, branches: string[], by: string | null) => { queued.push({ repo, branches, by }); return { queued: [{ id: "e1", state: "queued", tip, why: null }], refused: [], warnings: [] }; },
      remove: (id: string) => { removed.push(id); return {}; },
    }) as any,
    rootOf: (s) => s,
    report: (id) => (id === "ag1" ? "Did it.\n(Checks after its last edit (1 min ago): unit passed 1 min ago.)" : null),
    sendBack: async (id, text, key) => { sent.push({ id, text, key }); return { waits: false }; },
  });
  return { root, L, queued, removed, sent, setRows: (r: BoardRow[]) => (rows = r), setTip: (t: string) => (tip = t) };
}

test("the cards are the finished branches of the owner's live trees, ready first, each with its proof line", async () => {
  const { root, L } = setup();
  const cards = await L.list();
  // The working agent is no card, the archived tree is not read; ag1 is ready, ag3 has no review.
  expect(cards.map((c) => [c.key, c.ready, c.missing])).toEqual([[`${root.id}.ag1`, true, []], [`${root.id}.ag3`, false, ["no review"]]]);
  expect(cards[0]!.proof).toBe("(Checks after its last edit (1 min ago): unit passed 1 min ago.)");
  expect([cards[0]!.title, cards[0]!.branch]).toEqual(["Coordinator", "keel/ag1"]);
});

test("a landing goes to the queue only on the facts shown, and only for the head shown", async () => {
  const { root, L, queued, removed, setRows, setTip } = setup();
  const [card] = await L.list();
  // Shown, then its checks changed: refused with the card as it is now.
  setRows([row("ag1", { checks: { state: "known", passed: [], failed: ["unit"], notRun: [] } })]);
  const changed: any = await L.land(card!.key, card!.fp);
  expect([changed.status, changed.error, changed.card.missing]).toEqual([409, "Its facts changed since it was shown. Read the card again before deciding.", ["failed: unit"]]);
  expect(queued).toEqual([]);
  // As shown: queued by the owner.
  setRows([row("ag1")]);
  const ok: any = await L.land(card!.key, card!.fp);
  expect([ok.entry, queued]).toEqual([{ id: "e1", state: "queued", why: null }, [{ repo: dir, branches: ["keel/ag1"], by: null }]]);
  // The branch moved between the read and the queue: taken out again, and said.
  setTip("b".repeat(40));
  const moved: any = await L.land(card!.key, card!.fp);
  expect([moved.status, removed]).toEqual([409, ["e1"]]);
  // Landed meanwhile, or gone from the tree: no card to decide on.
  setRows([row("ag1", { landed: { state: "yes", how: "ancestor" } })]);
  expect(await L.land(card!.key, card!.fp)).toMatchObject({ status: 409, card: null });
  expect(await L.land(`${root.id}.nobody`, card!.fp)).toMatchObject({ status: 409, card: null });
});

test("sent back, the agent gets the owner's words with its branch and head, once per card", async () => {
  const { L, sent, setRows } = setup();
  const [card] = await L.list();
  const r: any = await L.back(card!.key, card!.fp, "Split the retry change from the rename.");
  expect(r.sent).toEqual({ waits: false, held: false });
  expect(sent).toEqual([{ id: "ag1", key: `phone-back:${card!.key}:${card!.fp}`, text: "The owner sent your branch keel/ag1 back from the phone, at aaaaaaaaa; it was not landed. Their words:\nSplit the retry change from the rename." }]);
  setRows([row("ag1", { head: "c".repeat(40) })]);
  expect(await L.back(card!.key, card!.fp, "again")).toMatchObject({ status: 409 });
  expect(sent).toHaveLength(1);
});
