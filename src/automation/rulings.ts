// Standing rulings: the owner's answer to an agent's question, kept for
// questions like it in a scope (this tree of agents, this repository, or
// everywhere), so a later agent of that scope that asks the same thing is
// answered from it instead of waiting on a card.
//
// - When the owner answers a model's question on its card, the answer is
//   offered for keeping (`after`): the card shows one line under the answer,
//   with the scopes the asking session is in. The owner keeps it in one of
//   them, or marks it just this once (then it is never kept).
// - When an agent (a session another started) asks, the rulings in its scope
//   are read first (`before`): a question is decided by a ruling in the same
//   words with the same options, else by a small model of the owner's chain
//   that reads the words (src/automation/ruling-match.ts); the id a question
//   carries decides nothing. Every question of the call
//   needs one, or the card is shown as before. The result names the ruling and
//   quotes the owner's words; each use is a row of the session's timeline.
// - A ruling is listed in Customize > Rulings with its uses, and revoked there.
//
// A ruling rides as the answer of the call that asked, never as an edit of
// any prompt: the session's cached prefix holds. A server's question and a
// permission card never reach it (src/tools/interact.ts `standing`): the
// gate keeps what it decides.
import { basename, dirname } from "node:path";
import { rootOf } from "../core/agent-tree.ts";
import { locate } from "../core/git.ts";
import { answerText, standing, type Answers, type Offer, type Question, type Ruled } from "../tools/interact.ts";
import type { ToolContext } from "../tools/types.ts";
import type { Deps, RouteModule } from "../server/app.ts";
import { record } from "./activity.ts";
import { whenPartsGo } from "./core.ts";
import { classOf, exactMatch, mapAnswer, matchHolds, matchPrompt, parseMatch, RULING_SYSTEM, type Kept } from "./ruling-match.ts";

export type Scope = "tree" | "repo" | "everywhere";
export const SCOPES: Scope[] = ["tree", "repo", "everywhere"];
export type Ruling = Kept & {
  scope: Scope; scope_name: string; session_id: string; call_id: string;
  revoked: number | null; uses: number; last_used: number | null;
};
// A scope the asking session is in: its key in the table, and the name the owner reads.
type Place = { scope: Scope; key: string; name: string };
type OfferRow = { session_id: string; call_id: string; questions: string; answers: string; places: string; ts: number; state: string | null; ruling_ids: string | null };
export type OfferMark = { call_id: string; state: "open" | "kept" | "one-off"; scope?: Scope; name?: string; rulings?: { id: string; revoked: boolean }[] };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rulings (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  scope_name TEXT NOT NULL,
  class TEXT,
  question TEXT NOT NULL,
  header TEXT,
  options TEXT NOT NULL,
  answer TEXT NOT NULL,
  words TEXT NOT NULL,
  session_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  created INTEGER NOT NULL,
  revoked INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used INTEGER
);
CREATE INDEX IF NOT EXISTS rulings_scope ON rulings(scope, scope_key) WHERE revoked IS NULL;
CREATE TABLE IF NOT EXISTS ruling_offers (
  session_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  questions TEXT NOT NULL,
  answers TEXT NOT NULL,
  places TEXT NOT NULL,
  ts INTEGER NOT NULL,
  state TEXT,
  ruling_ids TEXT,
  PRIMARY KEY (session_id, call_id)
);
CREATE TABLE IF NOT EXISTS ruling_uses (
  ruling_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (session_id, call_id, ruling_id)
);`;

// How long the small model may take to read the rulings before the owner is asked instead.
const MATCH_MS = 60_000;
const MATCH_OUT = 256;

// The words a scope is told by, after "kept for questions like it".
export const scopeWords = (scope: Scope, name: string) => (scope === "everywhere" ? "everywhere" : scope === "repo" ? `in ${name}` : `in this tree of agents (${name})`);

// A repository's name: the folder that holds its git directory.
const repoName = (common: string) => (basename(common) === ".git" ? basename(dirname(common)) : basename(common).replace(/\.git$/, ""));

export function rulings(deps: Pick<Deps, "store" | "engine" | "bus" | "errors">) {
  const { store, engine, bus, errors } = deps;
  const db = store.db;
  store.migrate(SCHEMA);
  const parentOf = (id: string) => db.query<{ parent_id: string | null }, [string]>("SELECT parent_id FROM sessions WHERE id = ?").get(id)?.parent_id ?? null;
  const capture = (e: unknown, at: string, session?: string) => errors.capture("server", e, { area: "rulings", at, ...(session ? { session } : {}) });
  const told = (sessionId: string, data: unknown) => bus.emit({ t: "feature", name: "rulings", session_id: sessionId, data });

  // The scopes a session is in: its tree, the repository of the folder it works in, everywhere.
  const placesOf = (sessionId: string, cwd?: string): Place[] => {
    const root = rootOf(parentOf, sessionId);
    const s = store.session(root);
    const out: Place[] = [{ scope: "tree", key: root, name: s?.title?.trim() || "this tree" }];
    const folder = cwd || store.session(sessionId)?.workspace;
    const repo = folder && !store.session(sessionId)?.machine ? locate(folder) : null;
    if (repo) out.push({ scope: "repo", key: repo.common, name: repoName(repo.common) });
    out.push({ scope: "everywhere", key: "", name: "everywhere" });
    return out;
  };

  const rowOf = (r: any): Ruling => ({ ...r, options: JSON.parse(r.options), answer: JSON.parse(r.answer) });
  const inScope = (places: Place[]): Ruling[] => {
    const tree = places.find((p) => p.scope === "tree")?.key ?? "";
    const repo = places.find((p) => p.scope === "repo")?.key ?? null;
    return db.query(`SELECT * FROM rulings WHERE revoked IS NULL AND ((scope = 'tree' AND scope_key = ?1) OR (scope = 'repo' AND scope_key = ?2) OR scope = 'everywhere') ORDER BY created DESC LIMIT 200`)
      .all(tree, repo).map(rowOf);
  };

  // An agent's question, answered from the rulings of its scope when each of its questions has one.
  // At once when it can be told at once (no ruling in scope, or each question one's in the same
  // words); a promise when the small model reads the rest.
  type Answer = { answers: Answers; ruled: Ruled };
  const before = (ctx: ToolContext, qs: Question[]): Answer | Promise<Answer | undefined> | undefined => {
    const s = store.session(ctx.sessionId);
    if (!s?.parent_id || !qs.length) return undefined;
    const kept = inScope(placesOf(ctx.sessionId, ctx.cwd));
    if (!kept.length) return undefined;
    const found = new Map<string, Ruling>();
    for (const q of qs) { const k = exactMatch(q, kept); if (k) found.set(q.id, k as Ruling); }
    const rest = qs.filter((q) => !found.has(q.id));
    if (!rest.length) return answer(ctx, qs, found);
    return (async () => {
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(MATCH_MS)]);
      const ids = rest.map((q) => q.id);
      const got = await engine.small(ctx.sessionId, s.model, { system: RULING_SYSTEM, prompt: matchPrompt(rest, kept), out: MATCH_OUT, signal, at: "a ruling's match", holds: (t) => matchHolds(t, ids) });
      if (!got || ctx.signal.aborted) return undefined;
      for (const [id, k] of parseMatch(got.text, ids, kept.length)) if (k !== undefined) found.set(id, kept[k]!);
      // (The owner may have revoked one while the model read: the card is theirs then.)
      return qs.every((q) => found.has(q.id)) ? answer(ctx, qs, found) : undefined;
    })();
  };
  // The answer of each question from its ruling, each use recorded once a call. None when a
  // ruling it would use was revoked since it was read.
  const answer = (ctx: ToolContext, qs: Question[], found: Map<string, Ruling>): Answer | undefined => {
    const live = db.query<{ revoked: number | null }, [string]>("SELECT revoked FROM rulings WHERE id = ?");
    if ([...found.values()].some((k) => { const row = live.get(k.id); return !row || row.revoked !== null; })) return undefined;
    const answers: Answers = Object.fromEntries(qs.map((q) => [q.id, mapAnswer(found.get(q.id)!.answer, q.options)]));
    const used = [...new Set(qs.map((q) => found.get(q.id)!))];
    const now = Date.now();
    const call = ctx.callId ?? "";
    for (const k of used) {
      // (A call answered again, after a restart cut it, is one use.)
      if (!db.query("INSERT OR IGNORE INTO ruling_uses (ruling_id, session_id, call_id, ts) VALUES (?, ?, ?, ?)").run(k.id, ctx.sessionId, call, now).changes) continue;
      db.query("UPDATE rulings SET uses = uses + 1, last_used = ? WHERE id = ?").run(now, k.id);
      record("ruling", "used", ctx.sessionId, `Answered a question from a standing ruling kept ${scopeWords(k.scope, k.scope_name)}`, { ruling_id: k.id, call_id: call, scope: k.scope });
    }
    const note = qs.map((q) => {
      const k = found.get(q.id)!;
      return `[harness] Answered from the owner's standing ruling ${k.id.slice(-8)}, kept ${scopeWords(k.scope, k.scope_name)} for questions like it: asked "${k.question}", the owner said "${k.words}". The owner did not see this question; they can revoke the ruling in Customize > Rulings.`;
    }).join("\n");
    const first = used[0]!;
    return { answers, ruled: { note, shown: { id: first.id, scope: first.scope, name: first.scope_name, words: used.map((k) => k.words) } } };
  };

  // The owner answered a model's question on its card: the answer can be kept.
  const after = (ctx: ToolContext, qs: Question[], answers: Answers): Offer | undefined => {
    if (!ctx.callId || !qs.length) return undefined;
    const places = placesOf(ctx.sessionId, ctx.cwd);
    const asked = qs.map((q) => ({ id: q.id, question: q.question, header: q.header ?? null, options: (q.options ?? []).map((o) => o.label), class: classOf(q) ?? null }));
    db.query("INSERT OR REPLACE INTO ruling_offers (session_id, call_id, questions, answers, places, ts, state, ruling_ids) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)")
      .run(ctx.sessionId, ctx.callId, JSON.stringify(asked), JSON.stringify(answers), JSON.stringify(places), Date.now());
    return { scopes: places.map(({ scope, name }) => ({ scope, name })) };
  };

  const offerOf = (sessionId: string, callId: string) =>
    db.query<OfferRow, [string, string]>("SELECT * FROM ruling_offers WHERE session_id = ? AND call_id = ?").get(sessionId, callId);
  const markOf = (r: OfferRow): OfferMark => {
    if (!r.state) return { call_id: r.call_id, state: "open" };
    if (r.state === "one-off") return { call_id: r.call_id, state: "one-off" };
    const ids: string[] = r.ruling_ids ? JSON.parse(r.ruling_ids) : [];
    const kept = ids.map((id) => db.query<{ id: string; scope: Scope; scope_name: string; revoked: number | null }, [string]>("SELECT id, scope, scope_name, revoked FROM rulings WHERE id = ?").get(id)).filter((x) => !!x);
    return { call_id: r.call_id, state: "kept", scope: kept[0]?.scope, name: kept[0]?.scope_name, rulings: kept.map((k) => ({ id: k.id, revoked: k.revoked !== null })) };
  };
  const fail = (message: string, status: number) => Object.assign(new Error(message), { status });

  // The owner keeps the answer of one call, one ruling a question of it.
  const keep = (sessionId: string, callId: string, scope: Scope): OfferMark => {
    const r = offerOf(sessionId, callId);
    if (!r) throw fail("no answer of that call can be kept", 404);
    if (r.state) throw fail(r.state === "one-off" ? "that answer was marked just this once" : "that answer is kept already", 409);
    const place = (JSON.parse(r.places) as Place[]).find((p) => p.scope === scope);
    if (!place) throw fail(`that question was not asked in a ${scope} scope`, 400);
    const asked = JSON.parse(r.questions) as { id: string; question: string; header: string | null; options: string[]; class: string | null }[];
    const answers = JSON.parse(r.answers) as Answers;
    const now = Date.now();
    const ids: string[] = [];
    store.atomic(sessionId, () => {
      for (const q of asked) {
        const a = answers[q.id];
        if (!a || (!a.picked.length && !a.other?.trim())) continue;
        const id = Bun.randomUUIDv7();
        db.query(`INSERT INTO rulings (id, scope, scope_key, scope_name, class, question, header, options, answer, words, session_id, call_id, created)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, scope, place.key, place.name, q.class, q.question, q.header, JSON.stringify(q.options),
          JSON.stringify({ picked: a.picked, ...(a.other?.trim() ? { other: a.other.trim() } : {}) }), answerText(a), sessionId, callId, now);
        ids.push(id);
      }
      db.query("UPDATE ruling_offers SET state = 'kept', ruling_ids = ? WHERE session_id = ? AND call_id = ?").run(JSON.stringify(ids), sessionId, callId);
    });
    if (!ids.length) throw fail("that call has no answer to keep", 400);
    record("ruling", "kept", sessionId, `Kept the owner's answer as a standing ruling ${scopeWords(scope, place.name)}`, { ruling_id: ids[0], call_id: callId, scope });
    const mark = markOf(offerOf(sessionId, callId)!);
    told(sessionId, mark);
    return mark;
  };

  const oneOff = (sessionId: string, callId: string): OfferMark => {
    const r = offerOf(sessionId, callId);
    if (!r) throw fail("no answer of that call can be kept", 404);
    if (r.state === "kept") throw fail("that answer is kept already: revoke its ruling in Customize > Rulings", 409);
    db.query("UPDATE ruling_offers SET state = 'one-off' WHERE session_id = ? AND call_id = ?").run(sessionId, callId);
    const mark = markOf(offerOf(sessionId, callId)!);
    told(sessionId, mark);
    return mark;
  };

  const revoke = (id: string): Ruling => {
    const r = db.query("SELECT * FROM rulings WHERE id = ?").get(id);
    if (!r) throw fail("no such ruling", 404);
    const k = rowOf(r);
    if (k.revoked === null) {
      db.query("UPDATE rulings SET revoked = ? WHERE id = ?").run(Date.now(), id);
      record("ruling", "revoked", k.session_id, `Revoked a standing ruling kept ${scopeWords(k.scope, k.scope_name)}`, { ruling_id: id, scope: k.scope });
      const offer = offerOf(k.session_id, k.call_id);
      if (offer) told(k.session_id, markOf(offer));
    }
    return rowOf(db.query("SELECT * FROM rulings WHERE id = ?").get(id));
  };

  const list = (): Ruling[] => db.query("SELECT * FROM rulings ORDER BY revoked IS NOT NULL, created DESC LIMIT 500").all().map(rowOf);
  const marks = (sessionId: string): OfferMark[] => db.query<OfferRow, [string]>("SELECT * FROM ruling_offers WHERE session_id = ?").all(sessionId).map(markOf);

  // (A ruling that cannot be read is captured once and answers nothing: the owner is asked.)
  const guarded = (ctx: ToolContext, qs: Question[]) => {
    const failed = (e: unknown) => { capture(e, "a ruling's match", ctx.sessionId); return undefined; };
    try {
      const r = before(ctx, qs);
      return r instanceof Promise ? r.catch(failed) : r;
    } catch (e) { return failed(e); }
  };
  return { before: guarded, after, keep, oneOff, revoke, list, marks, placesOf };
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const attempt = async (f: () => unknown | Promise<unknown>) => {
  try { return json(await f()); } catch (e: any) { return json({ error: e.message }, e.status ?? 400); }
};
const isScope = (v: unknown): v is Scope => SCOPES.includes(v as Scope);

export const rulingRoutes: RouteModule = (deps) => {
  const r = rulings(deps);
  const before: typeof standing.before = r.before;
  standing.before = before;
  standing.after = (ctx, qs, answers) => { try { return r.after(ctx, qs, answers); } catch (e) { deps.errors.capture("server", e, { area: "rulings", at: "a ruling's offer", session: ctx.sessionId }); return undefined; } };
  // The questions are process-wide: these parts' rulings answer none once the parts go (a test file's, a reload's).
  whenPartsGo(() => { if (standing.before === before) { standing.before = undefined; standing.after = undefined; } });
  return {
    "/api/rulings": {
      GET: () => json({ rulings: r.list() }),
      // { session_id, call_id, scope }: the owner keeps the answer of that call.
      POST: (req: Request) => attempt(async () => {
        const b = ((await req.json().catch(() => ({}))) ?? {}) as { session_id?: unknown; call_id?: unknown; scope?: unknown };
        if (typeof b.session_id !== "string" || typeof b.call_id !== "string") throw Object.assign(new Error("session_id and call_id are needed"), { status: 400 });
        if (!isScope(b.scope)) throw Object.assign(new Error(`scope is one of ${SCOPES.join(", ")}`), { status: 400 });
        return { offer: r.keep(b.session_id, b.call_id, b.scope) };
      }),
    },
    "/api/rulings/:id/revoke": {
      POST: (req: any) => attempt(() => ({ ruling: r.revoke(req.params.id) })),
    },
    "/api/sessions/:id/rulings": {
      GET: (req: any) => json({ offers: r.marks(req.params.id) }),
    },
    "/api/sessions/:id/rulings/:call/one-off": {
      POST: (req: any) => attempt(() => ({ offer: r.oneOff(req.params.id, req.params.call) })),
    },
  };
};
