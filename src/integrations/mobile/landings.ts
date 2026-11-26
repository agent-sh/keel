// Landings decided on the phone: each branch of an agent that finished and waits to land, as one card of
// the work board's facts (src/board/card.ts), across the owner's sessions. The owner lands it (the landing
// queue builds it on the base, checks that tree and fast-forwards) or sends it back to its agent with words.
// Either is refused when the card's facts, read again, are not the ones shown (its print), and a landing
// asks for the approval key as an approval does (biometric on the phone).
import type { Store } from "../../core/store.ts";
import { git } from "../../core/git.ts";
import type { WorkBoard } from "../../board/board.ts";
import { branchGone, type BoardRow } from "../../board/rules.ts";
import { SETTLED_TABLE, type ReadyRoots } from "../../board/ready-roots.ts";
import { readsOf } from "../../server/reads.ts";
import { cardOrder, isCard, landCard, type LandCard } from "../../board/card.ts";
import type { LandingQueue } from "../../landing/queue.ts";

// Sessions whose trees are read: the newest that have an agent with a branch made in this time, and every tree
// with an approved branch not landed yet, the newest BRANCHES_READ of those branches.
export const ROOTS_READ = 12;
const ROOTS_SINCE_MS = 14 * 86_400_000;
export const BRANCHES_READ = 200;
// Of the trees read only for an approved branch, the most one list reads (the longest unread first); the others
// show the cards their last read made. A decision reads its card fresh whatever the list showed.
export const APPROVED_READ = 8;
// The diffs a card's areas are read from, kept by base and head (a pair's answer never changes).
const AREAS_KEPT = 400;
// The owner's words to an agent that gets its branch back.
export const BACK_MAX = 4000;

export const landMessage = (key: string, fp: string, ts: string) => `land\n${key}\n${fp}\n${ts}`;

export type LandingsDeps = {
  store: Store;
  board: () => WorkBoard | undefined;
  landing: () => LandingQueue | undefined;
  rootOf: (sessionId: string) => string;
  report: (agentId: string) => string | null;
  // The owner's words to the agent: delivered as its next input (src/automation/agents.ts send).
  sendBack: (agentId: string, text: string, key: string) => Promise<{ waits: boolean; held?: boolean }>;
};

// The queue's entries of a branch (the queue makes its table; none yet is no entry).
function entriesOf(store: Store, repo: string, branch: string): string[] {
  try { return store.db.query<{ id: string }, [string, string]>("SELECT id FROM landing_queue WHERE repo = ? AND branch = ?").all(repo, branch).map((x) => x.id); } catch { return []; }
}

export function landings(d: LandingsDeps) {
  const areas = new Map<string, Promise<string>>();
  const numstat = (repo: string, base: string, head: string) => {
    const k = `${repo}\0${base}\0${head}`;
    let p = areas.get(k);
    if (!p) {
      p = git(repo, ["diff", "--numstat", "-M", `${base}...${head}`], { read: true, timeout: 10_000 }).then((r) => (r.code === 0 ? r.out : ""));
      areas.set(k, p);
      if (areas.size > AREAS_KEPT) areas.delete(areas.keys().next().value!);
    }
    return p;
  };

  // Approved branches a board read found landed, gone or past its board's rows: kept with when their agent
  // ended, so the read thread leaves them out until it ends again (src/board/ready-roots.ts), across restarts.
  let settledMade = false;
  const settle = (agent: string, ended: number | null, why: string) => {
    try {
      if (!settledMade) { d.store.db.run(SETTLED_TABLE); settledMade = true; }
      d.store.db.query("INSERT OR REPLACE INTO landing_settled (agent_id, ended, why, at) VALUES (?, ?, ?, ?)").run(agent, ended, why, Date.now());
    } catch {}
  };

  // The sessions at the top of trees whose agents made branches lately, the newest first; then those read only
  // for an approved branch not landed yet, with the agents of those branches by tree.
  const roots = async (): Promise<{ recent: string[]; approved: Map<string, Map<string, number | null>> }> => {
    const got = await readsOf(d.store).run("landings.roots", { since: Date.now() - ROOTS_SINCE_MS, recent: 200, branches: BRANCHES_READ }) as ReadyRoots;
    const open = (parent: string) => {
      const root = d.rootOf(parent);
      const s = d.store.session(root);
      return s && !s.archived ? root : null;
    };
    const recent: string[] = [];
    for (const p of got.recent) {
      const root = recent.length < ROOTS_READ ? open(p) : null;
      if (root && !recent.includes(root)) recent.push(root);
    }
    const approved = new Map<string, Map<string, number | null>>();
    for (const a of got.approved) {
      const root = open(a.parent_id);
      if (!root) continue;
      if (!approved.has(root)) approved.set(root, new Map());
      approved.get(root)!.set(a.id, a.ended);
    }
    return { recent, approved };
  };
  // The cards of each tree read only for an approved branch, as its last read made them.
  const kept = new Map<string, { at: number; cards: (LandCard & { at: number })[] }>();

  const cardOf = async (root: string, row: BoardRow, repos: { repo: string; base_tip: string | null }[] = []): Promise<LandCard> =>
    landCard({ root, title: d.store.session(root)?.title || "New chat", row, report: d.report(row.id), baseTip: repos.find((x) => x.repo === row.repo)?.base_tip ?? null,
      numstat: row.repo && row.base && row.head ? await numstat(row.repo, row.base, row.head) : "" });

  // Every card, ready first.
  async function list(fresh = false): Promise<LandCard[]> {
    const b = d.board();
    if (!b) return [];
    const out: (LandCard & { at: number })[] = [];
    const { recent, approved } = await roots();
    const read = async (root: string, now: boolean) => {
      const board = await b.read(root, now).catch(() => undefined);
      const cards: (LandCard & { at: number })[] = [];
      if (!board) return cards;
      for (const row of board.rows) {
        if (isCard(row)) cards.push({ ...(await cardOf(root, row, board.repos)), at: row.ended ?? row.created });
      }
      // An approved branch this read cannot make a card of, and will not on a later read until its agent ends
      // again, is settled: landed, gone, or left out by the board's row cap (only older finished agents are).
      const mine = approved.get(root);
      if (mine) {
        const shown = new Map(board.rows.map((r) => [r.id, r]));
        for (const [id, ended] of mine) {
          const row = shown.get(id);
          const why = !row ? (board.total > board.rows.length ? "past its board's rows" : null)
            : row.landed?.state === "yes" || row.landed?.state === "nothing" ? "landed" : branchGone(row) ? "gone" : null;
          if (why) settle(id, ended, why);
        }
      }
      return cards;
    };
    for (const root of recent) out.push(...(await read(root, fresh)));
    // The trees read only for an approved branch: a few each list, the longest unread first, and not fresh (each
    // read is git calls and merges); the others show what their last read made.
    const only = [...approved.keys()].filter((r) => !recent.includes(r));
    for (const r of kept.keys()) if (!only.includes(r)) kept.delete(r);
    const due = [...only].sort((x, y) => (kept.get(x)?.at ?? 0) - (kept.get(y)?.at ?? 0)).slice(0, APPROVED_READ);
    for (const root of only) {
      if (due.includes(root)) kept.set(root, { at: Date.now(), cards: await read(root, false) });
      out.push(...(kept.get(root)?.cards ?? []));
    }
    return out.sort(cardOrder).map(({ at, ...c }) => c);
  }

  // One card read fresh, by its key, with its branch's repository; null when its row no longer waits to land.
  async function fresh(key: string): Promise<{ card: LandCard; repo: string | null } | null> {
    const dot = key.lastIndexOf(".");
    const root = key.slice(0, Math.max(0, dot)), agent = key.slice(dot + 1);
    const b = d.board();
    if (!b || !root || !agent || !d.store.session(root)) return null;
    const board = await b.read(root, true);
    const row = board.rows.find((r) => r.id === agent);
    return row && isCard(row) ? { card: await cardOf(root, row, board.repos), repo: row.repo } : null;
  }

  // The card as shown (`fp`), or why not: its facts changed, or it is gone.
  async function check(key: string, fp: string): Promise<{ card: LandCard; repo: string | null } | { status: number; error: string; card: LandCard | null }> {
    const now = await fresh(key);
    if (!now) return { status: 409, error: "This branch no longer waits to land: it landed, its agent works on it again, or the queue has it.", card: null };
    if (now.card.fp !== fp) return { status: 409, error: "Its facts changed since it was shown. Read the card again before deciding.", card: now.card };
    return now;
  }

  async function land(key: string, fp: string) {
    const got = await check(key, fp);
    if ("status" in got) return got;
    const q = d.landing(), repo = got.repo;
    if (!q || !repo) return { status: 409, error: q ? "The branch's repository is not known on this machine." : "The landing queue is not running.", card: got.card };
    // (What was live before this call: an entry it did not make is someone else's, and is not taken out below.)
    const before = new Set(entriesOf(d.store, repo, got.card.branch));
    const r = await q.add(repo, [got.card.branch], null);
    const e = r.queued[0];
    if (!e) return { status: 409, error: `Not queued: ${r.refused[0]?.why ?? "the queue took nothing"}.`, card: got.card };
    // The queue took the branch as it is now: a head that moved since the card was read is not what was decided.
    if (e.tip !== got.card.head) {
      if (e.state === "queued" && !before.has(e.id)) q.remove(e.id, null);
      return { status: 409, error: "The branch moved while it was being queued. Read the card again before deciding.", card: got.card };
    }
    return { entry: { id: e.id, state: e.state, why: e.why ?? null }, warnings: r.warnings, card: got.card };
  }

  async function back(key: string, fp: string, text: string) {
    const got = await check(key, fp);
    if ("status" in got) return got;
    const c = got.card;
    const words = `The owner sent your branch ${c.branch} back from the phone, at ${c.head.slice(0, 9)}; it was not landed. Their words:\n${text}`;
    // The key is of these words on this card: other words on the same card are another message, the same
    // words sent twice are one.
    const r = await d.sendBack(c.agent_id, words, `phone-back:${c.key}:${c.fp}:${Bun.hash(text).toString(36)}`);
    return { sent: { waits: r.waits, held: !!r.held }, card: c };
  }

  return { list, fresh, land, back };
}
