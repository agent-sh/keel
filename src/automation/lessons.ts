// Lessons from repeated failures. A failure cause that recurs across a
// repository's agent trees (the miner: src/automation/lessons-mine.ts) becomes
// one proposed lesson: a short note for the repository's agents, drafted by a
// small model of the owner's chain from what the failures said, shown in
// Customize > Lessons with its evidence (the trees, sessions and counts). The
// owner accepts it (as drafted or in his own words) or drops it; a dropped
// cause is never proposed again.
//
// An accepted lesson rides in the task an agent of that repository starts
// with (src/automation/agents.ts), never in a system prompt: every session's
// cached prefix holds. Its effect is measured by a trial (src/admin/
// experiments.ts, the lesson template): half of the repository's new agent
// trees are told it, and the count of its own failure class in each tree is
// the primary metric. A trial that shows the class falls keeps the lesson for
// every agent; one that does not drops it, with the numbers. While another
// live experiment runs, an accepted lesson goes to every agent of its
// repository and its trial starts when that one stops.
//
// The drafting model may answer that no agent could avoid the cause (an
// outage, a test failing because the work is not done): such a cause is kept
// apart, listed under the proposals, and the owner can still propose it.
//
// The owner is shown a few at a time: the SHOWN causes that failed in the
// most trees and whose trial the repository decides within a week are drafted
// and proposed; the rest wait undrafted behind them ("waiting"), each with the
// days its trial would need, and move up as the owner settles the ones shown.
// A trial with no winner at its sample size keeps its lesson in use, undecided,
// with its numbers; only a trial that shows the lesson hurt drops it.
import type { Database } from "bun:sqlite";
import { basename } from "node:path";
import { repoRoot } from "../core/repo-root.ts";
import type { Session } from "../core/types.ts";
import { bytesPerToken } from "../engine/compact.ts";
import { armOf, LESSON_TEMPLATE, METRICS, registerFamilyRead, type Experiment } from "../admin/experiments.ts";
import { readsOf } from "../server/reads.ts";
import { experiments } from "../server/routes/experiments.ts";
import type { Deps, RouteModule } from "../server/app.ts";
import { record } from "./activity.ts";
import { whenPartsGo } from "./core.ts";
import { lessonStart } from "./lesson-start.ts";
import { DAYS, familyHas, MIN_PER_ARM, type Candidate, type Source } from "./lessons-mine.ts";
import { DRAFT_OUT, draftHolds, fateOf, SHOWN, toDraft, draftPrompt, KIND_OUT, KIND_SYSTEM, kindOfAnswer, kindPrompt, LESSON_SYSTEM, lessonBlock, NOTE_CHARS, plainDraft, told as toldAs } from "./lesson-draft.ts";

export type LessonState = "waiting" | "drafting" | "proposed" | "quiet" | "accepted" | "trial" | "kept" | "undecided" | "dropped";
// The states whose lesson an agent of its repository is told (a trial's: by its arm).
const IN_USE = "('accepted', 'trial', 'kept', 'undecided')";
export type Outcome = { verdict: string; text: string; arms: { arm: string; trees: number; per_tree: number | null }[] };
export type Lesson = {
  id: string; repo: string; repo_name: string; key: string; source: Source; label: string; words: string[] | null;
  state: LessonState; text: string; drafted_by: string | null; why_none: string | null;
  evidence: Candidate; created: number; updated: number; accepted: number | null; ended: number | null;
  exp_id: string | null; outcome: Outcome | null; given: number; chars: number;
  // A lesson in its trial: the numbers so far, and the agent trees an arm needs before it is read.
  progress?: Outcome | null; trees_per_arm?: number | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  key TEXT NOT NULL,
  source TEXT NOT NULL,
  label TEXT NOT NULL,
  words TEXT,
  state TEXT NOT NULL,
  text TEXT NOT NULL,
  drafted_by TEXT,
  why_none TEXT,
  evidence TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  accepted INTEGER,
  ended INTEGER,
  exp_id TEXT,
  outcome TEXT,
  UNIQUE (repo, key)
);
CREATE TABLE IF NOT EXISTS lesson_given (lesson_id TEXT NOT NULL, session_id TEXT NOT NULL, ts INTEGER NOT NULL, chars INTEGER NOT NULL, PRIMARY KEY (lesson_id, session_id));
CREATE TABLE IF NOT EXISTS lesson_kinds (ref TEXT PRIMARY KEY, kind TEXT, model TEXT, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS lesson_mines (id INTEGER PRIMARY KEY CHECK (id = 1), ts INTEGER NOT NULL, found INTEGER NOT NULL, ms INTEGER NOT NULL);`;

// A mine an hour: a cause is counted over two weeks, so an hour adds little to it.
const MINE_EVERY_MS = 3_600_000;
// The first mine waits for the start to settle.
const FIRST_MINE_MS = 60_000;
const DRAFT_MS = 60_000;
// The findings put in a kind at one mine: the rest wait for the next. A store's first mine reads two
// weeks of reviews; a review day of a busy repository is a few dozen.
const KINDS_A_MINE = 100;
// The repositories whose root a workspace is in, remembered: an agent's start reads it, and a folder stays
// in its repository. Bounded, the oldest forgotten first.
const ROOTS = 1000;

type Row = Omit<Lesson, "words" | "evidence" | "outcome" | "given" | "chars"> & { words: string | null; evidence: string; outcome: string | null };
const parse = <T>(s: string | null): T | null => { if (!s) return null; try { return JSON.parse(s) as T; } catch { return null; } };

export function lessons(deps: Pick<Deps, "store" | "engine" | "bus" | "errors">) {
  const { store, engine, bus, errors } = deps;
  const db: Database = store.db;
  store.migrate(SCHEMA);
  const capture = (e: unknown, at: string) => errors.capture("server", e, { area: "lessons", at });
  const told = () => bus.emit({ t: "feature", name: "lessons", data: {} });
  const fail = (message: string, status: number) => Object.assign(new Error(message), { status });

  const given = db.query<{ n: number; chars: number }, [string]>("SELECT COUNT(*) AS n, COALESCE(MAX(chars), 0) AS chars FROM lesson_given WHERE lesson_id = ?");
  const toLesson = (r: Row): Lesson => {
    const g = given.get(r.id)!;
    return { ...r, words: parse(r.words), evidence: parse(r.evidence)!, outcome: parse(r.outcome), given: g.n, chars: g.chars };
  };
  const one = (id: string) => { const r = db.query<Row, [string]>("SELECT * FROM lessons WHERE id = ?").get(id); return r ? toLesson(r) : undefined; };
  const must = (id: string) => { const l = one(id); if (!l) throw fail("no such lesson", 404); return l; };
  const set = (id: string, f: Record<string, string | number | null>) => {
    const keys = Object.keys(f);
    db.query(`UPDATE lessons SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated = ? WHERE id = ?`).run(...(keys.map((k) => f[k]!) as any[]), Date.now(), id);
  };

  // ---- drafts ----
  const queue: string[] = [];
  let drafting = false;
  const draftNext = async () => {
    if (drafting) return;
    drafting = true;
    try {
      for (let id = queue.shift(); id; id = queue.shift()) {
        const l = one(id);
        if (!l || l.state !== "drafting") continue;
        // The newest session the cause was seen in: the request is counted on it, on its model.
        const at = l.evidence.evidence.map((e) => store.session(e.session)).find((s): s is Session => !!s);
        let got: { text: string; model: string } | undefined;
        if (at) {
          try { got = await engine.small(at.id, at.model, { system: LESSON_SYSTEM, prompt: draftPrompt(l.evidence, at.id), out: DRAFT_OUT, signal: AbortSignal.timeout(DRAFT_MS), at: "a lesson's draft", holds: draftHolds }); }
          catch (e) { capture(e, "a lesson's draft"); }
        }
        const now = one(id);
        if (!now || now.state !== "drafting") continue;
        const t = got?.text.trim();
        if (t && /^NONE\b/.test(t)) set(id, { state: "quiet", why_none: t.replace(/^NONE:?\s*/, "").slice(0, 200) || null, drafted_by: got!.model });
        else set(id, { state: "proposed", ...(t ? { text: t, drafted_by: got!.model } : {}) });
        told();
      }
    } finally { drafting = false; }
  };

  // ---- the kinds of review findings ----
  // Each new refusing verdict and finding, once: a small model puts it in a kind, or in none. Asked on the
  // session that judged it; a finding no model answered for is asked again at the next mine.
  // They run after a mine, not before it: a first mine reads two weeks of findings, and its proposals
  // do not wait on those calls. A finding put in a kind is read by the next mine, run at once when any was.
  let kinding: Promise<number> | null = null;
  const kindsNow = (): Promise<number> => (kinding ??= (async () => {
    const todo = await readsOf(store).run("lessons.untagged", { since: Date.now() - DAYS * 86_400_000, max: KINDS_A_MINE });
    const put = db.query("INSERT OR REPLACE INTO lesson_kinds (ref, kind, model, ts) VALUES (?, ?, ?, ?)");
    let kinded = 0;
    for (const f of todo) {
      const s = store.session(f.session);
      if (!s) { put.run(f.ref, null, null, Date.now()); continue; }
      let got: { text: string; model: string } | undefined;
      try { got = await engine.small(s.id, s.model, { system: KIND_SYSTEM, prompt: kindPrompt(f.text, s.id), out: KIND_OUT, signal: AbortSignal.timeout(DRAFT_MS), at: "a finding's kind", holds: (t) => kindOfAnswer(t) !== undefined }); }
      catch (e) { capture(e, "a finding's kind"); }
      if (got) { const k = kindOfAnswer(got.text) ?? null; put.run(f.ref, k, got.model, Date.now()); if (k) kinded++; }
    }
    return kinded;
  })().finally(() => { kinding = null; }));

  // ---- mining ----
  // The open proposals' slots filled from the waiting causes, at most `cap` of them (a mine's SHOWN, an
  // owner's act one): each is drafted.
  const promote = (cap: number) => {
    const open = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM lessons WHERE state IN ('drafting', 'proposed')").get()!.n;
    const waiting = db.query<{ id: string; evidence: string }, []>("SELECT id, evidence FROM lessons WHERE state = 'waiting'").all().map((r) => ({ id: r.id, evidence: parse<Candidate>(r.evidence)! }));
    const ids = toDraft(waiting, open, cap);
    for (const id of ids) { set(id, { state: "drafting" }); queue.push(id); }
    return ids.length;
  };
  let mining: Promise<{ found: number; added: number }> | null = null;
  const mine = (): Promise<{ found: number; added: number }> => {
    if (mining) return mining;
    const t0 = Date.now();
    const p = readsOf(store).run("lessons.mine", { now: t0 }).then((found) => {
      let added = 0;
      const now = Date.now();
      const has = db.query<{ id: string; state: LessonState }, [string, string]>("SELECT id, state FROM lessons WHERE repo = ? AND key = ?");
      const add = db.query("INSERT INTO lessons (id, repo, repo_name, key, source, label, words, state, text, evidence, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?)");
      db.transaction(() => {
        for (const raw of found) {
          // What is kept and shown of a failure's words: the vault's secrets hidden too (the miner hid
          // what is shaped like a key and folded the paths; the vault is the daemon's).
          const c: Candidate = { ...raw, label: toldAs(raw.label, null, raw.repo), examples: raw.examples.map((e) => toldAs(e, null, raw.repo)) };
          const had = has.get(c.repo, c.key);
          if (!had) {
            add.run(Bun.randomUUIDv7(), c.repo, c.repo_name, c.key, c.source, c.label, c.words ? JSON.stringify(c.words) : null, plainDraft(c), JSON.stringify(c), now, now);
            added++;
          } else if (had.state === "waiting" || had.state === "drafting" || had.state === "proposed" || had.state === "quiet") {
            // The evidence of a cause still open is the newest; an accepted one keeps what it was accepted on.
            db.query("UPDATE lessons SET evidence = ?, updated = ? WHERE id = ?").run(JSON.stringify(c), now, had.id);
          }
        }
        // A proposal whose cause has not failed within the window is no longer a pattern.
        db.query("DELETE FROM lessons WHERE state IN ('waiting', 'proposed', 'quiet') AND json_extract(evidence, '$.last_ts') < ?").run(now - DAYS * 86_400_000);
        // A draft a restart cut is asked again.
        for (const r of db.query<{ id: string }, []>("SELECT id FROM lessons WHERE state = 'drafting'").all()) if (!queue.includes(r.id)) queue.push(r.id);
        promote(SHOWN);
        db.query("INSERT INTO lesson_mines (id, ts, found, ms) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, found = excluded.found, ms = excluded.ms").run(now, found.length, now - t0);
      })();
      told();
      void draftNext().catch((e) => capture(e, "drafts"));
      return { found: found.length, added };
    }).finally(() => { mining = null; });
    mining = p;
    // The findings' kinds after it; a mine again when they put any in a kind.
    void p.then(() => kindsNow()).then((n) => { if (n > 0) return mine(); }).catch((e) => capture(e, "kinds"));
    return p;
  };
  const lastMine = () => db.query<{ ts: number; found: number; ms: number }, []>("SELECT ts, found, ms FROM lesson_mines WHERE id = 1").get() ?? null;

  // ---- trials ----
  const trialOf = (l: Lesson): Experiment | undefined => (l.exp_id ? experiments?.get(l.exp_id) : undefined);
  // The trial of a lesson waiting for one starts when no live experiment runs.
  const startTrial = (l: Lesson): boolean => {
    const x = experiments;
    if (!x || x.running()) return false;
    let e = trialOf(l);
    if (!e || e.state !== "draft") {
      // Its sample size from its class's share of the repository's trees (src/automation/lessons-mine.ts perArm).
      const n = Math.max(MIN_PER_ARM, l.evidence.per_arm ?? 0);
      e = x.create({ template: "lesson", name: `Lesson: ${l.text.slice(0, 60)}${l.text.length > 60 ? "…" : ""}`, repo: l.repo, lesson: l.id,
        stop: { ...LESSON_TEMPLATE.make().stop, sessions_per_arm: n },
        hypothesis: `Agents of ${l.repo_name} told this lesson at their start fail with its class (${l.label}) less often, without more errors or cost: ${l.text}` });
    }
    x.start(e.id);
    set(l.id, { state: "trial", exp_id: e.id });
    record("agent", "lesson trial", null, `Started the trial of a lesson of ${l.repo_name}: half of its new agent trees are told it`, { lesson_id: l.id, experiment: e.id });
    return true;
  };
  // A trial that stopped decides its lesson (fateOf), with the numbers.
  const outcomeOf = (e: Experiment): Outcome | null => {
    const x = experiments;
    if (!x) return null;
    const r = x.report(e);
    return {
      verdict: fateOf(r.decision),
      text: r.decision.text,
      arms: r.arms.map((a) => ({ arm: a.arm, trees: a.clusters, per_tree: a.metrics.lesson_class && Number.isFinite(a.metrics.lesson_class.estimate) ? a.metrics.lesson_class.estimate : null })),
    };
  };
  const settle = () => {
    const x = experiments;
    if (!x) return;
    for (const r of db.query<Row, []>("SELECT * FROM lessons WHERE state IN ('accepted', 'trial')").all()) {
      const l = toLesson(r);
      if (l.state === "trial") {
        const e = trialOf(l);
        if (!e || e.state !== "stopped") continue;
        const o = outcomeOf(e);
        const fate = (o?.verdict ?? "undecided") as "kept" | "dropped" | "undecided";
        set(l.id, { state: fate, ended: Date.now(), outcome: o ? JSON.stringify(o) : null });
        record("agent", `lesson ${fate}`, null, fate === "kept" ? `Kept a lesson of ${l.repo_name}: its trial cut its failure class`
          : fate === "dropped" ? `Dropped a lesson of ${l.repo_name}: its trial showed it did not help` : `A lesson of ${l.repo_name} stays in use, undecided: its trial named no winner`, { lesson_id: l.id, experiment: e.id });
        told();
      }
    }
    // Then the oldest lesson that waits for a trial, if none runs.
    const next = db.query<Row, []>("SELECT * FROM lessons WHERE state = 'accepted' ORDER BY accepted LIMIT 1").get();
    if (next) { try { if (startTrial(toLesson(next))) told(); } catch (e) { capture(e, "a lesson's trial"); } }
  };

  // ---- the owner's acts ----
  const accept = (id: string, text?: string): Lesson => {
    const l = must(id);
    if (l.state !== "proposed" && l.state !== "quiet" && l.state !== "waiting" && l.state !== "dropped") throw fail(`that lesson is ${l.state}`, 409);
    const words = (text ?? l.text).trim();
    if (!words) throw fail("a lesson has words", 400);
    if (words.length > NOTE_CHARS) throw fail(`a lesson is at most ${NOTE_CHARS} characters: it is read at every agent's start`, 400);
    set(id, { state: "accepted", text: words, accepted: Date.now(), ended: null, outcome: null, exp_id: null });
    record("agent", "lesson accepted", null, `Accepted a lesson for the agents of ${l.repo_name}`, { lesson_id: id });
    try { settle(); } catch (e) { capture(e, "a lesson's trial"); }
    moveUp();
    told();
    return must(id);
  };
  const edit = (id: string, text: string): Lesson => {
    const l = must(id);
    if (l.state === "trial") throw fail("its trial is running: the words its agents are told stay as they started; retire it and accept it again in new words", 409);
    const words = text.trim();
    if (!words) throw fail("a lesson has words", 400);
    if (words.length > NOTE_CHARS) throw fail(`a lesson is at most ${NOTE_CHARS} characters: it is read at every agent's start`, 400);
    set(id, { text: words });
    told();
    return must(id);
  };
  // Dropped by the owner: a proposal is never made again, a lesson in use is no longer given, a running trial stops.
  const drop = (id: string): Lesson => {
    const l = must(id);
    if (l.state === "dropped") return l;
    const e = l.state === "trial" ? trialOf(l) : undefined;
    if (e?.state === "running") experiments!.stop(e.id, "the owner retired its lesson");
    const o = e ? outcomeOf(experiments!.get(e.id)!) : null;
    set(id, { state: "dropped", ended: Date.now(), ...(o ? { outcome: JSON.stringify(o) } : {}) });
    record("agent", "lesson dropped", null, `Dropped a lesson of ${l.repo_name}`, { lesson_id: id });
    try { settle(); } catch (err) { capture(err, "a lesson's trial"); }
    moveUp();
    told();
    return must(id);
  };
  // A settled proposal makes room for the next waiting one.
  const moveUp = () => { try { if (promote(1)) void draftNext().catch((e) => capture(e, "drafts")); } catch (e) { capture(e, "a lesson's draft"); } };
  // A cause the drafting model found no lesson in, put forward by the owner; or one that waits, drafted now.
  const propose = (id: string): Lesson => {
    const l = must(id);
    if (l.state === "waiting") {
      set(id, { state: "drafting" });
      queue.push(id);
      void draftNext().catch((e) => capture(e, "drafts"));
    } else if (l.state === "quiet") set(id, { state: "proposed" });
    else throw fail(`that lesson is ${l.state}`, 409);
    told();
    return must(id);
  };
  const list = (): Lesson[] => {
    try { settle(); } catch (e) { capture(e, "lessons settle"); }
    return db.query<Row, []>("SELECT * FROM lessons ORDER BY CASE state WHEN 'proposed' THEN 0 WHEN 'drafting' THEN 1 WHEN 'trial' THEN 2 WHEN 'accepted' THEN 3 WHEN 'undecided' THEN 4 WHEN 'kept' THEN 5 WHEN 'waiting' THEN 6 WHEN 'quiet' THEN 7 ELSE 8 END, json_extract(evidence, '$.trees') DESC, created DESC LIMIT 500").all().map(toLesson)
      .map((l) => {
        if (l.state !== "trial") return l;
        const e = trialOf(l);
        let progress: Outcome | null = null;
        try { progress = e ? outcomeOf(e) : null; } catch (err) { capture(err, "a trial's numbers"); }
        return { ...l, progress, trees_per_arm: e?.stop.sessions_per_arm ?? null };
      });
  };

  // ---- delivery at an agent's start ----
  const roots = new Map<string, string | null>();
  const rootOf = (dir: string) => {
    if (roots.has(dir)) return roots.get(dir)!;
    const r = repoRoot(dir);
    if (roots.size >= ROOTS) roots.delete(roots.keys().next().value!);
    roots.set(dir, r);
    return r;
  };
  const forAgent = (child: Session, agentId: string): string => {
    if (child.machine || !child.parent_id) return "";
    const repo = rootOf(child.workspace);
    if (!repo) return "";
    const rows = db.query<Row, [string]>(`SELECT * FROM lessons WHERE repo = ? AND state IN ${IN_USE} ORDER BY accepted`).all(repo);
    if (!rows.length) return "";
    try { settle(); } catch (e) { capture(e, "lessons settle"); }
    const live = db.query<Row, [string]>(`SELECT * FROM lessons WHERE repo = ? AND state IN ${IN_USE} ORDER BY accepted`).all(repo).map(toLesson);
    const trial = live.find((l) => l.state === "trial");
    // The trial's draw for this agent's tree, made now so the task it starts with follows it.
    if (trial) experiments?.assign(child);
    const tag = armOf(store, child.id);
    const arm = tag && experiments?.get(tag.exp_id)?.arms.find((a) => a.name === tag.arm);
    const told = live.filter((l) => l.state !== "trial" || (tag?.exp_id === l.exp_id && !!arm?.lesson));
    const block = lessonBlock(basename(repo), told.map((l) => l.text));
    if (!block) return "";
    const now = Date.now();
    const give = db.query("INSERT OR IGNORE INTO lesson_given (lesson_id, session_id, ts, chars) VALUES (?, ?, ?, ?)");
    for (const l of told) give.run(l.id, child.id, now, block.length);
    const tokens = Math.ceil(block.length / bytesPerToken(child.model));
    record("agent", "lessons", child.id, `Started with ${told.length === 1 ? "a lesson" : `${told.length} lessons`} of ${basename(repo)}, about ${tokens} tokens`,
      { agent_id: agentId, child_session: child.id, lessons: told.map((l) => l.id), repo: basename(repo), tokens });
    return block;
  };

  // A trial's count of its lesson's class, per family (src/admin/experiments.ts FAMILY_METRICS).
  const familyRead = (e: Experiment, roots: string[], until: number) => {
    if (!e.lesson) return undefined;
    const l = one(e.lesson);
    if (!l) return undefined;
    const want = new Set(roots);
    const sessions = db.query<{ id: string; root: string }, [string]>("SELECT session_id AS id, root FROM experiment_sessions WHERE exp_id = ?").all(e.id).filter((s) => want.has(s.root));
    const counts = familyHas(db, { source: l.source, key: l.key, words: l.words ?? undefined }, sessions, e.started_ms ?? 0, until);
    return new Map([...counts].map(([root, n]) => [root, { lesson_class: n }]));
  };

  return { mine, lastMine, list, accept, edit, drop, propose, forAgent, familyRead, settle, one: (id: string) => one(id) };
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const attempt = async (f: () => unknown | Promise<unknown>) => {
  try { return json(await f()); } catch (e: any) { return json({ error: e.message }, e.status ?? 400); }
};

// GET  /api/lessons                 every lesson, the last mine, the class metric's label
// POST /api/lessons/mine            mine now: { found, added }
// POST /api/lessons/:id/accept      { text? }: in use from now (its trial starts when no live experiment runs)
// POST /api/lessons/:id/edit        { text }: new words (not while its trial runs)
// POST /api/lessons/:id/drop        never proposed again; no longer given; a running trial stops
// POST /api/lessons/:id/propose     a cause the drafting model found no lesson in, proposed anyway; a waiting one drafted now
export const lessonRoutes: RouteModule = (deps) => {
  const l = lessons(deps);
  const start: typeof lessonStart.block = (child, agentId) => l.forAgent(child, agentId);
  lessonStart.block = start;
  const unread = registerFamilyRead("lessons", l.familyRead);
  // The miner on a beat; a reload replaces the last one's timers.
  const g = globalThis as { __keelLessonTimers?: ReturnType<typeof setTimeout>[] };
  for (const t of g.__keelLessonTimers ?? []) clearTimeout(t);
  const run = () => void l.mine().catch((e) => deps.errors.capture("server", e, { area: "lessons", at: "mine" }));
  const timers = process.env.NODE_ENV === "test" ? [] : [setTimeout(run, FIRST_MINE_MS), setInterval(run, MINE_EVERY_MS)];
  for (const t of timers) t.unref?.();
  g.__keelLessonTimers = timers;
  whenPartsGo(() => {
    if (lessonStart.block === start) lessonStart.block = undefined;
    unread();
    for (const t of timers) clearTimeout(t);
  });
  const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as { text?: unknown };
  return {
    "/api/lessons": { GET: () => json({ lessons: l.list(), mine: l.lastMine(), metric: METRICS.lesson_class.label, days: DAYS }) },
    "/api/lessons/mine": { POST: () => attempt(() => l.mine()) },
    "/api/lessons/:id/accept": { POST: (req: any) => attempt(async () => { const b = await body(req); return { lesson: l.accept(req.params.id, typeof b.text === "string" ? b.text : undefined) }; }) },
    "/api/lessons/:id/edit": { POST: (req: any) => attempt(async () => { const b = await body(req); if (typeof b.text !== "string") throw Object.assign(new Error("text is the lesson's words"), { status: 400 }); return { lesson: l.edit(req.params.id, b.text) }; }) },
    "/api/lessons/:id/drop": { POST: (req: any) => attempt(() => ({ lesson: l.drop(req.params.id) })) },
    "/api/lessons/:id/propose": { POST: (req: any) => attempt(() => ({ lesson: l.propose(req.params.id) })) },
  };
};
