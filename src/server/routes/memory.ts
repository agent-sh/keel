// What memory holds and what it gave, for the owner: the facts a session was
// given (Keel's own record: names, hooks and calls, no text), the store's own
// search and one fact in full (read from the store when asked), a correction
// sent through the store's own command, and how well what is given is used.
// Every read over many rows runs on the read thread; a call of the store is a
// process of its own, bounded, and never holds the loop.
import type { Deps } from "../app.ts";
import * as activity from "../../automation/activity.ts";
import type { MemoryMeter } from "../../integrations/memory-meter.ts";
import { CORRECTION_MAX, isFactName, QUERY_MAX, type MemoryStore } from "../../integrations/memory-store.ts";
import { readsOf } from "../reads.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
const bad = (error: string, status = 400) => json({ error }, status);

// The store's own calls among the measured ones: what a session start, a
// prompt and a tool call asked (a block carried to a later step is no call).
const CALLS = "path IN ('store_start', 'store_prompt', 'store_brief', 'store_tool')";
const STORE = "path LIKE 'store_%'";
// The facts one report lists; past it the answer says how many there are.
const FACTS_SHOWN = 200;
// The given rows one request brings: a screen or two, the rest in further parts.
const GIVEN_PART = 40;
// Why a correction did not reach the store, without the store's own words
// (they can quote the correction, and this line is kept and sent to every page).
const WHY: Record<string, string> = {
  slow: "it did not answer in time", failed: "its command failed", absent: "it is not installed", expired: "the confirmation was used already or came too late",
};

export function memoryRoutes({ store }: Deps, mem: MemoryStore, meter: MemoryMeter): Record<string, any> {
  const reads = () => readsOf(store);
  // The session a request names: its folder scopes a search to its repository.
  const sessionOf = (id: string | null | undefined) => (id ? store.session(id) : undefined);

  return {
    // GET /api/memory/sessions?with=ID: the sessions memory was given to that
    // are still kept, the latest first. `with` names one more to list by its
    // title whether or not it was given anything; `gone` says it was deleted.
    "/api/memory/sessions": {
      GET: async (req: Request) => {
        const named = new URL(req.url).searchParams.get("with");
        const sessions = await reads().sql<{ session_id: string; title: string | null; last: number; facts: number }>(
          "SELECT g.session_id, s.title, MAX(g.ts) AS last, COUNT(*) AS facts FROM memory_given g JOIN sessions s ON s.id = g.session_id GROUP BY g.session_id ORDER BY last DESC LIMIT 50");
        const s = sessionOf(named);
        if (s && !sessions.some((x) => x.session_id === s.id)) sessions.unshift({ session_id: s.id, title: s.title, last: 0, facts: 0 });
        return json({ available: mem.available, sessions, gone: !!named && !s });
      },
    },
    // GET /api/memory/given?session_id=: each fact the store handed to the
    // session, newest first: when, by which hook, for which call, and whether
    // the turn named it afterwards (a rough signal). `used` is null for a row
    // not checked: `open` says its turn still runs; else its turn was cut.
    // A part at a time: `before` is the id of the oldest row held; `more`
    // says older ones follow. `blocks`, `block_tokens` and `facts` are the
    // session's sums as the other views count them (a block's tokens hold
    // its frame; a line with no name is a fact with no row here).
    "/api/memory/given": {
      GET: async (req: Request) => {
        const q = new URL(req.url).searchParams;
        const id = q.get("session_id") ?? "";
        if (!store.session(id)) return bad("no such session", 404);
        const before = q.get("before") ? Number(q.get("before")) : Number.MAX_SAFE_INTEGER;
        if (!Number.isFinite(before)) return bad("before is a row's id");
        const [rows, total, blocks] = await Promise.all([
          reads().sql<{ id: number; used: number | null }>(`SELECT id, ts, recall, path, hook, name, call, ref, tokens, used, rule, held FROM memory_given WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ${GIVEN_PART + 1}`, [id, before]),
          reads().sql<{ n: number; tokens: number; named: number; checked: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(used), 0) AS named, COALESCE(SUM(used IS NOT NULL), 0) AS checked FROM memory_given WHERE session_id = ?", [id]),
          reads().sql<{ blocks: number; tokens: number; facts: number }>(`SELECT COUNT(*) AS blocks, COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(facts), 0) AS facts FROM telemetry_memory WHERE session_id = ? AND outcome = 'added' AND ${STORE}`, [id]),
        ]);
        // Still to be checked: the rows the meter holds until their turn has ended and been read
        // (a moment after the turn's last event). After a restart it holds none: those were cut.
        const open = meter.openGiven(id);
        return json({
          available: mem.available, rows: rows.slice(0, GIVEN_PART).map((r) => ({ ...r, open: r.used === null && open.has(r.id) })), more: rows.length > GIVEN_PART,
          total: total[0]?.n ?? 0, tokens: total[0]?.tokens ?? 0, named: total[0]?.named ?? 0, checked: total[0]?.checked ?? 0,
          blocks: blocks[0]?.blocks ?? 0, block_tokens: blocks[0]?.tokens ?? 0, facts: blocks[0]?.facts ?? 0,
        });
      },
    },
    // GET /api/memory/efficiency?since_ms=&session_id=: per fact, how often it
    // was given and how often a turn named it afterwards, the never named
    // first (`total_facts` when there are more than the answer lists); the
    // tokens memory added per session and per day; and the share of the
    // store's calls that came late or with nothing.
    "/api/memory/efficiency": {
      GET: async (req: Request) => {
        const q = new URL(req.url).searchParams;
        const since = q.get("since_ms") ? Number(q.get("since_ms")) : 0;
        if (!Number.isFinite(since)) return bad("since_ms is not a number");
        const session = q.get("session_id") || null;
        if (session && !store.session(session)) return bad("no such session", 404);
        const where = (alias = "") => `${alias}ts >= ?${session ? ` AND ${alias}session_id = ?` : ""}`;
        const args = session ? [since, session] : [since];
        const r = reads();
        const [facts, count, kinds, sessions, days, calls] = await Promise.all([
          r.sql(`SELECT name, COUNT(*) AS given, COUNT(DISTINCT session_id) AS sessions, COALESCE(SUM(used IS NOT NULL), 0) AS checked, COALESCE(SUM(used), 0) AS used,
  MAX(rule) AS rule, COALESCE(SUM(held = 1), 0) AS followed, COALESCE(SUM(held = 0), 0) AS broken,
  COALESCE(SUM(tokens), 0) AS tokens, MAX(ts) AS last FROM memory_given WHERE ${where()} GROUP BY name
  ORDER BY (MAX(rule) = 0 AND COALESCE(SUM(used), 0) = 0 AND COALESCE(SUM(used IS NOT NULL), 0) > 0) DESC, given DESC, tokens DESC, name LIMIT ${FACTS_SHOWN}`, args),
          r.sql<{ n: number }>(`SELECT COUNT(DISTINCT name) AS n FROM memory_given WHERE ${where()}`, args),
          // Rules by what became of them (a row a fact was given in), notes by whether a turn named them.
          r.sql(`SELECT COUNT(DISTINCT CASE WHEN rule = 1 THEN name END) AS rules, COALESCE(SUM(rule = 1), 0) AS rule_rows, COALESCE(SUM(held = 1), 0) AS followed, COALESCE(SUM(held = 0), 0) AS broken,
  COALESCE(SUM(rule = 1 AND held IS NULL), 0) AS unjudged, COALESCE(SUM(rule = 0), 0) AS note_rows, COALESCE(SUM(rule = 0 AND used = 1), 0) AS used, COALESCE(SUM(rule = 0 AND used = 0), 0) AS unused,
  COUNT(DISTINCT CASE WHEN rule = 0 THEN name END) AS notes FROM memory_given WHERE ${where()}`, args),
          r.sql(`SELECT m.session_id, s.title, s.id IS NULL AS gone, COALESCE(SUM(m.tokens), 0) AS tokens, COUNT(*) AS recalls, COALESCE(SUM(m.facts), 0) AS facts, MAX(m.ts) AS last
  FROM telemetry_memory m LEFT JOIN sessions s ON s.id = m.session_id WHERE m.outcome = 'added' AND m.${STORE} AND ${where("m.")} GROUP BY m.session_id ORDER BY tokens DESC LIMIT 20`, args),
          r.sql(`SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') AS day, COALESCE(SUM(tokens), 0) AS tokens, COUNT(*) AS recalls, COUNT(DISTINCT session_id) AS sessions
  FROM telemetry_memory WHERE outcome = 'added' AND ${STORE} AND ${where()} GROUP BY day ORDER BY day DESC LIMIT 31`, args),
          r.sql<Record<"asked" | "added" | "empty" | "late" | "failed" | "repeat" | "tokens", number>>(`SELECT COALESCE(SUM(${CALLS} AND outcome != 'skipped'), 0) AS asked, COALESCE(SUM(${CALLS} AND outcome = 'added'), 0) AS added,
  COALESCE(SUM(${CALLS} AND outcome = 'empty'), 0) AS empty, COALESCE(SUM(${CALLS} AND outcome IN ('late', 'timeout')), 0) AS late, COALESCE(SUM(${CALLS} AND outcome = 'failure'), 0) AS failed,
  COALESCE(SUM(${CALLS} AND outcome = 'repeat'), 0) AS repeat, COALESCE(SUM(CASE WHEN outcome = 'added' THEN tokens ELSE 0 END), 0) AS tokens
  FROM telemetry_memory WHERE ${STORE} AND ${where()}`, args),
        ]);
        return json({ available: mem.available, since_ms: since, estimate: true, facts, total_facts: count[0]?.n ?? facts.length, kinds: kinds[0], sessions, days, calls: calls[0] });
      },
    },
    // GET /api/memory/search?q=&session_id=&inbox=1: the store's own search, its order and score as they are.
    "/api/memory/search": {
      GET: async (req: Request) => {
        const q = new URL(req.url).searchParams;
        const session = q.get("session_id");
        if (session && !store.session(session)) return bad("no such session", 404);
        const text = q.get("q") ?? "";
        if (text.length > QUERY_MAX) return bad(`a search is at most ${QUERY_MAX} characters`);
        return json(await mem.search(text, { cwd: sessionOf(session)?.workspace, inbox: q.get("inbox") === "1" }));
      },
    },
    // GET /api/memory/fact?name=&session_id=: one fact as the store prints it,
    // with the store's own page for the owner (the command to edit or retire it).
    "/api/memory/fact": {
      GET: async (req: Request) => {
        const q = new URL(req.url).searchParams;
        const name = q.get("name");
        if (!isFactName(name)) return bad("name is a fact's name");
        const got = await mem.fact(name, sessionOf(q.get("session_id"))?.workspace);
        return json({ ...got, correct: { note: mem.correctionNote }, page: mem.ownerPage(name) });
      },
    },
    // GET /api/memory/writers: the writers the store takes a note from, when it names them (else null).
    "/api/memory/writers": {
      GET: async () => json({ writers: await mem.writers() }),
    },
    // POST /api/memory/correct: the owner's correction of a fact, sent as the
    // store takes one, in two requests.
    // {name, text, session_id?} sends nothing: the answer is the command it
    // would run and a one-time id (state "confirm").
    // {confirm: id} runs that command as it was shown, once, within two
    // minutes of the first request. It is listed in the activity of the
    // session it was sent from: the fact's name and the note's path, never
    // the correction's words; and whether the request came from no page.
    "/api/memory/correct": {
      POST: async (req: Request) => {
        const b = ((await req.json().catch(() => ({}))) ?? {}) as { name?: unknown; text?: unknown; confirm?: unknown; session_id?: unknown };
        if (b.confirm !== undefined) {
          const r = await mem.confirm(b.confirm);
          if (!r.name) return json({ state: r.state });
          // A page's request names its origin; one from a shell or a script names none.
          // Both requests count: a command a script asked for is not the page's because a page confirmed it.
          const page = !!req.headers.get("origin") && r.page !== false;
          const by = page ? "" : " The request came with no page origin: a process on this machine sent it, not the page.";
          const session = r.session && store.session(r.session) ? r.session : null;
          if (r.state === "ok") activity.record("memory", "correction", session, `Sent a correction of the fact ${r.name} to the memory store${r.where ? ` (${r.where})` : ""}.${by}`, { fact: r.name, where: r.where, ...(page ? {} : { origin: "none" }) });
          else activity.record("memory", "correction failed", session, `A correction of the fact ${r.name} did not reach the memory store: ${r.no_writer ? `the store has no writer named ${r.no_writer}` : WHY[r.state] ?? "it failed"}.${by}`, { fact: r.name, state: r.state, ...(r.no_writer ? { no_writer: r.no_writer } : {}), ...(page ? {} : { origin: "none" }) });
          return json({ state: r.state, error: r.error, where: r.where, no_writer: r.no_writer });
        }
        if (!isFactName(b.name)) return bad("name is a fact's name");
        const text = typeof b.text === "string" ? b.text.trim() : "";
        if (!text) return bad("text is what is right instead");
        if (text.length > CORRECTION_MAX) return bad(`a correction is at most ${CORRECTION_MAX} characters`);
        const session = typeof b.session_id === "string" && b.session_id ? store.session(b.session_id) : undefined;
        if (b.session_id && !session) return bad("no such session", 404);
        return json(await mem.preview(b.name, text, { cwd: session?.workspace, session: session?.id, page: !!req.headers.get("origin") }));
      },
    },
  };
}
