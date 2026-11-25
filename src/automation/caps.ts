import { readsOf } from "../server/reads.ts";
import type { Session } from "../core/types.ts";
import { capClosing, capHeldMessage, capOwnerNote, capView, dollars, HELD_CLS, warnDue, warnMessage, WARN_AT, WARN_CLS, BURN_WINDOW_MS, raisedCap, type CapRow, type CapView } from "./cap-rules.ts";
import { capGate, capture, D, flush, hasPending } from "./core.ts";
import * as alerts from "./alerts.ts";
import * as failures from "./failures.ts";
import { priceOf } from "../providers/pricing.ts";

// Dollar caps: on a top session (its settings, `cap_usd` from `cap_from`) and on an agent's task
// (its budget's `usd` from its task's start). Either counts the whole tree below it, from the
// ledger: the cap's sessions and every session started under them. The rules are in cap-rules.ts.
//
// Three readers, one statement. The gate before a model step (agents.budgetSpent) reads the spend
// on the loop as an agent's budget always did, and only for a session that has a cap above it.
// The pulse (every ten seconds while any cap is set) reads spend and the last ten minutes on the
// read thread and tells the pages by one frame when a figure changed. The route reads the same.
// Both go by the ledger's session index (telemetry_calls_session): the tree's sessions first, and
// only their rows since the cap began.

const TREE = "WITH RECURSIVE t(s) AS (SELECT value FROM json_each(?1) UNION SELECT g.id FROM sessions g JOIN t ON g.parent_id = t.s)";
// `top`: the newest row of the ledger as this statement saw it, so a figure read here is exact up to it.
// `np`: rows with no price when they ran (their tokens are priced by UNPRICED_SQL).
export const SPEND_SQL = `${TREE} SELECT COALESCE(SUM(c.cost), 0) AS spent, COALESCE(SUM(CASE WHEN c.ts >= ?3 THEN c.cost END), 0) AS recent, COALESCE(SUM(c.cost IS NULL AND c.unpriced != 0), 0) AS np, (SELECT COALESCE(MAX(id), 0) FROM telemetry_calls) AS top FROM t CROSS JOIN telemetry_calls c ON c.session_id = t.s WHERE c.ts >= ?2`;
// What came to the tree's ledger since a row the gate read to (the gate's read: constant in the tree's size, it
// reads the rows of the ledger after that row, not the tree's rows since the cap began). `+` keeps the planner
// on the row id range, not on the session index.
export const DELTA_SQL = `${TREE} SELECT COALESCE(SUM(c.cost), 0) AS spent, COALESCE(SUM(c.cost IS NULL AND c.unpriced != 0), 0) AS np, (SELECT COALESCE(MAX(id), 0) FROM telemetry_calls) AS top FROM telemetry_calls c WHERE c.id > ?2 AND c.ts >= ?3 AND +c.session_id IN (SELECT s FROM t)`;
// The tokens of the calls that had no price, by model, to price at the listed price now.
const UNPRICED = "SELECT c.model AS model, COUNT(*) AS calls, SUM(c.input) AS input, SUM(c.output) AS output, SUM(c.cache_read) AS cache_read, SUM(c.cache_write) AS cache_write FROM";
const UNPRICED_TAIL = "AND c.cost IS NULL AND c.unpriced != 0 GROUP BY c.model";
export const UNPRICED_SQL = `${TREE} ${UNPRICED} t CROSS JOIN telemetry_calls c ON c.session_id = t.s WHERE c.ts >= ?2 AND c.id <= ?3 ${UNPRICED_TAIL}`;
export const UNPRICED_DELTA_SQL = `${TREE} ${UNPRICED} telemetry_calls c WHERE c.id > ?2 AND c.id <= ?3 AND c.ts >= ?4 AND +c.session_id IN (SELECT s FROM t) ${UNPRICED_TAIL}`;
export type UnpricedRow = { model: string; calls: number; input: number; output: number; cache_read: number; cache_write: number };

// The dollars of calls that had no price when they ran, at the models' listed prices now; and how many
// calls have none to this day (a plan, a local model).
export function listedCost(rows: UnpricedRow[]): { usd: number; none: number } {
  let usd = 0, none = 0;
  const models = (() => { try { return D().providers?.current?.() ?? []; } catch { return []; } })();
  for (const r of rows) {
    const price = models.find((m) => m.id === r.model)?.price;
    const cost = priceOf({ input: r.input, output: r.output, cache_read: r.cache_read, cache_write: r.cache_write }, price);
    if (cost === undefined) none += r.calls; else usd += cost;
  }
  return { usd, none };
}

export type Scope = {
  id: string; // the session the cap sits on: a top session, or an agent's own session
  kind: "session" | "agent";
  owner: string; // what the 80 percent is told once for: the session's id, or the agent's
  usd: number;
  from: number;
  sessions: string[]; // the cap's own sessions: the one, or an agent's task contexts
  parent: string | null; // who is told at 80 percent when it is not the owner: the agent's parent session
  title: string;
};

const SCHEMA = `CREATE TABLE IF NOT EXISTS cap_told (owner TEXT PRIMARY KEY, usd REAL NOT NULL, from_ms INTEGER NOT NULL)`;
export const migrate = () => D().store.migrate(SCHEMA);

export const capOf = (s: Pick<Session, "settings"> | undefined): { usd: number; from: number } | undefined =>
  s && typeof s.settings.cap_usd === "number" && s.settings.cap_usd > 0 ? { usd: s.settings.cap_usd, from: s.settings.cap_from ?? 0 } : undefined;

const hasLedger = () => !!D().store.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'telemetry_calls'").get();

// The tree's spend since `from` and in the last ten minutes, read whole from the ledger's session
// index (a cap's first read, an 80 percent notice, an agent's rate).
export function spentSince(sessions: string[], from: number, now = Date.now()): { spent: number; recent: number; top: number; none: number } {
  if (!hasLedger()) return { spent: 0, recent: 0, top: 0, none: 0 };
  const own = JSON.stringify(sessions);
  const r = D().store.db.query<{ spent: number; recent: number; np: number; top: number }, [string, number, number]>(SPEND_SQL).get(own, from, now - BURN_WINDOW_MS) ?? { spent: 0, recent: 0, np: 0, top: 0 };
  const np = r.np ? listedCost(D().store.db.query<UnpricedRow, [string, number, number]>(UNPRICED_SQL).all(own, from, r.top)) : { usd: 0, none: 0 };
  return { spent: r.spent + np.usd, recent: r.recent, top: r.top, none: np.none };
}

// --- the gate's running sum -------------------------------------------------------
// A top session's tree spend since its cap began, kept: the gate asks before every step of every
// session under the cap, so the read must not grow with the tree's rows. The sum holds the figure and
// the newest ledger row it includes; the next read adds the rows after it. The pulse reads the whole
// tree off the loop every ten seconds and puts its exact figure back (a row deleted, a price that
// changed), so a drift is never longer than that.
type Sum = { from: number; last: number; usd: number; none: number };
const sums = new Map<string, Sum>();

export function treeSpend(root: string, from: number): { spent: number; none: number } {
  if (!hasLedger()) return { spent: 0, none: 0 };
  const have = sums.get(root);
  if (!have || have.from !== from) {
    const r = spentSince([root], from);
    sums.set(root, { from, last: r.top, usd: r.spent, none: r.none });
    return { spent: r.spent, none: r.none };
  }
  const own = JSON.stringify([root]);
  const d = D().store.db.query<{ spent: number; np: number; top: number }, [string, number, number]>(DELTA_SQL).get(own, have.last, from);
  if (!d || d.top <= have.last) return { spent: have.usd, none: have.none };
  let add = d.spent, none = 0;
  if (d.np) {
    const np = listedCost(D().store.db.query<UnpricedRow, [string, number, number, number]>(UNPRICED_DELTA_SQL).all(own, have.last, d.top, from));
    add += np.usd;
    none = np.none;
  }
  have.usd += add; have.none += none; have.last = d.top;
  return { spent: have.usd, none: have.none };
}

// The pulse's exact figure for a top session, put back when it is not behind the sum.
function settle(root: string, from: number, spent: number, top: number, none: number) {
  const have = sums.get(root);
  if (!have || have.from !== from || top >= have.last) sums.set(root, { from, last: top, usd: spent, none });
}

// --- who was told ---------------------------------------------------------------

const told = new Map<string, { usd: number; from: number }>();
// (The table is made at the daemon's start; a store that never ran it is given it at the first read.)
const made = new WeakSet<object>();
function toldOf(owner: string) {
  if (!made.has(D().store)) { migrate(); made.add(D().store); }
  if (!told.has(owner)) {
    const r = D().store.db.query<{ usd: number; from_ms: number }, [string]>("SELECT usd, from_ms FROM cap_told WHERE owner = ?").get(owner);
    told.set(owner, r ? { usd: r.usd, from: r.from_ms } : { usd: 0, from: 0 });
  }
  return told.get(owner)!;
}

const toldAt = (owner: string, cap: { usd: number; from: number }) => { const k = toldOf(owner); return k.usd === cap.usd && k.from === cap.from; };
const markTold = (owner: string, cap: { usd: number; from: number }) => {
  toldOf(owner);
  told.set(owner, { usd: cap.usd, from: cap.from });
  D().store.db.query("INSERT INTO cap_told (owner, usd, from_ms) VALUES (?, ?, ?) ON CONFLICT(owner) DO UPDATE SET usd = excluded.usd, from_ms = excluded.from_ms").run(owner, cap.usd, cap.from);
};
const warnPending = (owner: string, cap: { usd: number; from: number }) => !toldAt(owner, cap);

// The 80 percent, told once for this cap (a raised cap is told again at its own 80): into the failures
// notice of the owner's own session (a top session), or of the agent's parent (an agent).
export function warnOnce(scope: Scope, view: CapView) {
  try {
    if (!warnDue(view, toldOf(scope.owner), scope)) return;
    markTold(scope.owner, scope);
    // A cap that is already reached is told as the 80 percent it passed on the way: said as it stands.
    const to = scope.parent ?? scope.id;
    failures.record(to, { kind: "budget", cls: WARN_CLS, message: warnMessage(view), ...(scope.kind === "agent" ? { ref: { id: scope.owner, label: scope.title } } : {}), tell: "ride" }, scope.id);
  } catch (e) {
    capture(e, { at: "cap warning" });
  }
}

// --- the scopes -----------------------------------------------------------------

type AgentRow = { id: string; session_id: string; parent_id: string; title: string; budget: string; task_at: number | null; created: number; lost: string | null };
const AGENTS = "SELECT id, session_id, parent_id, title, budget, task_at, created, lost FROM agents WHERE status IN ('running', 'waiting') AND json_extract(budget, '$.usd') IS NOT NULL";
const TOPS = "SELECT id FROM sessions WHERE archived = 0 AND parent_id IS NULL AND json_extract(settings, '$.cap_usd') IS NOT NULL";

// The top sessions that carry a cap, known from one look at the table and kept: set and cleared
// through here, and looked at again each minute (a forked session carries its source's settings).
let tops: Set<string> | undefined;
let toppedAt = 0;
const TOPS_EVERY = 60_000;
function topIds(now: number): Set<string> {
  if (!tops || now - toppedAt >= TOPS_EVERY) {
    tops = new Set(D().store.db.query<{ id: string }, []>(TOPS).all().map((r) => r.id));
    toppedAt = now;
  }
  return tops;
}

export function scopes(now = Date.now()): Scope[] {
  const { store } = D();
  const out: Scope[] = [];
  for (const id of topIds(now)) {
    const s = store.session(id);
    const cap = capOf(s);
    if (s && cap) out.push({ id, kind: "session", owner: id, usd: cap.usd, from: cap.from, sessions: [id], parent: null, title: s.title || "Session" });
  }
  // (No agents table: a store the automation never opened.)
  let rows: AgentRow[] = [];
  try { rows = store.db.query<AgentRow, []>(AGENTS).all(); } catch { /* none */ }
  for (const a of rows) {
    const usd = (JSON.parse(a.budget) as { usd?: number }).usd;
    if (!usd) continue;
    const lost = a.lost ? (JSON.parse(a.lost) as { session: string }[]).map((l) => l.session) : [];
    out.push({ id: a.session_id, kind: "agent", owner: a.id, usd, from: a.task_at ?? a.created, sessions: [a.session_id, ...lost], parent: a.parent_id, title: a.title });
  }
  return out;
}

// --- the gate -------------------------------------------------------------------

// The cap above a session: its own when it is a top session, its tree's root's when it is an agent.
// Nothing when none is set (the usual case: no read at all).
function atRoot(root: string): { s: Session; cap: { usd: number; from: number } } | undefined {
  const s = D().store.session(root);
  const cap = capOf(s);
  return s && cap ? { s, cap } : undefined;
}
const rootScope = (s: Session, cap: { usd: number; from: number }): Scope => ({ id: s.id, kind: "session", owner: s.id, usd: cap.usd, from: cap.from, sessions: [s.id], parent: null, title: s.title || "Session" });

// What the gate decides before a model step of a session under `root`'s cap (a top session's):
//   a closing step (the session's own, or the session above an agent's), carrying the cap's words;
//   a note, when the owner's own message runs the turn past the cap (the owner chose to spend);
//   nothing, while there is room or no cap.
// The spend is the running sum (treeSpend): a read of the rows since the last one. The 80 percent is
// told once, reading the rate whole only then.
export function closing(root: string, agent: boolean, byOwner: () => boolean = () => false): { text: string; cap: true; note?: boolean } | undefined {
  const at = atRoot(root);
  if (!at) return undefined;
  const { spent } = treeSpend(root, at.cap.from);
  if (spent >= at.cap.usd * WARN_AT && warnPending(root, at.cap)) {
    const now = Date.now();
    const { recent } = spentSince([root], at.cap.from, now);
    warnOnce(rootScope(at.s, at.cap), capView({ ...at.cap, spent, recent, now }));
  }
  if (spent < at.cap.usd) return undefined;
  // Only a top session's turn runs on at the owner's word. An agent's task carries that word when its
  // parent's turn did (it lets a merge through), and must not take the cap's spend with it: an agent stops.
  if (!agent && byOwner()) return { text: capOwnerNote(at.cap.usd, spent), cap: true, note: true };
  return { text: capClosing(at.cap.usd, spent, agent ? at.s.title || "Session" : undefined), cap: true };
}

// Why a new agent may not start under the root: its cap is reached.
export function refusal(root: string): string | undefined {
  const at = atRoot(root);
  if (!at) return undefined;
  const { spent } = treeSpend(root, at.cap.from);
  return spent >= at.cap.usd ? `CAP: the dollar cap of this session (${dollars(at.cap.usd)}) is reached, with ${dollars(spent)} spent: no agent starts until the owner raises it.` : undefined;
}

// A top session whose reached cap holds what is not the owner's own words: a loop run, a timer wake, an
// agent's report, a goal's check, a message from another session wait for a raise (one closing step each, and a "Cap reached" alert each
// time, was what letting them run cost). Said once for the cap, to the owner. Only a session at the top of
// its tree holds: an agent's own inputs go on, and its next step is its report.
export function held(sessionId: string): boolean {
  const s = D().store.session(sessionId);
  if (!s || s.parent_id) return false;
  const cap = capOf(s);
  if (!cap) return false;
  const { spent } = treeSpend(sessionId, cap.from);
  if (spent < cap.usd) return false;
  const key = `hold:${sessionId}`;
  if (!toldAt(key, cap)) {
    markTold(key, cap);
    try {
      failures.record(sessionId, { kind: "budget", cls: HELD_CLS, message: capHeldMessage(cap.usd, spent), tell: "ride" }, sessionId);
      alerts.capReached(sessionId, capHeldMessage(cap.usd, spent));
    } catch (e) { capture(e, { at: "cap held" }); }
  }
  return true;
}

// What an agent's own dollar budget says as the gate reads it: the 80 percent, told once.
export function observeAgent(a: { id: string; session_id: string; parent_id: string; title: string; created: number; task_at?: number | null; lost?: { session: string }[] | null }, usd: number, spent: number) {
  const from = a.task_at ?? a.created;
  const now = Date.now();
  const view = capView({ usd, spent, recent: 0, from, now });
  if (view.level === "ok" || !warnDue(view, toldOf(a.id), { usd, from })) return;
  // The rate is read only when the notice is due: once for a budget.
  const sessions = [a.session_id, ...(a.lost ?? []).map((l) => l.session)];
  const { recent } = spentSince(sessions, from, now);
  warnOnce({ id: a.session_id, kind: "agent", owner: a.id, usd, from, sessions, parent: a.parent_id, title: a.title }, capView({ usd, spent, recent, from, now }));
}

// --- the pulse and the page -----------------------------------------------------

const rows = new Map<string, CapRow>();
let printed = "";
let busy = false;
let lastAt = 0;
export const EVERY_MS = 10_000;

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
const printOf = (list: CapRow[]) => list.map((r) => `${r.id}:${r.level}:${r.usd}:${round(r.spent, 4)}:${round(r.burn_hour, 3)}:${r.unpriced}`).join("|");

// Every cap's figures, read off the loop: one statement a cap.
export async function measure(now = Date.now()): Promise<CapRow[]> {
  const list = scopes(now);
  const reads = readsOf(D().store);
  const got = await Promise.all(list.map(async (sc) => {
    const own = JSON.stringify(sc.sessions);
    const [r] = await reads.sql<{ spent: number; recent: number; np: number; top: number }>(SPEND_SQL, [own, sc.from, now - BURN_WINDOW_MS]);
    const np = r?.np ? listedCost(await reads.sql<UnpricedRow>(UNPRICED_SQL, [own, sc.from, r.top])) : { usd: 0, none: 0 };
    const spent = (r?.spent ?? 0) + np.usd;
    // A top session's gate goes on from this exact figure.
    if (sc.kind === "session" && r) settle(sc.id, sc.from, spent, r.top, np.none);
    const view = capView({ usd: sc.usd, spent, recent: r?.recent ?? 0, from: sc.from, now });
    return { scope: sc, row: { ...view, id: sc.id, kind: sc.kind, from: sc.from, at: now, unpriced: np.none } satisfies CapRow };
  }));
  for (const { scope, row } of got) if (row.level !== "ok") warnOnce(scope, row);
  return got.map((g) => g.row);
}

export const current = (): CapRow[] => [...rows.values()];

// A read, and a frame when what a page shows changed.
export async function refresh(now = Date.now()): Promise<CapRow[]> {
  const list = await measure(now);
  rows.clear();
  for (const r of list) rows.set(r.id, r);
  // A top session whose cap has room again (raised, or cleared) goes on with what waited for it.
  for (const r of list) if (r.kind === "session" && r.level !== "spent") released(r.id);
  const print = printOf(list);
  if (print !== printed) {
    printed = print;
    D().bus.emit({ t: "feature", name: "caps", data: { caps: list } });
  }
  return list;
}

// Called by the automation's pulse: a read every ten seconds while any cap is set.
export function pulse(now = Date.now()) {
  if (busy || now - lastAt < EVERY_MS) return;
  if (!printed && !scopes(now).length) { lastAt = now; return; }
  busy = true;
  lastAt = now;
  refresh(now).catch((e) => capture(e, { at: "caps" })).finally(() => { busy = false; });
}

// What waited for a top session's cap goes: the inputs the automation holds, and the messages of other
// sessions that wait in the session's queue.
function released(id: string) {
  if (hasPending(id)) flush(id);
  D().engine.queueReleased?.(id);
}

// A cap set, changed or cleared now: the set of capped top sessions and the pages' figures follow at once.
export function changed(id: string, capped: boolean) {
  (tops ??= new Set()).add(id);
  if (!capped) { tops.delete(id); sums.delete(id); }
  lastAt = 0;
  return refresh().then((r) => { if (!capped) released(id); return r; }).catch((e) => capture(e, { at: "caps" }));
}

// The cap one press raises: its own size more, and past what is spent.
export async function raised(id: string): Promise<number | undefined> {
  const r = (await refresh()).find((x) => x.id === id);
  return r ? raisedCap(r.usd, r.spent) : undefined;
}

capGate.held = held;
export const reset = () => { sums.clear(); rows.clear(); printed = ""; told.clear(); tops = undefined; lastAt = 0; busy = false; };
