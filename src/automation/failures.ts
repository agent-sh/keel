import { keyShaped } from "../core/conceal.ts";
import { errorClass } from "../admin/classes.ts";
import type { Store } from "../core/store.ts";
import type { Session, ToolResultBlock } from "../core/types.ts";
import type { TurnHooks } from "../engine/hooks.ts";
import { errorText } from "../engine/retry.ts";
import { dur } from "../admin/timeline-rows.ts";
import { D, capture, clip, deliver, isPending, parkedOn, rider, stillRunning, type Pending, heldWhy } from "./core.ts";
import { cutTurn } from "./waits.ts";
import { acked, add, classOf, cleared, fingerprintOf, merged, render, room, settledBy, split, SELF, type Failure, type FailureGroup, type FailureKind, type Known, type Told } from "./failure-groups.ts";

// A session's own account of what went wrong in its scope, kept so nobody has
// to ask: every failure of its turns, of its agents and their tools, and of
// its waits and loops lands in one table, grouped by cause (failure-groups.ts).
// What the session's model has not been given yet goes to it as one harness
// input, built from the table with no model call: N failures of one cause are
// one entry with a count, and under it who failed, each agent with its own
// count and its own latest failure. An agent that failed with no words of its own is told
// here instead of in a report of its own. A failure outside the session's turn
// that stands in for a report starts a turn, like the report would have; the
// rest goes with the next harness input and never starts one. Only what a
// notice can name is owed: a silent agent's failures, a tool failure no agent
// repeated and an agent past the ids a cause keeps are counted, not told (a
// tool failure of the agents past them is told once they repeat it together).
// What is owed is in the table, so a restart delivers it, once. The same rows
// are the owner's record (GET /api/errors?session=).

const SCHEMA = `CREATE TABLE IF NOT EXISTS session_failures (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  fp TEXT NOT NULL,
  kind TEXT NOT NULL,
  cls TEXT NOT NULL,
  sample TEXT NOT NULL,
  count INTEGER NOT NULL,
  owed INTEGER NOT NULL DEFAULT 0,
  wake INTEGER NOT NULL DEFAULT 0,
  told INTEGER NOT NULL DEFAULT 0,
  first_ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  refs TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (session_id, fp)
);
CREATE INDEX IF NOT EXISTS session_failures_owed ON session_failures(owed) WHERE owed > 0;`;

// As many causes as the errors list shows; the oldest with nothing owed go first.
const KEEP = 200;
const CLASS_CHARS = 60;

type Row = Omit<FailureGroup, "wake" | "refs"> & { session_id: string; wake: number; refs: string };
const toGroup = ({ session_id: _s, ...r }: Row): FailureGroup => ({ ...r, wake: !!r.wake, refs: JSON.parse(r.refs) });

export const migrate = () => D().store.migrate(SCHEMA);

// A session's groups, the newest first. Reads the store it is given: the errors route has no automation deps.
export function groupsOf(store: Pick<Store, "db">, sessionId: string): FailureGroup[] {
  return store.db.query<Row, [string, number]>("SELECT * FROM session_failures WHERE session_id = ? ORDER BY last_ts DESC LIMIT ?").all(sessionId, KEEP).map(toGroup);
}

// The record the owner reads: a session's groups, or for an agent's session the
// groups of its parent that name it; then the groups of every agent below it
// that started agents of its own, each marked with that agent (`under`): an
// agent's failures are told to the agent that started it, and the session
// above sees its whole tree.
export type RecordGroup = FailureGroup & { under?: { id: string; label: string } };
const BELOW = "WITH RECURSIVE t(s) AS (SELECT session_id FROM agents WHERE parent_id = ?1 UNION SELECT a.session_id FROM agents a JOIN t ON a.parent_id = t.s) SELECT id, session_id, title FROM agents WHERE session_id IN (SELECT s FROM t) ORDER BY created";
export function recordOf(store: Pick<Store, "db" | "session">, sessionId: string): RecordGroup[] {
  const s = store.session(sessionId);
  // (No agents table: a store the automation never opened.)
  const read = <T,>(f: () => T, none: T): T => { try { return f(); } catch { return none; } };
  const deeper = read(() => store.db.query<{ id: string; session_id: string; title: string }, [string]>(BELOW).all(sessionId), [])
    .flatMap((a) => groupsOf(store, a.session_id).map((g) => ({ ...g, under: { id: a.id, label: a.title } })));
  if (!s?.parent_id) return [...groupsOf(store, sessionId), ...deeper];
  const me = read(() => store.db.query<{ id: string }, [string]>("SELECT id FROM agents WHERE session_id = ?").get(sessionId)?.id, undefined);
  const mine = groupsOf(store, s.parent_id).filter((g) => g.refs.some((r) => r.id === me));
  // An agent's own table holds the failures of the agents it started: they are below it.
  const its = groupsOf(store, sessionId).map((g) => ({ ...g, under: { id: me ?? sessionId.slice(-12), label: s.title } }));
  return [...mine, ...its, ...deeper];
}

function save(sessionId: string, g: FailureGroup) {
  D().store.db.query(`INSERT INTO session_failures (session_id, fp, kind, cls, sample, count, owed, wake, told, first_ts, last_ts, refs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, fp) DO UPDATE SET count = excluded.count, owed = excluded.owed, wake = excluded.wake, told = excluded.told, last_ts = excluded.last_ts, refs = excluded.refs`)
    .run(sessionId, g.fp, g.kind, g.cls, g.sample, g.count, g.owed, g.wake ? 1 : 0, g.told, g.first_ts, g.last_ts, JSON.stringify(g.refs));
}
const one = (sessionId: string, fp: string) => {
  const r = D().store.db.query<Row, [string, string]>("SELECT * FROM session_failures WHERE session_id = ? AND fp = ?").get(sessionId, fp);
  return r ? toGroup(r) : undefined;
};
// Every group with something owed, however old (the owner's list reads the newest KEEP).
const owedOf = (sessionId: string, kind?: FailureKind) =>
  D().store.db.query<Row, any[]>(`SELECT * FROM session_failures WHERE session_id = ? AND owed > 0${kind ? " AND kind = ?" : ""}`).all(...(kind ? [sessionId, kind] : [sessionId])).map(toGroup);

// One failure in the scope of `sessionId`. Kept like an error: a secret in its
// text is its placeholder, redacted as the session it happened in (`from`), so
// a failure never shown to the scope's session does not make it a holder of
// the secret. False when it could not be written, or when it asked for a turn
// (tell "wake") and the group cannot name it: its caller then tells it itself.
export function record(sessionId: string, f: Failure, from = sessionId): boolean {
  try {
    const { store } = D();
    if (!store.session(sessionId)) return false;
    // The known secrets as their placeholders, then anything else shaped like a key: before the sample is made.
    const clean = (s: string) => keyShaped(String(store.redact(from, "error", s)));
    const safe: Failure = { ...f, cls: clip(clean(f.cls), CLASS_CHARS), message: clean(f.message), ref: f.ref && { ...f.ref, label: f.ref.label && clean(f.ref.label) } };
    const had = one(sessionId, fingerprintOf(safe.kind, safe.cls, safe.message));
    const named = safe.tell !== "wake" || room(had, safe.ref?.id ?? SELF);
    save(sessionId, add(had, named ? safe : { ...safe, tell: undefined }, Date.now()));
    // The row is written: a prune that fails does not change what the caller is told.
    if (!had) prune(sessionId);
    return named;
  } catch (e) {
    capture(e, { at: "failures", session: sessionId });
    return false;
  }
}

// What `from` keeps of its agents' failures goes to `to`, a cause both keep made one: the agents moved there (a
// lost context's successor takes its working agents). Its own failures (the ref SELF) stay: they are what it lost
// its context to, and the successor was told that in its brief. In the caller's transaction, so nothing owed stays
// where no one reads it, and a start does not wake the session that lost its context for it (recover).
export function moveTo(from: string, to: string) {
  const { db } = D().store;
  for (const r of db.query<Row, [string]>("SELECT * FROM session_failures WHERE session_id = ?").all(from)) {
    const g = toGroup(r);
    const { taken, kept } = split(g, (x) => x.id !== SELF);
    if (!taken) continue;
    const had = one(to, g.fp);
    save(to, had ? merged(had, taken) : taken);
    if (kept) save(from, kept);
    else db.query("DELETE FROM session_failures WHERE session_id = ? AND fp = ?").run(from, g.fp);
  }
}

function prune(sessionId: string) {
  try {
    D().store.db.query("DELETE FROM session_failures WHERE session_id = ?1 AND owed = 0 AND fp NOT IN (SELECT fp FROM session_failures WHERE session_id = ?1 ORDER BY last_ts DESC LIMIT ?2)").run(sessionId, KEEP);
  } catch (e) {
    capture(e, { at: "failures prune", session: sessionId });
  }
}

// The session a failure in `s` is accounted to, and where in it: an agent's
// failures are its parent's, under the agent's id. `told`: its results reach
// the parent's conversation (a silent agent's never do: a reviewer, a verifier).
function scope(s: Pick<Session, "id" | "parent_id">): { root: string; ref: { id: string; label?: string }; told: boolean } {
  if (!s.parent_id) return { root: s.id, ref: { id: SELF }, told: false };
  const a = D().store.db.query<{ id: string; title: string; def: string | null }, [string]>("SELECT id, title, def FROM agents WHERE session_id = ?").get(s.id);
  return { root: s.parent_id, ref: { id: a?.id ?? s.id.slice(-12), label: a?.title }, told: !!a && !(a.def && JSON.parse(a.def).silent) };
}

const textOf = (r: ToolResultBlock) => (typeof r.content === "string" ? r.content : (r.content as any[]).map((b) => b?.text ?? "").join("\n"));

// Failed tool calls and failed model requests, as they happen. A session has
// its own tool results, so only an agent's are owed to its parent, once the
// agent repeated one (failure-groups.ts); a failed request is recorded only (a
// retry may pass, and one that ends the turn is told as the turn's or the
// agent's failure).
export const hooks: TurnHooks = {
  toolRan: (s, call, result, ran) => {
    if (ran.outcome !== "error") return;
    const at = scope(s);
    record(at.root, { kind: "tool", cls: call.tool.name, message: textOf(result), ref: at.ref, tell: at.told ? "ride" : undefined }, s.id);
  },
  requestFailed: (s, _req, err, aborted) => {
    const cls = aborted ? null : errorClass(err);
    if (!cls) return;
    const at = scope(s);
    record(at.root, { kind: "provider", cls, message: errorText(err), ref: at.ref }, s.id);
  },
  // An agent whose model has said it is overloaded for as long as the counted retries: its turn
  // goes on trying and holds its slot, so the session that started it is told once (it can stop
  // the agent, or start the work on another model). A session of the owner's says it on its row.
  capacityWaiting: (s, model, ms) => {
    if (!s.parent_id) return;
    const at = scope(s);
    if (!at.told) return;
    const message = `waited ${dur(ms)} for ${model}, which answers that it is overloaded; it keeps trying until the model has room. Stop it, or give the work to an agent on another model, if it should not wait.`;
    if (record(at.root, { kind: "provider", cls: "overloaded", message, ref: at.ref, tell: "wake" }, s.id)) wake(at.root);
  },
};

// A turn of a session of its own ended on an error: its model never saw why,
// so the next input says it. (An agent's is told to its parent when the agent
// settles.) Once a later turn got through, it no longer matters and is not told.
export function onTurnEnd(sessionId: string, reason: string) {
  const { store } = D();
  if (reason !== "error") {
    if (reason === "restart") return;
    for (const g of owedOf(sessionId, "turn")) save(sessionId, cleared(g));
    return;
  }
  if (store.session(sessionId)?.parent_id) return;
  const row = store.db.query<{ data: string }, [string]>("SELECT data FROM events WHERE session_id = ? AND kind = 'error' ORDER BY seq DESC LIMIT 1").get(sessionId);
  const message = row ? String(JSON.parse(row.data).message ?? "") : "";
  if (message) record(sessionId, { kind: "turn", cls: classOf(message), message, tell: "ride" });
}

// A failure the session is told by other means (a wait's own wake, a loop's
// failed run): counted for the record only.
export function seen(sessionId: string, kind: FailureKind, cls: string, message: string) {
  const s = D().store.session(sessionId);
  if (!s) return;
  const at = scope(s);
  record(at.root, { kind, cls, message, ref: at.ref }, sessionId);
}

// An agent ended as failed. `standsIn`: it wrote nothing of its own, so the
// grouped notice can be its report (`report`: that report's id); otherwise its
// own report (or the blocking call's result) carries the failure and this only
// counts it. True when the notice does stand in for its report: the failure
// is written and names it.
export function agentFailed(a: { id: string; parent_id: string; session_id: string; title: string; report: string }, cls: string, message: string, standsIn: boolean): boolean {
  return record(a.parent_id, { kind: "agent", cls, message, ref: { id: a.id, label: a.title, report: a.report }, tell: standsIn ? "wake" : undefined }, a.session_id) && standsIn;
}

// A sentence that goes with the session's next notice (a timer cancelled now
// that the last agent is in). Not kept over a restart.
const notes = new Map<string, string>();

// What a notice says of an agent beyond what its cause keeps, read when the
// notice is made: whether its session is still there (a deleted one has no
// timeline to point at) and the machine its tools run on when not this one.
function knownOf(sessionId: string): Known {
  const { store } = D();
  type AgentRow = { id: string; session_id: string; machine: string | null };
  const rows = new Map<string, AgentRow | null>(); // each read once, and only when a notice names it
  return (id) => {
    // By id: a notice names agents of the session's tree that it did not start (a peer it messaged).
    if (!rows.has(id)) rows.set(id, store.db.query<AgentRow, [string]>("SELECT id, session_id, machine FROM agents WHERE id = ?").get(id) ?? null);
    const a = rows.get(id);
    if (!a || !store.session(a.session_id)) return { gone: true };
    return a.machine ? { where: machineName(a.machine) } : undefined;
  };
}
// The fleet's name for a machine (its table is the fleet's: absent in a store the fleet never opened).
function machineName(id: string): string {
  try {
    return D().store.db.query<{ name: string }, [string]>("SELECT name FROM fleet_machines WHERE id = ?").get(id)?.name ?? id;
  } catch {
    return id;
  }
}

const AGENTS_LEFT = "SELECT COUNT(*) AS n FROM agents WHERE parent_id = ? AND status IN ('running', 'waiting') AND type != 'reviewer'";

// The notice for what the session is owed now, read from the table when it is
// sent: whatever happened until then is in it, each cause once. `parts`: the
// meta of what goes in the same input. An agent's report there is the account
// of its work, so its repeated tool failure gets no line, and a report says
// how many agents still run, so the notice does not say it again.
function notice(sessionId: string, parts: Record<string, unknown>[] = []): Pending | undefined {
  const { store } = D();
  const reports = parts.filter((p) => p.kind === "subagent");
  const r = render(owedOf(sessionId), Date.now(), new Set(reports.map((p) => String(p.agent_id))), knownOf(sessionId), sessionId);
  if (!r) return undefined;
  if (r.text === null) return void settle(sessionId, r.told); // all of it is in the reports going now
  let tail = "";
  if (r.agents) {
    const left = store.db.query<{ n: number }, [string]>(AGENTS_LEFT).get(sessionId)!.n;
    if (!left) tail = notes.get(sessionId) ?? "";
    else if (!reports.length) tail = stillRunning(left, heldWhy(sessionId), parkedOn(sessionId));
  }
  return {
    text: r.text + tail,
    meta: { kind: "failures", groups: r.told },
    onSent: () => {
      notes.delete(sessionId);
      settle(sessionId, r.told);
      wake(sessionId); // causes over a notice's bound go with the next one
    },
  };
}

function settle(sessionId: string, told: Pick<Told, "fp" | "count" | "refs">[]) {
  for (const t of told) {
    const g = one(sessionId, t.fp);
    if (g) save(sessionId, settledBy(g, t));
  }
}

// The notice as it goes when its time comes, or nothing: a session held after
// the owner's Stop starts no turn for it (it goes after the owner's next turn),
// and one with no failure worth a turn left (a wait returned it) has none.
function live(sessionId: string, parts?: Record<string, unknown>[]): Pending | undefined {
  if (D().engine.isHeld(sessionId)) return undefined;
  if (owedWake(sessionId)) return notice(sessionId, parts);
  notes.delete(sessionId);
  return undefined;
}

// What is owed and worth a turn goes out: one input, however many failures.
// Called when such a failure lands, after every turn of the session and at a
// start (`boot`: a session whose cut turn the engine is about to continue gets
// it when that turn ends, not ahead of it, like a wait's wake; that covers the
// notice sent from recover() only: one an agent settled at the start owes, like
// its report, goes on the usual timer).
export function wake(sessionId: string, note?: string, boot = false) {
  if (note) notes.set(sessionId, note);
  if (isPending(sessionId, (m) => m.kind === "failures")) return; // on its way: it is read again when sent
  const first = live(sessionId);
  if (first) deliver(sessionId, first.text, first.meta, { ...(boot && cutTurn(sessionId) ? { hold: true } : { coalesceMs: 300 }), refresh: (parts) => live(sessionId, parts) });
}

// Whether a failure that stands in for a report is still to be told (asked on every tick of a command that stays).
export const owedWake = (sessionId: string) => !!D().store.db.query("SELECT 1 FROM session_failures WHERE session_id = ? AND owed > 0 AND wake = 1 LIMIT 1").get(sessionId);

// The session got these reports in a stored wait_agent result: a failure that
// stood in for one of them is told. By report, not by agent: the failure of an
// earlier task stays owed when the wait returned a later task's report.
export function ackReports(sessionId: string, reportIds: string[]) {
  const ids = new Set(reportIds);
  for (const g of owedOf(sessionId, "agent")) {
    const next = acked(g, ids);
    if (next !== g) save(sessionId, next);
  }
  if (!owedWake(sessionId)) notes.delete(sessionId);
}

// After a start: a notice stored just before the stop settles what it told
// (its send and its settling are two writes; a failure that landed between
// them stays owed), then what is still owed goes. Every owed row is one a
// notice would tell, so only sessions with something to tell are looked at,
// and an archived one gets its notice when it is restored. A stop can fall
// between the two writes only right after the send, so the notice it left
// unsettled is the session's newest input: that one row is read, not the history.
export function recover() {
  const { store } = D();
  const owing = store.db.query<{ session_id: string }, []>("SELECT DISTINCT f.session_id FROM session_failures f JOIN sessions s ON s.id = f.session_id WHERE f.owed > 0 AND s.archived = 0").all();
  for (const { session_id } of owing) {
    const last = store.db.query<{ data: string }, [string]>("SELECT data FROM events WHERE session_id = ? AND kind = 'user' ORDER BY seq DESC LIMIT 1").get(session_id);
    const data = last ? JSON.parse(last.data) : undefined;
    for (const part of (data?.parts ?? (data ? [data] : [])) as any[]) {
      if (part?.kind !== "failures") continue;
      const unsettled = ((part.groups ?? []) as Told[]).filter((t) => (one(session_id, t.fp)?.told ?? Infinity) < t.count);
      settle(session_id, unsettled.map((t) => ({ ...t, refs: t.refs ?? {} })));
    }
    wake(session_id, undefined, true);
  }
}

// With any other input of the session: what is owed goes along, at no turn of its own.
export function init() {
  rider.get = (sessionId, parts) => (parts.some((p) => p.kind === "failures") ? undefined : notice(sessionId, parts));
}
