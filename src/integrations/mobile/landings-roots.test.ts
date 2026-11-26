// Which trees the landing cards are read from: newer trees with nothing to land do not push out an older tree
// that holds an approved branch, a branch the queue landed is not looked for, and one a board found landed is not
// read again. The board is a stand-in: its own tests cover it.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownEnv } from "../../../test/env.ts";
import { Store } from "../../core/store.ts";
import type { BoardRow } from "../../board/rules.ts";
import { APPROVED_READ, landings, ROOTS_READ } from "./landings.ts";
import { readyRoots } from "../../board/ready-roots.ts";
import { Database } from "bun:sqlite";

const dir = mkdtempSync(join(tmpdir(), "keel-landing-roots-"));
ownEnv({ KEEL_CONFIG_DIR: join(dir, "config") });
mkdirSync(process.env.KEEL_CONFIG_DIR!);
const store = new Store(dir);
store.db.exec("CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, parent_id TEXT, session_id TEXT, branch TEXT, status TEXT, created INTEGER, ended INTEGER, reviews TEXT)");
store.db.exec("CREATE TABLE IF NOT EXISTS review_verdicts (agent_id TEXT, commit_sha TEXT, branches TEXT, land TEXT, why TEXT, at INTEGER)");
store.db.exec("CREATE TABLE IF NOT EXISTS landing_queue (id TEXT PRIMARY KEY, repo TEXT, branch TEXT, tip TEXT, state TEXT, updated INTEGER)");

const HEAD = "a".repeat(40);
const DAY = 86_400_000;
const row = (id: string, o: Partial<BoardRow> = {}): BoardRow => ({
  id, session_id: `s-${id}`, parent_id: "", depth: 1, title: `Agent ${id}`, type: "general-purpose", model: "m", state: "completed",
  created: 1000, ended: 2000, machine: null, branch: `keel/${id}`, repo: dir, base: "main", head: HEAD, ahead: 1, behind: 0, worktree: "here",
  checks: { state: "known", passed: ["unit"], failed: [], notRun: [] },
  review: { by: "rv", title: "Review", how: "named", state: "completed", verdict: "approved", source: "verdict", line: "fine", tip: HEAD, of: HEAD, current: true, at: 1 },
  reviews: [], landed: { state: "no", missing: 1 }, queue: null, live: null, work: null, together: null, ...o,
});

// ROOTS_READ + 1 trees: the oldest holds the only approved branch, made 20 days ago; the newer ones made branches
// today with no review.
function setup() {
  const add = store.db.query("INSERT INTO agents (id, parent_id, session_id, branch, status, created, ended) VALUES (?, ?, ?, ?, 'completed', ?, ?)");
  const trees: string[] = [];
  const rows = new Map<string, BoardRow[]>();
  for (let i = 0; i <= ROOTS_READ; i++) {
    const root = store.createSession({ model: "m", workspace: dir, title: `Tree ${i}` }).id;
    const id = `ag${root.slice(-6)}${i}`;
    const at = i === 0 ? Date.now() - 20 * DAY : Date.now() - (ROOTS_READ - i) * 60_000;
    add.run(id, root, `s-${id}`, `keel/${id}`, at, at + 1000);
    rows.set(root, [i === 0 ? row(id, { parent_id: root }) : row(id, { parent_id: root, review: null })]);
    trees.push(root);
  }
  const old = trees[0]!, oldAgent = rows.get(old)![0]!.id;
  store.db.query("INSERT INTO review_verdicts VALUES ('rv', ?, ?, 'yes', 'fine', ?)").run(HEAD, JSON.stringify([`keel/${oldAgent}`]), Date.now());
  const read: string[] = [];
  const fresh: boolean[] = [];
  const total = new Map<string, number>();
  const make = () => landings({
    store,
    board: () => ({ read: async (r: string, f = false) => { read.push(r); fresh.push(f); const rs = rows.get(r) ?? []; return { rows: rs, total: total.get(r) ?? rs.length, repos: [{ repo: dir, base: "main", base_tip: null, deploys: [] }] }; } }) as any,
    landing: () => undefined, rootOf: (s) => s, report: () => null,
    sendBack: async () => ({ waits: false }),
  });
  return { L: make(), make, old, oldAgent, rows, read, fresh, total, newer: trees.slice(1) };
}

test("an old tree with an approved branch is read past newer trees with nothing to land", async () => {
  const { L, old, oldAgent, read, newer } = setup();
  const ready = (await L.list()).filter((c) => c.ready);
  expect(ready.map((c) => c.key)).toEqual([`${old}.${oldAgent}`]);
  // The newer trees are still read for their cards.
  expect(newer.every((r) => read.includes(r))).toBe(true);
});

test("a branch the queue landed is not looked for, and one a board found landed is not read again", async () => {
  const s = setup();
  // The board finds the approved branch landed: its tree is read once more, then not.
  s.rows.set(s.old, [row(s.oldAgent, { parent_id: s.old, landed: { state: "yes", how: "ancestor" } })]);
  await s.L.list();
  expect(s.read.filter((r) => r === s.old).length).toBe(1);
  await s.L.list();
  expect(s.read.filter((r) => r === s.old).length).toBe(1);
  // Landed by the queue: never looked for.
  const t = setup();
  store.db.query("INSERT INTO landing_queue VALUES (?, ?, ?, ?, 'landed', ?)").run(`q-${t.oldAgent}`, dir, `keel/${t.oldAgent}`, HEAD, Date.now());
  expect((await t.L.list()).filter((c) => c.ready)).toEqual([]);
  expect(t.read.includes(t.old)).toBe(false);
});

test("a settled branch stays settled across a restart, and one its board's row cap left out is settled too", async () => {
  const s = setup();
  s.rows.set(s.old, [row(s.oldAgent, { parent_id: s.old, landed: { state: "yes", how: "ancestor" } })]);
  await s.L.list();
  // A new daemon: the read thread leaves the branch out, so its tree is not read.
  await s.make().list();
  expect(s.read.filter((r) => r === s.old).length).toBe(1);
  // Its board holds more agents than its rows, and the approved one is not among them: no card can come of it.
  const t = setup();
  t.rows.set(t.old, [row("other", { parent_id: t.old, review: null })]);
  t.total.set(t.old, 201);
  await t.L.list();
  // It is said on the list, not as a card, and its tree is still read in turn: when the board shows it again
  // (an agent before it landed), it is a card again.
  const v = await t.L.view();
  expect(v.not_shown.filter((n) => n.agent_id === t.oldAgent)).toEqual([{ chat_id: t.old, agent_id: t.oldAgent, branch: `keel/${t.oldAgent}`, why: "past its board's rows" }]);
  expect(v.cards.some((c) => c.agent_id === t.oldAgent)).toBe(false);
  t.rows.set(t.old, [row(t.oldAgent, { parent_id: t.old })]);
  t.total.set(t.old, 1);
  await t.L.list();
  const back = await t.L.view();
  expect([back.cards.some((c) => c.agent_id === t.oldAgent && c.ready), back.not_shown.some((n) => n.agent_id === t.oldAgent)]).toEqual([true, false]);
});

test("trees read only for an approved branch are read a few a list, not fresh, and keep their cards between", async () => {
  const add = store.db.query("INSERT INTO agents (id, parent_id, session_id, branch, status, created, ended) VALUES (?, ?, ?, ?, 'completed', ?, ?)");
  const verdict = store.db.query("INSERT INTO review_verdicts VALUES ('rv', ?, ?, 'yes', 'fine', ?)");
  const s = setup();
  const extra: string[] = [];
  for (let i = 0; i < APPROVED_READ + 2; i++) {
    const root = store.createSession({ model: "m", workspace: dir, title: `Old ${i}` }).id;
    const id = `old${root.slice(-6)}${i}`, at = Date.now() - 30 * DAY + i;
    add.run(id, root, `s-${id}`, `keel/${id}`, at, at + 1000);
    verdict.run(`${i}`.padStart(40, "0"), JSON.stringify([`keel/${id}`]), Date.now());
    s.rows.set(root, [row(id, { parent_id: root })]);
    extra.push(root);
  }
  // (Other tests' trees with approved branches share the store: what is counted is the trees past the recent ones.)
  const lists: string[][] = [];
  const recent = new Set(readyRoots(store.db, { since: Date.now() - 14 * DAY, recent: ROOTS_READ, branches: 0 }).recent);
  const keys = async () => {
    const from = s.read.length;
    const got = (await s.L.list(true)).filter((c) => c.ready).map((c) => c.chat_id);
    lists.push(s.read.slice(from).filter((r) => !recent.has(r)));
    // None of them is read fresh, though the list was.
    s.read.slice(from).forEach((r, i) => { if (!recent.has(r)) expect(s.fresh[from + i]).toBe(false); });
    return got;
  };
  await keys();
  expect(lists[0]!.length).toBe(APPROVED_READ);
  expect(extra.every((r) => s.read.includes(r))).toBe(false);
  let last: string[] = [];
  for (let i = 0; i < 4 && !extra.every((r) => s.read.includes(r)); i++) last = await keys();
  // Each list read at most a few, the rest came in turn, and the cards read before are still shown.
  expect(lists.every((l) => l.length <= APPROVED_READ)).toBe(true);
  expect(extra.every((r) => s.read.includes(r))).toBe(true);
  expect(extra.every((r) => last.includes(r)) && last.includes(s.old)).toBe(true);
  // A new daemon goes on with the rotation where it was: the tree read longest ago is read first (a tree never read counts as read at 0).
  const at = store.db.query<{ root: string; at: number }, []>("SELECT root, at FROM landing_reads").all().filter((r) => extra.includes(r.root));
  expect(at.length).toBe(extra.length);
  // (Read longest ago: the fifth; then the others in order; the last two most lately.)
  extra.forEach((r, i) => store.db.query("UPDATE landing_reads SET at = ? WHERE root = ?").run(i === 5 ? -1 : 10 ** 12 + i, r));
  store.db.query("UPDATE landing_reads SET at = ? WHERE root NOT IN (SELECT value FROM json_each(?))").run(10 ** 12 - 1, JSON.stringify(extra));
  const from = s.read.length;
  await s.make().list();
  const now = s.read.slice(from);
  expect([now.includes(extra[5]!), now.includes(extra[8]!), now.includes(extra[9]!)]).toEqual([true, false, false]);
});

test("a verdict that names only a commit approves the branch its reviewer was named for, while it still works", async () => {
  const s = setup();
  const agent = store.db.query<{ id: string; branch: string }, [string]>("SELECT id, branch FROM agents WHERE parent_id = ?").get(s.newer[0]!)!;
  store.db.query("INSERT INTO agents (id, parent_id, session_id, branch, status, created, ended, reviews) VALUES (?, ?, ?, NULL, 'running', ?, NULL, ?)")
    .run(`rv-${agent.id}`, s.newer[0]!, `s-rv-${agent.id}`, Date.now(), JSON.stringify([{ branch: agent.branch, tip: null, how: "named" }]));
  store.db.query("INSERT INTO review_verdicts VALUES (?, ?, '[]', 'yes', 'fine', ?)").run(`rv-${agent.id}`, HEAD, Date.now());
  const got = readyRoots(store.db, { since: 0, recent: 1, branches: 200 });
  expect(got.approved.map((a) => a.id)).toContain(agent.id);
});

test("the read of approved branches grows with the rows, not with their product", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE agents (id TEXT PRIMARY KEY, parent_id TEXT, session_id TEXT, branch TEXT, status TEXT, created INTEGER, ended INTEGER, reviews TEXT)");
  db.run("CREATE TABLE review_verdicts (agent_id TEXT, commit_sha TEXT, branches TEXT, land TEXT, why TEXT, at INTEGER)");
  db.run("CREATE TABLE reviews (id TEXT PRIMARY KEY, session_id TEXT, child_id TEXT, state TEXT, diff_sha TEXT, data TEXT, created INTEGER)");
  db.run("CREATE TABLE landing_queue (id TEXT PRIMARY KEY, repo TEXT, branch TEXT, tip TEXT, state TEXT, updated INTEGER)");
  db.run("CREATE TABLE worktrees (session_id TEXT PRIMARY KEY, state TEXT)");
  const N = 20_000;
  db.transaction(() => {
    const ins = db.prepare("INSERT INTO agents VALUES (?,?,?,?,?,?,?,?)");
    for (let i = 0; i < N; i++) ins.run(`a${i}`, `p${i % 400}`, `s${i}`, i % 5 ? `keel/b${i}` : null, "completed", i, i + 1, i % 5 ? null : JSON.stringify([{ branch: `keel/b${i - 1}` }]));
    const v = db.prepare("INSERT INTO review_verdicts VALUES (?,?,?,?,?,?)");
    for (let i = 0; i < N / 5; i++) v.run(`a${i * 5}`, "x", JSON.stringify([`keel/b${i * 3}`]), "yes", "w", 1);
    const r = db.prepare("INSERT INTO reviews VALUES (?,?,?,?,?,?,?)");
    for (let i = 0; i < N / 10; i++) r.run(`r${i}`, "s", null, "done", "d", JSON.stringify({ agent_branch: `keel/b${i * 7}`, verdict: "correct" }), 1);
    const q = db.prepare("INSERT INTO landing_queue VALUES (?,?,?,?,?,?)");
    for (let i = 0; i < N / 7; i++) q.run(`q${i}`, "r", `keel/b${i * 2}`, "t", "landed", 1);
  })();
  const t = performance.now();
  expect(readyRoots(db, { since: 0, recent: 200, branches: 200 }).approved.length).toBe(200);
  // (Quadratic, this was tens of seconds; linear, it is tens of milliseconds.)
  expect(performance.now() - t).toBeLessThan(3_000);
});
