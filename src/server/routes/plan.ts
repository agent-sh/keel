// Plan mode's way out: the model presents a plan (ExitPlanMode for the Claude
// family, present_plan for the others) and waits on a card; the owner approves
// it, edited or not, and picks the mode the work goes on in, or sends it back
// with what to change. The plan last approved is kept with the session.
//
// Or the owner approves it to be carried out in a fresh session: a new session in the same folder (and the
// worktree, which goes with the work), in the chosen mode, whose first prompt is the approved plan with a
// link back. The planning session keeps its transcript, stays in plan mode and ends its turn after the plan's
// step, with a line that names the new one: one session works on the plan, never two.
import { registerHooks } from "../../engine/hooks.ts";
import { declareAsksOwner, registerShared } from "../../tools/registry.ts";
import type { Tool, ToolContext } from "../../tools/types.ts";
import { isMode } from "../../safety/policy.ts";
import type { Sightings } from "../../safety/provenance.ts";
import type { Deps, RouteModule } from "../app.ts";
import { gate, presence } from "./permissions.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);

export type PlanCard = { id: string; session_id: string; plan: string; title?: string; created: number };
// `fresh`: the session that carries it out instead of this one.
export type Answer = { approved: true; mode: string; plan: string; note?: string; fresh?: { id: string; title: string } } | { approved: false; feedback?: string; stopped?: true };
// By session and id: a plan is known by its tool call's id, and a wire whose ids count the calls
// gives two sessions the same one.
const waiting = new Map<string, PlanCard & { resolve: (a: Answer) => void }>();
const keyOf = (sessionId: string, id: string) => `${sessionId}\u0000${id}`;
// How a plan stopped waiting: approved (in a mode), sent back to planning, or the turn ended under it.
export type PlanEnd = { card: PlanCard; how: "approved" | "denied" | "expired"; mode?: string; at: number };
// The plans that ended in the last day, newest last: a client that was away (a phone) is told how
// the plans it was shown ended. Kept in memory, as the waiting plans are.
const ended: PlanEnd[] = [];
const ENDED_FOR = 24 * 3600_000;
let emit: (c: PlanCard, state: "open" | "closed", end?: PlanEnd) => void = () => {};
export const plansEnded = (sinceMs: number): PlanEnd[] => ended.filter((e) => e.at >= sinceMs);
// The plans that wait for the owner now: a session with one needs them (src/automation/state.ts).
export const plansWaiting = (): PlanCard[] => Array.from(waiting.values(), ({ resolve: _r, ...c }) => c);
export const planWaits = (sessionId: string, id: string) => waiting.has(keyOf(sessionId, id));
// Set when the routes load: the daemon is stopping, and a plan whose wait ends now is parked with its
// turn, to be put back on its card at the next start (it did not end).
let parking = () => false;
// Known as calls that wait on the owner before their route module registers them (see declareAsksOwner).
declareAsksOwner("ExitPlanMode", "present_plan");

async function present(input: any, ctx: ToolContext) {
  const plan = String(input?.plan ?? "").trim();
  if (!plan) return { content: "Give the plan as text.", is_error: true };
  const mode = gate?.perm(ctx.sessionId).mode;
  if (mode && mode !== "plan") return { content: `The session is not in plan mode (it is in ${mode}): go ahead with the work.` };
  const card: PlanCard = { id: ctx.callId ?? crypto.randomUUID(), session_id: ctx.sessionId, plan: plan.slice(0, 40_000), title: input?.title ? String(input.title).slice(0, 120) : undefined, created: Date.now() };
  const a = await waitPlan(card, ctx.signal);
  // His own words on the plan, kept with the result for what a compaction keeps of his (src/engine/compact.ts
  // ownerReplies); a stop's words are the harness's, never his.
  if (!a.approved) return { content: `The owner did not approve the plan${a.feedback ? `: ${a.feedback}` : "."} Stay in plan mode, change the plan, and present it again.`, ...(!a.stopped && a.feedback ? { shown: { plan_answer: { feedback: a.feedback } } } : {}) };
  const edited = a.plan !== card.plan;
  const said = { ...(a.note ? { note: a.note } : {}), ...(edited ? { plan: a.plan } : {}), ...(a.fresh ? { fresh: a.fresh.id } : {}) };
  if (a.fresh) return {
    shown: { plan_answer: said },
    content: `The owner approved the plan and started it in a fresh session, "${a.fresh.title}" (session ${a.fresh.id}), which carries it out. Do not carry it out here: this session stays in plan mode and its turn ends now.`,
  };
  return {
    ...(Object.keys(said).length ? { shown: { plan_answer: said } } : {}),
    content: [
      `The owner approved the plan. The session is now in ${a.mode} mode: carry it out.`,
      edited ? `The owner edited it; this is the plan to follow:\n\n${a.plan}` : "",
      a.note ? `The owner's note: ${a.note}` : "",
    ].filter(Boolean).join("\n\n"),
  };
}

// A plan on its card until the owner decides it or `signal` stops the wait (`stopped` on the answer). Also the card
// of a plan another harness presents while Keel answers its session in place (src/integrations/outside/claude-code.ts).
export function waitPlan(card: PlanCard, signal: AbortSignal): Promise<Answer> {
  return new Promise<Answer>((resolve) => {
    const done = (x: Answer, stopped = false) => {
      if (!waiting.delete(keyOf(card.session_id, card.id))) return;
      signal.removeEventListener("abort", onAbort);
      // Parked with its turn by a daemon that stops: it did not end, and no client is told it did.
      if (stopped && parking()) { emit(card, "closed"); resolve(x); return; }
      const end: PlanEnd = { card, how: stopped ? "expired" : x.approved ? "approved" : "denied", ...(x.approved ? { mode: x.mode } : {}), at: Date.now() };
      while (ended.length && (ended[0]!.at < end.at - ENDED_FOR)) ended.shift();
      ended.push(end);
      emit(card, "closed", end);
      resolve(x);
    };
    const onAbort = () => done({ approved: false, feedback: "the turn was stopped", stopped: true }, true);
    waiting.set(keyOf(card.session_id, card.id), { ...card, resolve: done });
    emit(card, "open");
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}
// What a fresh session carries over of the planning session's settings: how its model runs, nothing of a trial's arm.
const CARRY = ["effort", "speed", "fallback", "compact_at", "idle_compact", "owner_compact_by_price"] as const;
const carried = (s: Record<string, unknown> | undefined) => Object.fromEntries(CARRY.filter((k) => s?.[k] !== undefined).map((k) => [k, s![k]])) as any;
// The fresh session's first prompt: the approved plan as the owner left it, with where it was planned.
export const freshPrompt = (plan: string, title: string, note?: string) => [
  `Carry out this plan. The owner approved it in the planning session "${title || "untitled"}", where its planning transcript is kept.`,
  plan,
  note ? `The owner's note: ${note}` : "",
].filter(Boolean).join("\n\n");

const schema = {
  type: "object",
  properties: { plan: { type: "string", description: "The plan, in Markdown: what you will change and in what order" } },
  required: ["plan"],
};
const ExitPlanMode: Tool = {
  name: "ExitPlanMode",
  description: "In plan mode, present your plan to the owner for approval. Use it once the plan is ready; you cannot change anything until the owner approves.",
  input_schema: schema, readOnly: true, asksOwner: true, families: ["claude"], run: present,
};
const PresentPlan: Tool = {
  name: "present_plan",
  description: "In plan mode, present your plan to the owner for approval before you change anything. The owner approves it (maybe edited) or says what to change.",
  input_schema: { ...schema, properties: { ...schema.properties, title: { type: "string" } } }, readOnly: true, asksOwner: true, families: ["gpt", "gemini", "other"], run: present,
};

// The owner's decision on a waiting plan, from whichever client was proven to be the owner (the
// page with its passkey, the phone with its approval key): approve, edited or not, in a mode the
// work goes on in, or send it back with what to change. Set when the routes load.
// `fresh`: approve it to be carried out in a fresh session (see the top of the file).
export type PlanDecision = { approve?: unknown; mode?: unknown; plan?: unknown; note?: unknown; feedback?: unknown; fresh?: unknown };
// `proven`: asked once an approval is valid, before it is applied; an answer it gives refuses it.
type Said = { status: number; body: any };
export let decidePlan: (sessionId: string, id: string, b: PlanDecision, proven?: () => Said | null, sightings?: Sightings) => Said = () => ({ status: 503, body: { error: "plans are not loaded" } });

export const planRoutes: RouteModule = (deps: Deps) => {
  const { store, bus } = deps;
  parking = () => !!deps.engine?.isDraining?.();
  decidePlan = (sessionId, id, b, proven, sightings) => {
    const w = waiting.get(keyOf(sessionId, id));
    if (!w) return { status: 404, body: { error: "no plan is waiting with that id" } };
    // The decision is said one way. A body that says it another way (or not
    // at all) decides nothing: the plan keeps waiting.
    if (typeof b.approve !== "boolean") return { status: 400, body: { error: 'say the decision as "approve": true (with "mode") or false (with "feedback")' } };
    if (!b.approve) {
      w.resolve({ approved: false, feedback: typeof b.feedback === "string" && b.feedback.trim() ? b.feedback.trim().slice(0, 4000) : undefined });
      return { status: 200, body: { ok: true } };
    }
    // An edit the owner emptied approves nothing (an omitted one keeps the shown plan).
    if (b.plan !== undefined && (typeof b.plan !== "string" || !b.plan.trim())) return { status: 400, body: { error: "the edited plan is empty: write the plan to approve, or keep planning" } };
    const mode = String(b.mode ?? "ask");
    if (!isMode(mode) || mode === "plan") return { status: 400, body: { error: "pick the mode the work goes on in" } };
    const refused = proven?.();
    if (refused) return refused;
    const plan = typeof b.plan === "string" ? b.plan.trim().slice(0, 40_000) : w.plan;
    // (An approval changes the session's mode: not something owed to a store that takes no writes.)
    if (store.refusing) return { status: 503, body: { error: "the daemon's store takes no writes right now, and a plan's approval changes the session's mode, which cannot be kept: approve it when the store takes writes again, or reject it now" } };
    const note = typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 2000) : undefined;
    // (Where a session's plan work came from stays with it through a later plan: the gate reads it, src/safety/provenance-books.ts.)
    const keep = (rec: Record<string, unknown>) => {
      const was = store.db.query<{ data: string }, [string]>("SELECT data FROM plans WHERE session_id = ?").get(String(rec.session_id));
      const from = was ? JSON.parse(was.data)?.from_session : undefined;
      store.db.query("INSERT INTO plans (session_id, data) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET data = excluded.data").run(String(rec.session_id), JSON.stringify({ ...rec, ...(from && !rec.from_session ? { from_session: from } : {}) }));
    };
    if (b.fresh === true) {
      const src = store.session(w.session_id);
      if (!src) return { status: 404, body: { error: "the planning session is gone" } };
      if (src.outside) return { status: 400, body: { error: "a session another harness runs carries out its plan itself: approve it there" } };
      if (src.parent_id) return { status: 400, body: { error: "an agent's plan goes on in its own session: approve it there" } };
      // What outside content named in the planning session goes with the plan (src/safety/provenance.ts): asked by the
      // route before this, as it reads the books off the loop. With none read, nothing starts.
      if (!sightings) return { status: 503, body: { error: "what the planning session read could not be gathered, so the fresh session cannot start: approve it here or try again" } };
      // Everything here is synchronous and one write: the plan leaves the waiting list in the same tick the new session
      // starts, so a second press (or a retry) finds no plan and starts nothing. A start that fails leaves nothing of
      // the attempt and the plan waiting.
      const title = (w.title || src.title || "The plan").slice(0, 100);
      const p = gate?.perm(src.id);
      let to: string, moved = false;
      try {
        ({ to, moved } = store.db.transaction(() => {
          const s = store.createSession({ model: src.model, workspace: src.workspace, title, title_by: "", settings: carried(src.settings) });
          // Its folder is a folder of the machine the planning session's tools run on: the new session's tools run there too.
          if (src.machine) store.db.query("UPDATE sessions SET machine = ? WHERE id = ?").run(src.machine, s.id);
          // The planning session's sandbox and network go with the mode the owner chose.
          gate?.setPerm(s.id, { mode, ...(p ? { sandbox: p.sandbox, network: p.network } : {}) });
          // The worktree goes with the work: the planning session keeps reading its folder, in plan mode.
          let moved = false;
          try { moved = store.db.query("UPDATE worktrees SET session_id = ?, updated = ? WHERE session_id = ?").run(s.id, Date.now(), src.id).changes > 0; } catch (e) { if (!/no such table/.test(String(e))) throw e; } // no worktrees table: none to move
          keep({ session_id: s.id, plan, approval_id: w.id, mode, approved_ms: Date.now(), from_session: src.id });
          // The planning session's turn ends after the plan's step, kept so a restart before then does not go on with it.
          keep({ session_id: src.id, plan, approval_id: w.id, mode, approved_ms: Date.now(), fresh_session: s.id, end_owed: true });
          deps.engine.send(s.id, freshPrompt(plan, src.title, note), { meta: { kind: "plan", plan_from: src.id, plan_from_title: src.title, owned: true, sightings } });
          return { to: s.id, moved };
        })());
      } catch (e) {
        deps.errors.capture("server", e, { session: src.id, at: "plan in a fresh session" });
        return { status: 500, body: { error: `the fresh session could not start: ${(e as Error).message}. The plan still waits: approve it here or try again` } };
      }
      bus.emit({ t: "session", session: store.session(to)! });
      endAfterStep.add(src.id);
      w.resolve({ approved: true, mode, plan, note, fresh: { id: to, title } });
      // What the planning session keeps of it: a line that names the new session.
      try {
        bus.emit({ t: "event", event: store.append(src.id, "note", { kind: "plan_fresh", to_session: to, to_title: title, text: `The plan went to a fresh session, ${title}.` }) });
        if (moved) for (const id of [src.id, to]) bus.emit({ t: "feature", name: "worktree", session_id: id, data: { changed: true } });
      } catch (e) { deps.errors.capture("server", e, { session: src.id, at: "plan in a fresh session: the planning session's line" }); }
      return { status: 200, body: { ok: true, session: store.session(to), plan: { session_id: to, plan, mode } } };
    }
    // (A session another harness runs keeps no Keel mode: the mode goes to that harness with the answer.)
    if (!store.session(w.session_id)?.outside) gate?.setPerm(w.session_id, { mode });
    const rec = { session_id: w.session_id, plan, approval_id: w.id, mode, approved_ms: Date.now() };
    keep(rec);
    w.resolve({ approved: true, mode, plan, note });
    return { status: 200, body: { ok: true, plan: rec } };
  };
  // A planning session whose plan went to a fresh session ends its turn once the plan's step is stored: no
  // model step more there, so the work runs in one session only. The end is owed in the planning session's plan
  // row (`end_owed`), so a turn a restart cut before it is not continued: its plan is not presented again.
  const endAfterStep = new Set<string>();
  const settle = (id: string) => {
    try {
      const r = store.db.query<{ data: string }, [string]>("SELECT data FROM plans WHERE session_id = ?").get(id);
      const d = r ? JSON.parse(r.data) : null;
      if (d?.end_owed) { delete d.end_owed; store.db.query("UPDATE plans SET data = ? WHERE session_id = ?").run(JSON.stringify(d), id); return d as { fresh_session?: string }; }
    } catch (e) { deps.errors.capture("server", e, { session: id, at: "plan in a fresh session: the owed end" }); }
    return null;
  };
  registerHooks({
    stepDone: (s) => { if (endAfterStep.delete(s.id)) { settle(s.id); void deps.engine.interrupt(s.id, "plan_fresh"); } },
    // (A turn the daemon parks as it stops keeps the end owed: the next start's recovery settles it.)
    turnEnd: (s, reason) => { if (endAfterStep.delete(s.id) && reason !== "restart") settle(s.id); },
    cutTurn: (s) => {
      const d = settle(s.id);
      if (!d) return undefined;
      const to = d.fresh_session ? store.session(d.fresh_session) : undefined;
      return { hold: `The plan went to a fresh session${to ? `, ${to.title}` : ""}, which carries it out: this turn is not continued.` };
    },
  });
  store.migrate("CREATE TABLE IF NOT EXISTS plans (session_id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  emit = (c, state, end) => bus.emit({ t: "feature", name: "plan", session_id: c.session_id, data: { card: c, state, ...(end ? { end } : {}) } });
  registerShared(ExitPlanMode, PresentPlan);
  const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as any;

  return {
    "/api/sessions/:id/plan": {
      GET: (req: any) => {
        if (!store.session(req.params.id)) return bad("no such session", 404);
        const r = store.db.query<{ data: string }, [string]>("SELECT data FROM plans WHERE session_id = ?").get(req.params.id);
        const open = [...waiting.values()].filter((w) => w.session_id === req.params.id).map(({ resolve: _r, ...c }) => c);
        return json({ plan: r ? JSON.parse(r.data) : null, open });
      },
    },
    "/api/sessions/:id/plan/:pid": {
      POST: async (req: any) => {
        const w = waiting.get(keyOf(req.params.id, req.params.pid));
        if (!w || w.session_id !== req.params.id) return bad("no plan is waiting with that id", 404);
        const b = await body(req);
        // A plan that goes to a fresh session carries what the planning session read of outside content (read off the loop).
        let sightings: Sightings | undefined;
        if (b.fresh === true && gate) { const src = store.session(w.session_id); if (src) sightings = await gate.outsideOf(src).catch((e) => { deps.errors.capture("server", e, { session: src.id, at: "plan in a fresh session: the sightings" }); return undefined; }); }
        else if (b.fresh === true) sightings = { keys: [], listed: {} };
        // Leaving plan mode lets the session do more: from a remote device, the owner's passkey.
        const r = decidePlan(w.session_id, w.id, b, () => presence && !presence.allows(req, `plan:${w.id}`)
          ? { status: 428, body: { error: "this needs your passkey from a remote device", presence: { action: `plan:${w.id}` } } } : null, sightings);
        return json(r.body, r.status);
      },
    },
  };
};
