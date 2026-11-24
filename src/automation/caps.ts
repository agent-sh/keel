import { readsOf } from "../server/reads.ts";
import type { Session } from "../core/types.ts";
import { capClosing, capView, dollars, warnDue, warnMessage, WARN_CLS, BURN_WINDOW_MS, raisedCap, type CapRow, type CapView } from "./cap-rules.ts";
import { capture, D } from "./core.ts";
import * as failures from "./failures.ts";

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

export const SPEND_SQL = "WITH RECURSIVE t(s) AS (SELECT value FROM json_each(?1) UNION SELECT g.id FROM sessions g JOIN t ON g.parent_id = t.s) SELECT COALESCE(SUM(c.cost), 0) AS spent, COALESCE(SUM(CASE WHEN c.ts >= ?3 THEN c.cost END), 0) AS recent FROM t CROSS JOIN telemetry_calls c ON c.session_id = t.s WHERE c.ts >= ?2";

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

// The tree's spend since `from` and in the last ten minutes (the gate's read, on the loop).
export function spentSince(sessions: string[], from: number, now = Date.now()): { spent: number; recent: number } {
  const ledger = D().store.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'telemetry_calls'").get();
  if (!ledger) return { spent: 0, recent: 0 };
  return D().store.db.query<{ spent: number; recent: number }, [string, number, number]>(SPEND_SQL).get(JSON.stringify(sessions), from, now - BURN_WINDOW_MS) ?? { spent: 0, recent: 0 };
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

// The 80 percent, told once for this cap (a raised cap is told again at its own 80): into the failures
// notice of the owner's own session (a top session), or of the agent's parent (an agent).
export function warnOnce(scope: Scope, view: CapView) {
  try {
    if (!warnDue(view, toldOf(scope.owner), scope)) return;
    told.set(scope.owner, { usd: scope.usd, from: scope.from });
    D().store.db.query("INSERT INTO cap_told (owner, usd, from_ms) VALUES (?, ?, ?) ON CONFLICT(owner) DO UPDATE SET usd = excluded.usd, from_ms = excluded.from_ms").run(scope.owner, scope.usd, scope.from);
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

// The harness's words for the last step of a session at the cap of its root; nothing while there is room.
// `above`: the session is an agent's, so the cap is the one of the session above it.
export function closing(root: string, agent: boolean): string | undefined {
  const at = atRoot(root);
  if (!at) return undefined;
  const now = Date.now();
  const { spent, recent } = spentSince([root], at.cap.from, now);
  const view = capView({ ...at.cap, spent, recent, now });
  if (view.level !== "ok") warnOnce(rootScope(at.s, at.cap), view);
  return spent >= at.cap.usd ? capClosing(at.cap.usd, spent, agent ? at.s.title || "Session" : undefined) : undefined;
}

// Why a new agent may not start under the root: its cap is reached.
export function refusal(root: string): string | undefined {
  const at = atRoot(root);
  if (!at) return undefined;
  const { spent } = spentSince([root], at.cap.from);
  return spent >= at.cap.usd ? `CAP: the dollar cap of this session (${dollars(at.cap.usd)}) is reached, with ${dollars(spent)} spent: no agent starts until the owner raises it.` : undefined;
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
const printOf = (list: CapRow[]) => list.map((r) => `${r.id}:${r.level}:${r.usd}:${round(r.spent, 4)}:${round(r.burn_hour, 3)}`).join("|");

// Every cap's figures, read off the loop: one statement a cap.
export async function measure(now = Date.now()): Promise<CapRow[]> {
  const list = scopes(now);
  const reads = readsOf(D().store);
  const got = await Promise.all(list.map(async (sc) => {
    const [r] = await reads.sql<{ spent: number; recent: number }>(SPEND_SQL, [JSON.stringify(sc.sessions), sc.from, now - BURN_WINDOW_MS]);
    const view = capView({ usd: sc.usd, spent: r?.spent ?? 0, recent: r?.recent ?? 0, from: sc.from, now });
    return { scope: sc, row: { ...view, id: sc.id, kind: sc.kind, from: sc.from, at: now } satisfies CapRow };
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

// A cap set, changed or cleared now: the set of capped top sessions and the pages' figures follow at once.
export function changed(id: string, capped: boolean) {
  (tops ??= new Set()).add(id);
  if (!capped) tops.delete(id);
  lastAt = 0;
  return refresh().catch((e) => capture(e, { at: "caps" }));
}

// The cap one press raises: its own size more, and past what is spent.
export async function raised(id: string): Promise<number | undefined> {
  const r = (await refresh()).find((x) => x.id === id);
  return r ? raisedCap(r.usd, r.spent) : undefined;
}

export const reset = () => { rows.clear(); printed = ""; told.clear(); tops = undefined; lastAt = 0; busy = false; };
